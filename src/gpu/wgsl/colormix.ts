import { COMMON } from './common'

/**
 * Colour Mixer — eight hue bands, each with hue / saturation / luminance.
 *
 * Bands blend with a smoothstep partition of unity between adjacent centres,
 * which is what stops the banding you get from independent Gaussian weights.
 * Low-saturation pixels are excluded so the sky's hue shift doesn't drag grey
 * concrete with it.
 */
export const COLORMIX_FS = /* wgsl */ `
${COMMON}

struct U {
  // Scalar per element; see the note in BW_FS about the 16-byte stride
  // WGSL requires of uniform arrays.
  uHue: array<vec4f, 8>,
  uSat: array<vec4f, 8>,
  uLum: array<vec4f, 8>,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let src = textureSampleLevel(uImage, sampLin, uv, 0.0);
  let t = clamp(encode(src.rgb), vec3f(0.0), vec3f(1.0));
  var hsv = rgb2hsv(t);

  let h = hsv.x;
  var dh = 0.0;
  var ds = 0.0;
  var dl = 0.0;

  // Red, Orange, Yellow, Green, Aqua, Blue, Purple, Magenta — in turns.
  let CENTERS = array<f32, 9>(
    0.0, 0.0833333, 0.1666667, 0.3333333, 0.5, 0.6666667, 0.7777778, 0.8888889, 1.0
  );

  for (var i = 0; i < 8; i = i + 1) {
    let a = CENTERS[i];
    let b = CENTERS[i + 1];
    if (h >= a && h <= b) {
      var f = (h - a) / max(b - a, EPS);
      f = f * f * (3.0 - 2.0 * f);
      let j = select(i + 1, 0, i + 1 == 8);
      dh = mix(u.uHue[i].x, u.uHue[j].x, f);
      ds = mix(u.uSat[i].x, u.uSat[j].x, f);
      dl = mix(u.uLum[i].x, u.uLum[j].x, f);
      break;
    }
  }

  // Neutral pixels have meaningless hue; fade the whole effect out there.
  let gate = smoothstep(0.015, 0.10, hsv.y) * smoothstep(0.003, 0.04, hsv.z);
  dh = dh * gate;
  ds = ds * gate;
  dl = dl * gate;

  hsv.x = fract(hsv.x + dh * 0.0833333 + 1.0);
  hsv.y = clamp(hsv.y * (1.0 + ds * 1.1), 0.0, 1.0);
  hsv.z = clamp(hsv.z * exp2(dl * 0.85), 0.0, 1.0);

  return vec4f(decode(hsv2rgb(hsv)), src.a);
}
`

/**
 * Black & white conversion with an eight-band channel mixer.
 *
 * A straight luminance conversion throws away the one thing that made the scene
 * legible in colour: a red barn and green grass of equal luminance become the
 * same grey. The mixer restores that separation by scaling each pixel's grey
 * value according to its hue, which is what the photographer's coloured filter
 * did on film — a red filter darkens the sky, an orange one lifts skin.
 *
 * The weighting only applies to saturated pixels; neutrals have no meaningful
 * hue and must not drift.
 */
export const BW_FS = /* wgsl */ `
${COMMON}

struct U {
  // One scalar per element: WGSL requires a uniform array stride of at
  // least 16 bytes, so the band gain lives in .x and the rest is padding.
  uMix: array<vec4f, 8>,  // -1..1 per band
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let src = textureSampleLevel(uImage, sampLin, uv, 0.0);
  let t = clamp(encode(src.rgb), vec3f(0.0), vec3f(1.0));
  let hsv = rgb2hsv(t);

  let h = hsv.x;
  var w = 0.0;

  let BW_CENTERS = array<f32, 9>(
    0.0, 0.0833333, 0.1666667, 0.3333333, 0.5, 0.6666667, 0.7777778, 0.8888889, 1.0
  );

  for (var i = 0; i < 8; i = i + 1) {
    let a = BW_CENTERS[i];
    let b = BW_CENTERS[i + 1];
    if (h >= a && h <= b) {
      var f = (h - a) / max(b - a, EPS);
      f = f * f * (3.0 - 2.0 * f);
      let j = select(i + 1, 0, i + 1 == 8);
      w = mix(u.uMix[i].x, u.uMix[j].x, f);
      break;
    }
  }

  let grey = clamp(luma(t), 0.0, 1.0);
  // Saturation decides how much a hue-driven weight is allowed to say.
  let g = clamp(grey * exp2(w * hsv.y * 1.1), 0.0, 1.0);

  return vec4f(decode(vec3f(g)), src.a);
}
`
