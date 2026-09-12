import { useCallback } from 'react'
import { cn } from '../lib/cn'
import { useImporter } from '../state/importer'
import { Button } from '../design/Controls'
import { Spinner } from '../design/Spinner'

/** A calm, centred progress card while a folder is being read. */
export function ImportHUD() {
  const active = useImporter((s) => s.active)
  const cancelling = useImporter((s) => s.cancelling)
  const progress = useImporter((s) => s.progress)
  const batch = useImporter((s) => s.batch)
  const cancel = useImporter((s) => s.cancel)

  /*
   * Both this card and the toast stack live at the bottom centre, so the card
   * publishes the room it needs — its height plus the column gap — and the
   * toasts ride above it instead of landing on top of it.
   */
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const root = document.documentElement
    const ro = new ResizeObserver(() =>
      root.style.setProperty('--esq-hud-clear', `${el.offsetHeight + 8}px`),
    )
    ro.observe(el)
    return () => {
      ro.disconnect()
      root.style.removeProperty('--esq-hud-clear')
    }
  }, [])

  if (!active || !progress) return null

  const scanning = progress.phase === 'scanning'
  const developing = progress.phase === 'developing'
  const pct = progress.total ? Math.min(1, progress.done / progress.total) : 0
  /*
   * A drop of several folders is several scans, each counting from zero. Naming
   * the one in hand is what keeps that from reading as a progress bar that
   * restarts for no reason.
   */
  const where = batch ? `${batch.done + 1} of ${batch.total}` : ''
  const detail = [where, progress.current].filter(Boolean).join(' · ')

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center sm:bottom-6">
      <div
        ref={measure}
        aria-live="polite"
        aria-busy
        className={cn(
          'material-thick pointer-events-auto w-[340px] rounded-xl px-4 py-3',
          'shadow-[0_20px_60px_-16px_rgb(0_0_0/0.7)]',
        )}
      >
        <div className="flex items-center gap-2.5">
          {/* Was the mark on a slow spin, which worked while it was a centred
              iris. The fan pivots off a corner, so spinning it wobbles — and a
              progress readout wants a progress indicator, not the logo. */}
          <Spinner size={16} className="shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-mini font-medium text-label">
              {cancelling
                ? 'Stopping import…'
                : scanning
                  ? 'Scanning folder…'
                  : developing
                    ? 'Applying import settings'
                    : 'Importing photos'}
            </div>
            <div className="truncate text-micro text-label-tertiary">
              {cancelling
                ? 'Finishing files already in progress'
                : detail ||
                  (scanning ? 'Looking for photos' : developing ? 'Almost done' : '')}
            </div>
          </div>
          <span className="shrink-0 text-mini tnum text-label-secondary">
            {scanning
              ? progress.total
                ? `${progress.total.toLocaleString()} found`
                : ''
              : `${progress.done}/${progress.total}`}
          </span>
        </div>

        <div className="mt-2.5 h-[3px] overflow-hidden rounded-full bg-white/8">
          <div
            className={cn(
              'h-full rounded-full bg-accent',
              scanning
                ? 'w-1/3 animate-[esq-indeterminate_1.4s_ease-in-out_infinite]'
                : 'transition-[width] duration-200 ease-[--ease-out]',
            )}
            style={scanning ? undefined : { width: `${pct * 100}%` }}
          />
        </div>

        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="ghost" onClick={cancel} disabled={cancelling}>
            {cancelling ? 'Stopping…' : 'Cancel'}
          </Button>
        </div>
      </div>
    </div>
  )
}
