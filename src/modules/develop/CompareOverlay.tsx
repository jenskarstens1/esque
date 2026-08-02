import { useCallback, useRef, useState } from 'react'
import { cn } from '../../lib/cn'
import { useUI, type BeforeAfter } from '../../state/ui'

/**
 * How far a caption is pushed off a horizontal seam.
 *
 * The grip is centred on the seam, so half of it (8px) sits over the lower
 * half; clearing that plus the usual 12px gap keeps the caption from reading
 * as part of the handle.
 */
const GRIP_CLEARANCE = 20

/**
 * The draggable seam in a split compare.
 *
 * The handle is deliberately wider than the line it draws: a 1px seam is the
 * right visual weight and an unreasonable pointer target, so the hit area is
 * padded either side and only the line itself is painted. Pointer events stop
 * here so dragging the seam never doubles as a pan.
 */
export function CompareDivider({ mode }: { mode: BeforeAfter }) {
  const split = useUI((s) => s.compareSplit)
  const setSplit = useUI((s) => s.setCompareSplit)
  const vertical = mode === 'splitVertical'
  const ref = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const host = ref.current?.parentElement
      if (!host) return

      const move = (ev: PointerEvent) => {
        const r = host.getBoundingClientRect()
        setSplit(
          vertical ? (ev.clientX - r.left) / (r.width || 1) : (ev.clientY - r.top) / (r.height || 1),
        )
      }
      const up = () => {
        setDragging(false)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
      }
      setDragging(true)
      move(e.nativeEvent)
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    },
    [vertical, setSplit],
  )

  // Arrow keys nudge the seam, which is the only way to place it precisely.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.05 : 0.01
    const back = vertical ? 'ArrowLeft' : 'ArrowUp'
    const fwd = vertical ? 'ArrowRight' : 'ArrowDown'
    if (e.key === back) {
      e.preventDefault()
      e.stopPropagation()
      setSplit(split - step)
    } else if (e.key === fwd) {
      e.preventDefault()
      e.stopPropagation()
      setSplit(split + step)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setSplit(0.5)
    }
  }

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label="Before / after divider"
      aria-valuenow={Math.round(split * 100)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setSplit(0.5)
      }}
      onKeyDown={onKeyDown}
      className={cn(
        'group/divider absolute z-10 flex items-center justify-center',
        'focus-visible:outline-none',
        vertical ? 'top-0 bottom-0 w-6 cursor-ew-resize' : 'right-0 left-0 h-6 cursor-ns-resize',
      )}
      style={
        vertical
          ? { left: `${split * 100}%`, transform: 'translateX(-50%)' }
          : { top: `${split * 100}%`, transform: 'translateY(-50%)' }
      }
    >
      <span
        aria-hidden
        className={cn(
          'absolute bg-white/70 transition-[background-color] duration-[--duration-fast]',
          'group-hover/divider:bg-white group-focus-visible/divider:bg-accent',
          dragging && 'bg-white',
          vertical ? 'top-0 bottom-0 w-px' : 'right-0 left-0 h-px',
        )}
        style={{ boxShadow: '0 0 0 0.5px rgb(0 0 0 / 0.55)' }}
      />
      <span
        aria-hidden
        className={cn(
          'material relative grid place-items-center rounded-full text-label-secondary shadow-hud',
          'transition-[scale,color] duration-[--duration-fast] ease-[--ease-out]',
          'group-hover/divider:text-label',
          dragging ? 'scale-110 text-label' : 'scale-100',
          vertical ? 'h-7 w-4' : 'h-4 w-7',
        )}
      >
        <GripIcon vertical={vertical} />
      </span>
    </div>
  )
}

function GripIcon({ vertical }: { vertical: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      className={cn('size-3', !vertical && 'rotate-90')}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4.6 3.4 2.2 6l2.4 2.6M7.4 3.4 9.8 6l-2.4 2.6" />
    </svg>
  )
}

/**
 * The Before / After captions.
 *
 * They track the layout rather than sitting in fixed corners, so in a split
 * view each caption stays on its own side of the seam and never ends up
 * labelling the wrong half.
 */
export function CompareLabels({ mode, split }: { mode: BeforeAfter; split: number }) {
  if (mode === 'off') return null
  if (mode === 'before') {
    return (
      <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
        <Caption>Before</Caption>
      </div>
    )
  }

  if (mode === 'sideBySide' || mode === 'topBottom') {
    const stacked = mode === 'topBottom'
    return (
      <div
        className={cn(
          'pointer-events-none absolute inset-0 grid',
          stacked ? 'grid-rows-2' : 'grid-cols-2',
        )}
        aria-hidden
      >
        <div className="flex items-start justify-center pt-3">
          <Caption>Before</Caption>
        </div>
        <div className="flex items-start justify-center pt-3">
          <Caption accent>After</Caption>
        </div>
      </div>
    )
  }

  const vertical = mode === 'splitVertical'
  // Captions sit on their own side of the seam, and drop out near the edges so
  // a divider dragged hard over never pushes its label onto the wrong half.
  // A horizontal seam puts the grip directly above the lower caption, which is
  // the one case that needs more than the usual 12px of air.
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      <div
        className="absolute flex items-start justify-center"
        style={
          vertical
            ? { left: 0, width: `${split * 100}%`, top: 12 }
            : { top: 12, left: 0, right: 0 }
        }
      >
        {split > 0.14 && <Caption>Before</Caption>}
      </div>
      <div
        className="absolute flex items-start justify-center"
        style={
          vertical
            ? { left: `${split * 100}%`, right: 0, top: 12 }
            : { top: `calc(${split * 100}% + ${GRIP_CLEARANCE}px)`, left: 0, right: 0 }
        }
      >
        {split < 0.86 && <Caption accent>After</Caption>}
      </div>
    </div>
  )
}

function Caption({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <span
      className={cn(
        'material rounded-full px-2.5 py-1 text-micro tracking-[0.08em] uppercase shadow-hud',
        accent ? 'text-label' : 'text-label-secondary',
      )}
    >
      {children}
    </span>
  )
}
