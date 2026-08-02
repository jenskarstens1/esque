import { COMMON } from './common'

/**
 * Retouching: spot heal / clone, and red-eye.
 *
 * Both run on the *sensor grid*, before geometry, because that is where the
 * blemish is: a spot placed on a face has to stay on the face when the photo
 * is later cropped or straightened. That also means a tiled export cannot run
 * them per tile — a heal source can sit anywhere in the frame — so they are
 * part of the framing stage, which sees the whole assembled image at once.
 */

/** Spots per pass. More than this and the list is split across passes. */
export const MAX_SPOTS = 32
/** Red-eye corrections per pass. */
export const MAX_EYES = 24

export const SPOT_MODE = { heal: 0, clone: 1 } as const
export const EYE_KIND = { human: 0, pet: 1 } as const

// ---------------------------------------------------------------------------
// Spot heal / clone
// ---------------------------------------------------------------------------

/**
 * Healing is approximated as `source detail + destination tone`.
 *
 * A real Photoshop-style heal solves a Poisson equation so the patch's
 * gradients are the source's and its boundary is the destination's. Sampling a
 * heavily blurred copy of the image gives the same effect to within a shade:
 * `src + (blur(dst) - blur(src))` keeps the source's high frequencies and
 * takes its low frequencies — its colour and brightness — from the hole being
 * filled, which is what makes a heal disappear where a clone would show a seam.
 */
export const SPOT_FS = /* wgsl */ `
${COMMON}

const MAX_SPOTS = ${MAX_SPOTS};

// uSpots[i]:  (tgt.xy, source.xy)
// uParams[i]: (radius, feather, opacity, mode)

struct U {
  uCount: f32,
  uAspect: vec2f,
  uSpots: array<vec4f, ${MAX_SPOTS}>,
  uParams: array<vec4f, ${MAX_SPOTS}>,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;
@group(0) @binding(4) var uBlur: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(uImage, sampLin, uv, 0.0);
  var rgb = base.rgb;

  for (var i = 0; i < MAX_SPOTS; i = i + 1) {
    if (f32(i) >= u.uCount) { break; }
    let tgt = u.uSpots[i].xy;
    let source = u.uSpots[i].zw;
    let radius = u.uParams[i].x;
    let feather = u.uParams[i].y;
    let opacity = u.uParams[i].z;
    let mode = u.uParams[i].w;

    let d = (uv - tgt) * u.uAspect;
    let r = length(d) / max(radius, 1e-4);
    if (r > 1.0) { continue; }

    // feather 0 still gets a pixel of softness, or the patch edge aliases.
    let inner = clamp(1.0 - feather, 0.0, 0.98);
    var w = 1.0 - smoothstep(inner, 1.0, r);
    w *= opacity;
    if (w <= 0.0) { continue; }

    let srcUv = uv - tgt + source;
    let src = textureSampleLevel(uImage, sampLin, srcUv, 0.0).rgb;
    var healed = src;
    if (mode < 0.5) {
      let lowDst = textureSampleLevel(uBlur, sampLin, uv, 0.0).rgb;
      let lowSrc = textureSampleLevel(uBlur, sampLin, srcUv, 0.0).rgb;
      healed = max(src + (lowDst - lowSrc), vec3f(0.0));
    }
    rgb = mix(rgb, healed, w);
  }

  return vec4f(rgb, base.a);
}
`

// ---------------------------------------------------------------------------
// Red-eye
// ---------------------------------------------------------------------------

/**
 * Flash reflection off a retina. In humans it comes back red; in animals the
 * tapetum sends back green, yellow or blue, so the pet case cannot key on hue
 * and desaturates whatever it finds instead.
 */
export const RED_EYE_FS = /* wgsl */ `
${COMMON}

const MAX_EYES = ${MAX_EYES};

// uEyes[i]: (center.xy, radius, darken)
// uMeta[i]: (kind, 0, 0, 0)

struct U {
  uCount: f32,
  uAspect: vec2f,
  uEyes: array<vec4f, ${MAX_EYES}>,
  uMeta: array<vec4f, ${MAX_EYES}>,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(uImage, sampLin, uv, 0.0);
  var rgb = base.rgb;

  for (var i = 0; i < MAX_EYES; i = i + 1) {
    if (f32(i) >= u.uCount) { break; }
    let center = u.uEyes[i].xy;
    let radius = u.uEyes[i].z;
    let darken = u.uEyes[i].w;
    let kind = u.uMeta[i].x;

    let d = (uv - center) * u.uAspect;
    let r = length(d) / max(radius, 1e-4);
    if (r > 1.0) { continue; }
    let w = 1.0 - smoothstep(0.55, 1.0, r);
    if (w <= 0.0) { continue; }

    let mx = max(rgb.r, max(rgb.g, rgb.b));
    let mn = min(rgb.r, min(rgb.g, rgb.b));
    var sat = 0.0;
    if (mx > 1e-5) { sat = (mx - mn) / mx; }
    var fixed_ = rgb;
    var hit: f32;

    if (kind < 0.5) {
      // Human: the pupil is the only strongly red thing inside the circle, so
      // keying on redness leaves eyelids and skin alone.
      let redness = rgb.r - max(rgb.g, rgb.b);
      hit = smoothstep(0.02, 0.16, redness) * smoothstep(0.15, 0.4, sat);
      let grey = (rgb.g + rgb.b) * 0.5;
      fixed_ = vec3f(grey, rgb.g, rgb.b);
    } else {
      // Pet: the tapetum sends back green, yellow or blue depending on the
      // animal, so there is no hue to key on. The circle the user drew is the
      // key; all this does is refuse to touch something already neutral.
      hit = smoothstep(0.05, 0.2, sat);
      fixed_ = vec3f(luma(rgb));
    }

    let amount = clamp(w * hit, 0.0, 1.0);
    if (amount <= 0.0) { continue; }
    fixed_ *= mix(1.0, clamp(1.0 - darken, 0.0, 1.0), amount);
    rgb = mix(rgb, fixed_, amount);
  }

  return vec4f(rgb, base.a);
}
`
