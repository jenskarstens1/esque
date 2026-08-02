import { COMMON } from './common'

/**
 * Texture, Clarity and Dehaze — the three local-contrast controls.
 *
 * All three are unsharp-mask variants measured against blurred references at
 * different scales: Texture works on fine detail, Clarity on midtone structure,
 * Dehaze on the low-frequency veil plus a saturation and black-point recovery.
 *
 * Clarity and Dehaze are midtone-weighted so they don't blow out highlights or
 * crush shadows, which is what keeps them usable at extreme settings.
 */
export const LOCAL_FS = /* wgsl */ `
${COMMON}

struct U {
  uTexture: f32,  // -1..1
  uClarity: f32,  // -1..1
  uDehaze: f32,   // -1..1
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;
@group(0) @binding(4) var uFine: texture_2d<f32>;    // small-radius blur
@group(0) @binding(5) var uCoarse: texture_2d<f32>;  // large-radius blur

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let src = textureSampleLevel(uImage, sampLin, uv, 0.0);
  var t = encode(src.rgb);
  let fine = encode(max(textureSampleLevel(uFine, sampLin, uv, 0.0).rgb, vec3f(0.0)));
  let coarse = encode(max(textureSampleLevel(uCoarse, sampLin, uv, 0.0).rgb, vec3f(0.0)));

  let L = clamp(luma(t), 0.0, 1.0);
  // Bell centred on the midtones; keeps local contrast off the extremes.
  let mid = 1.0 - pow(abs(L * 2.0 - 1.0), 2.4);

  // --- Texture: fine detail only, no midtone weighting ----------------------
  if (abs(u.uTexture) > 1e-4) {
    var detail = t - fine;
    let amount = select(u.uTexture, u.uTexture * 1.6, u.uTexture > 0.0);
    // Soft-clip the detail signal so strong edges don't ring.
    detail = tanh(detail * 6.0) / 6.0;
    t += detail * amount;
  }

  // --- Clarity: midtone structure ------------------------------------------
  if (abs(u.uClarity) > 1e-4) {
    let lc = luma(t) - luma(coarse);
    let amount = u.uClarity * select(0.85, 1.25, u.uClarity > 0.0) * mid;
    let shaped = tanh(lc * 4.0) / 4.0;
    let Lin = clamp(luma(t), 0.0, 1.0);
    t = applyLumaRatio(t, Lin, clamp(Lin + shaped * amount, 0.0, 1.0));
  }

  // --- Dehaze: veil removal ------------------------------------------------
  if (abs(u.uDehaze) > 1e-4) {
    // The haze veil is the coarse scale's darkest channel: haze lifts blacks
    // uniformly, so the local minimum is a good estimate of how much to remove.
    let veil = min(min(coarse.r, coarse.g), coarse.b);
    let k = u.uDehaze * 0.55;
    // Subtract the veil and re-expand: negative amounts add haze instead.
    t = (t - veil * k) / max(1.0 - veil * k, 0.25);

    var hsv = rgb2hsv(clamp(t, vec3f(0.0), vec3f(1.0)));
    hsv.y = clamp(hsv.y * (1.0 + u.uDehaze * 0.35), 0.0, 1.0);
    t = hsv2rgb(hsv);
  }

  return vec4f(decode(clamp(t, vec3f(0.0), vec3f(1.0))), src.a);
}
`
