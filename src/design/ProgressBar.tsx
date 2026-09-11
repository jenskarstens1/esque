import { clamp01 } from '../lib/math'

export function ProgressBar({
  label,
  value,
  detail,
}: {
  label: string
  /** Completed fraction, from 0 to 1. */
  value: number
  detail?: string
}) {
  const progress = clamp01(value)
  const percent = Math.round(progress * 100)

  return (
    <div className="flex w-full min-w-0 flex-col gap-2 py-1">
      <div className="flex min-w-0 items-baseline justify-between gap-3 text-mini leading-snug tabular-nums">
        <span className="min-w-0 text-label-secondary">{detail ?? label}</span>
        <span className="w-[4ch] shrink-0 text-right font-medium text-label" aria-hidden="true">
          {percent}%
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={detail ? `${percent}%, ${detail}` : `${percent}%`}
        className="h-1.5 overflow-hidden rounded-full bg-slider-track shadow-[inset_0_1px_2px_rgb(0_0_0/0.16)]"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-(--duration-base) ease-(--ease-out) motion-reduce:transition-none"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    </div>
  )
}
