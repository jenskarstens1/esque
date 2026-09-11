import { forwardRef, useEffect, useRef, useState, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '../lib/cn'

const focusRing =
  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel'

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type Variant = 'primary' | 'secondary' | 'ghost' | 'destructive'
type Size = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: ReactNode
  full?: boolean
}

const variants: Record<Variant, string> = {
  primary:
    'bg-accent text-(--accent-ink) hover:bg-accent-hover active:bg-accent-press shadow-[0_1px_2px_rgb(0_0_0/0.3)]',
  secondary:
    'bg-control text-label hover:bg-hover active:bg-active shadow-[0_1px_2px_rgb(0_0_0/0.25),inset_0_0.5px_0_rgb(255_255_255/0.07)]',
  ghost: 'text-icon-secondary hover:bg-raised hover:text-icon active:bg-control',
  destructive: 'bg-red text-white hover:brightness-110 active:brightness-95',
}

/*
 * The coarse sizes target the 44px minimum touch target. Where shrinking the
 * ink matters more than the box (`sm`, inside dense panel rows), `esq-tap`
 * extends the hit area with a pseudo-element instead of inflating the layout.
 */
const sizes: Record<Size, string> = {
  sm: 'h-6 coarse:h-8 esq-tap px-2 coarse:px-3 text-mini rounded-sm gap-1',
  md: 'h-7 coarse:h-11 px-3 coarse:px-4 text-ui rounded-md gap-1.5',
  lg: 'h-9 coarse:h-11 px-4 coarse:px-5 text-ui-lg rounded-lg gap-2',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, full, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap',
        'transition-[background-color,color,filter,scale] duration-[--duration-fast] ease-[--ease-out]',
        'active:scale-[0.96] disabled:pointer-events-none disabled:opacity-35',
        focusRing,
        variants[variant],
        sizes[size],
        full && 'w-full',
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
})

// ---------------------------------------------------------------------------
// Icon button
// ---------------------------------------------------------------------------

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  active?: boolean
  size?: 'sm' | 'md'
}

/** Shared between the button and its anchor twin, so a link never drifts from
 *  the controls it sits beside. */
const iconChrome = (size: 'sm' | 'md', active?: boolean) =>
  cn(
    'inline-flex shrink-0 items-center justify-center rounded-md',
    'transition-[background-color,color,scale] duration-[--duration-fast] ease-[--ease-out]',
    'active:scale-[0.96]',
    focusRing,
    size === 'sm' ? 'size-6' : 'size-7',
    /*
     * 24 and 28px are right for a dense pro sidebar and far under the 44pt a
     * fingertip needs. `esq-tap` grows the *hit box* to 44px on coarse pointers
     * with a transparent pseudo-element, so the drawing stays exactly where the
     * layout put it and a mouse keeps the tight geometry.
     */
    'esq-tap',
    active ? 'bg-accent-soft text-accent' : 'text-icon-secondary hover:bg-raised hover:text-icon',
  )

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, size = 'md', className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        iconChrome(size, active),
        'disabled:pointer-events-none disabled:opacity-30',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
})

export interface IconLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  label: string
  size?: 'sm' | 'md'
}

/**
 * The icon button's twin for destinations rather than actions. A real anchor,
 * so middle-click, ⌘-click and "copy link" all behave the way the rest of the
 * web does. A `<button>` with a `window.open` quietly takes all of that away.
 */
export const IconLink = forwardRef<HTMLAnchorElement, IconLinkProps>(function IconLink(
  { label, size = 'md', className, children, ...rest },
  ref,
) {
  return (
    <a
      ref={ref}
      title={label}
      aria-label={label}
      className={cn(iconChrome(size), className)}
      {...rest}
    >
      {children}
    </a>
  )
})

// ---------------------------------------------------------------------------
// Segmented control
// ---------------------------------------------------------------------------

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  title?: string
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  full,
  className,
}: {
  options: SegmentedOption<T>[]
  value: T
  onChange: (v: T) => void
  size?: 'sm' | 'md'
  full?: boolean
  className?: string
}) {
  return (
    <div
      role="tablist"
      className={cn(
        'relative inline-flex shrink-0 items-center bg-raised p-0.5',
        'shadow-[inset_0_0.5px_1.5px_rgb(0_0_0/0.28)]',
        // Concentric with the chip inside: chip radius + the 2px of track.
        size === 'sm' ? 'rounded-lg' : 'rounded-md',
        full && 'w-full',
        className,
      )}
    >
      {options.map((opt) => {
        const selected = opt.value === value
        return (
          <button
            key={opt.value}
            role="tab"
            type="button"
            title={opt.title}
            aria-selected={selected}
            onClick={() => onChange(opt.value)}
            className={cn(
              'relative flex flex-1 items-center justify-center whitespace-nowrap font-medium',
              'transition-[color,background-color,box-shadow] duration-[--duration-fast] ease-[--ease-out]',
              focusRing,
              /*
               * The `sm` chip is sized to the `sm` Select's box, not to the
               * track's. The two carry the same fill and stand side by side in
               * the photo toolbar, so those are the edges the eye pairs up; the
               * track is nine levels off the chrome behind it and reads as a
               * shadow rather than as the control's height. Matching the track
               * instead leaves the lit chip 4px short and the row looks ragged.
               */
              size === 'sm'
                ? 'h-6 coarse:h-8 esq-tap rounded-md px-2 text-micro'
                : 'h-6 coarse:h-11 rounded-[5px] px-2.5 text-mini',
              selected
                ? // The fill alone is nine levels of grey off the track it sits
                  // in — enough to read as a tint, not as an edge. The hairline
                  // is what draws the chip's own outline, and it flips with the
                  // appearance so the same rule works on a light track.
                  cn(
                    'bg-control text-icon',
                    'shadow-[0_0_0_0.5px_var(--color-hairline-strong),0_1px_2.5px_rgb(0_0_0/0.32),inset_0_0.5px_0_rgb(255_255_255/0.1)]',
                  )
                : // Unselected segments had no hit state at all beyond the label
                  // changing colour, so the target you were aiming at was
                  // invisible until you landed on it.
                  'text-icon-secondary hover:bg-hover/45 hover:text-icon',
            )}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

export function Switch({
  checked,
  onChange,
  label,
  showLabel,
  disabled,
  className,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
  /**
   * Renders `label` beside the toggle. A switch whose row label names the
   * setting ("HDR preview") needs nothing more, but one that selects between
   * two named things ("Progressive" encoding) has to say which — otherwise a
   * sighted user gets a bare toggle and only the screen reader is told.
   */
  showLabel?: boolean
  disabled?: boolean
  className?: string
}) {
  const track = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={showLabel ? undefined : label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'esq-tap relative h-[15px] w-[26px] shrink-0 rounded-full transition-colors duration-[--duration-base] ease-[--ease-out]',
        'disabled:pointer-events-none disabled:opacity-35',
        focusRing,
        checked ? 'bg-accent' : 'bg-control shadow-[inset_0_0.5px_1px_rgb(0_0_0/0.3)]',
        !showLabel && className,
      )}
    >
      {/*
       * `left` is set explicitly. A button centres its contents, so an absolute
       * child given only `top` resolves its static position to the middle of
       * the track — the travel would then start from the centre and carry the
       * thumb clean off the right edge.
       */}
      <span
        className={cn(
          'absolute top-[2px] left-[2px] size-[11px] rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.4)]',
          'transition-[translate] duration-[--duration-base] ease-[--ease-out]',
          checked && 'translate-x-[11px]',
        )}
      />
    </button>
  )

  if (!showLabel) return track

  return (
    <label
      className={cn(
        'inline-flex min-w-0 items-center gap-2 text-ui text-label-secondary',
        disabled ? 'pointer-events-none opacity-35' : 'hover:text-label',
        className,
      )}
    >
      {track}
      <span className="truncate">{label}</span>
    </label>
  )
}

/** Lightroom's panel on/off toggle — the little switch left of a section title. */
export function PanelSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
      className={cn(
        'flex size-4 items-center justify-center rounded-xs transition-colors duration-[--duration-fast]',
        checked ? 'text-accent' : 'text-icon-quaternary hover:text-icon-tertiary',
      )}
    >
      <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
        <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.3" />
        {checked && <circle cx="6" cy="6" r="2" fill="currentColor" />}
      </svg>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Checkbox
// ---------------------------------------------------------------------------

export function Checkbox({
  checked,
  indeterminate,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  indeterminate?: boolean
  onChange: (v: boolean) => void
  label?: ReactNode
  disabled?: boolean
}) {
  return (
    <label
      className={cn(
        'inline-flex items-center gap-2 text-ui text-label-secondary coarse:min-h-9',
        disabled ? 'pointer-events-none opacity-35' : 'hover:text-label',
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={indeterminate ? 'mixed' : checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'esq-tap flex size-[14px] shrink-0 items-center justify-center rounded-xs',
          'transition-[background-color,box-shadow] duration-[--duration-fast] ease-[--ease-out]',
          focusRing,
          checked || indeterminate
            ? 'bg-accent shadow-none'
            : 'bg-control shadow-[inset_0_0.5px_1px_rgb(0_0_0/0.3)]',
        )}
      >
        {indeterminate ? (
          <span className="h-[1.5px] w-2 rounded-full bg-(--accent-ink)" />
        ) : checked ? (
          <svg viewBox="0 0 12 12" className="size-3 text-(--accent-ink)" aria-hidden>
            <path
              d="M2.5 6.2 L4.8 8.5 L9.5 3.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </button>
      {label}
    </label>
  )
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

export function Select<T extends string>({
  value,
  onChange,
  options,
  disabled,
  className,
  size = 'md',
  'aria-label': ariaLabel,
}: {
  value: T
  onChange: (v: T) => void
  options: Array<{ value: T; label: string } | { group: string }>
  disabled?: boolean
  className?: string
  size?: 'sm' | 'md'
  'aria-label'?: string
}) {
  return (
    <div className={cn('relative inline-flex min-w-0', className)}>
      <select
        value={value}
        aria-label={ariaLabel}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
        className={cn(
          'w-full min-w-0 cursor-default appearance-none truncate rounded-md bg-control pr-6 pl-2 font-medium text-label',
          'shadow-[0_1px_2px_rgb(0_0_0/0.25),inset_0_0.5px_0_rgb(255_255_255/0.07)]',
          'transition-colors duration-[--duration-fast] hover:bg-hover',
          'disabled:pointer-events-none disabled:opacity-35',
          focusRing,
          size === 'sm' ? 'h-6 coarse:h-9 esq-tap text-mini' : 'h-7 coarse:h-11 text-ui',
        )}
      >
        {options.map((o, i) =>
          'group' in o ? (
            <optgroup key={`g${i}`} label={o.group} />
          ) : (
            <option key={o.value} value={o.value} className="bg-panel">
              {o.label}
            </option>
          ),
        )}
      </select>
      <svg
        viewBox="0 0 10 12"
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-1.5 size-2.5 -translate-y-1/2 text-icon-tertiary"
      >
        <path
          d="M2.5 4.6 L5 2.2 L7.5 4.6 M2.5 7.4 L5 9.8 L7.5 7.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}

/**
 * Plain text input sharing Select's well.
 *
 * Numeric mode commits on blur or Enter and clamps to range, so a half-typed
 * value never reaches the store mid-keystroke.
 */
export function TextField({
  value,
  onChange,
  placeholder,
  disabled,
  className,
  style,
  size = 'md',
  mono,
  numeric,
  min,
  max,
  'aria-label': ariaLabel,
  autoFocus,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  style?: React.CSSProperties
  size?: 'sm' | 'md'
  mono?: boolean
  numeric?: boolean
  min?: number
  max?: number
  'aria-label'?: string
  autoFocus?: boolean
}) {
  const [draft, setDraft] = useState(value)
  const dirty = useRef(false)
  useEffect(() => {
    if (!dirty.current) setDraft(value)
  }, [value])

  const commit = () => {
    dirty.current = false
    if (!numeric) return onChange(draft)
    const n = Number(draft)
    if (!Number.isFinite(n)) return setDraft(value)
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n))
    setDraft(String(clamped))
    onChange(String(clamped))
  }

  return (
    <input
      value={draft}
      aria-label={ariaLabel}
      autoFocus={autoFocus}
      placeholder={placeholder}
      disabled={disabled}
      style={style}
      inputMode={numeric ? 'numeric' : undefined}
      data-size={size === 'sm' ? 'sm' : undefined}
      onChange={(e) => {
        dirty.current = true
        setDraft(e.target.value)
        if (!numeric) onChange(e.target.value)
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          // Blur is how Enter normally commits, but inside a form it also
          // cancels the browser's implicit submission — the field stops being
          // the focused control before the default action runs. Commit in
          // place instead and let the form's own submit handler continue.
          if (e.currentTarget.form) commit()
          else e.currentTarget.blur()
        }
        if (e.key === 'Escape') {
          setDraft(value)
          dirty.current = false
          e.currentTarget.blur()
        }
      }}
      className={cn('esq-field', (mono || numeric) && 'font-mono', numeric && 'esq-field--numeric', className)}
    />
  )
}
