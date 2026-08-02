import { COMMON } from './common'

/**
 * Binding convention every pass in this directory follows:
 *
 *   @binding(0)  var<uniform> u: U       the struct the layout is read from
 *   @binding(1)  sampLin                 linear, clamp to edge
 *   @binding(2)  sampNear                nearest, clamp to edge  (only if used)
 *   @binding(3+) textures                in declaration order
 *
 * The sampler's *name* selects which shared sampler gets bound, so a pass that
 * wants point sampling declares `sampNear` and one that wants mip selection
 * declares `sampMip`. Textures are sampled with `textureSampleLevel(..., 0.0)`
 * because WGSL forbids automatic LOD under non-uniform control flow, and every
 * graph pass runs at a single resolution anyway; only the output pass, which
 * genuinely minifies, uses `textureSample`.
 */

/**
 * Scene preparation: the user white-balance delta and camera calibration.
 *
 * The decoded source is already scene-linear ProPhoto with its as-shot balance
 * applied. This pass only moves away from that recorded white and calibrates the
 * working primaries. It deliberately has no exposure or upper clamp, so capture
 * cleanup still sees all RAW headroom.
 */
export const SCENE_INPUT_FS = /* wgsl */ `
${COMMON}

struct U {
  uWbGain: vec3f,
  uShadowTint: f32,
  uCalibration: mat3x3f,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let src = textureSampleLevel(uImage, sampLin, uv, 0.0);
  var c = src.rgb * u.uWbGain;

  c = max(u.uCalibration * c, vec3f(0.0));
  if (abs(u.uShadowTint) > 1e-4) {
    let w = exp(-luma(c) * 7.0);
    c.g = c.g * (1.0 - u.uShadowTint * 0.14 * w);
  }

  return vec4f(max(c, vec3f(0.0)), src.a);
}
`

/**
 * Scene-to-display rendering.
 *
 * Exposure remains a scene-linear operation. The profile shoulder then maps the
 * scene peak into display range with one RGB scale, preserving highlight hue
 * instead of clipping each channel independently. The remaining controls work
 * in Melissa-style tone space and return bounded display-linear ProPhoto for the
 * creative and local stages.
 */
export const RENDER_FS = /* wgsl */ `
${COMMON}

struct U {
  uExposure: f32,      // stops
  uContrast: f32,      // -1..1
  uHighlights: f32,    // -1..1
  uShadows: f32,       // -1..1
  uWhites: f32,        // -1..1
  uBlacks: f32,        // -1..1
  uVibrance: f32,      // -1..1
  uSaturation: f32,    // -1..1
  uProtectSkin: f32,   // 0 or 1
  uAvoidShift: f32,    // 0 or 1
  uProfileCurve: f32,  // filmic S strength; 0 = flat
  uProfileSat: f32,    // saturation baked into the profile, -1..1
  uShoulder: f32,      // scene-linear highlight knee
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let src = textureSampleLevel(uImage, sampLin, uv, 0.0);
  var c = max(src.rgb, vec3f(0.0)) * exp2(u.uExposure);

  // A single scale preserves RGB ratios through the display shoulder. Applying
  // the curve per channel is what turns clipped skies magenta or cyan.
  let peak = max(max(c.r, c.g), c.b);
  if (peak > u.uShoulder) {
    let mapped = shoulder(peak, u.uShoulder);
    c = c * (mapped / max(peak, EPS));
  }

  var t = encode(c);

  if (u.uProfileCurve > 1e-4) {
    t = vec3f(
      baseCurve(t.r, u.uProfileCurve),
      baseCurve(t.g, u.uProfileCurve),
      baseCurve(t.b, u.uProfileCurve)
    );
  }

  // Tonal regions act on luminance and are re-applied as a ratio, so colour
  // stays put while brightness moves.
  let L = clamp(luma(t), 0.0, 1.0);
  var dL = 0.0;
  dL = dL + u.uShadows    * 0.30 * region(L, 0.26, 0.24) * smoothstep(0.0, 0.10, L);
  dL = dL + u.uHighlights * 0.30 * region(L, 0.74, 0.22) * (1.0 - smoothstep(0.94, 1.0, L));
  dL = dL + u.uBlacks     * 0.20 * pow(max(0.0, 1.0 - L / 0.42), 2.0);
  dL = dL + u.uWhites     * 0.20 * pow(max(0.0, (L - 0.55) / 0.45), 1.6);

  let L2 = clamp(L + dL, 0.0, 1.0);
  t = applyLumaRatio(t, L, L2);

  // Per-channel contrast gives the familiar film-like highlight desaturation.
  t = vec3f(
    contrastCurve(t.r, u.uContrast),
    contrastCurve(t.g, u.uContrast),
    contrastCurve(t.b, u.uContrast)
  );

  if (abs(u.uSaturation) > 1e-4 || abs(u.uVibrance) > 1e-4 || abs(u.uProfileSat) > 1e-4) {
    let Lsat = luma(t);
    var hsv = rgb2hsv(clamp(t, vec3f(0.0), vec3f(1.0)));
    var s = hsv.y;

    s = s * (1.0 + u.uProfileSat);

    var skin = 1.0 - 0.55 * exp(-pow((hsv.x - 0.055) / 0.055, 2.0));
    skin = mix(1.0, skin, u.uProtectSkin);
    let head = pow(1.0 - s, 1.5);
    s = s * (1.0 + u.uVibrance * head * skin * 0.95);

    s = s * select(1.0 + u.uSaturation, 1.0 + u.uSaturation * 1.35, u.uSaturation >= 0.0);
    hsv.y = clamp(s, 0.0, 1.0);
    t = hsv2rgb(hsv);

    if (u.uAvoidShift > 0.5) {
      t = clamp(applyLumaRatio(t, luma(t), Lsat), vec3f(0.0), vec3f(1.0));
    }
  }

  return vec4f(decode(clamp(t, vec3f(0.0), vec3f(1.0))), src.a);
}
`
