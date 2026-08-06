/**
 * Overlay surfaces for touch: a bottom Sheet and an edge Drawer.
 *
 * Below the desktop break the side panels can no longer take space from the
 * canvas — 508px of chrome on a 390px screen leaves nothing for the photo — so
 * they float over it instead. These are the two shapes that works in: a sheet
 * rising from the bottom edge for controls, a drawer sliding in from a side for
 * navigation.
 *
 * Both are dragged with the same grammar as the rest of the app: pointer events
 * with capture, `touch-action: none` on the grab area only, and a throw that
 * commits on either distance or velocity so a quick flick dismisses without
 * having to travel the whole way.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn'

/** Past this fraction of the surface, or this speed, a drag becomes a dismissal. */
const DISMISS_FRACTION = 0.35
const DISMISS_VELOCITY = 0.55 // px per ms

/** Escape and the browser Back button both close the topmost overlay. */
const stack: object[] = []

function useDismissable(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const id = {}
    stack.push(id)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stack[stack.length - 1] === id) {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      stack.splice(stack.indexOf(id), 1)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose])
}

/**
 * Tracks a drag along one axis and reports how far the surface has been pulled
 * towards its closed edge. Never negative: dragging a sheet upward past its stop
 * would tear it off the bottom of the screen.
 */
function useThrow(axis: 'y' | 'x', sign: 1 | -1, onDismiss: () => void) {
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ v: number; t: number } | null>(null)
  const last = useRef<{ v: number; t: number } | null>(null)

  const onPointerDown = (e: React.PointerEvent) => {
    if (!e.isPrimary) return
    const v = axis === 'y' ? e.clientY : e.clientX
    start.current = { v, t: e.timeStamp }
    last.current = { v, t: e.timeStamp }
    setDragging(true)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const s = start.current
    if (!s) return
    const v = axis === 'y' ? e.clientY : e.clientX
    last.current = { v, t: e.timeStamp }
    setOffset(Math.max(0, (v - s.v) * sign))
  }

  const end = (e: React.PointerEvent) => {
    const s = start.current
    const l = last.current
    start.current = null
    setDragging(false)
    if (!s || !l) return setOffset(0)

    const surface = (e.currentTarget as HTMLElement).closest('[data-overlay-surface]')
    const extent = surface
      ? axis === 'y'
        ? surface.clientHeight
        : surface.clientWidth
      : 1
    const travelled = Math.max(0, (l.v - s.v) * sign)
    const dt = Math.max(1, l.t - s.t)
    const velocity = ((l.v - s.v) * sign) / dt

    if (travelled > extent * DISMISS_FRACTION || velocity > DISMISS_VELOCITY) onDismiss()
    // Left at the dragged offset when dismissing, so the exit animation
    // continues from where the finger let go rather than snapping back first.
    else setOffset(0)
  }

  return {
    offset,
    dragging,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: end,
      onPointerCancel: end,
      style: { touchAction: 'none' as const },
    },
  }
}

function Scrim({ show, onClick }: { show: boolean; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'absolute inset-0 bg-scrim',
        'transition-opacity duration-[--duration-base] ease-[--ease-out]',
        show ? 'opacity-100' : 'opacity-0',
      )}
    />
  )
}

// ---------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------

export interface SheetProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  /**
   * Height as a fraction of the viewport. Left short of 1 by default so the
   * photo behind stays partly visible — on a phone that strip is the only thing
   * telling you what the controls are acting on.
   */
  height?: number
  /** Actions pinned to the header's trailing edge. */
  actions?: ReactNode
  className?: string
}

/**
 * A panel rising from the bottom edge.
 *
 * The reach-friendly place for controls on a phone: the grab handle and the
 * header sit under the thumb, and the content scrolls above them.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  height = 0.62,
  actions,
  className,
}: SheetProps) {
  useDismissable(open, onClose)
  const { offset, dragging, handleProps } = useThrow('y', 1, onClose)
  const [mounted, setMounted] = useState(false)

  // One frame between mounting at the closed position and animating to the open
  // one, so the transition has a start value to run from.
  useEffect(() => {
    if (!open) return setMounted(false)
    const id = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(id)
  }, [open])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[1100] flex flex-col justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <Scrim show={mounted} onClick={onClose} />
      <div
        data-overlay-surface
        style={{
          height: `${Math.round(height * 100)}dvh`,
          translate: mounted ? `0 ${offset}px` : '0 100%',
        }}
        className={cn(
          'material-thick esq-safe-b relative flex flex-col overflow-hidden',
          'rounded-t-2xl shadow-[0_-8px_40px_rgb(0_0_0/0.5)]',
          // Not while dragging: a transition there would lag the finger.
          !dragging && 'transition-[translate] duration-[--duration-base] ease-[--ease-out]',
          className,
        )}
      >
        {/*
         * The grab area is the handle *and* the header. A 4px pill is honest
         * about what it affords but far too small to catch, so the whole strip
         * above the content is draggable.
         */}
        <div {...handleProps} className="shrink-0 cursor-grab active:cursor-grabbing">
          <div className="flex justify-center pt-2 pb-1">
            <span className="h-1 w-9 rounded-full bg-label-quaternary" />
          </div>
          {(title || actions) && (
            <div className="hairline-b flex h-11 items-center gap-2 px-4">
              <h2 className="min-w-0 flex-1 truncate text-title text-label">{title}</h2>
              {actions}
            </div>
          )}
        </div>
        <div className="esq-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

export interface DrawerProps {
  open: boolean
  onClose: () => void
  side: 'left' | 'right'
  children: ReactNode
  /** Fixed width in px, clamped to leave a strip of canvas showing. */
  width?: number
  label?: string
  className?: string
}

/**
 * A panel sliding in from a side edge, over the canvas rather than beside it.
 *
 * This is what the Library's catalog tree and the Develop panels become below
 * the desktop break: the same components, the same widths, just no longer taking
 * their space out of the photo.
 */
export function Drawer({
  open,
  onClose,
  side,
  children,
  width = 280,
  label,
  className,
}: DrawerProps) {
  useDismissable(open, onClose)
  const { offset, dragging, handleProps } = useThrow('x', side === 'left' ? -1 : 1, onClose)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    if (!open) return setMounted(false)
    const id = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(id)
  }, [open])

  // Never wider than the screen less a thumb's width of canvas, so there is
  // always somewhere to tap back out to.
  const [max, setMax] = useState(width)
  useEffect(() => {
    const read = () => setMax(Math.min(width, window.innerWidth - 56))
    read()
    window.addEventListener('resize', read)
    return () => window.removeEventListener('resize', read)
  }, [width])

  if (!open) return null

  const sign = side === 'left' ? -1 : 1
  const hidden = side === 'left' ? '-100%' : '100%'

  return createPortal(
    <div
      className={cn('fixed inset-0 z-[1100] flex', side === 'right' && 'justify-end')}
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <Scrim show={mounted} onClick={onClose} />
      <div
        data-overlay-surface
        style={{
          width: max,
          translate: mounted ? `${offset * sign}px 0` : `${hidden} 0`,
        }}
        className={cn(
          'material-thick esq-safe-b relative flex flex-col overflow-hidden',
          side === 'left' ? 'hairline-r' : 'hairline-l',
          'shadow-[0_0_40px_rgb(0_0_0/0.5)]',
          !dragging && 'transition-[translate] duration-[--duration-base] ease-[--ease-out]',
          className,
        )}
      >
        <div className="esq-safe-t min-h-0 flex-1 overflow-hidden">{children}</div>
        {/*
         * A swipe strip along the inner edge rather than a draggable body: the
         * drawer holds scrollable lists and sliders, and a body-wide drag would
         * fight every one of them for the same gesture.
         */}
        <div
          {...handleProps}
          aria-hidden
          className={cn(
            'absolute inset-y-0 w-5',
            side === 'left' ? 'right-0' : 'left-0',
          )}
        />
      </div>
    </div>,
    document.body,
  )
}
