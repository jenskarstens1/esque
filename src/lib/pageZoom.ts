import { useEffect, useState } from 'react'

/**
 * How far the browser's *page* zoom has drifted from 100%.
 *
 * The app swallows every zoom gesture so that zoom always means image zoom —
 * but page zoom is remembered per origin, so a window can arrive already at
 * 150% from a setting made in another tab or from the browser's own View menu.
 * With the gestures gone there would be no way back out, so the one state the
 * guard can strand you in has to be observable.
 *
 * There is no API for this. `devicePixelRatio` folds zoom together with the
 * display's density and cannot be split apart; `visualViewport.scale` reports
 * pinch, which is a different thing entirely. The outer window measured against
 * the CSS viewport is the one ratio that moves with page zoom alone: the app
 * never scrolls the document, and desktop window borders are thin enough to sit
 * well inside the threshold below.
 */
export function readPageZoom(): number {
  if (typeof window === 'undefined') return 1
  const { outerWidth, innerWidth } = window
  if (!outerWidth || !innerWidth) return 1
  return outerWidth / innerWidth
}

/**
 * Enough drift to be certain it is zoom rather than a window border. The
 * smallest step any browser offers is 10%, so this clears the noise without
 * missing a single rung.
 */
const TOLERANCE = 0.06

/**
 * Whether the page is zoomed far enough from 100% to trap the user.
 *
 * Touch browsers are excluded: they have no page zoom to reset, pinch is
 * handled by the visual viewport instead, and their address bar makes the outer
 * window an unreliable measure.
 */
export function isPageZoomed(): boolean {
  if (typeof window === 'undefined') return false
  if (window.matchMedia('(pointer: coarse)').matches) return false
  return Math.abs(readPageZoom() - 1) > TOLERANCE
}

/** The chords a browser resets or steps its own zoom with. */
export function isPageZoomChord(e: KeyboardEvent): boolean {
  if (!e.metaKey && !e.ctrlKey) return false
  return e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_' || e.key === '0'
}

/**
 * `[zoomed, zoom]`, kept current.
 *
 * Page zoom reaches the page as a resize and nothing else, which is the only
 * notification available — there is no zoom event to listen for.
 */
export function usePageZoom(): [boolean, number] {
  const [state, setState] = useState<[boolean, number]>(() => [isPageZoomed(), readPageZoom()])

  useEffect(() => {
    const read = () =>
      setState((prev) => {
        const next: [boolean, number] = [isPageZoomed(), readPageZoom()]
        return prev[0] === next[0] && Math.abs(prev[1] - next[1]) < 0.005 ? prev : next
      })
    window.addEventListener('resize', read)
    read()
    return () => window.removeEventListener('resize', read)
  }, [])

  return state
}
