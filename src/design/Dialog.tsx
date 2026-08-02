import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn'
import { Button } from './Controls'
import { Scroller } from './Scroller'

/** Open dialogs, innermost last — only the top one answers Escape. */
const stack: object[] = []

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 460,
  height,
  dismissable = true,
  scrollable = true,
  dividers,
  bodyClassName,
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  width?: number
  /**
   * Pins the dialog to a fixed height instead of letting content size it, so a
   * panel whose body changes shape doesn't resize under the pointer. Still
   * clamped to the viewport.
   */
  height?: number
  dismissable?: boolean
  /** Set false when the body owns its own scrolling, e.g. a two-column layout. */
  scrollable?: boolean
  /**
   * Whether the header and footer draw a rule. A scrollable body answers this
   * itself by measuring, but a body that owns its own scrolling is opaque to
   * the dialog, so its owner declares it: true where content really does run
   * under the edges, false where the panes always fit.
   */
  dividers?: boolean
  bodyClassName?: string
}) {
  useEffect(() => {
    if (!open || !dismissable) return
    const id = {}
    stack.push(id)
    const onKey = (e: KeyboardEvent) => {
      // A nested dialog owns Escape while it is up, so dismissing it doesn't
      // take its parent down with it.
      if (e.key === 'Escape' && stack[stack.length - 1] === id) {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      stack.splice(stack.indexOf(id), 1)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose, dismissable])

  const [scroll, setScroll] = useState({ top: false, bottom: false })
  // Hairlines only appear when there is content hidden past the edge, so a
  // short dialog stays completely undivided.
  const measure = useCallback((el: HTMLElement | null) => {
    if (!el) return
    const read = () =>
      setScroll({
        top: el.scrollTop > 1,
        bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
      })
    read()
    el.addEventListener('scroll', read, { passive: true })
    const ro = new ResizeObserver(read)
    ro.observe(el)
    for (const child of el.children) ro.observe(child)
  }, [])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[1100] flex items-center justify-center p-8">
      <div
        className="absolute inset-0 bg-scrim backdrop-blur-[2px] animate-[fadeIn_var(--duration-base)_var(--ease-out)]"
        onClick={dismissable ? onClose : undefined}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width, height }}
        className={cn(
          'material-thick relative max-h-full overflow-hidden rounded-xl shadow-lg',
          'flex flex-col animate-[dialogIn_var(--duration-base)_var(--ease-out)]',
        )}
      >
        <header
          className={cn('shrink-0 px-5 pt-5 pb-3', (dividers ?? (scroll.top || !scrollable)) && 'hairline-b')}
        >
          <h2 className="text-title text-label">{title}</h2>
          {description && (
            <p className="mt-1 text-ui leading-relaxed text-label-secondary">{description}</p>
          )}
        </header>
        {children &&
          (scrollable ? (
            <Scroller
              ref={measure}
              frameClassName="min-h-0 flex-1"
              className={bodyClassName ?? 'px-5 pb-2'}
            >
              {children}
            </Scroller>
          ) : (
            <div className={cn('flex min-h-0 flex-1', bodyClassName)}>{children}</div>
          ))}
        <footer
          className={cn(
            'flex shrink-0 items-center justify-end gap-2 px-5 pt-3 pb-5',
            (dividers ?? (scroll.bottom || !scrollable)) && 'hairline-t',
          )}
        >
          {footer ?? (
            <Button variant="primary" onClick={onClose}>
              OK
            </Button>
          )}
        </footer>
      </div>
      <style>{`
        @keyframes fadeIn{from{opacity:0}to{opacity:1}}
        @keyframes dialogIn{from{opacity:0;scale:0.94;translate:0 8px}to{opacity:1;scale:1;translate:0 0}}
      `}</style>
    </div>,
    document.body,
  )
}
