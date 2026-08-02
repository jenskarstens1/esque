import { COMMON } from './common'

/**
 * Effects — post-crop vignette and film grain.
 *
 * The vignette is elliptical with independent roundness and feather, and its
 * `highlights` control lets bright areas punch back through the darkening, the
 * way an optical vignette behaves.
 *
 * Grain is value noise at a controllable scale, applied in tone space and
 * weighted toward the midtones so it doesn't speckle blacks or clip whites.
 */
export const EFFECTS_FS = /* wgsl */ `
${COMMON}

struct U {
  uVignette: f32,           // -1..1
  uMidpoint: f32,           // 0..1
  uRoundness: f32,          // -1..1
  uFeather: f32,            // 0..1
  uVignetteHighlights: f32, // 0..1
  uGrain: f32,              // 0..1
  uGrainSize: f32,          // 0..1
  uGrainRough: f32,         // 0..1
  uResolution: vec2f,
  uSeed: f32,
  uFrameOffset: vec2f,
  uFrameScale: vec2f,
};

// uResolution: size of the whole frame, not of the tile being drawn.
// uFrameOffset / uFrameScale: where this draw sits inside the full frame, so a
// tiled export produces the same vignette and grain as a single-shot render.
// Identity is (0,0)/(1,1).

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;

fn hash(p0: vec2f) -> f32 {
  var p = fract(p0 * vec2f(443.8975, 397.2973));
  p = p + dot(p, p + 19.19);
  return fract(p.x * p.y);
}

fn valueNoise(p: vec2f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  let a = hash(i);
  let b = hash(i + vec2f(1.0, 0.0));
  let c = hash(i + vec2f(0.0, 1.0));
  let d = hash(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let src = textureSampleLevel(uImage, sampLin, uv, 0.0);
  var t = clamp(encode(src.rgb), vec3f(0.0), vec3f(1.0));
  let fUv = u.uFrameOffset + uv * u.uFrameScale;

  // --- Vignette -------------------------------------------------------------
  if (abs(u.uVignette) > 1e-4) {
    var p = (fUv - 0.5) * 2.0;
    let aspect = u.uResolution.x / max(u.uResolution.y, 1.0);
    // Roundness blends between a circle in image space and one that follows
    // the frame's aspect ratio.
    let k = mix(1.0, aspect, clamp(u.uRoundness * 0.5 + 0.5, 0.0, 1.0));
    p.x = p.x * (aspect / max(k, EPS));

    let d = length(p);
    let mid = mix(0.35, 1.55, clamp(u.uMidpoint, 0.0, 1.0));
    let feather = mix(0.02, 0.9, clamp(u.uFeather, 0.0, 1.0));
    let v = smoothstep(mid - feather, mid + feather, d);

    let L = luma(t);
    // Highlights slider lets bright detail resist the darkening.
    let protect = mix(0.0, smoothstep(0.55, 1.0, L), clamp(u.uVignetteHighlights, 0.0, 1.0));
    let amount = u.uVignette * v * (1.0 - protect);

    let tgt = select(
      L + (1.0 - L) * amount * 0.85,
      L * (1.0 + amount),
      u.uVignette < 0.0);
    t = applyLumaRatio(t, L, clamp(tgt, 0.0, 1.0));
  }

  // --- Grain ----------------------------------------------------------------
  if (u.uGrain > 1e-4) {
    let scale = mix(2.4, 0.45, clamp(u.uGrainSize, 0.0, 1.0));
    let gp = fUv * u.uResolution * scale * 0.5 + u.uSeed;
    var n = valueNoise(gp);
    // Roughness mixes in a second octave to break up the regular structure.
    n = mix(n, n * 0.55 + valueNoise(gp * 2.7 + 31.4) * 0.45, clamp(u.uGrainRough, 0.0, 1.0));
    n = n * 2.0 - 1.0;

    let L = luma(t);
    // Midtone weighting: grain is invisible in true black and clipped white.
    let w = 1.0 - pow(abs(L * 2.0 - 1.0), 2.0);
    t = clamp(t + n * u.uGrain * 0.16 * w, vec3f(0.0), vec3f(1.0));
  }

  return vec4f(decode(t), src.a);
}
`
