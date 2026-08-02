import { useRef, useState } from 'react'
import { cn } from '../lib/cn'
import { clamp } from '../lib/math'

interface Props {
  hue: number
  saturation: number
  size?: number
  onChange: (hue: number, saturation: number) => void
  onCommit?: (hue: number, saturation: number) => void
  label: string
}

/**
 * A colour-grading wheel: hue around the rim, saturation toward the centre.
 *
 * The disc is painted with a conic hue sweep behind a radial white fade rather
 * than per-pixel canvas work, so it stays crisp at any DPI and costs nothing to
 * re-render while dragging.
 */
export function ColorWheel({ hue, saturation, size = 92, onChange, onCommit, label }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(false)

  const radius = size / 2
  const rad = ((hue - 90) * Math.PI) / 180
  const dist = (saturation / 100) * (radius - 7)
  const knobX = radius + Math.cos(rad) * dist
  const knobY = radius + Math.sin(rad) * dist

  const apply = (clientX: number, clientY: number, shift: boolean, commit: boolean) => {
    const host = ref.current
    if (!host) return
    const r = host.getBoundingClientRect()
    const dx = clientX - (r.left + r.width / 2)
    const dy = clientY - (r.top + r.height / 2)
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90
    if (deg < 0) deg += 360
    const sat = clamp((Math.hypot(dx, dy) / (r.width / 2 - 7)) * 100, 0, 100)
    // Shift constrains to the current hue, matching Lightroom's modifier.
    const nextHue = shift ? hue : Math.round(deg)
    const nextSat = Math.round(sat)
    onChange(nextHue, nextSat)
    if (commit) onCommit?.(nextHue, nextSat)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    setActive(true)
    apply(e.clientX, e.clientY, e.shiftKey, false)
    const move = (ev: PointerEvent) => apply(ev.clientX, ev.clientY, ev.shiftKey, false)
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setActive(false)
      apply(ev.clientX, ev.clientY, ev.shiftKey, true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        ref={ref}
        role="slider"
        aria-label={label}
        aria-valuenow={hue}
        aria-valuemin={0}
        aria-valuemax={360}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onDoubleClick={() => {
          onChange(hue, 0)
          onCommit?.(hue, 0)
        }}
        className={cn(
          'relative shrink-0 cursor-crosshair rounded-full',
          'transition-transform duration-[--duration-fast] ease-[--ease-out]',
          active && 'scale-[1.03]',
        )}
        style={{ width: size, height: size }}
      >
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background:
              'conic-gradient(from 0deg,#ff2d2d,#ffb02e,#ffe92e,#4cff5a,#2effe0,#2e9dff,#6b3cff,#ff34d2,#ff2d2d)',
          }}
        />
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background: 'radial-gradient(circle at 50% 50%,#8a8a8f 0%,rgba(138,138,143,0) 72%)',
          }}
        />
        <div className="absolute inset-0 rounded-full ring-[0.5px] ring-black/45 ring-inset" />
        <div
          className="pointer-events-none absolute size-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_1px_4px_rgba(0,0,0,.6)]"
          style={{
            left: knobX,
            top: knobY,
            background: `hsl(${hue} ${saturation}% 55%)`,
          }}
        />
      </div>
      <span className="text-micro text-label-tertiary">{label}</span>
    </div>
  )
}
