import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn'
import { CheckIcon, ChevronRightIcon } from './icons'

export interface MenuItem {
  kind?: 'item' | 'separator' | 'header'
  label?: string
  shortcut?: string
  icon?: ReactNode
  checked?: boolean
  danger?: boolean
  disabled?: boolean
  onSelect?: () => void
  submenu?: MenuItem[]
}

interface MenuProps {
  items: MenuItem[]
  x: number
  y: number
  /** Read `y` as the menu's bottom edge and grow upward, for anchors near the foot of the window. */
  above?: boolean
  /** Read `x` as the menu's right edge, so a right-aligned control keeps its edge. */
  fromRight?: boolean
  onClose: () => void
  minWidth?: number
}

export function Menu({
  items,
  x,
  y,
  above = false,
  fromRight = false,
  onClose,
  minWidth = 180,
}: MenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [openSub, setOpenSub] = useState<number | null>(null)

  // Measured before paint, so the menu is never seen at the unresolved corner.
  // `offset*` rather than a client rect: the entry animation starts scaled, and
  // a scaled rect would place the menu a few pixels off its anchor.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = fromRight ? x - w : x
    const top = above ? y - h : y
    setPos({
      x: Math.max(8, Math.min(left, window.innerWidth - w - 8)),
      y: Math.max(8, Math.min(top, window.innerHeight - h - 8)),
    })
  }, [x, y, above, fromRight])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    // Defer so the click that opened the menu doesn't immediately close it.
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onDown, true), 0)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.clearTimeout(id)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.x, top: pos.y, minWidth }}
      className={cn(
        'material-thick fixed z-[1000] overflow-hidden rounded-lg py-1 shadow-popover',
        'animate-[menuIn_var(--duration-fast)_var(--ease-out)]',
        // Grow out of the corner nearest the thing that opened it.
        above
          ? fromRight
            ? 'origin-bottom-right'
            : 'origin-bottom-left'
          : fromRight
            ? 'origin-top-right'
            : 'origin-top-left',
      )}
    >
      {items.map((item, i) => {
        if (item.kind === 'separator') return <div key={i} className="my-1 h-px bg-hairline" />
        if (item.kind === 'header')
          return (
            <div key={i} className="esq-section-title px-3 pt-1.5 pb-1">
              {item.label}
            </div>
          )
        const hasSub = !!item.submenu?.length
        return (
          <div key={i} className="relative" onPointerEnter={() => setOpenSub(hasSub ? i : null)}>
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                if (hasSub) return
                item.onSelect?.()
                onClose()
              }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-[5px] text-left text-ui',
                'transition-colors duration-[--duration-instant]',
                item.disabled
                  ? 'pointer-events-none text-label-quaternary'
                  : item.danger
                    ? 'text-red hover:bg-red hover:text-white'
                    : 'text-label hover:bg-accent hover:text-white',
              )}
            >
              <span className="flex w-3.5 shrink-0 justify-center opacity-80">
                {item.checked ? <CheckIcon size={11} /> : item.icon}
              </span>
              <span className="flex-1 truncate">{item.label}</span>
              {item.shortcut && (
                <span className="shrink-0 font-mono text-micro opacity-55">{item.shortcut}</span>
              )}
              {hasSub && <ChevronRightIcon size={10} className="shrink-0 opacity-55" />}
            </button>
            {hasSub && openSub === i && (
              <Menu
                items={item.submenu!}
                x={pos.x + (ref.current?.offsetWidth ?? minWidth) - 4}
                y={pos.y + (ref.current?.children[i] as HTMLElement)?.offsetTop}
                onClose={onClose}
              />
            )}
          </div>
        )
      })}
      <style>{`@keyframes menuIn{from{opacity:0;scale:0.96}to{opacity:1;scale:1}}`}</style>
    </div>,
    document.body,
  )
}
