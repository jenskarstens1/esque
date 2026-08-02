import { COMMON } from './common'

/**
 * Masking, in three shaders.
 *
 * A mask is a list of components — a gradient, a brush stroke, a colour range —
 * each of which is rasterised to a coverage value in 0..1 and then folded into
 * an accumulator with add / subtract / intersect. Keeping rasterisation and
 * folding apart is what lets the brush work: a stroke can hold thousands of
 * dabs, far more than a uniform array can carry, so it is rasterised over
 * several passes into a scratch buffer and folded in once at the end.
 *
 * Coverage lives in the red channel. Everything runs in the *framed* image, so
 * mask coordinates are the ones the user sees on screen: 0..1 across the
 * cropped, straightened, rotated photo.
 */

/** Dabs per rasterisation pass. A long stroke simply takes more passes. */
export const MAX_DABS = 96
/** Colour samples a colour-range component can hold. */
export const MAX_SAMPLES = 8

export const MASK_KIND = {
  linear: 0,
  radial: 1,
  brush: 2,
  colorRange: 3,
  luminanceRange: 4,
} as const

export const MASK_BLEND = { add: 0, subtract: 1, intersect: 2 } as const

// ---------------------------------------------------------------------------
// Component rasterisation
// ---------------------------------------------------------------------------

export const MASK_FS = /* wgsl */ `
${COMMON}

struct U {
  uKind: f32,
  uAspect: vec2f,
  // -- linear gradient --------------------------------------------------------
  uP0: vec2f,
  uP1: vec2f,
  // -- radial gradient --------------------------------------------------------
  uCenter: vec2f,
  uRadius: vec2f,
  uRotation: f32,
  uFeather: f32,
  // -- brush ------------------------------------------------------------------
  uDabs: array<vec4f, ${MAX_DABS}>,
  uDabCount: f32,
  uBrushFeather: f32,
  uFirstChunk: f32,
  // -- colour range -----------------------------------------------------------
  uSamples: array<vec3f, ${MAX_SAMPLES}>,
  uSampleCount: f32,
  uRefine: f32,
  // -- luminance range --------------------------------------------------------
  uRange: vec4f,
  uSmoothness: f32,
}

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;
@group(0) @binding(4) var uPrev: texture_2d<f32>;

/** Aspect-corrected position, so distances mean the same on both axes. */
fn P(uv: vec2f) -> vec2f { return uv * u.uAspect; }

fn linearMask(uv: vec2f) -> f32 {
  let a = P(u.uP0);
  let b = P(u.uP1);
  let d = b - a;
  let len2 = dot(d, d);
  if (len2 < EPS) { return 1.0; }
  // Distance along the axis, 0 at the first handle and 1 at the second.
  let t = dot(P(uv) - a, d) / len2;
  return smoothstep(0.0, 1.0, clamp(t, 0.0, 1.0));
}

fn radialMask(uv: vec2f) -> f32 {
  let p = P(uv) - P(u.uCenter);
  let c = cos(-u.uRotation);
  let s = sin(-u.uRotation);
  let r = vec2f(p.x * c - p.y * s, p.x * s + p.y * c);
  let rad = max(u.uRadius * u.uAspect, vec2f(1e-4));
  let d = length(r / rad);
  // Feather 0 still needs a pixel of ramp or the edge aliases badly.
  let f = max(u.uFeather * 0.01, 0.002);
  return 1.0 - smoothstep(1.0 - f, 1.0, d);
}

fn brushMask(uv: vec2f) -> f32 {
  var acc: f32;
  if (u.uFirstChunk > 0.5) {
    acc = 0.0;
  } else {
    acc = textureSampleLevel(uPrev, sampLin, uv, 0.0).r;
  }
  let p = P(uv);
  let n = i32(u.uDabCount);
  for (var i = 0; i < ${MAX_DABS}; i = i + 1) {
    if (i >= n) { break; }
    let dab = u.uDabs[i];
    let rad = max(dab.z, 1e-5) * max(u.uAspect.x, u.uAspect.y);
    let d = length(p - P(dab.xy)) / rad;
    // A soft dab is a smooth falloff from the feather point to the rim; a hard
    // one still keeps a hair of ramp so strokes don't look like cut paper.
    let inner = clamp(1.0 - u.uBrushFeather * 0.01, 0.02, 0.98);
    let w = 1.0 - smoothstep(inner, 1.0, d);
    let flow = dab.w;
    if (flow < 0.0) {
      acc = acc * (1.0 - w * (-flow));   // erase
    } else {
      acc = acc + (1.0 - acc) * w * flow;  // paint
    }
  }
  return clamp(acc, 0.0, 1.0);
}

fn colorRangeMask(uv: vec2f) -> f32 {
  let n = i32(u.uSampleCount);
  if (n <= 0) { return 0.0; }
  let c = encode(max(textureSampleLevel(uImage, sampLin, uv, 0.0).rgb, vec3f(0.0)));
  let hsvC = rgb2hsv(clamp(c, vec3f(0.0), vec3f(1.0)));
  // Tolerance widens with refine; the exponent keeps the low end usable.
  let tol = mix(0.04, 0.55, pow(clamp(u.uRefine * 0.01, 0.0, 1.0), 0.7));
  var best = 0.0;
  for (var i = 0; i < ${MAX_SAMPLES}; i = i + 1) {
    if (i >= n) { break; }
    let hsvS = rgb2hsv(clamp(encode(max(u.uSamples[i], vec3f(0.0))), vec3f(0.0), vec3f(1.0)));
    // Hue is a circle, so the shorter way round is the real distance. Weight it
    // far above value: picking "the red jumper" should not also pick the sky
    // just because they are equally bright.
    var dh = abs(hsvC.x - hsvS.x);
    dh = min(dh, 1.0 - dh);
    let ds = hsvC.y - hsvS.y;
    let dv = hsvC.z - hsvS.z;
    // Desaturated pixels have meaningless hue; fade its weight out with chroma.
    let chroma = min(hsvC.y, hsvS.y);
    let d = sqrt(dh * dh * 4.0 * chroma + ds * ds * 1.5 + dv * dv * 0.6);
    best = max(best, 1.0 - smoothstep(tol * 0.35, tol, d));
  }
  return best;
}

fn luminanceRangeMask(uv: vec2f) -> f32 {
  let L = clamp(luma(encode(max(textureSampleLevel(uImage, sampLin, uv, 0.0).rgb, vec3f(0.0)))), 0.0, 1.0);
  let b0 = u.uRange.x;
  let b1 = u.uRange.y;
  let w1 = u.uRange.z;
  let w0 = u.uRange.w;
  // Two ramps facing each other: in over the shadow pair, out over the
  // highlight pair. Degenerate stops collapse to a hard edge rather than NaN.
  let rise = select(step(b0, L), smoothstep(b0, b1, L), b1 > b0 + EPS);
  let fall = select(1.0 - step(w1, L), 1.0 - smoothstep(w1, w0, L), w0 > w1 + EPS);
  let m = min(rise, fall);
  // Smoothness rounds the plateau's corners without moving the stops.
  let s = clamp(u.uSmoothness * 0.01, 0.0, 1.0);
  return mix(m, smoothstep(0.0, 1.0, m), s);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  var m: f32;
  if (u.uKind < 0.5)      { m = linearMask(uv); }
  else if (u.uKind < 1.5) { m = radialMask(uv); }
  else if (u.uKind < 2.5) { m = brushMask(uv); }
  else if (u.uKind < 3.5) { m = colorRangeMask(uv); }
  else                    { m = luminanceRangeMask(uv); }
  return vec4f(clamp(m, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`

// ---------------------------------------------------------------------------
// Folding a component into the accumulator
// ---------------------------------------------------------------------------

export const MASK_MERGE_FS = /* wgsl */ `
struct U {
  uBlend: f32,
  uInvert: f32,
  uFirst: f32,
}

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uPrev: texture_2d<f32>;
@group(0) @binding(4) var uCov: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  var c = textureSampleLevel(uCov, sampLin, uv, 0.0).r;
  if (u.uInvert > 0.5) { c = 1.0 - c; }
  let prev = textureSampleLevel(uPrev, sampLin, uv, 0.0).r;

  var outv = 0.0;
  if (u.uFirst > 0.5) {
    // Lightroom's first component is always additive, whatever its blend says:
    // subtracting from nothing would leave an empty mask.
    if (u.uBlend > 1.5) {
      outv = c;
    } else if (u.uBlend > 0.5) {
      outv = 0.0;
    } else {
      outv = c;
    }
  } else if (u.uBlend > 1.5) {
    outv = prev * c;
  } else if (u.uBlend > 0.5) {
    outv = prev * (1.0 - c);
  } else {
    // Screen rather than add: two overlapping gradients should meet at 1.0,
    // not clip into a visible plateau.
    outv = prev + c - prev * c;
  }
  return vec4f(clamp(outv, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`

// ---------------------------------------------------------------------------
// Applying a mask's adjustments
// ---------------------------------------------------------------------------

export const MASK_APPLY_FS = /* wgsl */ `
${COMMON}

struct U {
  uOpacity: f32,
  uExposure: f32,    // stops
  uContrast: f32,    // -1..1
  uHighlights: f32,
  uShadows: f32,
  uWhites: f32,
  uBlacks: f32,
  uTexture: f32,
  uClarity: f32,
  uDehaze: f32,
  uTemp: f32,        // -1..1
  uTint: f32,
  uSaturation: f32,  // -1..1
  uHue: f32,         // 0..360 overlay hue
  uHueStrength: f32, // 0..1
  uColorize: f32,    // 0..1
  uSharpness: f32,   // -1..1
  uNoise: f32,       // 0..1
  uMoire: f32,       // 0..1
  uDefringe: f32,    // 0..1
  uHasCurve: f32,
  uLutSize: f32,
}

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;
@group(0) @binding(4) var uMask: texture_2d<f32>;
@group(0) @binding(5) var uFine: texture_2d<f32>;    // small-radius blur, for texture / sharpness / noise
@group(0) @binding(6) var uCoarse: texture_2d<f32>;  // large-radius blur, for clarity / dehaze
@group(0) @binding(7) var uLut: texture_2d<f32>;     // the local point curve

fn lut1(x: f32, ch: i32) -> f32 {
  let lc = (clamp(x, 0.0, 1.0) * (u.uLutSize - 1.0) + 0.5) / u.uLutSize;
  let s = textureSampleLevel(uLut, sampLin, vec2f(lc, 0.5), 0.0);
  if (ch == 0) { return s.r; }
  if (ch == 1) { return s.g; }
  return s.b;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let src = textureSampleLevel(uImage, sampLin, uv, 0.0);
  let m = clamp(textureSampleLevel(uMask, sampLin, uv, 0.0).r, 0.0, 1.0) * u.uOpacity;
  if (m <= 0.0005) { return src; }

  var lin = max(src.rgb, vec3f(0.0));

  // --- Linear-light work ---------------------------------------------------
  if (abs(u.uExposure) > 1e-4) { lin = lin * exp2(u.uExposure); }

  if (abs(u.uTemp) > 1e-4 || abs(u.uTint) > 1e-4) {
    // A cheap channel tilt rather than a full chromatic adaptation: the local
    // control is a nudge, and the global white balance already did the physics.
    let g = vec3f(1.0 + u.uTemp * 0.30 - u.uTint * 0.06,
                  1.0 + u.uTint * 0.22,
                  1.0 - u.uTemp * 0.30 - u.uTint * 0.06);
    lin = lin * max(g, vec3f(0.02));
  }

  var t = encode(lin);

  // --- Tone ----------------------------------------------------------------
  if (abs(u.uContrast) > 1e-4) {
    let L = clamp(luma(t), 0.0, 1.0);
    t = applyLumaRatio(t, L, contrastCurve(L, u.uContrast));
  }

  if (abs(u.uHighlights) > 1e-4 || abs(u.uShadows) > 1e-4) {
    let L = clamp(luma(t), 0.0, 1.0);
    let hw = smoothstep(0.45, 1.0, L);
    let sw = 1.0 - smoothstep(0.0, 0.55, L);
    let out1 = clamp(L + u.uHighlights * 0.45 * hw + u.uShadows * 0.45 * sw, 0.0, 1.0);
    t = applyLumaRatio(t, L, out1);
  }

  if (abs(u.uWhites) > 1e-4 || abs(u.uBlacks) > 1e-4) {
    let L = clamp(luma(t), 0.0, 1.0);
    let ww = smoothstep(0.6, 1.0, L);
    let bw = 1.0 - smoothstep(0.0, 0.4, L);
    let out1 = clamp(L + u.uWhites * 0.35 * ww + u.uBlacks * 0.35 * bw, 0.0, 1.0);
    t = applyLumaRatio(t, L, out1);
  }

  // --- Local contrast ------------------------------------------------------
  let fine = encode(max(textureSampleLevel(uFine, sampLin, uv, 0.0).rgb, vec3f(0.0)));
  let coarse = encode(max(textureSampleLevel(uCoarse, sampLin, uv, 0.0).rgb, vec3f(0.0)));

  if (abs(u.uTexture) > 1e-4) {
    let detail = tanh((t - fine) * 6.0) / 6.0;
    t = t + detail * select(u.uTexture, u.uTexture * 1.6, u.uTexture > 0.0);
  }

  if (abs(u.uSharpness) > 1e-4) {
    // Unsharp against the fine blur, so it sharpens the same band the global
    // detail pass does and the two stack predictably.
    t = t + (t - fine) * u.uSharpness * 1.2;
  }

  if (u.uNoise > 1e-4 || u.uMoire > 1e-4) {
    // Both are "throw away high-frequency variation", differing only in which
    // part: noise smooths everything, moire only the colour.
    let tgt = mix(t, coarse, vec3f(u.uMoire * 0.85));
    let Lt = luma(t);
    let chromaFixed = tgt + vec3f(Lt - luma(tgt));
    t = mix(t, chromaFixed, vec3f(u.uMoire));
    t = mix(t, fine, vec3f(u.uNoise * 0.8));
  }

  if (abs(u.uClarity) > 1e-4) {
    let L = clamp(luma(t), 0.0, 1.0);
    let mid = 1.0 - pow(abs(L * 2.0 - 1.0), 2.4);
    let shaped = tanh((L - luma(coarse)) * 4.0) / 4.0;
    t = applyLumaRatio(t, L, clamp(L + shaped * u.uClarity * mid * 1.1, 0.0, 1.0));
  }

  if (abs(u.uDehaze) > 1e-4) {
    let veil = min(min(coarse.r, coarse.g), coarse.b);
    let k = u.uDehaze * 0.55;
    t = (t - veil * k) / max(1.0 - veil * k, 0.25);
    var hsv = rgb2hsv(clamp(t, vec3f(0.0), vec3f(1.0)));
    hsv.y = clamp(hsv.y * (1.0 + u.uDehaze * 0.35), 0.0, 1.0);
    t = hsv2rgb(hsv);
  }

  // --- Colour --------------------------------------------------------------
  if (abs(u.uSaturation) > 1e-4) {
    let L = luma(t);
    t = mix(vec3f(L), t, vec3f(clamp(1.0 + u.uSaturation, 0.0, 3.0)));
  }

  if (u.uDefringe > 1e-4) {
    // Pull colour toward the blurred neighbourhood while keeping luminance;
    // fringes are a chroma artefact, so only chroma should move.
    let c2 = coarse + vec3f(luma(t) - luma(coarse));
    t = mix(t, c2, vec3f(u.uDefringe * 0.8));
  }

  if (u.uColorize > 1e-4 || u.uHueStrength > 1e-4) {
    var hsv = rgb2hsv(clamp(t, vec3f(0.0), vec3f(1.0)));
    // Lightroom's local Color: the hue is imposed, the saturation is dialled.
    hsv.x = mix(hsv.x, fract(u.uHue / 360.0), clamp(u.uHueStrength, 0.0, 1.0));
    hsv.y = clamp(mix(hsv.y, max(hsv.y, 0.6), u.uColorize), 0.0, 1.0);
    t = hsv2rgb(hsv);
  }

  // --- Local curve ---------------------------------------------------------
  if (u.uHasCurve > 0.5) {
    t = vec3f(lut1(t.r, 0), lut1(t.g, 1), lut1(t.b, 2));
  }

  let outRgb = decode(clamp(t, vec3f(0.0), vec3f(1.0)));
  return vec4f(mix(src.rgb, outRgb, vec3f(m)), src.a);
}
`

// ---------------------------------------------------------------------------
// Showing the mask
// ---------------------------------------------------------------------------

export const MASK_SHOW_FS = /* wgsl */ `
struct U {
  uTint: vec3f,
  uAmount: f32,
  uMode: f32,
}

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;
@group(0) @binding(4) var uMask: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let src = textureSampleLevel(uImage, sampLin, uv, 0.0);
  let m = clamp(textureSampleLevel(uMask, sampLin, uv, 0.0).r, 0.0, 1.0);
  if (u.uMode > 0.5) { return vec4f(vec3f(m), 1.0); }
  return vec4f(mix(src.rgb, u.uTint, vec3f(m * u.uAmount)), src.a);
}
`
