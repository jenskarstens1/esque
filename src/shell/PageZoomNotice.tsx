import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn'
import { usePageZoom } from '../lib/pageZoom'
import { formatChord } from './commands'
import { CloseIcon, ZoomIcon } from '../design/icons'

/**
 * The way out of a zoomed page.
 *
 * Every zoom gesture belongs to the photo here, so nothing in the app can
 * change the browser's own zoom — and page zoom is remembered per origin, so a
 * window can open at 150% from a setting made in another tab entirely. The
 * keymap hands the reset chord back to the browser while that is true
 * (`useAppZoomGuard`); this says so, because a released shortcut nobody knows
 * about is not an escape.
 *
 * Dismissal is per-episode rather than permanent: zoom back to 100% and out
 * again and the way out is offered again, which is what someone who dismissed
 * it by reflex needs.
 */
export function PageZoomNotice() {
  const [zoomed, zoom] = usePageZoom()
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!zoomed) setDismissed(false)
  }, [zoomed])

  if (!zoomed || dismissed) return null

  return createPortal(
    <div
      role="status"
      className={cn(
        'pointer-events-none fixed inset-x-0 top-4 z-[1300] flex justify-center px-4',
      )}
    >
      <div
        className={cn(
          'material-solid pointer-events-auto flex max-w-[520px] items-start gap-2.5',
          'rounded-lg py-2.5 pr-2 pl-3.5 ring-[0.5px] ring-hairline-strong ring-inset',
          'animate-[esq-toast-in_var(--duration-base)_var(--ease-out)]',
        )}
      >
        <ZoomIcon size={14} className="mt-0.5 shrink-0 text-label-secondary" />
        <div className="min-w-0 flex-1">
          <div className="text-ui text-label">
            Your browser is zoomed to {Math.round(zoom * 100)}%
          </div>
          <div className="mt-0.5 text-mini text-label-secondary">
            esque draws at 1:1, so page zoom softens the photo. Press{' '}
            {formatChord('mod+0')} or use the browser's View menu to reset it.
          </div>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={() => setDismissed(true)}
          className="-mt-0.5 shrink-0 rounded p-1.5 text-label-secondary hover:text-label"
        >
          <CloseIcon size={12} />
        </button>
      </div>
    </div>,
    document.body,
  )
}
