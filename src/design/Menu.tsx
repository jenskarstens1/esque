import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SetStateAction,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn'
import { CheckIcon, ChevronRightIcon } from './icons'
import { isCoarsePointer } from '../lib/useViewport'
import { canFocus, focusableElements, useModalBranch } from './focusScope'
import { Scroller } from './Scroller'
import { COMMAND_BY_ID, chordsFor, formatChord } from '../shell/commands'
import { useUI } from '../state/ui'

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

type OpenSubmenu = { index: number; keyboard: boolean } | null
type MenuPosition = { x: number; y: number }
type KeyBindings = ReturnType<typeof useUI.getState>['keyBindings']

const MenuTree = createContext<MenuTreeState | null>(null)

/**
 * One base width for every menu, scaled with the user's text-size preference
 * rather than sized independently to each menu's content.
 *
 * 216 rather than 240: at 12px the longest label the app raises is around 150px
 * set, and the rest of the column is icon, shortcut and chevron at fixed widths.
 * The extra 24px was margin nobody read, and it is what made a nineteen-row
 * photo menu read as a slab.
 */
export const MENU_WIDTH = 216

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
  /** Resolve the current platform-specific binding rather than hard-coding a hint. */
  commandId?: string
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

const MOVE_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End']
const BACK_KEYS = ['ArrowLeft', 'Escape']
const ACTIVATE_KEYS = ['Enter', ' ']

function currentMenuIndex(
  event: ReactKeyboardEvent<HTMLDivElement>,
  buttons: Map<number, HTMLButtonElement>,
  fallback: number,
) {
  if (!(event.target instanceof Element)) return fallback
  const target = event.target.closest('button')
  return [...buttons].find(([, button]) => button === target)?.[0] ?? fallback
}

function moveMenuFocus(
  event: ReactKeyboardEvent<HTMLDivElement>,
  indices: number[],
  currentIndex: number,
  focusItem: (index: number) => void,
  closeSubmenu: () => void,
) {
  event.preventDefault()
  closeSubmenu()
  if (!indices.length) return

  if (event.key === 'Home') return focusItem(indices[0])
  if (event.key === 'End') return focusItem(indices.at(-1)!)
  const direction = event.key === 'ArrowDown' ? 1 : -1
  const next = (currentIndex + direction + indices.length) % indices.length
  focusItem(indices[next])
}

function findTypeaheadMatch(
  event: ReactKeyboardEvent<HTMLDivElement>,
  items: MenuItem[],
  indices: number[],
  currentIndex: number,
  search: { value: string; time: number },
) {
  if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return
  event.preventDefault()
  const now = performance.now()
  const key = event.key.toLocaleLowerCase()
  const value = now - search.time > 700 ? key : search.value + key
  search.value = value
  search.time = now
  const prefix = [...value].every((letter) => letter === key) ? key : value
  const offset = prefix.length === 1 ? 1 : 0
  const start = Math.max(0, currentIndex + offset)
  const ordered = [...indices.slice(start), ...indices.slice(0, start)]
  return ordered.find((index) => items[index].label?.toLocaleLowerCase().startsWith(prefix))
}

function itemClassName(item: MenuItem, active: boolean) {
  let state = 'text-label'
  if (item.disabled) state = 'pointer-events-none text-label-quaternary'
  else if (item.danger) state = 'text-red'

  let highlight: string | false = false
  if (active) highlight = item.danger ? 'bg-red text-white' : 'bg-accent text-accent-ink'

  /*
   * The highlight is inset and rounded rather than full-bleed, the way macOS
   * has drawn a menu since Big Sur: a bar that runs edge to edge turns the menu
   * into a table of rows, where a floating capsule reads as one thing picked
   * out of a list. The inset is also what lets the row padding come in — the
   * text sits 10px from the menu's edge instead of 12, without the highlight
   * ever touching it.
   *
   * `py` stays generous under a finger; only the pointer case tightens.
   */
  return cn(
    'mx-1 flex w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-sm px-1.5 text-left text-ui',
    'py-[3px] coarse:py-2.5',
    'transition-colors duration-[--duration-instant] focus-visible:shadow-none',
    state,
    highlight,
  )
}

interface MenuEntryProps {
  item: MenuItem
  index: number
  id: string
  active: number
  openSub: OpenSubmenu
  pos: MenuPosition
  keyBindings: KeyBindings
  tree: MenuTreeState
  buttons: Map<number, HTMLButtonElement>
  focusItem: (index: number, reveal?: boolean) => void
  setActive: Dispatch<SetStateAction<number>>
  setOpenSub: Dispatch<SetStateAction<OpenSubmenu>>
  onClose: () => void
}

function MenuCommand({
  item,
  index,
  id,
  active,
  openSub,
  pos,
  keyBindings,
  tree,
  buttons,
  focusItem,
  setActive,
  setOpenSub,
  onClose,
}: MenuEntryProps) {
  const hasSubmenu = !!item.submenu?.length
  const command = item.commandId ? COMMAND_BY_ID.get(item.commandId) : undefined
  const chord = command ? chordsFor(command, keyBindings)[0] : undefined
  const shortcut = chord ? formatChord(chord) : undefined
  const shortcutId = `${id}-${index}-shortcut`

  const select = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (hasSubmenu) {
      const shouldClose = openSub?.index === index && isCoarsePointer() && event.detail !== 0
      setOpenSub(shouldClose ? null : { index, keyboard: event.detail === 0 })
      return
    }
    if (tree.trigger && canFocus(tree.trigger)) {
      tree.trigger.focus({ preventScroll: true })
    }
    item.onSelect?.()
    onClose()
  }

  return (
    <div
      role="none"
      className="relative"
      onPointerMove={(event) => {
        event.stopPropagation()
        if (event.pointerType === 'touch') return
        const { clientX: x, clientY: y } = event
        if (tree.pointerPosition?.x === x && tree.pointerPosition.y === y) return
        tree.pointerPosition = { x, y }
        if (item.disabled) return setOpenSub(null)
        focusItem(index, false)
        setOpenSub((current) =>
          hasSubmenu
            ? current?.index === index
              ? current
              : { index, keyboard: false }
            : null,
        )
      }}
    >
      <button
        ref={(element) => {
          if (element) buttons.set(index, element)
          else buttons.delete(index)
        }}
        type="button"
        role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
        aria-label={item.label}
        aria-describedby={shortcut ? shortcutId : undefined}
        aria-checked={item.checked}
        aria-haspopup={hasSubmenu ? 'menu' : undefined}
        aria-expanded={hasSubmenu ? openSub?.index === index : undefined}
        tabIndex={active === index ? 0 : -1}
        disabled={item.disabled}
        onFocus={() => setActive(index)}
        onClick={select}
        className={itemClassName(item, active === index)}
      >
        <span aria-hidden="true" className="flex w-3.5 shrink-0 justify-center opacity-80">
          {item.checked ? <CheckIcon size={11} /> : item.icon}
        </span>
        <span data-menu-label className="min-w-0 flex-1 wrap-anywhere">{item.label}</span>
        {shortcut && (
          <kbd
            id={shortcutId}
            className="shrink-0 whitespace-nowrap font-ui text-mini font-normal tracking-normal opacity-75"
          >
            {shortcut}
          </kbd>
        )}
        {hasSubmenu && <ChevronRightIcon size={10} className="shrink-0 opacity-55" />}
      </button>
      {hasSubmenu && openSub?.index === index && (
        <Menu
          items={item.submenu ?? []}
          x={pos.x}
          y={pos.y}
          anchor={buttons.get(index)}
          focusOnOpen={openSub.keyboard}
          onBack={() => {
            setOpenSub(null)
            focusItem(index)
          }}
          onClose={onClose}
        />
      )}
    </div>
  )
}

function MenuEntry(props: MenuEntryProps) {
  const { item } = props
  if (item.kind === 'separator') {
    // Inset to the highlight's own edges, so a rule parts two groups of rows
    // rather than slicing the card it sits in.
    return <div role="separator" className="mx-1 my-1 h-px bg-hairline" />
  }
  if (item.kind === 'note') {
    return (
      <div className="px-2.5 py-1 text-micro leading-snug text-balance text-label-tertiary">
        {item.label}
      </div>
    )
  }
  return <MenuCommand {...props} />
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
  const id = useId()
  const keyBindings = useUI((state) => state.keyBindings)
  const ref = useRef<HTMLDivElement>(null)
  const buttons = useRef(new Map<number, HTMLButtonElement>())
  const close = useRef(onClose)
  const inModal = useModalBranch(ref)
  const [pos, setPos] = useState({ x, y })
  const [active, setActive] = useState(() => items.findIndex(enabled))
  const [openSub, setOpenSub] = useState<OpenSubmenu>(null)
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
      /*
       * Submenu rows are inset by 4px inside their menu (see `itemClassName`),
       * so the anchor's edges are not the menu's edges. Adding the inset back
       * keeps the submenu overlapping the parent by the same 4px it always did,
       * rather than by eight, and lines its first row up with the row that
       * opened it instead of sitting a row-padding lower.
       */
      const inset = 4
      const left = row
        ? row.right + inset + w <= window.innerWidth - 8
          ? row.right + inset - 4
          : row.left - inset - w + 4
        : fromRight
          ? x - w
          : x
      const top = row ? row.top - inset : above ? y - h : y
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
    const current = currentMenuIndex(event, buttons.current, active)
    const indices = items.flatMap((item, index) => (enabled(item) ? [index] : []))
    const index = indices.indexOf(current)

    if (MOVE_KEYS.includes(event.key)) {
      moveMenuFocus(event, indices, index, focusItem, () => setOpenSub(null))
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      if (items[current]?.submenu?.length && enabled(items[current]))
        setOpenSub({ index: current, keyboard: true })
      return
    }
    if (BACK_KEYS.includes(event.key)) {
      event.preventDefault()
      if (onBack) onBack()
      else if (event.key === 'Escape') close.current()
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      tree.tabDirection = event.shiftKey ? -1 : 1
      close.current()
      return
    }
    if (ACTIVATE_KEYS.includes(event.key)) {
      event.preventDefault()
      buttons.current.get(current)?.click()
      return
    }
    const match = findTypeaheadMatch(event, items, indices, index, search.current)
    if (match !== undefined) {
      setOpenSub(null)
      focusItem(match)
    }
  }

  return createPortal(
    <MenuTree.Provider value={tree}>
      <div
        ref={ref}
        role="menu"
        aria-label={anchor?.getAttribute('aria-label') || 'Actions'}
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
          {items.map((item, index) => (
            <MenuEntry
              key={index}
              item={item}
              index={index}
              id={id}
              active={active}
              openSub={openSub}
              pos={pos}
              keyBindings={keyBindings}
              tree={tree}
              buttons={buttons.current}
              focusItem={focusItem}
              setActive={setActive}
              setOpenSub={setOpenSub}
              onClose={onClose}
            />
          ))}
        </Scroller>
        <style>{`@keyframes menuIn{from{opacity:0;scale:0.96}to{opacity:1;scale:1}}`}</style>
      </div>
    </MenuTree.Provider>,
    document.body,
  )
}
