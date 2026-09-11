import { useRef, useState } from 'react'
import { cn } from '../lib/cn'
import { clamp } from '../lib/math'

interface Props {
  hue: number
  saturation: number
  size?: number
  onChange: (hue: number, saturation: number) => void
  onCommit?: (hue: number, saturation: number) => void
  /**
   * Restores the wheel's default. Double-click and Home route through this
   * rather than through `onChange(hue, 0)`, so a wheel that also carries a
   * luminance offset can clear that too — from here the two are one control.
   */
  onReset?: () => void
  /** Shows the reset affordance. Defaults to any saturation at all. */
  modified?: boolean
  label: string
}

/** Degrees and points per arrow press. Shift drops both to one. */
const HUE_STEP = 5
const SAT_STEP = 5

/**
 * A colour-grading wheel: hue around the rim, saturation toward the centre.
 *
 * The disc is painted with a conic hue sweep behind a radial white fade rather
 * than per-pixel canvas work, so it stays crisp at any DPI and costs nothing to
 * re-render while dragging.
 *
 * Pointer, keyboard and double-click all reach the same two numbers: the wheel
 * is a slider in polar coordinates, so it answers the arrow keys a slider does
 * — left/right around the rim, up/down toward the centre — and Home clears it.
 */
export function ColorWheel({
  hue,
  saturation,
  size = 92,
  onChange,
  onCommit,
  onReset,
  modified,
  label,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(false)

  const radius = size / 2
  const rad = ((hue - 90) * Math.PI) / 180
  const dist = (saturation / 100) * (radius - 7)
  const knobX = radius + Math.cos(rad) * dist
  const knobY = radius + Math.sin(rad) * dist
  const dirty = modified ?? saturation > 0

  const apply = (
    clientX: number,
    clientY: number,
    mods: { shiftKey: boolean; altKey: boolean },
    commit: boolean,
  ) => {
    const host = ref.current
    if (!host) return
    const r = host.getBoundingClientRect()
    const dx = clientX - (r.left + r.width / 2)
    const dy = clientY - (r.top + r.height / 2)
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90
    if (deg < 0) deg += 360
    const sat = clamp((Math.hypot(dx, dy) / (r.width / 2 - 7)) * 100, 0, 100)
    // Shift constrains to the current hue, matching Lightroom's modifier; alt
    // is its opposite number, holding the strength while you hunt for a hue.
    const nextHue = mods.shiftKey ? hue : Math.round(deg)
    const nextSat = mods.altKey ? saturation : Math.round(sat)
    onChange(nextHue, nextSat)
    if (commit) onCommit?.(nextHue, nextSat)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    ref.current?.focus()
    setActive(true)
    apply(e.clientX, e.clientY, e, false)
    const move = (ev: PointerEvent) => apply(ev.clientX, ev.clientY, ev, false)
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setActive(false)
      apply(ev.clientX, ev.clientY, ev, true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const reset = () => {
    if (onReset) return onReset()
    onChange(hue, 0)
    onCommit?.(hue, 0)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Home') {
      e.preventDefault()
      reset()
      return
    }
    // Shift is the fine gesture here as it is on every slider in the app. The
    // coarse default is what makes the keyboard a usable way to find a hue at
    // all: five degrees a press rather than seventy-two presses per turn.
    const hueStep = e.shiftKey ? 1 : HUE_STEP
    const satStep = e.shiftKey ? 1 : SAT_STEP
    let h = hue
    let s = saturation
    if (e.key === 'ArrowLeft') h -= hueStep
    else if (e.key === 'ArrowRight') h += hueStep
    else if (e.key === 'ArrowUp') s += satStep
    else if (e.key === 'ArrowDown') s -= satStep
    else return
    e.preventDefault()
    const nextHue = (Math.round(h) + 360) % 360
    const nextSat = clamp(Math.round(s), 0, 100)
    onChange(nextHue, nextSat)
    onCommit?.(nextHue, nextSat)
  }

  return (
    <div className="flex min-w-0 flex-col items-center gap-1.5">
      <div
        ref={ref}
        role="slider"
        aria-label={label}
        aria-valuenow={hue}
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuetext={saturation === 0 ? 'Neutral' : `Hue ${hue}°, saturation ${saturation}`}
        tabIndex={0}
        title={`${label}: drag to grade · shift holds the hue · ⌥ holds the strength · double-click to reset`}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onDoubleClick={reset}
        className={cn(
          'relative shrink-0 cursor-crosshair rounded-full outline-none',
          'transition-transform duration-[--duration-fast] ease-[--ease-out]',
          'focus-visible:ring-2 focus-visible:ring-accent',
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

      {/*
       * A fixed-height footer. The reset only appears on a wheel that has
       * something to reset, and reserving its width unconditionally is what
       * keeps three wheels in a row from stepping sideways as you grade them.
       */}
      <div className="flex h-4 w-full items-center justify-center gap-0.5">
        <span
          className={cn(
            'truncate text-micro',
            dirty ? 'text-label-secondary' : 'text-label-tertiary',
          )}
        >
          {label}
        </span>
        <button
          type="button"
          aria-label={`Reset ${label}`}
          title={`Reset ${label}`}
          tabIndex={dirty ? 0 : -1}
          onClick={reset}
          className={cn(
            'esq-tap grid size-4 shrink-0 place-items-center rounded-xs text-icon-tertiary',
            'transition-[opacity,color,background-color] duration-[--duration-fast] ease-[--ease-out]',
            'hover:bg-raised hover:text-icon',
            dirty ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        >
          <svg viewBox="0 0 12 12" className="size-[9px]" aria-hidden>
            <path
              d="M3 3 L9 9 M9 3 L3 9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  )
}
