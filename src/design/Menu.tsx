import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn'
import { CheckIcon, ChevronRightIcon } from './icons'
import { isCoarsePointer } from '../lib/useViewport'
import { canFocus, focusableElements, useModalBranch } from './focusScope'
import { Scroller } from './Scroller'

/**
 * Every menu portals to `document.body`, so a submenu is a *sibling* of the menu
 * that owns it rather than a descendant. A plain `ref.contains(target)` test
 * therefore reads a click on one's own submenu as a click outside, and the whole
 * tree is torn down on `pointerdown` — before the item's `onClick` can fire. That
 * made every nested item silently unselectable with a real pointer.
 *
 * The outermost menu owns outside dismissal and the return-focus target;
 * submenus join its tree while handling their own arrow keys and Escape.
 */
interface MenuTreeState {
  elements: Set<HTMLElement>
  trigger: HTMLElement | null
  restoreFocus: boolean
  tabDirection: number
  mounted: boolean
  pointerPosition: { x: number; y: number } | null
}

const MenuTree = createContext<MenuTreeState | null>(null)

/**
 * One base width for every menu, scaled with the user's text-size preference
 * rather than sized independently to each menu's content.
 */
export const MENU_WIDTH = 240

/**
 * The size every icon in a menu row is drawn at. Exported so call sites name
 * the token rather than repeating a number that then drifts by one.
 *
 * **Where an icon belongs.** Every row of a *root* menu carries one. Submenu
 * rows carry none: the parent row's icon already names the group, and a second
 * column of glyphs inside it competes with the check mark for the only thing a
 * submenu usually has to say — which one is live. The single exception is a
 * glyph that *is* the value rather than a name for the act: a colour swatch, or
 * the two grid layouts, where the picture is the fastest way to say which one
 * you mean.
 */
export const MENU_ICON = 12

export interface MenuItem {
  /**
   * `note` is a wrapped, unclickable line of explanation. There is deliberately
   * no title row: a context menu is opened *on* its subject, so repeating the
   * subject's name back costs a line and tells the user nothing they did not
   * just point at.
   */
  kind?: 'item' | 'separator' | 'note'
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
  returnFocus?: HTMLElement | null
  /** Submenus follow their row and flip left when the right edge is crowded. */
  anchor?: HTMLElement
  focusOnOpen?: boolean
  onBack?: () => void
}

function enabled(item: MenuItem): boolean {
  return (!item.kind || item.kind === 'item') && !item.disabled
}

export function Menu({
  items,
  x,
  y,
  above = false,
  fromRight = false,
  onClose,
  returnFocus,
  anchor,
  focusOnOpen = true,
  onBack,
}: MenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const buttons = useRef(new Map<number, HTMLButtonElement>())
  const close = useRef(onClose)
  const inModal = useModalBranch(ref)
  const [pos, setPos] = useState({ x, y })
  const [active, setActive] = useState(() => items.findIndex(enabled))
  const [openSub, setOpenSub] = useState<{ index: number; keyboard: boolean } | null>(null)
  const search = useRef({ value: '', time: 0 })

  const inherited = useContext(MenuTree)
  const owned = useMemo<MenuTreeState>(
    () => ({
      elements: new Set(),
      trigger: null,
      restoreFocus: true,
      tabDirection: 0,
      mounted: false,
      pointerPosition: null,
    }),
    [],
  )
  const tree = inherited ?? owned
  const isRoot = !inherited

  useLayoutEffect(() => {
    close.current = onClose
  }, [onClose])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    tree.elements.add(el)
    if (isRoot) {
      tree.mounted = true
      tree.restoreFocus = true
      tree.tabDirection = 0
      tree.trigger =
        returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    }
    return () => {
      tree.elements.delete(el)
      if (!isRoot) return
      tree.mounted = false
      queueMicrotask(() => {
        const trigger = tree.trigger
        if (
          tree.mounted ||
          !tree.restoreFocus ||
          !trigger ||
          !canFocus(trigger) ||
          (document.activeElement !== document.body && !el.contains(document.activeElement))
        )
          return
        const candidates = tree.tabDirection ? focusableElements(document) : []
        const next = candidates[candidates.indexOf(trigger) + tree.tabDirection]
        ;(next ?? trigger).focus({ preventScroll: true })
      })
    }
  }, [tree, isRoot, returnFocus])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const place = () => {
      const w = el.offsetWidth
      const h = el.offsetHeight
      const row = anchor?.getBoundingClientRect()
      const left = row
        ? row.right + w - 4 <= window.innerWidth - 8
          ? row.right - 4
          : row.left - w + 4
        : fromRight
          ? x - w
          : x
      const top = row ? row.top : above ? y - h : y
      const next = {
        x: Math.max(8, Math.min(left, window.innerWidth - w - 8)),
        y: Math.max(8, Math.min(top, window.innerHeight - h - 8)),
      }
      setPos((current) => (current.x === next.x && current.y === next.y ? current : next))
    }
    place()
    const resize = new ResizeObserver(place)
    resize.observe(el)
    if (anchor) resize.observe(anchor)
    window.addEventListener('resize', place)
    window.visualViewport?.addEventListener('resize', place)
    return () => {
      resize.disconnect()
      window.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('resize', place)
    }
  }, [x, y, above, fromRight, anchor])

  const focusItem = useCallback((index: number, reveal = true) => {
    const button = buttons.current.get(index)
    if (!button) return
    setActive(index)
    button.focus({ preventScroll: true })
    if (reveal) button.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [])

  useLayoutEffect(() => {
    if (!focusOnOpen) return
    const first = items.findIndex(enabled)
    if (first >= 0) focusItem(first)
    else ref.current?.focus({ preventScroll: true })
  }, [focusOnOpen, items, focusItem])

  useLayoutEffect(() => {
    if (!isRoot) return
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node)) return
      for (const el of tree.elements) if (el.contains(e.target)) return
      tree.restoreFocus = false
      close.current()
    }
    const onFocus = (e: FocusEvent) => {
      if (!(e.target instanceof Node)) return
      for (const el of tree.elements) if (el.contains(e.target)) return
      tree.restoreFocus = false
      close.current()
    }
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onDown, true), 0)
    document.addEventListener('focusin', onFocus)
    return () => {
      window.clearTimeout(id)
      window.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('focusin', onFocus)
    }
  }, [isRoot, tree])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation()
    const target = event.target instanceof Element ? event.target.closest('button') : null
    const current = [...buttons.current].find(([, button]) => button === target)?.[0] ?? active
    const indices = items.flatMap((item, index) => (enabled(item) ? [index] : []))
    const index = indices.indexOf(current)

    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      setOpenSub(null)
      if (!indices.length) return
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? indices.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + indices.length) % indices.length
      focusItem(indices[next])
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      if (items[current]?.submenu?.length && enabled(items[current]))
        setOpenSub({ index: current, keyboard: true })
    } else if (event.key === 'ArrowLeft' || event.key === 'Escape') {
      event.preventDefault()
      if (onBack) onBack()
      else if (event.key === 'Escape') close.current()
    } else if (event.key === 'Tab') {
      event.preventDefault()
      tree.tabDirection = event.shiftKey ? -1 : 1
      close.current()
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      buttons.current.get(current)?.click()
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      const now = performance.now()
      const key = event.key.toLocaleLowerCase()
      const value = now - search.current.time > 700 ? key : search.current.value + key
      search.current = { value, time: now }
      const prefix = [...value].every((letter) => letter === key) ? key : value
      const start = Math.max(0, index + (prefix.length === 1 ? 1 : 0))
      const ordered = [...indices.slice(start), ...indices.slice(0, start)]
      const match = ordered.find((i) => items[i].label?.toLocaleLowerCase().startsWith(prefix))
      if (match !== undefined) {
        setOpenSub(null)
        focusItem(match)
      }
    }
  }

  return createPortal(
    <MenuTree.Provider value={tree}>
      <div
        ref={ref}
        role="menu"
        aria-label={anchor?.textContent?.trim() || 'Actions'}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{
          left: pos.x,
          top: pos.y,
          width: `min(calc(${MENU_WIDTH}px * var(--ui-scale, 1)), calc(100vw - 16px))`,
          maxHeight: 'calc(100dvh - 16px)',
        }}
        className={cn(
          'material-solid fixed flex flex-col overflow-hidden rounded-lg shadow-popover',
          inModal ? 'z-[1150]' : 'z-[1000]',
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
        <Scroller
          frameClassName="min-h-0"
          className="overscroll-contain py-1"
          edgeFade={8}
          onScroll={() => setOpenSub(null)}
        >
          {items.map((item, i) => {
            if (item.kind === 'separator')
              return <div key={i} role="separator" className="my-1 h-px bg-hairline" />
            // Wraps, because a note exists to be read in full — the one thing in
            // a menu that a fixed width must not clip.
            if (item.kind === 'note')
              return (
                <div
                  key={i}
                  className="px-3 py-1 text-micro leading-snug text-balance text-label-tertiary"
                >
                  {item.label}
                </div>
              )
            const hasSub = !!item.submenu?.length
            return (
              <div
                key={i}
                role="none"
                className="relative"
                onPointerMove={(e) => {
                  e.stopPropagation()
                  if (e.pointerType === 'touch') return
                  // Scrolling can move a row under a stationary pointer.
                  // Only actual pointer movement should replace keyboard focus.
                  const { clientX: x, clientY: y } = e
                  if (tree.pointerPosition?.x === x && tree.pointerPosition.y === y) return
                  tree.pointerPosition = { x, y }
                  if (item.disabled) return setOpenSub(null)
                  focusItem(i, false)
                  setOpenSub((current) =>
                    hasSub ? (current?.index === i ? current : { index: i, keyboard: false }) : null,
                  )
                }}
              >
                <button
                  ref={(element) => {
                    if (element) buttons.current.set(i, element)
                    else buttons.current.delete(i)
                  }}
                  type="button"
                  role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                  aria-checked={item.checked}
                  aria-haspopup={hasSub ? 'menu' : undefined}
                  aria-expanded={hasSub ? openSub?.index === i : undefined}
                  tabIndex={active === i ? 0 : -1}
                  disabled={item.disabled}
                  onFocus={() => setActive(i)}
                  onClick={(e) => {
                    if (hasSub)
                      return setOpenSub(
                        openSub?.index === i && isCoarsePointer() && e.detail !== 0
                          ? null
                          : { index: i, keyboard: e.detail === 0 },
                      )
                    // A dialog opened by the action must inherit a live return
                    // target, not this menu item which is about to unmount.
                    if (tree.trigger && canFocus(tree.trigger))
                      tree.trigger.focus({ preventScroll: true })
                    item.onSelect?.()
                    close.current()
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 text-left text-ui',
                    // A menu row is a primary way through the app on touch, so it
                    // gets a full target rather than the 22px a pointer needs.
                    'py-[5px] coarse:py-2.5',
                    'transition-colors duration-[--duration-instant] focus-visible:shadow-none',
                    item.disabled
                      ? 'pointer-events-none text-label-quaternary'
                      : item.danger
                        ? 'text-red'
                        : 'text-label',
                    !item.disabled &&
                      active === i &&
                      (item.danger
                        ? 'bg-red text-white'
                        : 'bg-accent text-(--accent-ink)'),
                  )}
                >
                  <span aria-hidden="true" className="flex w-3.5 shrink-0 justify-center opacity-80">
                    {item.checked ? <CheckIcon size={11} /> : item.icon}
                  </span>
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.shortcut && (
                    <span className="shrink-0 font-mono text-micro opacity-55">{item.shortcut}</span>
                  )}
                  {hasSub && <ChevronRightIcon size={10} className="shrink-0 opacity-55" />}
                </button>
                {hasSub && openSub?.index === i && (
                  <Menu
                    items={item.submenu!}
                    x={pos.x}
                    y={pos.y}
                    anchor={buttons.current.get(i)}
                    focusOnOpen={openSub.keyboard}
                    onBack={() => {
                      setOpenSub(null)
                      focusItem(i)
                    }}
                    onClose={onClose}
                  />
                )}
              </div>
            )
          })}
        </Scroller>
        <style>{`@keyframes menuIn{from{opacity:0;scale:0.96}to{opacity:1;scale:1}}`}</style>
      </div>
    </MenuTree.Provider>,
    document.body,
  )
}
