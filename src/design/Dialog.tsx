import { useCallback, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn'
import { Button } from './Controls'
import { Scroller } from './Scroller'
import { ModalFocusContext, useModalFocus } from './focusScope'

export function Dialog({
  open,
  onClose,
  title,
  titleIcon,
  description,
  children,
  footer,
  width = 460,
  height,
  dismissable = true,
  scrollable = true,
  dividers,
  hideTitle,
  bodyClassName,
}: {
  open: boolean
  onClose: () => void
  title: string
  /**
   * A mark set against the title. Decorative by contract — the title stays the
   * accessible name — so it is for the dialogs that are about the app itself
   * rather than a way to give every panel an icon.
   */
  titleIcon?: ReactNode
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
  /**
   * Drops the visible header for a dialog whose own first row already names it
   * — a rail of tabs, say. `title` still carries the accessible name, so the
   * heading is only gone from the screen, not from the accessibility tree.
   */
  hideTitle?: boolean
  bodyClassName?: string
}) {
  const { ref, scope } = useModalFocus(open, dismissable ? onClose : undefined)

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
    // A ref callback that returns a cleanup is *not* called again with null, so
    // this is the only place the observer and the listener can be released. A
    // dialog opened and closed repeatedly used to leave one of each behind,
    // still holding its detached body.
    return () => {
      el.removeEventListener('scroll', read)
      ro.disconnect()
    }
  }, [])

  if (!open) return null

  /*
   * A rule separates the body from the header or the footer, so with no body
   * there is nothing to separate. Without this, a plain confirm drew the
   * header's bottom hairline and the footer's top hairline against each other
   * and the pair read as one rule of twice the weight of every other rule in
   * the app.
   */
  const hasBody = Boolean(children)
  const divided = (overflowing: boolean) => dividers ?? (overflowing || !scrollable)

  return createPortal(
    <ModalFocusContext.Provider value={scope}>
      <div className="fixed inset-0 z-[1100] flex items-center justify-center p-4 md:p-8">
        <div
          className="absolute inset-0 bg-scrim backdrop-blur-[2px] animate-[fadeIn_var(--duration-base)_var(--ease-out)]"
          onClick={dismissable ? onClose : undefined}
        />
        <div
          ref={ref}
          role="dialog"
          tabIndex={-1}
          aria-modal="true"
          aria-label={title}
          // `width` caps rather than fixes the size, so a 460px dialog still fits
          // a 390px phone instead of running off both edges.
          style={{ width: '100%', maxWidth: width, height }}
          className={cn(
            'material-solid relative max-h-full overflow-hidden rounded-xl shadow-lg',
            'flex flex-col animate-[dialogIn_var(--duration-base)_var(--ease-out)]',
          )}
        >
          {!hideTitle && (
            <header
              className={cn(
                'shrink-0 px-5 pt-5 pb-3',
                hasBody && divided(scroll.top) && 'hairline-b',
              )}
            >
              <div className="flex items-center gap-[3px]">
                {titleIcon}
                <h2 className="text-title text-balance text-label">{title}</h2>
              </div>
              {description && (
                <p className="mt-1 text-ui leading-relaxed text-pretty text-label-secondary">
                  {description}
                </p>
              )}
            </header>
          )}
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
              hasBody && divided(scroll.bottom) && 'hairline-t',
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
      </div>
    </ModalFocusContext.Provider>,
    document.body,
  )
}
