import { COMMON } from './common'

/**
 * Geometry and optics, as one inverse map.
 *
 * Everything that moves a pixel rather than changing its colour happens here:
 * lens distortion, chromatic aberration, perspective, straightening, flips and
 * the crop. Doing it in a single pass matters — each resample softens the
 * image, so correcting a lens and then straightening as two passes costs twice
 * the detail of doing both at once.
 *
 * The map runs backwards. For each pixel of the *output* we ask which point of
 * the input it came from, which is the only direction that fills every output
 * pixel exactly once.
 *
 * Coordinates are centred and aspect-corrected, so a radius is a real circle
 * and a rotation does not shear.
 */
export const GEOMETRY_FS = /* wgsl */ `
${COMMON}

// uInAspect:      aspect of the source image, as (w,h) normalised to the longer side.
// uFrameAspect:   aspect of the straightened frame — the source's, with quarter turns applied.
//                 The crop rect is expressed in this frame, not in the sensor's.
// uCrop:          crop rect in the straightened frame, normalised 0..1 as (l,t,r,b).
// uAngle:         straighten plus transform rotation, in radians.
// uQuarter:       quarter turns, 0..3. Float because every uniform in this codebase is.
// uFlip:          -1 flips that axis.
// uPerspective:   keystone, as a shift of the homogeneous w per unit of x and y.
// uAspectStretch: non-uniform aspect stretch, >1 widens.
// uDistortion:    radial distortion coefficients, applied as r' = r (1 + k1*r2 + k2*r4).
// uCa:            per-channel radial scale for red and blue; green is the reference.
// uLensVignette:  lens vignetting correction; positive brightens the corners.
// uEdgeFill:      0 leaves the outside black, 1 mirrors the edge pixels into it.

struct U {
  uInAspect: vec2f,
  uFrameAspect: vec2f,
  uCrop: vec4f,
  uAngle: f32,
  uQuarter: f32,
  uFlip: vec2f,
  uPerspective: vec2f,
  uAspectStretch: vec2f,
  uScale: f32,
  uOffset: vec2f,
  uDistortion: vec2f,
  uCa: vec2f,
  uLensVignette: f32,
  uEdgeFill: f32,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sampLin: sampler;
@group(0) @binding(3) var uImage: texture_2d<f32>;

/** Longest half-diagonal in centred units — the radius normaliser. */
fn radiusNorm() -> f32 {
  return length(u.uInAspect * 0.5);
}

/** Output pixel to a point in the straightened, corrected frame. */
fn toFrame(uv: vec2f) -> vec2f {
  // The output *is* the crop rect, so the output's own 0..1 maps straight onto
  // the crop's corners. The output resolution already carries the crop's shape,
  // which is why no output aspect appears here.
  let t = u.uCrop.xy + uv * (u.uCrop.zw - u.uCrop.xy);
  return (t - 0.5) * u.uFrameAspect;
}

/** Straightened frame back to the raw sensor frame. */
fn toSource(p0: vec2f) -> vec2f {
  // Scale and offset are the last thing the user applies, so undo them first.
  var p = p0 / max(u.uScale, 1e-4) - u.uOffset * u.uInAspect;

  // Aspect stretch.
  p /= max(u.uAspectStretch, vec2f(1e-4));

  // Perspective. The forward map divides by w, so the inverse multiplies —
  // solved for the point whose projection lands on p.
  let w = 1.0 - dot(u.uPerspective, p);
  p /= max(w, 1e-3);

  // Rotation.
  let s = sin(-u.uAngle);
  let c = cos(-u.uAngle);
  p = vec2f(c * p.x - s * p.y, s * p.x + c * p.y);

  return p;
}

/** Undoes the lens's radial distortion for one channel's scale factor. */
fn undistort(p: vec2f, caScale: f32) -> vec2f {
  let rn = radiusNorm();
  let r2 = dot(p, p) / (rn * rn);
  let k = 1.0 + u.uDistortion.x * r2 + u.uDistortion.y * r2 * r2;
  return p * k * caScale;
}

/** Centred frame units back to a texture coordinate. */
fn toUv(p: vec2f) -> vec2f {
  return p / u.uInAspect + 0.5;
}

/** Samples with the chosen out-of-frame behaviour. */
fn sampleAt(uv: vec2f) -> vec3f {
  let clamped = clamp(uv, vec2f(0.0), vec2f(1.0));
  if (any(uv != clamped) && u.uEdgeFill < 0.5) { return vec3f(0.0); }
  return textureSampleLevel(uImage, sampLin, clamped, 0.0).rgb;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let frame = toFrame(uv);
  var p = toSource(frame);

  // Quarter turns and flips act on the sensor frame, so they come last on the
  // way in — a rotated photo straightens about its own centre, not the raw's.
  p *= u.uFlip;
  if (u.uQuarter > 2.5) { p = vec2f(-p.y, p.x); }
  else if (u.uQuarter > 1.5) { p = -p; }
  else if (u.uQuarter > 0.5) { p = vec2f(p.y, -p.x); }

  let pg = undistort(p, 1.0);
  var rgb: vec3f;
  if (u.uCa.x != 0.0 || u.uCa.y != 0.0) {
    // Lateral CA is a per-channel magnification, so each channel is fetched
    // from its own radius rather than the green one's.
    rgb = vec3f(
      sampleAt(toUv(undistort(p, 1.0 + u.uCa.x))).r,
      sampleAt(toUv(pg)).g,
      sampleAt(toUv(undistort(p, 1.0 + u.uCa.y))).b
    );
  } else {
    rgb = sampleAt(toUv(pg));
  }

  if (u.uLensVignette != 0.0) {
    // A lens falls off as cos⁴ of the field angle, so r⁴ is the shape to undo.
    // Positive lifts the corners; negative adds falloff back.
    let rn = radiusNorm();
    let r2 = dot(pg, pg) / (rn * rn);
    rgb *= 1.0 + u.uLensVignette * r2 * r2;
  }

  return vec4f(max(rgb, vec3f(0.0)), 1.0);
}
`
