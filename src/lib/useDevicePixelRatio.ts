import { useEffect, useState } from 'react'

/**
 * The display's device pixel ratio, kept current.
 *
 * `window.devicePixelRatio` is a plain number with no change event, so a window
 * dragged from a Retina display to a 1x one silently leaves every canvas sized
 * for the wrong density — the image goes soft and never recovers. A media query
 * pinned to the *current* ratio fires the moment it stops matching, which is
 * exactly the moment the ratio changed.
 */
export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() =>
    typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    const read = () => setDpr(window.devicePixelRatio || 1)
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`)
    mq.addEventListener('change', read)
    // Browser zoom changes the ratio too, and reaches us as a resize first.
    window.addEventListener('resize', read)
    // The ratio may already have moved between render and effect.
    if (window.devicePixelRatio !== dpr) read()
    return () => {
      mq.removeEventListener('change', read)
      window.removeEventListener('resize', read)
    }
  }, [dpr])

  return dpr
}
