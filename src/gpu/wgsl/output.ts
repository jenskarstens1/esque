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
 * the top of the display range into the headroom the display has above white.
 * That is a viewing transform and nothing more: the edit graph is untouched, so
 * turning HDR off puts exactly the previous pixels back.
 */
export const OUTPUT_FS = /* wgsl */ `
${COMMON}

/**
 * The gap between 1.0 and the largest half float below it. The render targets
 * feeding this pass are RGBA16F, so this is the finest distinction their
 * highlights can carry, and it is what bounds the expansion below.
 */
const HALF_STEP: f32 = 1.0 / 2048.0;

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
 * Re-opens the highlights that the render shoulder folded into the last stretch
 * below display white.
 *
 * The render pass rolls scene light off with \`shoulder\`, an exponential that
 * approaches display white and never reaches it. So a display value here can be
 * read back as the scene light it came from, and that light rolled off a second
 * time against the display's ceiling H instead of against 1 — which is the
 * whole transform:
 *
 *     scene  = k - r * ln(1 - t),  t = (x-k)/r,  r = 1-k
 *     expand = k + R * (1 - exp(-(scene-k)/R)),  R = H-k
 *
 * It is exactly the identity at H = 1, has slope exactly 1 where it meets the
 * knee, and is monotonic. Below the knee nothing moves at all.
 *
 * How far it can see is set by the render buffer, not by the algebra: the
 * inverse of an asymptote runs away to infinity, but half float cannot tell
 * white from one step below it, so scene light beyond what that step represents
 * was never written down. Stopping there is what keeps the curve continuous
 * through a clipped highlight — the flat white of a blown sky lands exactly
 * where the gradient running into it does, instead of jumping past it.
 */
fn hdrExpand1(x: f32, k: f32, h: f32) -> f32 {
  if (x <= k) { return x; }
  let r = max(1.0 - k, EPS);
  let R = max(h - k, EPS);
  let t = clamp((x - k) / r, 0.0, 1.0);
  // One half-float step below white, in the same units as (1 - t).
  let ut = max(1.0 - t, HALF_STEP / r);
  let scene = k - r * log(ut);
  return k + R * (1.0 - exp(-(scene - k) / R));
}

/**
 * Expansion is driven by the brightest channel and applied as one scale, the
 * same way the render shoulder is. Per channel it would pull a saturated
 * highlight toward white as the channels expanded by different amounts.
 */
fn hdrExpand(c: vec3f, k: f32, h: f32) -> vec3f {
  if (h <= 1.0 + 1e-4) { return c; }
  let peak = max(max(c.r, c.g), c.b);
  if (peak <= k) { return c; }
  return c * (hdrExpand1(peak, k, h) / max(peak, EPS));
}

@fragment
fn fs(@builtin(position) pos: vec4f, @location(0) uv: vec2f) -> @location(0) vec4f {
  // Passes keep image row 0 at v=0; the screen wants it at the top, so the
  // final transform is where the flip happens.
  let sampleUv = u.uSrcOffset + uv * u.uSrcScale;
  let src = textureSample(uImage, sampMip, sampleUv);
  let lin = src.rgb;

  var disp = u.uToOutput * lin;
  let clipHi = u.uShowHighlightClip > 0.5 &&
    (disp.r >= u.uClipHighlight || disp.g >= u.uClipHighlight || disp.b >= u.uClipHighlight);
  let clipLo = u.uShowShadowClip > 0.5 &&
    (disp.r <= u.uClipShadow && disp.g <= u.uClipShadow && disp.b <= u.uClipShadow);

  disp = clamp(gamutCompress(disp, u.uOutputLuma, u.uOutputGamutCompress), vec3f(0.0), vec3f(1.0));
  if (u.uProofToCanvas > 0.5) {
    disp = u.uToCanvas * disp;
    disp = clamp(gamutCompress(disp, u.uCanvasLuma, u.uCanvasGamutCompress), vec3f(0.0), vec3f(1.0));
  }

  // Last, so the gamut work above still reasons about a [0,1] cube and the
  // expansion is a pure brightness scale on colours already inside the display.
  disp = hdrExpand(disp, u.uHdrKnee, u.uHdrHeadroom);

  // The sRGB formula keeps going above 1, which is exactly how an
  // extended-range canvas reads a value over 1: same colour, brighter than
  // display white.
  var encoded: vec3f;
  if (u.uGamma <= 0.0) {
    encoded = encode(disp);
  } else {
    encoded = pow(disp, vec3f(u.uGamma));
  }

  // Interleaved gradient noise, ±half a code value: kills banding without grain.
  let n = ign(pos.xy) - 0.5;
  encoded = encoded + n * u.uDither;

  if (clipHi) { encoded = vec3f(1.0, 0.16, 0.11); }
  if (clipLo) { encoded = vec3f(0.16, 0.4, 1.0); }

  return vec4f(encoded, 1.0);
}
`
