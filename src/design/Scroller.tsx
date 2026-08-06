import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ComponentPropsWithoutRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { cn } from '../lib/cn'
import { clamp } from '../lib/math'
import { mergeRefs } from '../lib/mergeRefs'

/** Distance the thumb keeps from each end of its track. */
const INSET = 2
/** A thumb shorter than this is impossible to grab. */
const MIN_THUMB = 24
/** How long the thumb lingers after scrolling stops, macOS-style. */
const FADE_DELAY = 900
/** How deep the edge fade runs once fully open. */
const EDGE_FADE = 22

type ScrollerProps = Omit<ComponentPropsWithoutRef<'div'>, 'children' | 'className'> & {
  /**
   * Classes for the outer frame: everything that sizes the box
   * (`h-full`, `min-h-0 flex-1`, `max-h-[280px]`, margins).
   */
  frameClassName?: string
  /** Classes for the scrolling viewport itself: padding and content layout. */
  className?: string
  axis?: 'y' | 'x'
  /** Set false to scroll without ever painting a thumb. */
  thumb?: boolean
  /**
   * Softens content into each edge it can still scroll toward, so a cut-off row
   * reads as "there is more" instead of as a row someone sliced. Pass a number
   * to set the depth. Costs a mask, so it is opt-in.
   */
  edgeFade?: boolean | number
  children?: ReactNode
}

/**
 * A scroll container with a real overlay scrollbar.
 *
 * Native scrollbars are hidden app-wide because a styled `::-webkit-scrollbar`
 * is a *classic* scrollbar in Chromium: it eats layout space inside the padding
 * box, so content jumps sideways the moment an area starts or stops overflowing.
 * The thumb here is painted absolutely over the content, so it costs no space
 * and nothing reflows.
 *
 * The forwarded ref points at the scrolling element, which is what virtualizers
 * and scroll listeners want.
 */
export const Scroller = forwardRef<HTMLDivElement, ScrollerProps>(function Scroller(
  { axis = 'y', thumb: showThumb = true, edgeFade, frameClassName, className, children, ...rest },
  ref,
) {
  const viewport = useRef<HTMLDivElement>(null)
  const thumb = useRef<HTMLDivElement>(null)
  const fade = useRef(0)
  const frame = useRef(0)
  const dragging = useRef(false)
  const vertical = axis === 'y'
  const fadeDepth = edgeFade ? (typeof edgeFade === 'number' ? edgeFade : EDGE_FADE) : 0

  /** Track geometry for the current viewport, or null when it doesn't overflow. */
  const geometry = useCallback(() => {
    const el = viewport.current
    if (!el) return null
    const client = vertical ? el.clientHeight : el.clientWidth
    const content = vertical ? el.scrollHeight : el.scrollWidth
    const overflow = content - client
    if (client <= 0 || overflow <= 1) return null
    const track = Math.max(0, client - INSET * 2)
    const size = clamp(Math.round((client / content) * track), Math.min(MIN_THUMB, track), track)
    return { overflow, track, size, range: track - size }
  }, [vertical])

  const measure = useCallback(() => {
    const el = viewport.current
    if (!el) return
    const geo = geometry()
    const bar = thumb.current
    const pos = vertical ? el.scrollTop : el.scrollLeft

    if (bar) {
      if (!geo) {
        bar.hidden = true
      } else {
        bar.hidden = false
        const offset = clamp(Math.round((geo.range * pos) / geo.overflow), 0, geo.range)
        if (vertical) {
          bar.style.height = `${geo.size}px`
          bar.style.transform = `translateY(${offset}px)`
        } else {
          bar.style.width = `${geo.size}px`
          bar.style.transform = `translateX(${offset}px)`
        }
      }
    }

    if (fadeDepth) {
      // Each edge opens in proportion to how far it can still be scrolled, so
      // the fade grows out of the first pixels of travel rather than snapping
      // on — and closes flush when there is nothing left that way.
      const overflow = geo?.overflow ?? 0
      el.style.setProperty('--esq-fade-a', `${clamp(pos, 0, fadeDepth)}px`)
      el.style.setProperty('--esq-fade-b', `${clamp(overflow - pos, 0, fadeDepth)}px`)
    }
  }, [geometry, vertical, fadeDepth])

  const schedule = useCallback(() => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      measure()
    })
  }, [measure])

  /** Show the thumb, then let it fade back out once scrolling settles. */
  const flash = useCallback(() => {
    const bar = thumb.current
    if (!bar) return
    bar.dataset.active = ''
    clearTimeout(fade.current)
    fade.current = window.setTimeout(() => {
      if (!dragging.current) delete thumb.current?.dataset.active
    }, FADE_DELAY)
  }, [])

  useEffect(() => {
    const el = viewport.current
    if (!el) return

    const onScroll = () => {
      schedule()
      flash()
    }
    el.addEventListener('scroll', onScroll, { passive: true })

    const resize = new ResizeObserver(schedule)
    const watch = () => {
      resize.disconnect()
      resize.observe(el)
      // Content can grow without the viewport resizing — a thumbnail decoding,
      // a section expanding — and that only shows up on the children.
      for (const child of el.children) resize.observe(child)
    }
    watch()

    const mutate = new MutationObserver(() => {
      watch()
      schedule()
    })
    mutate.observe(el, { childList: true, subtree: true })

    return () => {
      el.removeEventListener('scroll', onScroll)
      resize.disconnect()
      mutate.disconnect()
      clearTimeout(fade.current)
      cancelAnimationFrame(frame.current)
      // Leaving a stale id here would make `schedule` think a measure is
      // already queued and silently drop every later one (StrictMode remounts).
      frame.current = 0
    }
  }, [schedule, flash])

  // Children changing is the common case for panels; re-measure every render.
  useEffect(measure)

  // `mergeRefs` returns a fresh function, and an unstable ref callback is
  // detached and re-attached on every render — enough to trip a consumer whose
  // ref sets state (Dialog's edge hairlines) into an update loop.
  const attach = useMemo(() => mergeRefs(viewport, ref), [ref])

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = viewport.current
    const bar = thumb.current
    if (!el || !bar || e.button !== 0) return
    const geo = geometry()
    if (!geo || geo.range <= 0) return

    e.preventDefault()
    e.stopPropagation()
    bar.setPointerCapture(e.pointerId)
    dragging.current = true
    bar.dataset.dragging = ''
    bar.dataset.active = ''
    clearTimeout(fade.current)

    const origin = vertical ? e.clientY : e.clientX
    const base = vertical ? el.scrollTop : el.scrollLeft

    const move = (ev: PointerEvent) => {
      const delta = (vertical ? ev.clientY : ev.clientX) - origin
      const next = base + (delta / geo.range) * geo.overflow
      if (vertical) el.scrollTop = next
      else el.scrollLeft = next
    }
    const end = () => {
      dragging.current = false
      delete bar.dataset.dragging
      flash()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  return (
    <div className={cn('esq-scroller', frameClassName)}>
      <div
        {...rest}
        ref={attach}
        className={cn(
          'esq-scroll min-h-0 flex-auto',
          vertical ? 'overflow-x-hidden overflow-y-auto' : 'overflow-x-auto overflow-y-hidden',
          fadeDepth && (vertical ? 'esq-scroll-fade' : 'esq-scroll-fade is-x'),
          className,
        )}
      >
        {children}
      </div>
      {showThumb && (
        <div
          ref={thumb}
          hidden
          aria-hidden
          onPointerDown={startDrag}
          className={cn('esq-scroll-thumb', vertical ? 'is-y' : 'is-x')}
        />
      )}
    </div>
  )
})
