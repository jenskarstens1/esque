import { defaultEdits } from '../core/defaults'
import type { CropAspect, Edits } from '../core/types'

/**
 * The geometry the renderer and the viewport have to agree on.
 *
 * Cropping changes the size and shape of the rendered image, so the layout
 * code cannot keep assuming the photo's own dimensions. Both sides derive that
 * from here rather than each doing their own arithmetic.
 */

/** Numerator/denominator for the fixed aspect presets. */
export const ASPECT_RATIOS: Partial<Record<CropAspect, [number, number]>> = {
  '1x1': [1, 1],
  '4x5': [4, 5],
  '5x7': [5, 7],
  '2x3': [2, 3],
  '4x3': [4, 3],
  '16x9': [16, 9],
  '3x1': [3, 1],
  '65x24': [65, 24],
}

export const ASPECT_LABELS: Record<CropAspect, string> = {
  free: 'Free',
  original: 'Original',
  '1x1': '1 × 1',
  '4x5': '4 × 5 / 8 × 10',
  '5x7': '5 × 7',
  '2x3': '2 × 3 / 4 × 6',
  '4x3': '4 × 3',
  '16x9': '16 × 9',
  '3x1': '3 × 1',
  '65x24': '65 × 24 (Xpan)',
}

/** True when the crop is doing nothing at all. */
export function isFullFrame(crop: Edits['crop']): boolean {
  return (
    crop.left <= 1e-6 &&
    crop.top <= 1e-6 &&
    crop.right >= 1 - 1e-6 &&
    crop.bottom >= 1 - 1e-6
  )
}

/** True when geometry would leave the pixels exactly where they are. */
export function isIdentityGeometry(edits: Edits): boolean {
  const { crop, transform, lens } = edits
  return (
    isFullFrame(crop) &&
    Math.abs(crop.angle) < 1e-4 &&
    crop.quarterTurns === 0 &&
    !crop.flipH &&
    !crop.flipV &&
    transform.vertical === 0 &&
    transform.horizontal === 0 &&
    transform.rotate === 0 &&
    transform.aspect === 0 &&
    transform.scale === 100 &&
    transform.offsetX === 0 &&
    transform.offsetY === 0 &&
    lens.distortion === 0 &&
    lens.caRed === 0 &&
    lens.caBlue === 0 &&
    lens.vignetting === 0
  )
}

/**
 * Splits the edits at the geometry boundary.
 *
 * The tiled export renders the colour graph one strip at a time, which only
 * works while every pass is local. Geometry moves pixels across the whole
 * frame and the post-crop vignette is defined on the cropped result, so those
 * two run once over the assembled image instead.
 */
export function splitAtGeometry(edits: Edits): { local: Edits; framing: Edits } {
  const base = structuredClone(edits)
  // The accumulator already contains graded pixels. Rendered defaults keep the
  // framing graph neutral instead of applying RAW denoise and sharpening again.
  const fresh = defaultEdits('rendered')
  // Masks are drawn on the framed photo, so their coordinates only mean
  // anything once the crop has been applied — they belong with the framing.
  const local: Edits = {
    ...base,
    crop: fresh.crop,
    transform: fresh.transform,
    effects: fresh.effects,
    masks: [],
    // Spots and red-eye read pixels from anywhere in the frame, so a tile has
    // no way to run them correctly; they move to the assembled stage.
    spots: [],
    redEye: [],
  }
  // Defringe and lens *profile* corrections are per-pixel colour work, so they
  // stay with the tiles; only the geometric part of the lens moves.
  local.lens = {
    ...base.lens,
    distortion: 0,
    vignetting: 0,
    caRed: 0,
    caBlue: 0,
  }
  const framing: Edits = {
    ...fresh,
    version: base.version,
    crop: base.crop,
    transform: base.transform,
    effects: base.effects,
    masks: base.masks,
    spots: base.spots,
    redEye: base.redEye,
    lens: {
      ...fresh.lens,
      distortion: base.lens.distortion,
      vignetting: base.lens.vignetting,
      caRed: base.lens.caRed,
      caBlue: base.lens.caBlue,
    },
  }
  return { local, framing }
}

/** True when the framing stage would do nothing at all. */
export function isIdentityFraming(edits: Edits): boolean {
  return (
    isIdentityGeometry(edits) &&
    edits.effects.vignetteAmount === 0 &&
    edits.effects.grainAmount === 0 &&
    !edits.masks.some((m) => m.visible && m.components.length > 0) &&
    !edits.spots.some((s) => s.opacity > 0 && s.radius > 0) &&
    !edits.redEye.some((r) => r.radius > 0)
  )
}

/**
 * The straightened frame's width:height, which is what an aspect preset is
 * measured against.
 *
 * It is *not* the sensor's aspect: quarter-turns swap the axes and a straighten
 * grows the frame, so a 3:2 photo rotated once has to report 2:3 or every
 * preset would snap to the wrong shape.
 */
export function frameAspect(
  width: number,
  height: number,
  edits: Edits,
): number {
  if (!width || !height) return 1
  const f = geometryOutputSize(width, height, uncrop(edits))
  return f.height > 0 ? f.width / f.height : 1
}

/**
 * The same edits with the crop rectangle opened out to the whole frame.
 *
 * The crop tool shows the uncropped photo so you can see what is being cut, but
 * the straighten, turns, flips and lens corrections have to stay applied — the
 * rectangle is drawn on the *corrected* frame, not the raw one.
 */
export function uncrop(edits: Edits, active = true): Edits {
  if (!active || isFullFrame(edits.crop)) return edits
  return { ...edits, crop: { ...edits.crop, left: 0, top: 0, right: 1, bottom: 1 } }
}

/**
 * The edit stack as it stands on the sensor grid.
 *
 * Spot and red-eye coordinates belong to the source image — a blemish is part
 * of the thing it sits on, not of the frame — so the retouch tools have to work
 * on the source image; under a crop or a straighten the circles would land
 * somewhere else entirely. Masks and post-crop effects are defined on the
 * framed photo and are dropped for the same reason.
 */
export function ungeometry(edits: Edits, active = true): Edits {
  if (!active) return edits
  const { local } = splitAtGeometry(edits)
  return { ...local, spots: edits.spots, redEye: edits.redEye }
}

export interface GeometrySize {
  width: number
  height: number
}

/**
 * The size the geometry pass renders into.
 *
 * The crop rect is expressed in the *straightened* frame, whose own aspect is
 * the source's with quarter turns applied. Keeping the pixel density of the
 * source means a 50% crop of a 6000px frame is 3000px, not a resample.
 */
export function geometryOutputSize(
  width: number,
  height: number,
  edits: Edits,
): GeometrySize {
  const { crop } = edits
  const turned = crop.quarterTurns % 2 === 1
  const fw = turned ? height : width
  const fh = turned ? width : height

  const w = Math.max(1, Math.round(fw * Math.max(0.01, crop.right - crop.left)))
  const h = Math.max(1, Math.round(fh * Math.max(0.01, crop.bottom - crop.top)))
  return { width: w, height: h }
}

/**
 * Fits a crop rect to an aspect ratio, keeping it centred on where it is and
 * inside the frame. `frameAspect` is the straightened frame's width/height.
 */
export function fitCropToAspect(
  crop: Edits['crop'],
  aspect: CropAspect,
  frameAspect: number,
): Pick<Edits['crop'], 'left' | 'top' | 'right' | 'bottom'> {
  const ratio =
    aspect === 'free'
      ? null
      : aspect === 'original'
        ? frameAspect
        : (() => {
            const r = ASPECT_RATIOS[aspect]
            return r ? r[0] / r[1] : null
          })()
  if (ratio === null) return crop

  // Work in frame units so the ratio means what it says on screen.
  const cx = (crop.left + crop.right) / 2
  const cy = (crop.top + crop.bottom) / 2
  let w = crop.right - crop.left
  let h = crop.bottom - crop.top

  // Preserve area rather than a single edge, so switching presets doesn't
  // shrink the crop a little more each time.
  const area = w * (h / frameAspect)
  w = Math.sqrt(area * ratio)
  h = (w / ratio) * frameAspect

  // Shrink to fit before recentring, so a wide preset on a tall crop still
  // lands entirely inside the frame.
  const shrink = Math.min(1, 1 / Math.max(w, h))
  w *= shrink
  h *= shrink

  const left = Math.min(Math.max(cx - w / 2, 0), 1 - w)
  const top = Math.min(Math.max(cy - h / 2, 0), 1 - h)
  return { left, top, right: left + w, bottom: top + h }
}
