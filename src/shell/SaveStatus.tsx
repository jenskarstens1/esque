import { Button } from '../design/Controls'
import { WarningIcon } from '../design/icons'
import { useDevelop } from '../develop/session'

/**
 * The save indicator.
 *
 * Only failure is worth a row. Saving is the expected outcome of every slider
 * move, so a spinner announcing it fires on each edit and flickers through the
 * panel without ever telling the photographer something they did not already
 * assume — it reads as clutter, not as reassurance. A save that does *not*
 * land is the one case they cannot infer, and it stays, with the retry.
 */
export function SaveStatus() {
  const status = useDevelop((s) => s.saveStatus)
  const error = useDevelop((s) => s.saveError)
  const count = useDevelop((s) => s.pendingSaveCount)
  const retry = useDevelop((s) => s.retrySave)

  if (status !== 'error') return null

  return (
    <div className="flex min-w-0 items-center gap-2 text-mini" role="status" aria-live="polite">
      <WarningIcon className="size-3.5 shrink-0 text-orange" />
      <span className="truncate text-label-secondary" title={error ?? undefined}>
        {count > 1 ? `${count} photos not saved` : 'Edits not saved'}
      </span>
      <span className="sr-only">{error} Your changes are still in this tab.</span>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          void retry().catch(() => {
            // The retained error is already shown here and in a toast.
          })
        }}
      >
        Retry Save
      </Button>
    </div>
  )
}
