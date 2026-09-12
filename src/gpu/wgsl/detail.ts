import { COMMON } from './common'

/**
 * Scene-referred noise reduction — an edge-aware bilateral pass split into
 * luminance and chroma, run before sharpening so the sharpener does not amplify
 * what NR is about to remove. Extended tone encoding keeps RAW values above one
 * finite and reversible while the filter measures perceptual differences.
 *
 * Chroma noise gets a much wider kernel than luminance noise because colour
 * detail carries almost no perceptual information: you can blur it hard and
 * nobody notices.
 */
export const DENOISE_FS = /* wgsl */ `
${COMMON}

struct U {
  uTexel: vec2f,
  uLuminance: f32,       // 0..1
  uLumaDetail: f32,      // 0..1
  uLumaContrast: f32,    // 0..1
  uColor: f32,           // 0..1
  uColorDetail: f32,     // 0..1
  uColorSmoothness: f32, // 0..1
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let src = textureSampleLevel(uImage, sampLin, uv, 0.0);
  let center = encode(src.rgb);
  let cL = luma(center);
  let cC = vec2f(center.r - cL, center.b - cL);
  // Perceptual controls need useful travel near their Lightroom-style defaults;
  // a literal 0.25 blend left three quarters of every chroma outlier intact.
  let lumaAmount = 1.0 - pow(1.0 - clamp(u.uLuminance, 0.0, 1.0), 2.1);
  let colorAmount = 1.0 - pow(1.0 - clamp(u.uColor, 0.0, 1.0), 2.1);

  // Threshold: how different a neighbour may be before it stops contributing.
  let lumaSigma = mix(0.006, 0.075, lumaAmount) * mix(1.6, 0.35, u.uLumaDetail);
  let colorSigma =
    mix(0.02, 0.30, colorAmount) *
    mix(1.6, 0.4, u.uColorDetail) *
    mix(0.55, 1.45, u.uColorSmoothness);

  let lumaRadius = mix(1.0, 2.6, lumaAmount);
  // Smoothness reaches farther into broad colour blotches. Keeping the default
  // radius fractional also prevents repeatedly sampling the same Bayer phase.
  let colorRadius = mix(
    1.0,
    5.0,
    clamp(colorAmount * 0.55 + u.uColorSmoothness * 0.45, 0.0, 1.0)
  );

  var accL = 0.0;
  var wSumL = 0.0;
  var accC = vec2f(0.0);
  var wSumC = 0.0;

  for (var y = -2; y <= 2; y = y + 1) {
    for (var x = -2; x <= 2; x = x + 1) {
      let d = vec2f(f32(x), f32(y));
      let spatial = exp(-dot(d, d) * 0.36);

      if (u.uLuminance > 1e-3) {
        let nL = encode(textureSampleLevel(uImage, sampLin, uv + d * u.uTexel * lumaRadius, 0.0).rgb);
        let l = luma(nL);
        // WGSL pow has undefined behaviour for a negative base; square directly.
        let dl = (l - cL) / lumaSigma;
        let wl = spatial * exp(-(dl * dl));
        accL = accL + l * wl;
        wSumL = wSumL + wl;
      }

      if (u.uColor > 1e-3) {
        let nC = encode(textureSampleLevel(uImage, sampLin, uv + d * u.uTexel * colorRadius, 0.0).rgb);
        let lc = max(luma(nC), EPS);
        // Opponent chroma keeps luminance out of the range test.
        let chroma = vec2f(nC.r - lc, nC.b - lc);
        let dc = distance(chroma, cC) / colorSigma;
        let wc = spatial * exp(-(dc * dc));
        accC = accC + chroma * wc;
        wSumC = wSumC + wc;
      }
    }
  }

  var outT = center;

  if (u.uLuminance > 1e-3) {
    let filtered = accL / max(wSumL, EPS);
    // Contrast restores residuals larger than the estimated noise floor rather
    // than simply undoing the filter, so real texture returns before grain does.
    let residual = cL - filtered;
    let preserved = sign(residual) * max(abs(residual) - lumaSigma * 0.08, 0.0);
    let denoised = filtered + preserved * u.uLumaContrast;
    let tgt = mix(cL, denoised, lumaAmount);
    outT = applyLumaRatio(outT, cL, tgt);
  }

  if (u.uColor > 1e-3) {
    let l = max(luma(outT), EPS);
    let filtered = accC / max(wSumC, EPS);
    let current = vec2f(outT.r - l, outT.b - l);
    let blended = mix(current, filtered, vec2f(colorAmount));
    // Rebuild green from the luminance constraint so brightness is preserved.
    let r = l + blended.x;
    let b = l + blended.y;
    let g = (l - LUMA.r * r - LUMA.b * b) / max(LUMA.g, EPS);
    outT = max(vec3f(r, g, b), vec3f(0.0));
  }

  return vec4f(decode(max(outT, vec3f(0.0))), src.a);
}
`

/**
 * Scene-referred capture sharpening — unsharp mask with Lightroom's three
 * modifiers. The upper range remains unbounded for the later display shoulder.
 *
 * `detail` controls halo suppression (low values behave like a deconvolution
 * that keeps edges clean); `masking` builds an edge mask from the local
 * gradient so flat areas — skin, sky, sensor noise — are left alone.
 */
export const SHARPEN_FS = /* wgsl */ `
${COMMON}

struct U {
  uTexel: vec2f,
  uAmount: f32,   // 0..1.5
  uDetail: f32,   // 0..1
  uMasking: f32,  // 0..1
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;
@group(0) @binding(4) var uBlur: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let src = textureSampleLevel(uImage, sampLin, uv, 0.0);
  var t = encode(src.rgb);
  let L = luma(t);
  let blurred = luma(encode(max(textureSampleLevel(uBlur, sampLin, uv, 0.0).rgb, vec3f(0.0))));

  var high = L - blurred;

  // Halo suppression: low detail soft-clips the overshoot, high detail lets it
  // through, which is exactly how Lightroom's Detail slider behaves.
  let knee = mix(0.035, 0.22, u.uDetail);
  high = knee * tanh(high / max(knee, EPS));

  var mask = 1.0;
  if (u.uMasking > 1e-3) {
    let gx =
      luma(encode(textureSampleLevel(uImage, sampLin, uv + vec2f(u.uTexel.x, 0.0), 0.0).rgb)) -
      luma(encode(textureSampleLevel(uImage, sampLin, uv - vec2f(u.uTexel.x, 0.0), 0.0).rgb));
    let gy =
      luma(encode(textureSampleLevel(uImage, sampLin, uv + vec2f(0.0, u.uTexel.y), 0.0).rgb)) -
      luma(encode(textureSampleLevel(uImage, sampLin, uv - vec2f(0.0, u.uTexel.y), 0.0).rgb));
    let edge = length(vec2f(gx, gy));
    let threshold = u.uMasking * 0.17;
    mask = smoothstep(threshold * 0.2, threshold + 0.006, edge);
  }

  let tgt = max(L + high * u.uAmount * mask, 0.0);
  t = applyLumaRatio(t, L, tgt);

  return vec4f(decode(max(t, vec3f(0.0))), src.a);
}
`

/**
 * Impulse noise reduction — the hot-pixel / salt-and-pepper filter.
 *
 * Rather than a full 3x3 median (nine sorted taps for one number), the centre
 * pixel is clamped into the range spanned by its neighbours once the extremes
 * have been discarded. A pixel that agrees with its surroundings is untouched;
 * a single stuck sensel, which by definition lies outside that range, is pulled
 * back to the nearest plausible value. Edges survive because both sides of an
 * edge are represented among the eight neighbours.
 */
export const IMPULSE_FS = /* wgsl */ `
${COMMON}

struct U {
  uTexel: vec2f,
  uAmount: f32,  // 0..1
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let src = textureSampleLevel(uImage, sampLin, uv, 0.0);
  var t = encode(src.rgb);
  let c = luma(t);

  var n: array<f32, 8>;
  n[0] = luma(encode(max(textureSampleLevel(uImage, sampLin, uv + vec2f(-u.uTexel.x, -u.uTexel.y), 0.0).rgb, vec3f(0.0))));
  n[1] = luma(encode(max(textureSampleLevel(uImage, sampLin, uv + vec2f( 0.0,        -u.uTexel.y), 0.0).rgb, vec3f(0.0))));
  n[2] = luma(encode(max(textureSampleLevel(uImage, sampLin, uv + vec2f( u.uTexel.x, -u.uTexel.y), 0.0).rgb, vec3f(0.0))));
  n[3] = luma(encode(max(textureSampleLevel(uImage, sampLin, uv + vec2f(-u.uTexel.x,  0.0),        0.0).rgb, vec3f(0.0))));
  n[4] = luma(encode(max(textureSampleLevel(uImage, sampLin, uv + vec2f( u.uTexel.x,  0.0),        0.0).rgb, vec3f(0.0))));
  n[5] = luma(encode(max(textureSampleLevel(uImage, sampLin, uv + vec2f(-u.uTexel.x,  u.uTexel.y), 0.0).rgb, vec3f(0.0))));
  n[6] = luma(encode(max(textureSampleLevel(uImage, sampLin, uv + vec2f( 0.0,         u.uTexel.y), 0.0).rgb, vec3f(0.0))));
  n[7] = luma(encode(max(textureSampleLevel(uImage, sampLin, uv + vec2f( u.uTexel.x,  u.uTexel.y), 0.0).rgb, vec3f(0.0))));

  // Second-smallest and second-largest: one dead neighbour can't skew the bounds.
  var lo1: f32 = 1.0e9;
  var lo2: f32 = 1.0e9;
  var hi1: f32 = -1.0e9;
  var hi2: f32 = -1.0e9;
  for (var i = 0; i < 8; i = i + 1) {
    let v = n[i];
    if (v < lo1) { lo2 = lo1; lo1 = v; } else if (v < lo2) { lo2 = v; }
    if (v > hi1) { hi2 = hi1; hi1 = v; } else if (v > hi2) { hi2 = v; }
  }

  // Aggressiveness widens the tolerance band at low amounts so only the truly
  // isolated outliers are touched.
  let slack = mix(0.30, 0.01, clamp(u.uAmount, 0.0, 1.0));
  let range = max(hi2 - lo2, 0.0);
  let lo = lo2 - slack - range * 0.25;
  let hi = hi2 + slack + range * 0.25;

  let fixed_ = clamp(c, lo, hi);
  let tgt = mix(c, fixed_, clamp(u.uAmount, 0.0, 1.0));
  t = applyLumaRatio(t, c, tgt);

  return vec4f(decode(max(t, vec3f(0.0))), src.a);
}
`

/**
 * Defringe — removes the purple and green haloes lateral chromatic aberration
 * and sensor blooming leave along high-contrast edges.
 *
 * Only pixels that are both (a) sitting on a strong luminance edge and (b) in
 * one of the two tgt hue windows are affected, and the correction is a pull
 * toward the local chroma rather than a flat desaturation, so a genuinely
 * purple subject against a bright sky keeps its colour.
 */
export const DEFRINGE_FS = /* wgsl */ `
${COMMON}

struct U {
  uTexel: vec2f,
  uPurple: f32,      // 0..1
  uPurpleHue: vec2f, // hue window in turns
  uGreen: f32,       // 0..1
  uGreenHue: vec2f,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;

/** 1 inside the window, falling off over a fifth of its width outside. */
fn hueWindow(h: f32, win: vec2f) -> f32 {
  let lo = win.x;
  let hi = win.y;
  let feather = max((hi - lo) * 0.35, 0.02);
  // Hue is circular: measure against the window centre the short way round.
  let mid = (lo + hi) * 0.5;
  let half_ = (hi - lo) * 0.5;
  let d = abs(fract(h - mid + 0.5) - 0.5);
  return 1.0 - smoothstep(half_, half_ + feather, d);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let src = textureSampleLevel(uImage, sampLin, uv, 0.0);
  let t = max(encode(src.rgb), vec3f(0.0));

  if (u.uPurple <= 0.0 && u.uGreen <= 0.0) {
    return src;
  }

  // Edge strength from the luminance gradient; fringes only exist on edges.
  let l0 = luma(encode(max(textureSampleLevel(uImage, sampLin, uv + vec2f(u.uTexel.x, 0.0), 0.0).rgb, vec3f(0.0))));
  let l1 = luma(encode(max(textureSampleLevel(uImage, sampLin, uv - vec2f(u.uTexel.x, 0.0), 0.0).rgb, vec3f(0.0))));
  let l2 = luma(encode(max(textureSampleLevel(uImage, sampLin, uv + vec2f(0.0, u.uTexel.y), 0.0).rgb, vec3f(0.0))));
  let l3 = luma(encode(max(textureSampleLevel(uImage, sampLin, uv - vec2f(0.0, u.uTexel.y), 0.0).rgb, vec3f(0.0))));
  let edge = smoothstep(0.05, 0.30, length(vec2f(l0 - l1, l2 - l3)));

  var hsv = rgb2hsv(t);
  var amount =
    u.uPurple * hueWindow(hsv.x, u.uPurpleHue) + u.uGreen * hueWindow(hsv.x, u.uGreenHue);
  amount = clamp(amount, 0.0, 1.0) * edge * smoothstep(0.04, 0.20, hsv.y);

  hsv.y = hsv.y * (1.0 - amount);
  return vec4f(decode(max(hsv2rgb(hsv), vec3f(0.0))), src.a);
}
`
