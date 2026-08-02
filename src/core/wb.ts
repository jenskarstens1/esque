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
