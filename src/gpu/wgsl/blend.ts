/**
 * Layer blend modes.
 *
 * The twelve separable modes are the W3C compositing set — the same formulas
 * Photoshop, GIMP and Affinity implement — evaluated per channel. The four
 * non-separable modes at the end swap luminosity or chroma wholesale between
 * the backdrop and the layer, which needs all three channels at once.
 *
 * Everything here runs in *tone space*, not linear light. That is deliberate:
 * `overlay`, `softLight`, `hardLight` and the two dodge/burn modes all pivot
 * around a mid grey of 0.5, and 0.5 in linear light is not the middle of
 * anything a person can see. Blending a 50% grey layer in `overlay` onto its
 * own backdrop has to leave the picture alone, and only the encoded space does
 * that. The caller encodes once, blends, and decodes on the way out.
 *
 * Luminosity uses the pipeline's ProPhoto weights rather than the sRGB ones in
 * the spec, because that is what the rest of the graph means by brightness.
 */

export const BLEND_MODE_INDEX = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  colorDodge: 6,
  colorBurn: 7,
  hardLight: 8,
  softLight: 9,
  difference: 10,
  exclusion: 11,
  hue: 12,
  saturation: 13,
  color: 14,
  luminosity: 15,
} as const

/** Requires `COMMON` (for `luma`) to have been prepended already. */
export const BLEND = /* wgsl */ `
fn blendHardLight1(b: f32, s: f32) -> f32 {
  if (s <= 0.5) { return 2.0 * b * s; }
  return 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
}

fn blendSoftLight1(b: f32, s: f32) -> f32 {
  // The W3C 'D(b)' auxiliary: a gentler curve below a quarter tone, so the
  // shadows don't posterise the way a naive sqrt does.
  let d = select((((16.0 * b - 12.0) * b + 4.0) * b), sqrt(max(b, 0.0)), b > 0.25);
  if (s <= 0.5) { return b - (1.0 - 2.0 * s) * b * (1.0 - b); }
  return b + (2.0 * s - 1.0) * (d - b);
}

fn blendSeparable1(mode: i32, b: f32, s: f32) -> f32 {
  switch (mode) {
    case 1: { return b * s; }
    case 2: { return b + s - b * s; }
    case 3: { return blendHardLight1(s, b); }
    case 4: { return min(b, s); }
    case 5: { return max(b, s); }
    case 6: {
      // Dodge and burn divide, so both guard the degenerate end explicitly
      // rather than trusting a division that would produce inf or NaN.
      if (b <= 0.0) { return 0.0; }
      if (s >= 1.0) { return 1.0; }
      return min(1.0, b / (1.0 - s));
    }
    case 7: {
      if (b >= 1.0) { return 1.0; }
      if (s <= 0.0) { return 0.0; }
      return 1.0 - min(1.0, (1.0 - b) / s);
    }
    case 8: { return blendHardLight1(b, s); }
    case 9: { return blendSoftLight1(b, s); }
    case 10: { return abs(b - s); }
    case 11: { return b + s - 2.0 * b * s; }
    default: { return s; }
  }
}

/** Re-anchors a colour on a new luminosity, pulling it back into gamut. */
fn blendSetLum(c: vec3f, l: f32) -> vec3f {
  let shifted = c + vec3f(l - luma(c));
  let lum = luma(shifted);
  let lo = min(min(shifted.r, shifted.g), shifted.b);
  let hi = max(max(shifted.r, shifted.g), shifted.b);
  var out = shifted;
  if (lo < 0.0) { out = lum + (out - lum) * lum / max(lum - lo, EPS); }
  if (hi > 1.0) { out = lum + (out - lum) * (1.0 - lum) / max(hi - lum, EPS); }
  return out;
}

fn blendSat(c: vec3f) -> f32 {
  return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
}

/** Rescales a colour's chroma to s while keeping which channel is brightest. */
fn blendSetSat(c: vec3f, s: f32) -> vec3f {
  let lo = min(min(c.r, c.g), c.b);
  let hi = max(max(c.r, c.g), c.b);
  if (hi <= lo) { return vec3f(0.0); }
  return (c - lo) * s / (hi - lo);
}

fn blendNonSeparable(mode: i32, b: vec3f, s: vec3f) -> vec3f {
  switch (mode) {
    case 12: { return blendSetLum(blendSetSat(s, blendSat(b)), luma(b)); }
    case 13: { return blendSetLum(blendSetSat(b, blendSat(s)), luma(b)); }
    case 14: { return blendSetLum(s, luma(b)); }
    case 15: { return blendSetLum(b, luma(s)); }
    default: { return s; }
  }
}

/** b is the backdrop, s the layer, both in tone space. */
fn blendMode(mode: i32, b: vec3f, s: vec3f) -> vec3f {
  if (mode <= 0) { return s; }
  if (mode >= 12) { return blendNonSeparable(mode, b, s); }
  return vec3f(
    blendSeparable1(mode, b.r, s.r),
    blendSeparable1(mode, b.g, s.g),
    blendSeparable1(mode, b.b, s.b),
  );
}
`
