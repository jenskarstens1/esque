import { COMMON } from './common'

/**
 * Output transform: display-linear ProPhoto -> output primaries, luminance-
 * preserving gamut mapping, transfer encoding, clipping overlays, and dither.
 *
 * A viewport soft proof takes one extra, explicit step from the proof primaries
 * into the browser canvas's sRGB primaries. Export leaves that step disabled and
 * writes the selected output space directly.
 *
 * With HDR viewing on, the last thing this pass does before encoding is expand
 * the top of the display range into the headroom the display has above white,
 * driven by the scene peak the render pass recorded in alpha. That is a viewing
 * transform and nothing more: the edit graph is untouched, so turning HDR off
 * puts exactly the previous pixels back.
 */
export const OUTPUT_FS = /* wgsl */ `
${COMMON}

struct U {
  uToOutput: mat3x3f,
  uOutputLuma: vec3f,
  uToCanvas: mat3x3f,
  uCanvasLuma: vec3f,
  uProofToCanvas: f32,
  uGamma: f32,        // 0 selects the piecewise sRGB curve
  uDither: f32,       // amplitude in output code values
  uResolution: vec2f,
  uShowShadowClip: f32,
  uShowHighlightClip: f32,
  uClipHighlight: f32, // display value at or above which a channel counts as blown
  uClipShadow: f32,    // display value at or below which every channel counts as blocked
  uOutputGamutCompress: f32,
  uCanvasGamutCompress: f32,
  uHdrHeadroom: f32,  // 1 = SDR; 4 = two stops above display white
  uHdrKnee: f32,      // display value the expansion starts from
  uSrcOffset: vec2f,  // sub-rect origin; sample UV = uSrcOffset + uv * uSrcScale
  uSrcScale: vec2f,
}

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampMip: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;

/**
 * Pulls out-of-gamut colours back toward the achromatic axis instead of
 * clipping each channel, which is what causes the classic magenta sunset.
 */
fn gamutCompress(c: vec3f, weights: vec3f, amount: f32) -> vec3f {
  if (amount <= 0.0) { return c; }

  let y = clamp(dot(c, weights), 0.0, 1.0);
  let d = c - vec3f(y);

  let unitUpper = vec3f(1.0 - y) / max(d, vec3f(EPS));
  let unitLower = vec3f(-y) / min(d, vec3f(-EPS));
  let upperScale = min(unitUpper.r, min(unitUpper.g, unitUpper.b));
  let lowerScale = min(unitLower.r, min(unitLower.g, unitLower.b));
  let boundary = max(min(upperScale, lowerScale), EPS);

  // Chroma as a fraction of the available distance to the RGB cube boundary.
  // Identity through 90%, then a C1-continuous shoulder approaching 94%. The
  // inset keeps saturated highlights from quantising into a flat code-255 shelf.
  let chromaDist = 1.0 / boundary;
  const threshold = 0.90;
  const limit = 0.94;
  if (chromaDist <= threshold) { return c; }
  let mapped = threshold + (limit - threshold) *
    (1.0 - exp(-(chromaDist - threshold) / (limit - threshold)));
  let scale = clamp(mapped / chromaDist, 0.0, 1.0);
  let bounded = vec3f(y) + d * scale;
  return mix(c, bounded, vec3f(clamp(amount, 0.0, 1.0)));
}

/**
 * The render pass's highlight roll-off, aimed at an arbitrary ceiling.
 *
 * At a ceiling of 1 this is exactly the shoulder from common.wgsl. At a ceiling
 * of H it is the same curve rolling off against the display's headroom instead.
 */
fn shoulderTo(x: f32, k: f32, ceil: f32) -> f32 {
  if (x <= k) { return x; }
  let R = max(ceil - k, EPS);
  return k + R * (1.0 - exp(-(x - k) / R));
}

/**
 * Re-opens the highlights the earlier passes folded into the top of the display
 * range.
 *
 * The range is read, not guessed. Alpha carries a ratio: how much brighter this
 * pixel would be given somewhere to put it — a gain map's boost, the render
 * shoulder's compression, exposure pushed past white, or all three composed.
 * It is a ratio rather than an absolute because inverting the shoulder cannot
 * work. That curve is an asymptote, so a two-stop overexposure and a twenty-stop
 * specular land within one half-float step of each other, and an inverse has to
 * invent a ceiling to stop at. The old one stopped at that half-float step,
 * which is why asking for four stops of headroom and asking for one produced
 * almost the same picture.
 *
 * The ratio is rolled off against the headroom H the display actually has, so:
 *
 *   - a ratio of 1 — no range recorded — returns the pixel untouched, which is
 *     what a plain SDR photo must do even with HDR on;
 *   - at H = 1 the roll-off is flat and every pixel is returned untouched, so
 *     turning HDR off restores the previous picture exactly;
 *   - more range on offer means more gain, approaching H and never passing it.
 *
 * The gain then fades out below the knee. A highlight the photographer
 * deliberately pulled down to a midtone should stay a midtone — the grade is
 * the picture, and HDR is only how much room the bright end of it gets. How
 * bright is asked of the encoded value rather than the linear one it is applied
 * to: the knee is a place in the picture, and light is not where the eye is.
 */
fn hdrExpand(c: vec3f, headroom: f32, bright: f32, k: f32, h: f32) -> vec3f {
  if (h <= 1.0 + 1e-4 || headroom <= 1.0) { return c; }
  let gain = shoulderTo(headroom, 1.0, h);
  let t = clamp(bright / max(k, EPS), 0.0, 1.0);
  return c * (1.0 + (gain - 1.0) * t * t);
}

/**
 * The output transfer: the sRGB curve, or a plain power for a space that wants
 * one. The sRGB formula keeps going above 1, which is exactly how an
 * extended-range canvas reads a value over 1: same colour, brighter than
 * display white.
 */
fn transfer(c: vec3f, gamma: f32) -> vec3f {
  if (gamma <= 0.0) { return encode(c); }
  return pow(c, vec3f(gamma));
}

@fragment
fn fs(@builtin(position) pos: vec4f, @location(0) uv: vec2f) -> @location(0) vec4f {
  // Passes keep image row 0 at v=0; the screen wants it at the top, so the
  // final transform is where the flip happens.
  let sampleUv = u.uSrcOffset + uv * u.uSrcScale;
  let src = textureSample(uImage, sampMip, sampleUv);
  let lin = src.rgb;

  var disp = u.uToOutput * lin;

  disp = clamp(gamutCompress(disp, u.uOutputLuma, u.uOutputGamutCompress), vec3f(0.0), vec3f(1.0));
  if (u.uProofToCanvas > 0.5) {
    disp = u.uToCanvas * disp;
    disp = clamp(gamutCompress(disp, u.uCanvasLuma, u.uCanvasGamutCompress), vec3f(0.0), vec3f(1.0));
  }

  // Clipping is a property of the *encoded* output — the code value the display
  // or the exported file receives — and the thresholds are written as code-value
  // fractions. Comparing them against linear light instead moves them: 0.0025
  // linear is code 8, not code 0, so the shadow warning paints several stops of
  // perfectly recoverable shadow as lost, and disagrees with the histogram's own
  // clipping readout on the same frame.
  let code = transfer(disp, u.uGamma);
  let clipHi = u.uShowHighlightClip > 0.5 &&
    (code.r >= u.uClipHighlight || code.g >= u.uClipHighlight || code.b >= u.uClipHighlight);
  let clipLo = u.uShowShadowClip > 0.5 &&
    (code.r <= u.uClipShadow && code.g <= u.uClipShadow && code.b <= u.uClipShadow);

  // Last, so the gamut work above still reasons about a [0,1] cube and the
  // expansion is a pure brightness scale on colours already inside the display.
  // The encoded value is the same pixel as the eye reads it, which is what the
  // knee means.
  disp = hdrExpand(
    disp,
    src.a,
    max(max(code.r, code.g), code.b),
    u.uHdrKnee,
    u.uHdrHeadroom,
  );

  var encoded = transfer(disp, u.uGamma);

  // Interleaved gradient noise, ±half a code value: kills banding without grain.
  let n = ign(pos.xy) - 0.5;
  encoded = encoded + n * u.uDither;

  if (clipHi) { encoded = vec3f(1.0, 0.16, 0.11); }
  if (clipLo) { encoded = vec3f(0.16, 0.4, 1.0); }

  return vec4f(encoded, 1.0);
}
`
