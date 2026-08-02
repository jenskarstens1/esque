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
