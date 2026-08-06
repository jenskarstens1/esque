/**
 * Viewport and input-capability sensing.
 *
 * esque is a desktop-class editor that also has to survive a phone, and the two
 * need genuinely different layouts rather than the same one shrunk: below the
 * tablet break the side panels stop being columns and become overlays, because
 * 240 + 268px of chrome on a 390px screen leaves the photo — the entire point —
 * with nothing.
 *
 * Everything here reads `matchMedia` rather than `window.innerWidth`, so a
 * resize costs one class change instead of a re-render per pixel, and the same
 * queries can be written in CSS where no component needs to know.
 */
import { useSyncExternalStore } from 'react'

/**
 * Layout tiers.
 *
 * `phone` gets one module at a time with the panels as sheets. `tablet` keeps
 * the full editor but floats the panels over the canvas. `desktop` is the
 * three-column layout the app was designed around.
 */
export type Breakpoint = 'phone' | 'tablet' | 'desktop'

/** Where each tier starts. Chosen from the layout's own floor, not a device
 *  list: the shell needs ~1100px before both panels and a usable canvas fit. */
export const BREAKPOINTS = { tablet: 768, desktop: 1100 } as const

const QUERIES = {
  phone: `(max-width: ${BREAKPOINTS.tablet - 1}px)`,
  tablet: `(min-width: ${BREAKPOINTS.tablet}px) and (max-width: ${BREAKPOINTS.desktop - 1}px)`,
  desktop: `(min-width: ${BREAKPOINTS.desktop}px)`,
  /** A finger or a pen, not a mouse: the hit-target and gesture rules hang off this. */
  coarse: '(pointer: coarse)',
  /** No hovering input at all, so anything revealed on hover is unreachable. */
  noHover: '(hover: none)',
  landscape: '(orientation: landscape)',
} as const

type QueryKey = keyof typeof QUERIES

/*
 * One MediaQueryList per query, shared by every subscriber. `useSyncExternalStore`
 * wants a stable snapshot, and a fresh `matchMedia` call per render would give a
 * new object each time and tear on concurrent renders.
 */
const lists = new Map<string, MediaQueryList>()
const listFor = (q: string) => {
  let l = lists.get(q)
  if (!l) {
    l = window.matchMedia(q)
    lists.set(q, l)
  }
  return l
}

const subscribe = (q: string) => (onChange: () => void) => {
  const l = listFor(q)
  l.addEventListener('change', onChange)
  return () => l.removeEventListener('change', onChange)
}

/** Subscribes to a raw media query. SSR and the check harnesses get `false`. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    subscribe(query),
    () => listFor(query).matches,
    () => false,
  )
}

const useQuery = (key: QueryKey) => useMediaQuery(QUERIES[key])

/** The current layout tier. */
export function useBreakpoint(): Breakpoint {
  const phone = useQuery('phone')
  const tablet = useQuery('tablet')
  return phone ? 'phone' : tablet ? 'tablet' : 'desktop'
}

/** True on phones — one module at a time, panels as sheets. */
export const useIsPhone = () => useQuery('phone')

/**
 * True below the desktop break, on phone *and* tablet.
 *
 * This is the one most layout code wants: it is the point where a panel stops
 * being able to take space from the canvas and has to float over it instead.
 */
export function useIsCompact(): boolean {
  return !useQuery('desktop')
}

/** True when the primary input is a finger or pen. */
export const useIsCoarsePointer = () => useQuery('coarse')

/** True when nothing can hover, so `hover:` styling never fires. */
export const useIsTouchOnly = () => useQuery('noHover')

export const useIsLandscape = () => useQuery('landscape')

/**
 * The viewport width in px, for the few places that need a number rather than a
 * tier — chiefly clamping a panel drag so it can never squeeze the canvas out.
 */
export function useWindowWidth(): number {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener('resize', onChange)
      return () => window.removeEventListener('resize', onChange)
    },
    () => window.innerWidth,
    () => BREAKPOINTS.desktop,
  )
}

/**
 * Non-reactive reads, for the imperative paths — a pointer handler deciding
 * whether to arm a long press has no render to hang a hook off.
 */
export const isCoarsePointer = () =>
  typeof window !== 'undefined' && window.matchMedia(QUERIES.coarse).matches

export const isTouchOnly = () =>
  typeof window !== 'undefined' && window.matchMedia(QUERIES.noHover).matches
