import { useEffect, useState } from 'react'
import { displayIsHdr, watchDisplayHdr } from '../core/hdr'

/**
 * Whether the display the window is currently on has headroom above SDR white.
 *
 * Worth subscribing to rather than reading once: the answer changes when the
 * window is dragged to a second monitor, and macOS withdraws headroom on its
 * own when a laptop drops to low power. The toggle stays usable either way —
 * this only decides whether the UI says the setting is having any effect.
 */
export function useDisplayHdr(): boolean {
  const [high, setHigh] = useState(displayIsHdr)
  useEffect(() => {
    setHigh(displayIsHdr())
    return watchDisplayHdr(setHigh)
  }, [])
  return high
}
