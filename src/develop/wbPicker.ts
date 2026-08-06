import { halfToFloat } from '../core/half'
import { whitePointForGain } from '../core/color'
import { useDevelop } from './session'
import { peekProxy, loadProxy, proxyEdge } from './proxy'
import { toast } from '../design/toast'
import type { Edits, Point2 } from '../core/types'
import { sourcePeak } from '../core/workingImage'
import type { SourceImage } from '../core/workingImage'
import type { WhitePoint } from '../core/color'

/**
 * The white-balance dropper.
 *
 * Clicking a surface that ought to be neutral is the fastest way to balance a
 * photograph, and it is exact in a way the sliders are not: the answer is
 * measured off one thing the photographer can point at rather than assumed
 * about the frame as a whole. Auto WB solves the same equation from the whole
 * image; this solves it from a patch.
 *
 * Everything reads the decoded proxy, not the rendered canvas. The proxy holds
 * scene-linear pixels with only the camera's own multipliers applied, so the
 * measurement is independent of the exposure, curves and grading already
 * dialled in — sampling the screen would fold all of those back in and the
 * result would change every time an unrelated slider moved.
 */

/** Half-width of the sampled patch, in source pixels. Lightroom's is comparable. */
const PATCH = 2

/** How close to the decoder's ceiling counts as blown. Matches auto's white balance. */
const CLIP_FRACTION = 0.98

/**
 * Armed state lives in `useUI` beside the Develop tools, not here: it is a mode,
 * and `setModule` is already the one place that clears the modes a module owns.
 * See the `wbPicking` comment there.
 */

// ---------------------------------------------------------------------------
// Output pixel back to a sensor pixel
// ---------------------------------------------------------------------------

/*
 * A CPU mirror of the inverse map in `src/gpu/wgsl/geometry.ts`.
 *
 * The viewport shows the *cropped, straightened* photo, but the pixels being
 * measured are the sensor's — so a point on screen has to be walked back
 * through the same transform chain the shader uses, in the same order. The
 * shader already runs backwards, which is why this is a transcription rather
 * than an inversion.
 *
 * The two must stay in step. Anything added to the geometry pass that moves a
 * pixel belongs here too, or the dropper samples the wrong thing on exactly the
 * photos that are hardest to notice it on.
 */

/** Aspect as (w,h) normalised to the longer side — the shader's `aspectVec`. */
function aspectVec(w: number, h: number): Point2 {
  const long = Math.max(w, h) || 1
  return { x: w / long, y: h / long }
}

export function outputUvToSourceUv(edits: Edits, srcW: number, srcH: number, uv: Point2): Point2 {
  const c = edits.crop
  const t = edits.transform
  const turned = c.quarterTurns % 2 === 1

  const inA = aspectVec(srcW, srcH)
  const frameA = aspectVec(turned ? srcH : srcW, turned ? srcW : srcH)

  // Output pixel to a point in the straightened, corrected frame.
  let px = (c.left + uv.x * (c.right - c.left) - 0.5) * frameA.x
  let py = (c.top + uv.y * (c.bottom - c.top) - 0.5) * frameA.y

  // Scale and offset are the last thing the user applies, so undo them first.
  const scale = Math.max(0.05, t.scale / 100)
  px = px / Math.max(scale, 1e-4) - (t.offsetX / 100) * inA.x
  py = py / Math.max(scale, 1e-4) - (-t.offsetY / 100) * inA.y

  px /= Math.max(t.aspect > 0 ? 1 + t.aspect / 100 : 1, 1e-4)
  py /= Math.max(t.aspect < 0 ? 1 - t.aspect / 100 : 1, 1e-4)

  // The forward map divides by w, so the inverse multiplies.
  const w = 1 - ((t.horizontal / 220) * px + (t.vertical / 220) * py)
  const iw = Math.max(w, 1e-3)
  px /= iw
  py /= iw

  const angle = ((c.angle + t.rotate) * Math.PI) / 180
  const s = Math.sin(-angle)
  const co = Math.cos(-angle)
  ;[px, py] = [co * px - s * py, s * px + co * py]

  // Quarter turns and flips act on the sensor frame, so they come last on the
  // way in — a rotated photo straightens about its own centre, not the raw's.
  px *= c.flipH ? -1 : 1
  py *= c.flipV ? -1 : 1
  const quarter = c.quarterTurns & 3
  if (quarter === 3) [px, py] = [-py, px]
  else if (quarter === 2) [px, py] = [-px, -py]
  else if (quarter === 1) [px, py] = [py, -px]

  // Radial distortion, on the same normalised radius the shader uses.
  const rn = Math.hypot(inA.x * 0.5, inA.y * 0.5) || 1
  const r2 = (px * px + py * py) / (rn * rn)
  const k = 1 + (-edits.lens.distortion / 100) * r2
  px *= k
  py *= k

  return { x: px / inA.x + 0.5, y: py / inA.y + 0.5 }
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/** Mean linear RGB of a small patch, or null if the point is off the image. */
export function samplePatch(image: SourceImage, uv: Point2): [number, number, number] | null {
  const cx = Math.round(uv.x * image.width - 0.5)
  const cy = Math.round(uv.y * image.height - 0.5)
  if (cx < 0 || cy < 0 || cx >= image.width || cy >= image.height) return null

  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let y = cy - PATCH; y <= cy + PATCH; y++) {
    if (y < 0 || y >= image.height) continue
    for (let x = cx - PATCH; x <= cx + PATCH; x++) {
      if (x < 0 || x >= image.width) continue
      const i = (y * image.width + x) * 4
      r += halfToFloat(image.data[i])
      g += halfToFloat(image.data[i + 1])
      b += halfToFloat(image.data[i + 2])
      n++
    }
  }
  if (!n) return null
  return [r / n, g / n, b / n]
}

/**
 * The white point that would make the sampled patch neutral.
 *
 * Returns null when the patch cannot say: black has no colour to correct, and a
 * clipped highlight has had its colour destroyed by the clip rather than by the
 * light — balancing on either produces a confident, meaningless number.
 */
export function whiteBalanceFromPatch(
  image: SourceImage,
  rgb: [number, number, number],
): WhitePoint | null {
  const [r, g, b] = rgb
  if (!(r > 1e-5) || !(g > 1e-5) || !(b > 1e-5)) return null
  // `sourcePeak` rather than a comparison against the working values, because a
  // saturated colour clipped in sRGB still reads well under 1 in ProPhoto — the
  // exact patch a photographer is most likely to mistake for a bright neutral.
  if (sourcePeak(image, r, g, b) >= CLIP_FRACTION) return null
  return whitePointForGain(image.asShot, g / r, g / b)
}

/** Resolves the proxy the dropper measures, decoding one if Develop has none. */
export async function pickerImage(photoId: string): Promise<SourceImage | null> {
  return peekProxy(photoId) ?? (await loadProxy(photoId, proxyEdge()).catch(() => null))
}

/**
 * Balances the open photo on a point of the displayed frame, in 0..1 output
 * coordinates. Lands as one named history step, like any other WB change.
 */
export function pickWhiteBalanceAt(image: SourceImage, uv: Point2): boolean {
  const dev = useDevelop.getState()
  if (!dev.photoId) return false

  const rgb = readAt(image, dev.edits, uv)
  const wp = rgb && whiteBalanceFromPatch(image, rgb)
  if (!wp) {
    toast.error(
      'Nothing to balance there',
      'Pick a light neutral surface that is not blown out.',
    )
    return false
  }

  dev.update(
    'basic.wbMode',
    'White Balance',
    (e) => {
      e.basic.wbMode = 'custom'
      e.basic.temp = wp.temp
      e.basic.tint = wp.tint
    },
    false,
  )
  return true
}

/** Linear RGB under a point of the displayed frame, geometry undone. */
export function readAt(
  image: SourceImage,
  edits: Edits,
  uv: Point2,
): [number, number, number] | null {
  return samplePatch(image, outputUvToSourceUv(edits, image.width, image.height, uv))
}
