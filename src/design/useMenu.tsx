import { useState } from 'react'
import { Menu, type MenuItem } from './Menu'

/** Hook that wires a right-click (or button) to a context menu. */
export function useMenu() {
  const [state, setState] = useState<{
    x: number
    y: number
    items: MenuItem[]
    above?: boolean
    fromRight?: boolean
  } | null>(null)
  return {
    menu: state && <Menu {...state} onClose={() => setState(null)} />,
    /*
     * Menus nest — a thumbnail sits inside the grid, a slider inside a panel —
     * and the innermost one is always the one meant. Stopping the event keeps
     * an outer handler from opening a second menu on top of it.
     */
    open: (
      e: {
        clientX: number
        clientY: number
        preventDefault(): void
        stopPropagation(): void
      },
      items: MenuItem[],
    ) => {
      e.preventDefault()
      e.stopPropagation()
      setState({ x: e.clientX, y: e.clientY, items })
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
    ) => setState({ x, y, items, ...placement }),
    close: () => setState(null),
  }
}
