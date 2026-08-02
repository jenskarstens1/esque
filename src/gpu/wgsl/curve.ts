import { COMMON } from './common'

/**
 * Tone curve pass. The LUT texture is 256x1 RGBA16F:
 *   .a = composite RGB curve (parametric ∘ point), applied first
 *   .r/.g/.b = per-channel point curves, applied after
 *
 * Curves are 1D transfer functions, so they run in tone space and the result is
 * decoded back to linear.
 *
 * The composite curve has a mode, borrowed from RawTherapee: the same curve
 * shape produces very different colour depending on what it is applied to.
 * Applied per channel it saturates as it steepens (the familiar look of an RGB
 * S-curve); applied to luminance it leaves colour completely alone.
 */
export const CURVE_FS = /* wgsl */ `
${COMMON}

struct U {
  uHasRgb: f32,
  uHasChannels: f32,
  uMode: f32,  // 0 standard, 1 weighted, 2 film-like, 3 sat+value, 4 luminance, 5 perceptual
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;
@group(0) @binding(4) var uLut: texture_2d<f32>;

fn lutA(x: f32) -> f32 { return textureSampleLevel(uLut, sampLin, vec2f(clamp(x, 0.0, 1.0), 0.5), 0.0).a; }

/** Per channel — the classic RGB curve. */
fn standard(t: vec3f) -> vec3f {
  return vec3f(lutA(t.r), lutA(t.g), lutA(t.b));
}

/** Luminance only: chromaticity is carried through untouched. */
fn luminanceMode(t: vec3f) -> vec3f {
  let L = luma(t);
  return applyLumaRatio(t, L, lutA(L));
}

/**
 * Film-like. The curve is applied to the brightest and darkest channels and the
 * middle one is interpolated to hold its original position between them — the
 * construction RawTherapee uses. Highlights bleach toward white instead of
 * taking on the hue of whichever channel saturated last.
 */
fn filmLike(t: vec3f) -> vec3f {
  let hi = max(max(t.r, t.g), t.b);
  let lo = min(min(t.r, t.g), t.b);
  let mid = t.r + t.g + t.b - hi - lo;

  let hi2 = lutA(hi);
  let lo2 = lutA(lo);
  // select is not short-circuit; guard the division with if.
  var mid2: f32;
  if (hi - lo > EPS) {
    mid2 = lo2 + (hi2 - lo2) * (mid - lo) / (hi - lo);
  } else {
    mid2 = lo2;
  }

  // Put the three results back on the channels they came from.
  var o: vec3f;
  o.r = select(select(mid2, lo2, t.r <= lo + EPS), hi2, t.r >= hi - EPS);
  o.g = select(select(mid2, lo2, t.g <= lo + EPS), hi2, t.g >= hi - EPS);
  o.b = select(select(mid2, lo2, t.b <= lo + EPS), hi2, t.b >= hi - EPS);
  return o;
}

/**
 * Weighted standard: the per-channel result, pulled back toward the film-like
 * one in proportion to how saturated the pixel is. Keeps most of the punch of a
 * standard curve while cutting the hue drift it causes in strong colour.
 */
fn weighted(t: vec3f) -> vec3f {
  let hi = max(max(t.r, t.g), t.b);
  let lo = min(min(t.r, t.g), t.b);
  var sat: f32;
  if (hi > EPS) {
    sat = (hi - lo) / hi;
  } else {
    sat = 0.0;
  }
  return mix(standard(t), filmLike(t), vec3f(clamp(sat, 0.0, 1.0) * 0.65));
}

/** Value in HSV, with saturation compensated — colour stays as vivid. */
fn satAndValue(t: vec3f) -> vec3f {
  var hsv = rgb2hsv(clamp(t, vec3f(0.0), vec3f(1.0)));
  let v2 = lutA(hsv.z);
  // A brightened pixel would otherwise wash out; scale saturation to keep the
  // same distance from the achromatic axis.
  var scale: f32;
  if (v2 > EPS) {
    scale = hsv.z / v2;
  } else {
    scale = 1.0;
  }
  hsv.y = clamp(hsv.y * scale, 0.0, 1.0);
  hsv.z = v2;
  return hsv2rgb(hsv);
}

/**
 * Perceptual: luminance is curved, then saturation is corrected by the local
 * slope of the curve. Where the curve steepens, apparent chroma rises with it,
 * so it is scaled back down — and lifted again in the compressed regions.
 */
fn perceptual(t: vec3f) -> vec3f {
  let L = luma(t);
  let L2 = lutA(L);
  let h = 1.0 / 48.0;
  let a = max(L - h, 0.0);
  let b = min(L + h, 1.0);
  let slope = (lutA(b) - lutA(a)) / max(b - a, EPS);

  let c = applyLumaRatio(t, L, L2);
  var hsv = rgb2hsv(clamp(c, vec3f(0.0), vec3f(1.0)));
  hsv.y = clamp(hsv.y * pow(max(slope, 0.05), -0.4), 0.0, 1.0);
  return hsv2rgb(hsv);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let src = textureSampleLevel(uImage, sampLin, uv, 0.0);
  var t = clamp(encode(src.rgb), vec3f(0.0), vec3f(1.0));

  if (u.uHasRgb > 0.5) {
    if (u.uMode < 0.5) {
      t = standard(t);
    } else if (u.uMode < 1.5) {
      t = weighted(t);
    } else if (u.uMode < 2.5) {
      t = filmLike(t);
    } else if (u.uMode < 3.5) {
      t = satAndValue(t);
    } else if (u.uMode < 4.5) {
      t = luminanceMode(t);
    } else {
      t = perceptual(t);
    }
    t = clamp(t, vec3f(0.0), vec3f(1.0));
  }
  if (u.uHasChannels > 0.5) {
    t = vec3f(
      textureSampleLevel(uLut, sampLin, vec2f(t.r, 0.5), 0.0).r,
      textureSampleLevel(uLut, sampLin, vec2f(t.g, 0.5), 0.0).g,
      textureSampleLevel(uLut, sampLin, vec2f(t.b, 0.5), 0.0).b
    );
  }

  return vec4f(decode(clamp(t, vec3f(0.0), vec3f(1.0))), src.a);
}
`
