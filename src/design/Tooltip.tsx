import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn'

/** Shared timer so moving between adjacent controls shows tooltips instantly. */
let warm = false
let warmTimer: number | undefined

export function Tooltip({
  content,
  children,
  side = 'bottom',
  delay = 550,
  shortcut,
  disabled,
}: {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  delay?: number
  shortcut?: string
  disabled?: boolean
}) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const timer = useRef<number>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  useLayoutEffect(() => {
    if (!open) return
    const anchor = anchorRef.current?.firstElementChild ?? anchorRef.current
    const tip = tipRef.current
    if (!anchor || !tip) return
    const a = anchor.getBoundingClientRect()
    const t = tip.getBoundingClientRect()
    const gap = 6
    let x = a.left + a.width / 2 - t.width / 2
    let y = side === 'top' ? a.top - t.height - gap : a.bottom + gap
    if (side === 'left') {
      x = a.left - t.width - gap
      y = a.top + a.height / 2 - t.height / 2
    } else if (side === 'right') {
      x = a.right + gap
      y = a.top + a.height / 2 - t.height / 2
    }
    // Keep the tip on screen without flipping sides, which reads as jitter.
    x = Math.max(6, Math.min(x, window.innerWidth - t.width - 6))
    y = Math.max(6, Math.min(y, window.innerHeight - t.height - 6))
    setPos({ x, y })
  }, [open, side])

  const show = () => {
    if (disabled) return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      setOpen(true)
      warm = true
      window.clearTimeout(warmTimer)
    }, warm ? 60 : delay)
  }

  const hide = () => {
    window.clearTimeout(timer.current)
    setOpen(false)
    window.clearTimeout(warmTimer)
    warmTimer = window.setTimeout(() => (warm = false), 700)
  }

  return (
    <>
      <span
        ref={anchorRef}
        className="contents"
        onPointerEnter={show}
        onPointerLeave={hide}
        onPointerDown={hide}
      >
        {children}
      </span>
      {open &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            style={{ left: pos.x, top: pos.y }}
            className={cn(
              'material-thick pointer-events-none fixed z-[900] flex items-center gap-2 rounded-md px-2 py-1',
              'text-mini text-label shadow-popover',
              'animate-[tip_var(--duration-fast)_var(--ease-out)]',
            )}
          >
            {content}
            {shortcut && (
              <kbd className="rounded-xs bg-wash px-1 font-mono text-micro text-label-secondary">
                {shortcut}
              </kbd>
            )}
          </div>,
          document.body,
        )}
      <style>{`@keyframes tip{from{opacity:0;translate:0 -2px}to{opacity:1;translate:0 0}}`}</style>
    </>
  )
}
