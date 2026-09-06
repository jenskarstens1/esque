import { useCallback, useRef, useState } from 'react'
import { Menu, type MenuItem } from './Menu'

/** Hook that wires a right-click (or button) to a context menu. */
export function useMenu() {
  const serial = useRef(0)
  const [state, setState] = useState<{
    id: number
    x: number
    y: number
    items: MenuItem[]
    above?: boolean
    fromRight?: boolean
    returnFocus: HTMLElement | null
  } | null>(null)
  const close = useCallback(() => setState(null), [])
  const focused = () => (document.activeElement instanceof HTMLElement ? document.activeElement : null)
  return {
    menu: state && <Menu key={state.id} {...state} onClose={close} />,
    /*
     * Menus nest — a thumbnail sits inside the grid, a slider inside a panel —
     * and the innermost one is always the one meant. Stopping the event keeps
     * an outer handler from opening a second menu on top of it.
     */
    open: (
      e: {
        clientX: number
        clientY: number
        currentTarget?: EventTarget | null
        preventDefault(): void
        stopPropagation(): void
      },
      items: MenuItem[],
    ) => {
      e.preventDefault()
      e.stopPropagation()
      const target = e.currentTarget instanceof HTMLElement ? e.currentTarget : null
      const rect = !e.clientX && !e.clientY ? target?.getBoundingClientRect() : null
      setState({
        id: ++serial.current,
        x: rect?.left ?? e.clientX,
        y: rect?.bottom ?? e.clientY,
        items,
        returnFocus: target && target.tabIndex >= 0 ? target : focused(),
      })
    },
    /**
     * For menus hung off a button rather than a click. `above` / `fromRight`
     * reinterpret the point as the menu's bottom / right edge, so a control in
     * a corner opens away from it instead of over it.
     */
    openAt: (
      x: number,
      y: number,
      items: MenuItem[],
      placement?: { above?: boolean; fromRight?: boolean },
    ) => setState({ id: ++serial.current, x, y, items, ...placement, returnFocus: focused() }),
    close,
  }
}
