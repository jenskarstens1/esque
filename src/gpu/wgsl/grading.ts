import { COMMON } from './common'

/**
 * Colour Grading — four wheels (shadows, midtones, highlights, global) with
 * blending and balance.
 *
 * Each wheel becomes a luminance-normalised RGB multiplier, so tinting a range
 * shifts its colour without shifting its brightness. Blending widens the
 * overlap between ranges; balance slides the shadow/highlight split.
 */
export const GRADING_FS = /* wgsl */ `
${COMMON}

struct U {
  uShadow: vec3f,     // hue(turns);  sat 0..1;  lum -1..1
  uMidtone: vec3f,
  uHighlight: vec3f,
  uGlobal: vec3f,
  uBlending: f32,     // 0..1
  uBalance: f32,      // -1..1
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;

/** Pure hue at unit luminance: multiplying by it tints without darkening. */
fn tintMul(hue: f32, sat: f32) -> vec3f {
  if (sat < 1e-4) { return vec3f(1.0); }
  var c = hsv2rgb(vec3f(fract(hue), 1.0, 1.0));
  c = c / max(luma(c), EPS);
  return mix(vec3f(1.0), c, vec3f(sat));
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let src = textureSampleLevel(uImage, sampLin, uv, 0.0);
  var t = clamp(encode(src.rgb), vec3f(0.0), vec3f(1.0));

  let L = clamp(luma(t), 0.0, 1.0);

  // Balance slides the pivot; blending widens the overlap between ranges.
  let pivot = clamp(0.5 - u.uBalance * 0.26, 0.15, 0.85);
  let e = mix(3.0, 1.0, clamp(u.uBlending, 0.0, 1.0));

  let wS = pow(1.0 - smoothstep(0.0, pivot, L), e);
  let wH = pow(smoothstep(pivot, 1.0, L), e);
  // The three weights partition unity, so a pixel never gets more than one
  // wheel's worth of tint no matter how the ranges are configured.
  let wM = clamp(1.0 - wS - wH, 0.0, 1.0);

  var m = vec3f(1.0);
  m = m * mix(vec3f(1.0), tintMul(u.uShadow.x, u.uShadow.y * 0.55), vec3f(wS));
  m = m * mix(vec3f(1.0), tintMul(u.uMidtone.x, u.uMidtone.y * 0.55), vec3f(wM));
  m = m * mix(vec3f(1.0), tintMul(u.uHighlight.x, u.uHighlight.y * 0.55), vec3f(wH));
  m = m * tintMul(u.uGlobal.x, u.uGlobal.y * 0.55);

  let lum = u.uShadow.z * wS + u.uMidtone.z * wM + u.uHighlight.z * wH + u.uGlobal.z;

  t = t * m * exp2(lum * 0.6);

  return vec4f(decode(clamp(t, vec3f(0.0), vec3f(1.0))), src.a);
}
`
