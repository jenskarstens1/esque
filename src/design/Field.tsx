import type { ReactNode } from 'react'
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
  return (
    <div
      className={cn('grid grid-cols-[116px_1fr] items-center gap-x-3 py-[3px]', className)}
    >
      {label && <span className="truncate text-ui text-label-secondary">{label}</span>}
      <div className="col-start-2 flex max-w-(--field-measure) min-w-0 items-center gap-2.5">
        {children}
      </div>
      {hint && (
        <p className="col-start-2 mt-1 max-w-(--field-measure) text-mini leading-[1.45] text-balance text-label-secondary">
          {hint}
        </p>
      )}
    </div>
  )
}

export function FieldGroup({
  title,
  aside,
  children,
  className,
}: {
  title?: string
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
    // Adjacent groups divide themselves, so the first and last never draw a
    // hairline against the dialog's own header and footer rules.
    <section className={cn('pt-5 pb-4 first:pt-1 [&+&]:hairline-t', className)}>
      {/* The eyebrow belongs to the rows under it, not to the group it was just
          divided from, so it carries more air above than below. */}
      {title && (
        <div className="mb-2.5 grid grid-cols-[116px_1fr] items-center gap-x-3">
          <h3 className="esq-section-title">{title}</h3>
          {aside && (
            <div className="col-start-2 flex max-w-(--field-measure) justify-end">{aside}</div>
          )}
        </div>
      )}
      {children}
    </section>
  )
}
