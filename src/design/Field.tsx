import { useId, type ReactNode } from 'react'
import { cn } from '../lib/cn'

/**
 * The settings-row vocabulary shared by every dialog: a titled group of
 * labelled fields.
 *
 * The label column is left aligned and fixed in width, so a whole dialog —
 * section titles, labels, hints — reads down one edge instead of against a
 * ragged right-hand gutter, and controls line up in a second column no matter
 * how long a label runs.
 *
 * That column has a *measure*, not just a start. Left free, every row invented
 * its own width: a select stopped at 176px, the text field on the next row ran
 * the full 880, and the column had no right edge to read down at all.
 * `--field-measure` is declared once per dialog and every control spans exactly
 * it — one select, one text field, a slider with its readout, two controls
 * sharing a row — so the column closes on both sides. Hints wrap inside the
 * same measure instead of trailing off across the dialog.
 */

export function Field({
  label,
  hint,
  children,
  className,
}: {
  /** Omit for a continuation row: the control lines up under the column above. */
  label?: string
  hint?: ReactNode
  children: ReactNode
  className?: string
}) {
  const labelId = useId()
  return (
    <div
      role={label ? 'group' : undefined}
      aria-labelledby={label ? labelId : undefined}
      className={cn(
        'grid grid-cols-[var(--field-label-width,116px)_minmax(0,1fr)] items-center gap-x-3 py-1',
        className,
      )}
    >
      {label && <span id={labelId} className="text-ui text-label-secondary">{label}</span>}
      <div className="col-start-2 flex w-full max-w-(--field-measure) min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2">
        {children}
      </div>
      {hint && (
        <p className="col-start-2 mt-1 max-w-(--field-measure) text-mini leading-relaxed text-pretty text-label-secondary [overflow-wrap:anywhere]">
          {hint}
        </p>
      )}
    </div>
  )
}

export function FieldGroup({
  title,
  label,
  aside,
  children,
  className,
}: {
  title?: string
  /**
   * Names the group for assistive tech where the rows read plainly enough that
   * a visible eyebrow would only be repeating them.
   */
  label?: string
  /**
   * A control that governs the whole group rather than one row — a watermark's
   * on/off, say. It lands on the trailing edge of the control measure, which
   * reads as "this block" instead of borrowing a field row and knocking the
   * row's own control off the column.
   */
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      aria-label={label ?? title}
      className={cn('py-4 first:pt-0 last:pb-0 [&+&]:hairline-t', className)}
    >
      {(title || aside) && (
        <div className="mb-2 flex min-h-6 items-center justify-between gap-3">
          {title && <h3 className="text-ui font-medium text-label">{title}</h3>}
          {aside && <div className="ml-auto flex shrink-0 items-center">{aside}</div>}
        </div>
      )}
      {children}
    </section>
  )
}
