import { useCallback, useEffect, useRef } from 'react'
import { cn } from '../lib/cn'
import { clamp } from '../lib/math'

/**
 * A drag handle sitting on a panel edge. The hit area is deliberately wider than
 * the visible hairline — 8px of grab, 1px of ink.
 */
export function PanelResizer({
  side,
  size,
  min,
  max,
  onResize,
  onDoubleClick,
}: {
  side: 'left' | 'right' | 'top'
  size: number
  min: number
  max: number
  onResize: (n: number) => void
  onDoubleClick?: () => void
}) {
  const drag = useRef({ start: 0, base: 0, active: false })
  const ref = useRef<HTMLDivElement>(null)

  const move = useCallback(
    (e: PointerEvent) => {
      if (!drag.current.active) return
      const pos = side === 'top' ? e.clientY : e.clientX
      const delta = pos - drag.current.start
      // Left panels and the filmstrip grow the opposite way from right panels.
      const signed = side === 'right' || side === 'top' ? -delta : delta
      onResize(clamp(Math.round(drag.current.base + signed), min, max))
    },
    [max, min, onResize, side],
  )

  const end = useCallback(() => {
    drag.current.active = false
    document.body.style.cursor = ''
  }, [])

  useEffect(() => {
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
    }
  }, [move, end])

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation={side === 'top' ? 'horizontal' : 'vertical'}
      onDoubleClick={onDoubleClick}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        drag.current = {
          start: side === 'top' ? e.clientY : e.clientX,
          base: size,
          active: true,
        }
        document.body.style.cursor = side === 'top' ? 'row-resize' : 'col-resize'
      }}
      className={cn(
        'group/rz absolute z-20',
        side === 'top'
          ? 'inset-x-0 top-0 h-2 -translate-y-1/2 cursor-row-resize'
          : 'inset-y-0 w-2 cursor-col-resize',
        side === 'left' && 'right-0 translate-x-1/2',
        side === 'right' && 'left-0 -translate-x-1/2',
      )}
    >
      <div
        className={cn(
          'absolute bg-accent opacity-0 transition-opacity duration-[--duration-base] group-hover/rz:opacity-100',
          side === 'top'
            ? 'inset-x-0 top-1/2 h-[1.5px] -translate-y-1/2'
            : 'inset-y-0 left-1/2 w-[1.5px] -translate-x-1/2',
        )}
      />
    </div>
  )
}
