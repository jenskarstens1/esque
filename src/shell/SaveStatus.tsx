import { Button } from '../design/Controls'
import { Spinner } from '../design/Spinner'
import { WarningIcon } from '../design/icons'
import { useDevelop } from '../develop/session'

export function SaveStatus() {
  const status = useDevelop((s) => s.saveStatus)
  const error = useDevelop((s) => s.saveError)
  const count = useDevelop((s) => s.pendingSaveCount)
  const retry = useDevelop((s) => s.retrySave)

  if (status === 'saved') return null

  return (
    <div className="flex min-w-0 items-center gap-2 text-mini" role="status" aria-live="polite">
      {status === 'error' ? (
        <>
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
        </>
      ) : (
        <>
          <Spinner size={11} className="shrink-0 text-label-tertiary" />
          <span className="text-label-secondary">Saving…</span>
        </>
      )}
    </div>
  )
}
