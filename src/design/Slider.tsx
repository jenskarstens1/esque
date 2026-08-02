import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn'
import { clamp, quantize } from '../lib/math'
import { useMenu } from './useMenu'
import type { MenuItem } from './Menu'

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
  onChange: (value: number) => void
  /** Fired once when a drag gesture ends, so history records one step per drag. */
  onCommit?: (value: number) => void
  className?: string
  'aria-label'?: string
}

export type SliderSize = 'S' | 'M' | 'L' | 'XL'

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

  const frac = (v: number) => (clamp(v, min, max) - min) / (max - min)
  const knobFrac = frac(value)
  const zeroFrac = frac(zero)
  const fillFrac = Math.min(knobFrac, zeroFrac)
  const fillSpan = Math.abs(knobFrac - zeroFrac)

  /** Value under a client X, in the knob's inset coordinate space. */
  const valueAt = (clientX: number, rect: DOMRect) => {
    const usable = Math.max(1, rect.width - thumbW)
    return min + ((clientX - rect.left - thumbW / 2) / usable) * (max - min)
  }

  const commitValue = useCallback(
    (next: number, snap: boolean) => {
      let v = clamp(next, min, max)
      // Detent: a small magnetic zone around the origin so "back to zero" is easy
      // to hit by hand. Alt bypasses it for deliberate near-zero values.
      if (snap && Math.abs(v - zero) < (max - min) * 0.012) v = zero
      onChange(quantize(v, step))
    },
    [max, min, onChange, step, zero],
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
    const scale = e.shiftKey ? 0.18 : 1
    const usable = Math.max(1, rect.width - thumbW)
    const next = drag.current.startValue + (dx / usable) * (max - min) * scale
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
    const big = e.shiftKey ? 10 : 1
    let next: number | null = null
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = value - step * big
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = value + step * big
    else if (e.key === 'Home') next = min
    else if (e.key === 'End') next = max
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
      <div className="esq-slider__thumb" style={{ left: travel(knobFrac) }}>
        <div className="esq-slider__knob" />
      </div>
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
    const sensitivity = (e.shiftKey ? 0.05 : 0.4) * (max - min) * 0.01
    onChange(quantize(clamp(drag.current.start + dx * sensitivity, min, max), step))
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
      className={cn('esq-num', disabled && 'pointer-events-none opacity-35')}
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
  return (
    <div
      className="group/row select-none"
      onContextMenu={menuItems ? (e) => open(e, menuItems({ reset })) : undefined}
    >
      {/* S2's field layout: label start, output end, track full-width below. */}
      <div className="grid grid-cols-[1fr_auto] items-baseline gap-2">
        <button
          type="button"
          className={cn(
            'truncate text-left text-mini transition-colors duration-[--duration-fast]',
            modified ? 'text-label' : 'text-label-secondary',
            'group-hover/row:text-label',
            slider.disabled && 'opacity-35',
          )}
          title={`${label} — double-click to reset`}
          onDoubleClick={() => {
            slider.onChange(reset)
            slider.onCommit?.(reset)
          }}
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
          onChange={slider.onChange}
          onCommit={slider.onCommit}
        />
      </div>
      <Slider {...slider} aria-label={label} />
      {menu}
    </div>
  )
}
