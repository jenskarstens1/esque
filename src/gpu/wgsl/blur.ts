import { COMMON } from './common'

/**
 * Separable Gaussian. Used to build the blurred references that clarity,
 * texture, dehaze and sharpening all measure themselves against.
 *
 * Nine taps with the linear-sampling trick, so it costs five fetches per pass
 * and still covers a ±4σ kernel.
 */
export const BLUR_FS = /* wgsl */ `
${COMMON}

struct U {
  uTexel: vec2f,      // 1 / texture size
  uDirection: vec2f,  // (1;0) or (0;1)
  uRadius: f32,       // sigma in texels
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  // Module-scope const arrays cannot be indexed by a runtime variable in WGSL,
  // so these live here as let bindings where indexing is unconstrained.
  let OFFSETS = array<f32, 3>(0.0, 1.3846153846, 3.2307692308);
  let WEIGHTS = array<f32, 3>(0.2270270270, 0.3162162162, 0.0702702703);
  let step = u.uDirection * u.uTexel * max(u.uRadius, 0.0001);
  var sum = textureSampleLevel(uImage, sampLin, uv, 0.0) * WEIGHTS[0];
  for (var i = 1; i < 3; i = i + 1) {
    let o = step * OFFSETS[i];
    sum = sum + textureSampleLevel(uImage, sampLin, uv + o, 0.0) * WEIGHTS[i];
    sum = sum + textureSampleLevel(uImage, sampLin, uv - o, 0.0) * WEIGHTS[i];
  }
  return sum;
}
`

/** Straight copy, used to seed downsampled chains. */
/**
 * Fills the target with opaque black.
 *
 * This exists because `loadOp: 'clear'` is not enough on its own. WebKit drops
 * a render pass that records no draw calls, load op and all, so the empty pass
 * that used to clear the canvas silently did nothing in Safari and every frame
 * showed the previous one through wherever the new one did not paint — the
 * gutter between compare panes, everything outside a clip. Chromium honoured
 * it, which is exactly what made it hard to see. A pass with a real draw in it
 * is not elided anywhere, and one fullscreen fill costs nothing measurable.
 */
export const CLEAR_FS = /* wgsl */ `
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(0.0, 0.0, 0.0, 1.0);
}
`

export const COPY_FS = /* wgsl */ `
${COMMON}

/** Sub-rect of the source to copy; defaults to the whole thing. */
struct U {
  uSrcOffset: vec2f,
  uSrcScale: vec2f,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(uImage, sampLin, u.uSrcOffset + uv * u.uSrcScale, 0.0);
}
`
