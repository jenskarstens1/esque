import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Dialog } from '../design/Dialog'
import { Checkbox } from '../design/Controls'
import { Drawer, Sheet } from '../design/Sheet'
import { MENU_WIDTH, type MenuItem } from '../design/Menu'
import { useMenu } from '../design/useMenu'
import { focusableElements } from '../design/focusScope'
import { useKeymap } from '../shell/useKeymap'
import { useUI } from '../state/ui'
import '../styles/index.css'

const failures: string[] = []
let assertions = 0
let selected = 0

function check(condition: unknown, message: string) {
  assertions++
  if (!condition) failures.push(message)
}

function element(selector: string, root: ParentNode = document): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector)
  if (!found) throw new Error(`Missing ${selector}`)
  return found
}

const tick = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const activeText = () => document.activeElement?.textContent?.trim()

function press(key: string, shiftKey = false) {
  document.activeElement?.dispatchEvent(
    new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
  )
}

async function click(selector: string) {
  const target = element(selector)
  target.focus()
  target.click()
  await tick()
}

export function Harness() {
  const [dialog, setDialog] = useState(false)
  const [plain, setPlain] = useState(false)
  const [ruled, setRuled] = useState(false)
  const [nested, setNested] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const outer = useMenu()
  const inner = useMenu()
  useKeymap()

  const items: MenuItem[] = [
    { label: 'Alpha', onSelect: () => selected++ },
    { label: 'Unavailable', disabled: true, onSelect: () => selected++ },
    { kind: 'separator' },
    { kind: 'note', label: 'A wrapped explanation, not a command.' },
    { label: 'Beta', checked: false, onSelect: () => selected++ },
    {
      label: 'Group',
      submenu: [
        { label: 'Unavailable child', disabled: true, onSelect: () => selected++ },
        { label: 'Nested one', checked: true, onSelect: () => selected++ },
        { label: 'Nested two', onSelect: () => selected++ },
      ],
    },
    { label: 'Open dialog', onSelect: () => setDialog(true) },
    ...Array.from({ length: 50 }, (_, i) => ({
      label: `Option ${String(i + 1).padStart(2, '0')}`,
      onSelect: () => selected++,
    })),
  ]

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      await tick()
      if (cancelled) return
      const previousScale = document.documentElement.style.getPropertyValue('--ui-scale')
      document.documentElement.style.setProperty('--ui-scale', '1')
      try {
        await click('#open-menu')
        await wait(160)
        const menu = element('[role="menu"]')
        check(activeText() === 'Alpha', 'A menu focuses its first enabled command')
        check(menu.offsetWidth === MENU_WIDTH, 'Menu uses the shared base width')
        check(menu.offsetHeight <= innerHeight - 16, 'Long menus fit the viewport')
        check(menu.querySelectorAll('[role^="menuitem"][tabindex="0"]').length === 1, 'Menu uses a single tab stop')
        press('ArrowDown')
        await tick()
        check(activeText() === 'Beta', 'Arrow navigation skips disabled rows, separators and notes')
        check(document.activeElement?.getAttribute('aria-checked') === 'false', 'Unchecked state is accessible')
        press('ArrowDown')
        await tick()
        press('ArrowRight')
        await tick()
        check(document.querySelectorAll('[role="menu"]').length === 2, 'Right arrow opens a submenu')
        check(activeText() === 'Nested one', 'Submenu focuses its first enabled command')
        check(document.activeElement?.getAttribute('aria-checked') === 'true', 'Checked state is accessible')
        const child = element('[role="menu"][aria-label="Group"]')
        check(parseFloat(child.style.left) < parseFloat(menu.style.left), 'A submenu flips left at the right edge')
        press('ArrowLeft')
        await tick()
        check(document.querySelectorAll('[role="menu"]').length === 1 && activeText() === 'Group', 'Left arrow returns to the parent row')
        press('ArrowRight')
        await tick()
        press('Escape')
        await tick()
        check(document.querySelectorAll('[role="menu"]').length === 1 && activeText() === 'Group', 'Submenu Escape leaves the root menu open')
        press('b')
        await tick()
        check(activeText() === 'Beta', 'Typeahead finds an enabled command')
        const beforeModule = useUI.getState().module
        press('d')
        await tick()
        check(useUI.getState().module === beforeModule, 'App letter shortcuts do not run behind a menu')
        press('End')
        await tick()
        const scroll = element('.esq-scroll', menu)
        check(activeText() === 'Option 50' && scroll.scrollTop > 0, 'End reveals the final command')
        check((document.activeElement?.getBoundingClientRect().bottom ?? Infinity) <= innerHeight - 7, 'The final command is on screen')
        const pointerRow = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
          .find((row) => row.textContent?.trim() === 'Option 49')
        if (!pointerRow) throw new Error('Missing pointer navigation command')
        pointerRow.dispatchEvent(new PointerEvent('pointerover', {
          bubbles: true, pointerType: 'mouse', clientX: 10, clientY: 10,
        }))
        await tick()
        check(activeText() === 'Option 50', 'Scrolling beneath a stationary pointer does not steal keyboard focus')
        pointerRow.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, pointerType: 'mouse', clientX: 11, clientY: 10,
        }))
        await tick()
        check(activeText() === 'Option 49', 'Real pointer movement takes over menu navigation')
        press('End')
        await tick()
        pointerRow.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, pointerType: 'mouse', clientX: 11, clientY: 10,
        }))
        await tick()
        check(activeText() === 'Option 50', 'Repeated pointer coordinates do not replace keyboard focus')
        const highlighted = menu.querySelectorAll('button.bg-accent')
        check(highlighted.length === 1 && highlighted[0] === document.activeElement, 'Only the active command is highlighted')
        press('Home')
        await tick()
        press('Enter')
        await tick()
        check(selected === 1 && !document.querySelector('[role="menu"]'), 'Enter runs one command and closes the menu')
        check(document.activeElement?.id === 'open-menu', 'Menu dismissal restores its trigger')

        await click('#open-menu')
        press('Tab')
        await tick()
        check(!document.querySelector('[role="menu"]') && document.activeElement?.id === 'open-dialog', 'Tab exits the menu to the next control')

        await click('#open-menu')
        const openDialog = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
          .find((row) => row.textContent?.trim() === 'Open dialog')
        if (!openDialog) throw new Error('Missing dialog command')
        openDialog.focus()
        press('Enter')
        await tick()
        const modal = element('[role="dialog"][aria-label="Parent dialog"]')
        check(modal.contains(document.activeElement), 'Opening a dialog from a menu keeps focus in the dialog')
        check(element('#root').inert, 'A dialog makes the application background inert')
        element('#background').focus()
        check(modal.contains(document.activeElement), 'Background controls cannot steal modal focus')
        const checkbox = modal.querySelector<HTMLButtonElement>('[role="checkbox"]')
        const beforeDisabled = selected
        checkbox?.click()
        check(checkbox?.disabled && selected === beforeDisabled, 'Disabled checkboxes cannot be activated by keyboard or script')
        element('#dialog-editor').focus()
        press('Escape')
        await tick()
        check(modal.isConnected, 'An editor can handle Escape before its dialog')
        const fields = focusableElements(modal)
        fields.at(-1)?.focus()
        press('Tab')
        await tick()
        check(document.activeElement === fields[0], 'Modal Tab wraps from last to first')
        press('Tab', true)
        await tick()
        check(document.activeElement === fields.at(-1), 'Modal Shift+Tab wraps from first to last')

        await click('#modal-menu')
        const modalMenu = element('[role="menu"]')
        check(!modalMenu.closest('[inert]'), 'A menu portal inside a dialog is not inert')
        check(Number(getComputedStyle(modalMenu).zIndex) > 1100, 'A dialog menu is above its scrim')
        check(modalMenu.contains(document.activeElement), 'Dialog menu owns focus')
        press('Escape')
        await tick()
        check(document.querySelectorAll('[role="dialog"]').length === 1, 'Menu Escape does not dismiss its dialog')
        check(document.activeElement?.id === 'modal-menu', 'Dialog menu restores its trigger')

        await click('#open-nested')
        const nestedModal = element('[role="dialog"][aria-label="Nested dialog"]')
        check(nestedModal.contains(document.activeElement), 'The topmost dialog owns focus')
        check(!!modal.closest('[inert]'), 'The parent dialog is inert under its child')
        press('Escape')
        await tick()
        check(document.querySelectorAll('[role="dialog"]').length === 1, 'One Escape closes only the top dialog')
        check(document.activeElement?.id === 'open-nested', 'Nested dialog restores the parent control')
        press('Escape')
        await tick()
        check(!element('#root').inert && !document.querySelector('[role="dialog"]'), 'Closing the last dialog restores background interaction')

        /*
         * Surface and rules.
         *
         * A dialog is the surface someone reads and decides on, so it is opaque
         * rather than a material: a translucent panel takes its tone from
         * whichever photograph is behind it. Chromium serialises a fully opaque
         * colour as `rgb(...)` and anything with alpha as `rgba(...)`, so the
         * prefix is the whole assertion.
         */
        await click('#open-plain')
        const plain = element('[role="dialog"][aria-label="Plain dialog"]')
        const surface = getComputedStyle(plain)
        check(surface.backgroundColor.startsWith('rgb('), `A dialog panel is opaque, got ${surface.backgroundColor}`)
        check(surface.backdropFilter === 'none', `An opaque panel costs no backdrop filter, got ${surface.backdropFilter}`)
        // A rule separates the body from the header or footer. With no body the
        // two used to be drawn against each other and read as one rule of twice
        // the weight of every other rule in the app.
        const ruleOf = (tag: string, root: HTMLElement) =>
          getComputedStyle(element(tag, root)).boxShadow
        check(ruleOf('header', plain) === 'none' && ruleOf('footer', plain) === 'none', 'A dialog with no body draws no rule')
        press('Escape')
        await tick()

        await click('#open-ruled')
        const ruled = element('[role="dialog"][aria-label="Ruled dialog"]')
        check(ruleOf('header', ruled) !== 'none' && ruleOf('footer', ruled) !== 'none', 'A dialog with a body still rules its header and footer off')
        press('Escape')
        await tick()

        await click('#open-sheet')
        await wait(240)
        check(!!document.activeElement?.closest('[role="dialog"]'), 'A sheet claims focus')
        await click('#sheet-nested')
        press('Escape')
        await tick()
        check(document.querySelectorAll('[role="dialog"]').length === 1 && document.activeElement?.id === 'sheet-nested', 'Dialog over a sheet uses the same focus stack')
        press('Escape')
        await tick()
        check(document.activeElement?.id === 'open-sheet', 'Sheet dismissal restores its trigger')

        await click('#open-drawer')
        await wait(240)
        check(document.activeElement?.id === 'drawer-action', 'A drawer claims focus')
        press('Escape')
        await tick()
        check(document.activeElement?.id === 'open-drawer' && !element('#root').inert, 'Drawer dismissal restores focus and isolation')
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
      } finally {
        if (previousScale) document.documentElement.style.setProperty('--ui-scale', previousScale)
        else document.documentElement.style.removeProperty('--ui-scale')
      }
      window.__result = { pass: failures.length === 0, assertions, failures }
      window.__done = true
    }
    void run()
    return () => { cancelled = true }
  }, [])

  return (
    <div className="flex gap-3 p-5">
      <button id="background">Background</button>
      <button
        id="open-menu"
        onClick={() => outer.openAt(innerWidth - 8, 40, items, { fromRight: true })}
      >
        Open menu
      </button>
      <button id="open-dialog" onClick={() => setDialog(true)}>Open dialog</button>
      <button id="open-plain" onClick={() => setPlain(true)}>Open plain</button>
      <button id="open-ruled" onClick={() => setRuled(true)}>Open ruled</button>
      <button id="open-sheet" onClick={() => setSheet(true)}>Open sheet</button>
      <button id="open-drawer" onClick={() => setDrawer(true)}>Open drawer</button>
      {outer.menu}
      <Dialog open={dialog} onClose={() => setDialog(false)} title="Parent dialog">
        <input
          id="dialog-editor"
          aria-label="Name"
          onKeyDown={(event) => {
            if (event.key === 'Escape') event.preventDefault()
          }}
        />
        <button
          id="modal-menu"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            inner.openAt(rect.left, rect.bottom, [{ label: 'Dialog action', onSelect: () => selected++ }])
          }}
        >
          Menu
        </button>
        <button id="open-nested" onClick={() => setNested(true)}>Nested dialog</button>
        <Checkbox disabled checked={false} label="Unavailable option" onChange={() => selected++} />
        {inner.menu}
      </Dialog>
      <Dialog open={nested} onClose={() => setNested(false)} title="Nested dialog">
        <input aria-label="Nested name" />
      </Dialog>
      {/* A confirm prompt: no body, and it owns its own (absent) scrolling. */}
      <Dialog open={plain} onClose={() => setPlain(false)} title="Plain dialog" description="No body." scrollable={false} />
      <Dialog open={ruled} onClose={() => setRuled(false)} title="Ruled dialog" scrollable={false}>
        <p>Body</p>
      </Dialog>
      <Sheet open={sheet} onClose={() => setSheet(false)} title="Sheet">
        <button id="sheet-nested" onClick={() => setNested(true)}>Nested dialog</button>
      </Sheet>
      <Drawer open={drawer} onClose={() => setDrawer(false)} side="left" label="Drawer">
        <button id="drawer-action">Drawer action</button>
      </Drawer>
    </div>
  )
}

createRoot(element('#root')).render(<StrictMode><Harness /></StrictMode>)
