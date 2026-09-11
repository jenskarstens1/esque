import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn'
import { clamp, quantize } from '../lib/math'
import { useMenu } from './useMenu'
import { MENU_ICON, type MenuItem } from './Menu'
import { ResetIcon } from './icons'

/**
 * Slider.
 *
 * The look is React Spectrum S2's `<Slider trackStyle="thick" thumbStyle="precise" />`
 * — a 16px trough with 4px corners and a narrow 6px pill thumb carrying a 2px
 * ring — verified against the real component's computed geometry. S2's size
 * scale, emphasis and press push-back are mirrored too, so `size`, `trackStyle`,
 * `thumbStyle` and `isEmphasized` mean exactly what they do there.
 *
 * The *interaction* is deliberately not S2's: it's Lightroom's, because that's
 * the muscle memory the people using esque already have. Centre detent with alt
 * to bypass it, shift to slow the drag, double-click to reset, drag-scrub on the
 * numeric readout.
 */
export interface SliderProps {
  value: number
  min: number
  max: number
  step?: number
  /** Where the fill starts. Defaults to 0 when in range, otherwise `min`. */
  origin?: number
  /** Value restored on double-click. Defaults to `origin`. */
  defaultValue?: number
  disabled?: boolean
  /** CSS background painted onto the track, e.g. a hue ramp. */
  gradient?: string
  /** S2 size scale. Drives the hit box and thumb height, not the track weight. */
  size?: SliderSize
  /** S2 `trackStyle`. `thick` is the 16px trough esque uses everywhere. */
  trackStyle?: 'thin' | 'thick'
  /** S2 `thumbStyle`. `precise` is the narrow 6px pill. */
  thumbStyle?: 'default' | 'precise'
  /** S2 `isEmphasized` — fills the track in the accent colour. */
  isEmphasized?: boolean
  /** Spacing along the track. Defaults to linear. */
  scale?: SliderScale
  onChange: (value: number) => void
  /** Fired once when a drag gesture ends, so history records one step per drag. */
  onCommit?: (value: number) => void
  className?: string
  'aria-label'?: string
}

export type SliderSize = 'S' | 'M' | 'L' | 'XL'

/**
 * How values are spaced along the track.
 *
 * Most sliders are linear, because most of what they control is. A few are
 * not: colour temperature in Kelvin crams every temperature a photograph is
 * shot under into the first eighth of its range. A scale keeps the stored
 * value honest — the readout, keyboard steps and history all stay in real
 * units — and only changes where the knob sits.
 */
export interface SliderScale {
  /** Value to position along the track, 0 at `min` and 1 at `max`. */
  toPosition(value: number, min: number, max: number): number
  /** The inverse, for turning a pointer position back into a value. */
  fromPosition(frac: number, min: number, max: number): number
}

const LINEAR: SliderScale = {
  toPosition: (v, min, max) => (v - min) / (max - min),
  fromPosition: (f, min, max) => min + f * (max - min),
}

/**
 * The value a keystroke asks for, or null when the key is not the slider's.
 *
 * Steps are taken in real units rather than along the track, so the arrows stay
 * the precise tool even where the track is spaced non-linearly.
 */
function keyedValue(
  e: React.KeyboardEvent,
  value: number,
  min: number,
  max: number,
  step: number,
): number | null {
  const big = step * (e.shiftKey ? 10 : 1)
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') return value - big
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') return value + big
  if (e.key === 'Home') return min
  if (e.key === 'End') return max
  return null
}

/** Width of the thumb's hit box per S2 size, used to detect a knob grab. */
const THUMB_BOX: Record<SliderSize, number> = { S: 18, M: 20, L: 22, XL: 24 }

/** Visual width of the knob. The thumb's travel is inset by half of it at each
 *  end so the knob never hangs off the trough at min or max. */
const PRECISE_THUMB_W = 6

export function Slider({
  value,
  min,
  max,
  step = 1,
  origin,
  defaultValue,
  disabled,
  gradient,
  size = 'M',
  trackStyle = 'thick',
  thumbStyle = 'precise',
  isEmphasized,
  scale = LINEAR,
  onChange,
  onCommit,
  className,
  'aria-label': ariaLabel,
}: SliderProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const drag = useRef({ startX: 0, startValue: 0, moved: false })

  const zero = origin ?? (min <= 0 && max >= 0 ? 0 : min)
  const resetTo = defaultValue ?? zero

  // The knob is a real object with width, so its centre can only travel between
  // half a knob in from each end. Pointer maths and paint both work off that
  // inset range, otherwise a value of `min` puts half the knob outside the
  // trough and every reading is off by a few pixels.
  const thumbW = thumbStyle === 'precise' ? PRECISE_THUMB_W : THUMB_BOX[size]
  const travel = (frac: number) => `calc(${thumbW / 2}px + (100% - ${thumbW}px) * ${frac})`

  const frac = (v: number) => clamp(scale.toPosition(clamp(v, min, max), min, max), 0, 1)
  const knobFrac = frac(value)
  const zeroFrac = frac(zero)
  const fillFrac = Math.min(knobFrac, zeroFrac)
  const fillSpan = Math.abs(knobFrac - zeroFrac)

  /** Value under a client X, in the knob's inset coordinate space. */
  const valueAt = (clientX: number, rect: DOMRect) => {
    const usable = Math.max(1, rect.width - thumbW)
    return scale.fromPosition(clamp((clientX - rect.left - thumbW / 2) / usable, 0, 1), min, max)
  }

  const commitValue = useCallback(
    (next: number, snap: boolean) => {
      let v = clamp(next, min, max)
      // Detent: a small magnetic zone around the origin so "back to zero" is easy
      // to hit by hand. Alt bypasses it for deliberate near-zero values. It is
      // measured along the track rather than in value space, so it stays the
      // same few pixels wide on a slider that is not linear.
      const reach = Math.abs(
        scale.toPosition(v, min, max) - scale.toPosition(clamp(zero, min, max), min, max),
      )
      if (snap && reach < 0.012) v = zero
      onChange(quantize(v, step))
    },
    [max, min, onChange, scale, step, zero],
  )

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return
    const el = trackRef.current
    if (!el) return
    e.preventDefault()
    el.setPointerCapture(e.pointerId)

    const rect = el.getBoundingClientRect()
    const knobX = rect.left + thumbW / 2 + knobFrac * (rect.width - thumbW)
    const onKnob = Math.abs(e.clientX - knobX) <= THUMB_BOX[size] / 2

    let startValue = value
    if (!onKnob) {
      // Clicking the track jumps the knob under the cursor, then drags from there.
      startValue = valueAt(e.clientX, rect)
      commitValue(startValue, !e.altKey)
    }
    drag.current = { startX: e.clientX, startValue, moved: false }
    setDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return
    const el = trackRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const dx = e.clientX - drag.current.startX
    if (Math.abs(dx) > 1) drag.current.moved = true
    // Shift slows the gesture down for precision work at high zoom.
    const speed = e.shiftKey ? 0.18 : 1
    const usable = Math.max(1, rect.width - thumbW)
    // The drag is measured along the track, not in value space, so the knob
    // keeps up with the pointer whatever the scale is doing underneath.
    const from = scale.toPosition(clamp(drag.current.startValue, min, max), min, max)
    const next = scale.fromPosition(clamp(from + (dx / usable) * speed, 0, 1), min, max)
    commitValue(next, !e.altKey)
  }

  const endDrag = (e: React.PointerEvent) => {
    if (!dragging) return
    const el = trackRef.current
    if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    setDragging(false)
    onCommit?.(value)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return
    const next = keyedValue(e, value, min, max, step)
    if (next === null) return
    e.preventDefault()
    commitValue(next, false)
    onCommit?.(clamp(next, min, max))
  }

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-disabled={disabled || undefined}
      className={cn('esq-slider', className)}
      data-size={size}
      data-track={trackStyle}
      data-thumb={thumbStyle}
      data-active={dragging}
      data-disabled={disabled}
      data-emphasized={isEmphasized ? 'true' : undefined}
      data-gradient={gradient ? 'true' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        if (disabled || drag.current.moved) return
        onChange(resetTo)
        onCommit?.(resetTo)
      }}
    >
      <SliderTrack
        gradient={gradient}
        zero={zero}
        min={min}
        max={max}
        zeroFrac={zeroFrac}
        fillFrac={fillFrac}
        fillSpan={fillSpan}
        travel={travel}
      />
      <div className="esq-slider__thumb" style={{ left: travel(knobFrac) }}>
        <div className="esq-slider__knob" />
      </div>
    </div>
  )
}

/** The trough: a colour ramp or a fill grown from the slider's zero. */
function SliderTrack({
  gradient,
  zero,
  min,
  max,
  zeroFrac,
  fillFrac,
  fillSpan,
  travel,
}: {
  gradient?: string
  zero: number
  min: number
  max: number
  zeroFrac: number
  fillFrac: number
  fillSpan: number
  travel: (frac: number) => string
}) {
  return (
    <div className="esq-slider__track" style={gradient ? { background: gradient } : undefined}>
      {/* A bipolar fill already shows where neutral is, so the tick only earns
          its place on gradient ramps, which have no fill. */}
      {gradient && zero > min && zero < max && (
        <div className="esq-slider__detent" style={{ left: travel(zeroFrac) }} />
      )}
      <div
        className="esq-slider__fill"
        style={{
          // Pinned flush to the trough's end when the fill runs all the way
          // there, so an origin-at-min slider has no dead gap.
          left: fillFrac <= 0.0001 ? 0 : travel(fillFrac),
          right:
            fillFrac + fillSpan >= 0.9999
              ? 0
              : `calc(100% - ${travel(fillFrac + fillSpan)})`,
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------

export interface NumberFieldProps {
  value: number
  min: number
  max: number
  step?: number
  precision?: number
  suffix?: string
  disabled?: boolean
  /** Matches the slider's spacing, so scrubbing and dragging move together. */
  scale?: SliderScale
  onChange: (value: number) => void
  onCommit?: (value: number) => void
}

/**
 * The numeric readout beside a slider. Dragging it horizontally scrubs the value
 * — the fastest way to make a small, precise change without hunting for the knob.
 */
export function NumberField({
  value,
  min,
  max,
  step = 1,
  precision,
  suffix = '',
  disabled,
  scale = LINEAR,
  onChange,
  onCommit,
}: NumberFieldProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const drag = useRef({ x: 0, start: 0, active: false, moved: false })

  const decimals =
    precision ?? Math.min(3, (String(step).split('.')[1] ?? '').length)

  const display = `${value > 0 && (min < 0 || step < 1) ? '+' : ''}${value.toFixed(decimals)}${suffix}`

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const finish = () => {
    const parsed = parseFloat(draft.replace(',', '.'))
    setEditing(false)
    if (!isNaN(parsed)) {
      const v = quantize(clamp(parsed, min, max), step)
      onChange(v)
      onCommit?.(v)
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled || editing || e.button !== 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, start: value, active: true, moved: false }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current.active) return
    const dx = e.clientX - drag.current.x
    if (Math.abs(dx) < 2) return
    drag.current.moved = true
    // A fraction of the track per pixel, so the scrub covers the same ground
    // the knob would and stays usable on a non-linear scale.
    const rate = (e.shiftKey ? 0.05 : 0.4) * 0.01
    const from = scale.toPosition(clamp(drag.current.start, min, max), min, max)
    const next = scale.fromPosition(clamp(from + dx * rate, 0, 1), min, max)
    onChange(quantize(clamp(next, min, max), step))
  }

  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag.current.active) return
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    const { moved } = drag.current
    drag.current.active = false
    if (moved) onCommit?.(value)
    else setEditing(true)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="esq-num w-14 outline-none"
        data-editing="true"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={finish}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish()
          if (e.key === 'Escape') setEditing(false)
          e.stopPropagation()
        }}
      />
    )
  }

  return (
    <button
      type="button"
      className={cn('esq-num esq-tap', disabled && 'pointer-events-none opacity-35')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onFocus={() => setDraft(value.toFixed(decimals))}
      onClick={() => setDraft(value.toFixed(decimals))}
      tabIndex={disabled ? -1 : 0}
    >
      {display}
    </button>
  )
}

// ---------------------------------------------------------------------------

export interface SliderRowProps extends Omit<SliderProps, 'aria-label'> {
  label: string
  suffix?: string
  precision?: number
  /** Renders the label in accent colour to flag a non-default value. */
  modified?: boolean
  /** Built lazily on right-click, so a panel of sliders costs nothing to mount. */
  menuItems?: (ctx: { reset: number }) => MenuItem[]
}

/** Label + value + track, the unit every Develop panel is built from. */
export function SliderRow({
  label,
  suffix,
  precision,
  modified,
  menuItems,
  ...slider
}: SliderRowProps) {
  const reset = slider.defaultValue ?? slider.origin ?? 0
  const { menu, open } = useMenu()
  const doReset = () => {
    slider.onChange(reset)
    slider.onCommit?.(reset)
  }
  /*
   * Resetting one slider was double-click only, which touch cannot express, so
   * the row always carries its own reset ahead of whatever the panel adds. Long
   * press raises this same menu on touch.
   */
  const rowMenu = (): MenuItem[] => {
    const own: MenuItem[] = [
      {
        kind: 'item',
        label: `Reset ${label}`,
        icon: <ResetIcon size={MENU_ICON} />,
        disabled: slider.disabled,
        onSelect: doReset,
      },
    ]
    const extra = menuItems?.({ reset })
    return extra?.length ? [...own, { kind: 'separator' }, ...extra] : own
  }
  return (
    <div className="group/row select-none" onContextMenu={(e) => open(e, rowMenu())}>
      {/* S2's field layout: label start, output end, track full-width below. */}
      <div className="grid grid-cols-[1fr_auto] items-baseline gap-2">
        <button
          type="button"
          className={cn(
            'esq-tap truncate text-left text-mini transition-colors duration-[--duration-fast]',
            modified ? 'text-label' : 'text-label-secondary',
            'group-hover/row:text-label',
            slider.disabled && 'opacity-35',
          )}
          title={`${label}: double-click to reset`}
          onDoubleClick={doReset}
        >
          {label}
        </button>
        <NumberField
          value={slider.value}
          min={slider.min}
          max={slider.max}
          step={slider.step}
          precision={precision}
          suffix={suffix}
          disabled={slider.disabled}
          scale={slider.scale}
          onChange={slider.onChange}
          onCommit={slider.onCommit}
        />
      </div>
      <Slider {...slider} aria-label={label} />
      {menu}
    </div>
  )
}
