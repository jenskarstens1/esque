/**
 * Shared WGSL. Every pass prepends `COMMON` so the colour helpers, tone
 * primitives and the working-space transfer functions are defined once.
 *
 * Working space: linear ProPhoto RGB (D50).
 * Tone space ("Melissa RGB"): ProPhoto primaries with the sRGB transfer curve —
 * the space Lightroom's tone controls and histogram actually operate in.
 *
 * Translation notes for the rest of the pipeline, since WGSL is stricter than
 * GLSL in ways that fail silently if you are not looking for them:
 *
 * - Function parameters are immutable. GLSL's habit of reassigning an argument
 *   (`x = max(x, 0.0)`) becomes a `let` under a new name.
 * - `select(f, t, cond)` takes the *false* value first. Reading it as a ternary
 *   left to right inverts every branch in the file.
 * - `select` is a function, not a short-circuit, so both arms are evaluated;
 *   an arm that can produce NaN has to be guarded rather than relied upon.
 * - Mixed scalar/vector arguments are rejected: `clamp(v, 0.0, 1.0)` on a
 *   vector must spell out `clamp(v, vec3f(0.0), vec3f(1.0))`.
 * - GLSL `mod(x, y)` floors; WGSL `%` truncates. They differ for negatives, so
 *   `glslMod` below is used wherever the sign is not known to be positive.
 */

export const COMMON = /* wgsl */ `
const EPS: f32 = 1e-6;

// ProPhoto luminance weights (from the D50 primaries' Y row).
const LUMA = vec3f(0.2880402, 0.7118741, 0.0000857);

fn luma(c: vec3f) -> f32 { return dot(c, LUMA); }

/** GLSL's floored modulus, which differs from WGSL's truncated '%'. */
fn glslMod(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }

// --- Working-space transfer -------------------------------------------------
// sRGB transfer applied to ProPhoto primaries. Encodes linear -> tone space.

fn encode1(x0: f32) -> f32 {
  let x = max(x0, 0.0);
  return select(1.055 * pow(x, 1.0 / 2.4) - 0.055, x * 12.92, x <= 0.0031308);
}
fn decode1(x0: f32) -> f32 {
  let x = max(x0, 0.0);
  return select(pow((x + 0.055) / 1.055, 2.4), x / 12.92, x <= 0.04045);
}
fn encode(c: vec3f) -> vec3f { return vec3f(encode1(c.r), encode1(c.g), encode1(c.b)); }
fn decode(c: vec3f) -> vec3f { return vec3f(decode1(c.r), decode1(c.g), decode1(c.b)); }

// --- Colour conversions -----------------------------------------------------

fn rgb2hsv(c: vec3f) -> vec3f {
  let K = vec4f(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  let p = mix(vec4f(c.bg, K.wz), vec4f(c.gb, K.xy), vec4f(step(c.b, c.g)));
  let q = mix(vec4f(p.xyw, c.r), vec4f(c.r, p.yzx), vec4f(step(p.x, c.r)));
  let d = q.x - min(q.w, q.y);
  return vec3f(abs(q.z + (q.w - q.y) / (6.0 * d + EPS)), d / (q.x + EPS), q.x);
}

fn hsv2rgb(c: vec3f) -> vec3f {
  let K = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  let p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, vec3f(0.0), vec3f(1.0)), vec3f(c.y));
}

// --- Tone primitives --------------------------------------------------------

/**
 * Monotonic contrast around 0.5. Positive uses smoothstep, negative its exact
 * inverse, so contrast(-c) undoes contrast(+c) and nothing ever clips.
 */
fn contrastCurve(x0: f32, c: f32) -> f32 {
  let x = clamp(x0, 0.0, 1.0);
  if (abs(c) < 1e-5) { return x; }
  let s = select(
    0.5 - sin(asin(clamp(1.0 - 2.0 * x, -1.0, 1.0)) / 3.0),
    x * x * (3.0 - 2.0 * x),
    c > 0.0);
  return mix(x, s, min(abs(c), 1.0));
}

/** Smooth highlight shoulder so blown values roll off instead of hard-clipping. */
fn shoulder(x: f32, knee: f32) -> f32 {
  if (x <= knee) { return x; }
  let over = x - knee;
  let range = max(1.0 - knee, EPS);
  return knee + range * (1.0 - exp(-over / range));
}
fn shoulder3(c: vec3f, knee: f32) -> vec3f {
  return vec3f(shoulder(c.r, knee), shoulder(c.g, knee), shoulder(c.b, knee));
}

/**
 * The profile base curve: a filmic S applied in tone space, standing in for the
 * contrast a camera profile bakes into a RAW rendering. The strength k is the
 * profile's own contrast: at 0 this is the identity, the Neutral rendering.
 *
 * The sine term is *subtracted*. Added, it lifts the quarter tone and pulls the
 * three-quarter tone down — an inverted S that flattens the picture and lifts
 * blacks off zero, so the more contrast a profile asked for the less it got.
 */
fn baseCurve(x0: f32, k: f32) -> f32 {
  let x = clamp(x0, 0.0, 1.0);
  // Anchored at 0, 0.5 and 1; steepest through the midtones, flat at the ends.
  return x - k * sin(6.2831853 * x) * (0.5 - abs(x - 0.5)) * 0.5;
}

/** Applies a scalar transform to RGB while keeping hue and saturation stable. */
fn applyLumaRatio(c: vec3f, lIn: f32, lOut: f32) -> vec3f {
  return c * (lOut / max(lIn, EPS));
}

/** Gaussian weight used for the tonal region masks. */
fn region(x: f32, center: f32, width: f32) -> f32 {
  let t = (x - center) / width;
  return exp(-t * t);
}

// --- Dithering --------------------------------------------------------------

/** Interleaved gradient noise: cheap, stable, and free of visible structure. */
fn ign(p: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}
`
