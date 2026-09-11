import type { WhiteBalanceMode } from './types'

/**
 * The white-balance presets, in absolute Kelvin.
 *
 * These are the standard illuminants Lightroom offers. Because esque derives a
 * real as-shot temperature from the camera matrix, picking "Shade" here lands
 * on the same colour it would in any other raw converter.
 */
export const WB_PRESETS: Partial<Record<WhiteBalanceMode, { temp: number; tint: number }>> = {
  daylight: { temp: 5500, tint: 10 },
  cloudy: { temp: 6500, tint: 10 },
  shade: { temp: 7500, tint: 10 },
  tungsten: { temp: 2850, tint: 0 },
  fluorescent: { temp: 3800, tint: 21 },
  flash: { temp: 5500, tint: 0 },
}

/** The full temperature range esque stores, and Lightroom's XMP round-trips. */
export const TEMP_MIN = 2000
export const TEMP_MAX = 50000

/** The tint range esque stores, matching Lightroom's. */
export const TINT_MIN = -150
export const TINT_MAX = 150

/**
 * Where a temperature sits along its slider.
 *
 * Kelvin is not a perceptual scale. Every preset above lives between 2850 and
 * 7500 K, which on a linear 2000–50000 K track is the leftmost eighth — a
 * single pixel there is worth about 180 K, so the one control that matters
 * most is the one you cannot adjust, while four fifths of the track covers
 * temperatures no photograph is ever shot under.
 *
 * Mireds (10⁶/K) are the unit colour temperature shifts are actually perceived
 * in: a hundred mireds looks like the same size of change whether you start
 * warm or cool. Spacing the track in mireds spends its length where the
 * photographs are, and makes an equal drag anywhere produce an equal shift in
 * the image, which is what a slider is supposed to promise.
 */
export const MIRED_SCALE = {
  toPosition(kelvin: number, min: number, max: number): number {
    const hi = 1e6 / min
    return (hi - 1e6 / Math.max(kelvin, min)) / (hi - 1e6 / max)
  },
  fromPosition(frac: number, min: number, max: number): number {
    const hi = 1e6 / min
    return 1e6 / (hi - frac * (hi - 1e6 / max))
  },
}
