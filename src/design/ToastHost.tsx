import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn'
import { WarningIcon } from './icons'
import { holdToasts, releaseToasts, snapshot, subscribe, toast } from './toast'

/**
 * Transient notices, stacked bottom-centre in the same column as the import HUD.
 *
 * Nothing here is colour-coded by status: the sentence is the status. Only a
 * failure is marked, with the same warning glyph the rest of the app uses,
 * because that is the one message a user must not scroll past.
 */
export function ToastHost() {
  const items = useSyncExternalStore(subscribe, snapshot, snapshot)

  return createPortal(
    // The column is mounted for the life of the app, empty or not: a live
    // region announces nothing if it arrives in the DOM already full.
    <div
      aria-live="polite"
      aria-atomic="false"
      onPointerEnter={holdToasts}
      onPointerLeave={releaseToasts}
      className={cn(
        'pointer-events-none fixed inset-x-0 z-[1200] flex flex-col items-center',
        // Rides above the import HUD while a folder is being read.
        'bottom-[calc(1.5rem_+_var(--esq-hud-clear,0px))]',
        'transition-[bottom] duration-[--duration-base] ease-[--ease-out]',
      )}
    >
      {items.map((t) => (
        // Collapsing the grid row on the way out is what lets the stack close
        // the gap smoothly instead of the surviving toasts jumping into place.
        <div
          key={t.id}
          className={cn(
            'grid transition-[grid-template-rows] duration-[--duration-fast] ease-[--ease-out]',
            t.closing ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
          )}
        >
          <div className="overflow-hidden pt-2">
            <div
              data-tone={t.tone}
              onClick={() => toast.dismiss(t.id)}
              className={cn(
                'material-thick pointer-events-auto flex w-[340px] items-start gap-2',
                'rounded-xl px-3.5 py-2.5 shadow-lg',
                'transition-[opacity,scale] duration-[--duration-fast] ease-[--ease-out]',
                t.closing
                  ? 'scale-[0.98] opacity-0'
                  : 'animate-[esq-toast-in_var(--duration-base)_var(--ease-out)]',
              )}
            >
              {t.tone === 'error' && (
                <WarningIcon size={14} className="mt-0.5 shrink-0 text-red" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-ui text-label">{t.message}</div>
                {/* Wrapped, not truncated: a failure detail is often a raw
                    message from the filesystem and has to stay readable. */}
                {t.detail && (
                  <div className="mt-0.5 line-clamp-3 text-mini text-label-secondary">
                    {t.detail}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>,
    document.body,
  )
}
