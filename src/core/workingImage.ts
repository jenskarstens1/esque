import { PROPHOTO_D50_TO_SRGB_D65 } from './color'
import type { WhitePoint } from './color'

/**
 * The only pixel contract accepted by Develop and the renderer.
 *
 * Values are oriented, scene-linear ProPhoto RGB (D50) in RGBA half-float
 * storage. RAW values may exceed 1: `whiteLevel` is the code ceiling retained
 * by the decode, so highlight logic can distinguish real headroom from a
 * channel that LibRaw clipped. Rendered files use a white level of 1.
 */
export interface SourceImage {
  width: number
  height: number
  /** RGBA half-float bit patterns. */
  data: Uint16Array
  isRaw: boolean
  /** White point already applied to the pixels at decode time. */
  asShot: WhitePoint
  /** Working-space value produced by a saturated decoder output channel. */
  whiteLevel: number
}

/** Browser-decoded rendered files are authored against the sRGB D65 white. */
export const RENDERED_WHITE_POINT: WhitePoint = { temp: 6504, tint: 0 }

/**
 * How close a pixel is to the ceiling its decoder could represent, where 1 is
 * clipped.
 *
 * Which ceiling that is depends on where the pixel came from. RAW keeps the
 * sensor's own scale, so the test is against `whiteLevel` directly. A rendered
 * file was clipped in *sRGB* before it ever reached the working space, and a
 * saturated colour can sit well below 1 in ProPhoto while having been pinned at
 * 255 in sRGB — so it has to be converted back to be asked honestly.
 *
 * Everything that must not trust a blown pixel shares this: auto's white
 * balance, its highlight recovery, and the dropper.
 */
export function sourcePeak(image: SourceImage, r: number, g: number, b: number): number {
  if (image.isRaw) return Math.max(r, g, b) / image.whiteLevel
  const m = PROPHOTO_D50_TO_SRGB_D65
  return Math.max(
    m[0] * r + m[1] * g + m[2] * b,
    m[3] * r + m[4] * g + m[5] * b,
    m[6] * r + m[7] * g + m[8] * b,
  )
}
