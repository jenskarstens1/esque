import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn'
import { CheckIcon, ChevronRightIcon } from './icons'
import { isCoarsePointer } from '../lib/useViewport'

/**
 * Every menu portals to `document.body`, so a submenu is a *sibling* of the menu
 * that owns it rather than a descendant. A plain `ref.contains(target)` test
 * therefore reads a click on one's own submenu as a click outside, and the whole
 * tree is torn down on `pointerdown` — before the item's `onClick` can fire. That
 * made every nested item silently unselectable with a real pointer.
 *
 * So the outermost menu owns a set of the roots of every menu in its tree, and
 * nested menus just join it. Dismissal is then "outside *all* of them", and only
 * the root binds listeners, so one Escape closes the tree once.
 */
const MenuTree = createContext<Set<HTMLElement> | null>(null)

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

  // No context above us means we are the outermost menu, so we own the tree.
  const inherited = useContext(MenuTree)
  const owned = useMemo(() => new Set<HTMLElement>(), [])
  const tree = inherited ?? owned
  const isRoot = !inherited

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    tree.add(el)
    return () => {
      tree.delete(el)
    }
  }, [tree])

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
    if (!isRoot) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      for (const el of tree) if (el.contains(t)) return
      onClose()
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
  }, [onClose, isRoot, tree])

  return createPortal(
    <MenuTree.Provider value={tree}>
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
            <div
              key={i}
              className="relative"
              // Hover opens a submenu on a desktop. Touch has no hover at all, so
              // there the parent row is a button that opens it on tap instead —
              // see the click handler below.
              onPointerEnter={(e) => e.pointerType !== 'touch' && setOpenSub(hasSub ? i : null)}
            >
              <button
                type="button"
                role="menuitem"
                aria-haspopup={hasSub || undefined}
                aria-expanded={hasSub ? openSub === i : undefined}
                disabled={item.disabled}
                onClick={() => {
                  // Hover already opened it on a fine pointer, so a click there
                  // must keep it open — toggling would collapse the submenu the
                  // user is reaching for. Only touch, which has no hover to open
                  // it in the first place, gets toggle semantics.
                  if (hasSub) return setOpenSub(openSub === i && isCoarsePointer() ? null : i)
                  item.onSelect?.()
                  onClose()
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 text-left text-ui',
                  // A menu row is a primary way through the app on touch, so it
                  // gets a full target rather than the 22px a pointer needs.
                  'py-[5px] coarse:py-2.5',
                  'transition-colors duration-[--duration-instant]',
                  item.disabled
                    ? 'pointer-events-none text-label-quaternary'
                    : item.danger
                      ? 'text-red hover:bg-red hover:text-white'
                      : 'text-label hover:bg-accent hover:text-(--accent-ink)',
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
      </div>
    </MenuTree.Provider>,
    document.body,
  )
}
