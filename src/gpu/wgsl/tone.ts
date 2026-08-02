import { COMMON } from './common'

/**
 * Highlight reconstruction, applied to decoded scene data before the user's
 * white-balance delta. LibRaw has already applied the camera's as-shot balance.
 *
 * A raw file usually keeps one or two channels below saturation after the
 * brightest one has pegged, which is why blown skies drift magenta: the red and
 * blue channels are still climbing while green has stopped. Both non-trivial
 * modes work from that observation.
 *
 *   blend      pull the clipped channels up toward the highest one, so the
 *              highlight desaturates to neutral instead of taking on the hue of
 *              whichever channel clipped last.
 *   propagate  read the hue of the surrounding, unclipped neighbourhood from a
 *              blurred copy and paint it back over the clipped area at full
 *              brightness — colour propagation.
 */
export const RECOVER_FS = /* wgsl */ `
${COMMON}

struct U {
  uMode: f32,       // 1 clip, 2 blend, 3 propagate
  uThreshold: f32,  // fraction of the decoded saturation ceiling
  uWhiteLevel: f32, // working-space value at decoder saturation
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;
@group(0) @binding(4) var uBlur: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let src = textureSampleLevel(uImage, sampLin, uv, 0.0);
  let c = max(src.rgb, vec3f(0.0));

  let white = max(u.uWhiteLevel, EPS);
  let t = white * clamp(u.uThreshold, 0.05, 0.995);
  let mx = max(max(c.r, c.g), c.b);

  if (u.uMode < 1.5) {
    // Clip: hard-limit at the saturation point. Predictable, never invents data.
    return vec4f(min(c, vec3f(white)), src.a);
  }

  // How far into the clipped region this pixel sits.
  let over = smoothstep(t, white, mx);
  if (over <= 0.0) {
    return src;
  }

  var recovered: vec3f;
  if (u.uMode < 2.5) {
    // Blend: each channel is lifted toward the brightest one in proportion to
    // how badly it is clipped, which converges on neutral at full clipping.
    let lift = smoothstep(vec3f(t), vec3f(white), c);
    recovered = mix(c, vec3f(min(mx, white)), lift * over);
  } else {
    // Propagate: normalise the neighbourhood colour and rescale it to this
    // pixel's brightness, so texture survives while hue comes from around it.
    let nb = max(textureSampleLevel(uBlur, sampLin, uv, 0.0).rgb, vec3f(0.0));
    let nbMax = max(max(nb.r, nb.g), max(nb.b, EPS));
    var ratio = nb / nbMax;
    // A neighbourhood that is itself blown carries no usable hue; fall back to
    // neutral rather than propagating the same magenta cast outward.
    let trust = 1.0 - smoothstep(t * 0.9, white, nbMax);
    ratio = mix(vec3f(1.0), ratio, vec3f(trust));
    recovered = mix(c, ratio * min(mx, white), vec3f(over));
  }

  return vec4f(recovered, src.a);
}
`

/**
 * Shadows/Highlights and Dynamic Range Compression.
 *
 * Both are local operators: the correction is driven by a blurred copy of the
 * image rather than the pixel itself, so a bright face against a bright sky can
 * be treated differently from a bright sky alone. That is also where halos come
 * from, so the base/detail split is explicit — the base is what gets compressed
 * and the detail is added back at whatever strength the user asked for.
 */
export const TONEMAP_FS = /* wgsl */ `
${COMMON}

struct U {
  uHighlights: f32,  // 0..1
  uShadows: f32,     // 0..1
  uWidth: f32,       // 0.1..1, tonal reach
  uDrc: f32,         // 0..1
  uDrcDetail: f32,   // 0..1
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;
@group(0) @binding(4) var uBlur: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let src = textureSampleLevel(uImage, sampLin, uv, 0.0);
  var t = clamp(encode(src.rgb), vec3f(0.0), vec3f(1.0));
  let L = clamp(luma(t), 0.0, 1.0);

  let blurT = clamp(encode(max(textureSampleLevel(uBlur, sampLin, uv, 0.0).rgb, vec3f(0.0))), vec3f(0.0), vec3f(1.0));
  let base = clamp(luma(blurT), 0.0, 1.0);

  var out_ = L;

  // --- Shadows / Highlights -------------------------------------------------
  // Masks read the *local mean*, which is what makes this different from the
  // global Highlights slider in Basic.
  let w = max(u.uWidth, 0.1);
  if (u.uHighlights > 0.0) {
    let mask = pow(clamp(base, 0.0, 1.0), 1.0 / w);
    // Darkening is applied as a ratio against the base so local contrast is
    // preserved: the whole neighbourhood moves together.
    let tgt = base * (1.0 - 0.75 * u.uHighlights * mask);
    out_ = out_ + (tgt - base) * smoothstep(0.0, 0.12, L);
  }
  if (u.uShadows > 0.0) {
    let mask = pow(clamp(1.0 - base, 0.0, 1.0), 1.0 / w);
    let tgt = base + (1.0 - base) * 0.62 * u.uShadows * mask;
    out_ = out_ + (tgt - base) * (1.0 - smoothstep(0.88, 1.0, L));
  }

  // --- Dynamic range compression -------------------------------------------
  if (u.uDrc > 0.0) {
    // Compress the base toward mid grey in log space, then re-add the detail
    // the compression would otherwise have flattened.
    let detail = out_ - base;
    let lb = log2(max(base, 1.0 / 512.0));
    let mid = log2(0.4);
    let compressed = exp2(mix(lb, mid + (lb - mid) * 0.35, u.uDrc));
    out_ = compressed + detail * (0.35 + 0.65 * u.uDrcDetail + u.uDrc * u.uDrcDetail * 0.6);
  }

  out_ = clamp(out_, 0.0, 1.0);
  t = applyLumaRatio(t, L, out_);
  return vec4f(decode(clamp(t, vec3f(0.0), vec3f(1.0))), src.a);
}
`

/**
 * Contrast by detail levels.
 *
 * A four-octave Laplacian split of luminance: each band is the difference
 * between two successive blurs, so boosting the finest band sharpens texture
 * while boosting the coarsest one acts like a very wide clarity. The threshold
 * softens small differences toward zero so noise is not amplified along with
 * the detail.
 */
export const DETAILBANDS_FS = /* wgsl */ `
${COMMON}

struct U {
  uGain: vec4f,    // finest .. coarsest, -1..1
  uThresh: f32,    // 0..1 noise floor
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;
@group(0) @binding(4) var uL0: texture_2d<f32>;
@group(0) @binding(5) var uL1: texture_2d<f32>;
@group(0) @binding(6) var uL2: texture_2d<f32>;
@group(0) @binding(7) var uL3: texture_2d<f32>;

/** Soft-knee gate: leaves large detail alone, fades small detail out. */
fn gate(d: f32, k: f32) -> f32 {
  if (k <= 0.0) { return d; }
  let a = abs(d);
  return d * smoothstep(0.0, k, a);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let src = textureSampleLevel(uImage, sampLin, uv, 0.0);
  var t = clamp(encode(src.rgb), vec3f(0.0), vec3f(1.0));
  let L = clamp(luma(t), 0.0, 1.0);

  let y0 = clamp(luma(clamp(encode(max(textureSampleLevel(uL0, sampLin, uv, 0.0).rgb, vec3f(0.0))), vec3f(0.0), vec3f(1.0))), 0.0, 1.0);
  let y1 = clamp(luma(clamp(encode(max(textureSampleLevel(uL1, sampLin, uv, 0.0).rgb, vec3f(0.0))), vec3f(0.0), vec3f(1.0))), 0.0, 1.0);
  let y2 = clamp(luma(clamp(encode(max(textureSampleLevel(uL2, sampLin, uv, 0.0).rgb, vec3f(0.0))), vec3f(0.0), vec3f(1.0))), 0.0, 1.0);
  let y3 = clamp(luma(clamp(encode(max(textureSampleLevel(uL3, sampLin, uv, 0.0).rgb, vec3f(0.0))), vec3f(0.0), vec3f(1.0))), 0.0, 1.0);

  let k = u.uThresh * 0.08;
  let d0 = gate(L - y0, k);
  let d1 = gate(y0 - y1, k * 0.6);
  let d2 = y1 - y2;
  let d3 = y2 - y3;

  var out_ = y3
    + d0 * (1.0 + u.uGain.x)
    + d1 * (1.0 + u.uGain.y)
    + d2 * (1.0 + u.uGain.z)
    + d3 * (1.0 + u.uGain.w);

  out_ = clamp(out_, 0.0, 1.0);
  t = applyLumaRatio(t, L, out_);
  return vec4f(decode(clamp(t, vec3f(0.0), vec3f(1.0))), src.a);
}
`
