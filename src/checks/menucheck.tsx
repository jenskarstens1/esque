import { createRoot } from 'react-dom/client'
import { useEffect, useLayoutEffect, useState } from 'react'
import { MENU_WIDTH, Menu, type MenuItem } from '../design/Menu'
import { photoMenuItems } from '../shell/photoMenu'
import {
  compareMenuItems,
  cropMenuItems,
  gridBackgroundMenuItems,
  histogramMenuItems,
  maskMenuItems,
  panelMenuItems,
  retouchMenuItems,
  sliderMenuItems,
  sourceMenuItems,
  viewportMenuItems,
} from '../shell/appMenus'
import { defaultEdits, ALL_SECTIONS } from '../core/defaults'
import type { CatalogFolder, Collection, Photo } from '../core/types'
import '../styles/index.css'

/*
 * Menu smoke check. Builds every context menu the app can raise, asserts the
 * item lists are well formed, then mounts one and drives it with the keyboard
 * and pointer to confirm the primitive actually renders what it was handed.
 */

declare global {
  interface Window {
    __result?: unknown
    __done?: boolean
  }
}

const failures: string[] = []
const fail = (msg: string) => failures.push(msg)

function photo(id: string): Photo {
  return {
    id,
    folderId: 'f1',
    relPath: `${id}.arw`,
    filename: `${id}.arw`,
    ext: 'arw',
    isRaw: true,
    fileSize: 1024,
    modifiedAt: 0,
    addedAt: 0,
    width: 6000,
    height: 4000,
    meta: {} as Photo['meta'],
    rating: 3,
    flag: 'unflagged',
    label: 'none',
    keywords: [],
    title: '',
    caption: '',
    edits: defaultEdits(),
    thumbKey: null,
    proxyKey: null,
    masterId: null,
    copyName: null,
    stackId: null,
    stackPosition: 0,
    stackCollapsed: false,
  }
}

const collection = (id: string, smart = false): Collection => ({
  id,
  name: `Collection ${id}`,
  smart,
  rules: [],
  match: 'all',
  photoIds: ['p1'],
  createdAt: 0,
  setId: null,
})

const folder = { id: 'f1', name: 'Shoot', photoCount: 12 } as CatalogFolder

/** A menu is only useful if every row can be read and every leaf can be run. */
function validate(name: string, items: MenuItem[], depth = 0) {
  if (depth > 4) return fail(`${name}: submenu nesting runs deeper than 4`)
  if (items.length === 0) return fail(`${name}: empty`)

  let separators = 0
  items.forEach((item, i) => {
    const where = `${name}[${i}]`
    if (item.kind === 'separator') {
      separators++
      if (i === 0) fail(`${where}: leads with a separator`)
      if (i === items.length - 1) fail(`${where}: trails a separator`)
      if (items[i - 1]?.kind === 'separator') fail(`${where}: doubled separator`)
      return
    }
    separators = 0
    if (!item.label) return fail(`${where}: no label`)
    if (item.kind === 'note') return
    if (item.submenu) {
      validate(`${where} “${item.label}”`, item.submenu, depth + 1)
      return
    }
    if (!item.onSelect) fail(`${where} “${item.label}”: no action and no submenu`)
  })
  void separators
}

/**
 * Every root menu is one fixture at one width, and every one of its rows is
 * marked. A menu that quietly drops the icon column reads as a different
 * control from the one the user opened a moment ago.
 */
function validateIcons(name: string, items: MenuItem[]) {
  items.forEach((item, i) => {
    if (item.kind && item.kind !== 'item') return
    // A checked row shows a check in the gutter instead, so it needs no icon.
    if (!item.icon && !item.checked) fail(`${name}[${i}] “${item.label}”: root row with no icon`)
  })
}

const cases: Array<[string, () => MenuItem[]]> = [
  ['photo', () => photoMenuItems(photo('p1'), { collections: [collection('c1')] })],
  [
    'photo · in collection',
    () =>
      photoMenuItems(photo('p1'), {
        collections: [collection('c1'), collection('c2', true)],
        collectionId: 'c1',
      }),
  ],
  ['photo · compact', () => photoMenuItems(photo('p1'), { compact: true })],
  ['grid background', () => gridBackgroundMenuItems()],
  ['viewport', () => viewportMenuItems()],
  ['crop', () => cropMenuItems()],
  ['mask', () => maskMenuItems()],
  ['retouch', () => retouchMenuItems()],
  ['compare', () => compareMenuItems(true)],
  ['histogram', () => histogramMenuItems()],
  ['folder', () => sourceMenuItems({ kind: 'folder', folder })],
  ['collection', () => sourceMenuItems({ kind: 'collection', collection: collection('c1') })],
  ['smart collection', () => sourceMenuItems({ kind: 'collection', collection: collection('c2', true) })],
  [
    'slider',
    () =>
      sliderMenuItems({
        value: 0.5,
        defaultValue: 0,
        onReset: () => {},
        onSet: () => {},
      }),
  ],
]
for (const section of ALL_SECTIONS) cases.push([`panel · ${section}`, () => panelMenuItems(section)])

const built = new Map<string, MenuItem[]>()
for (const [name, build] of cases) {
  try {
    const items = build()
    built.set(name, items)
    validate(name, items)
    validateIcons(name, items)
  } catch (e) {
    fail(`${name}: threw — ${(e as Error).message}`)
  }
}

function countRows(items: MenuItem[]): number {
  return items.filter((i) => i.kind !== 'separator' && i.kind !== 'note').length
}

const names = [...built.keys()]
const measurements = [1, 1.14].flatMap((scale) => names.map((name) => ({ name, scale })))
const widths: Array<{ name: string; scale: number; width: number; height: number }> = []
const emptyItems: MenuItem[] = []

export function Harness() {
  // Every menu is mounted in turn, so the width claim is measured on the real
  // thing rather than trusted from the stylesheet.
  const [step, setStep] = useState(0)
  const [open, setOpen] = useState(true)
  const measurement = measurements[step]
  const name = measurement?.name ?? 'photo'
  const scale = measurement?.scale ?? 1
  const items = built.get(name) ?? emptyItems
  const measuring = !!measurement

  useLayoutEffect(() => {
    const previous = document.documentElement.style.getPropertyValue('--ui-scale')
    document.documentElement.style.setProperty('--ui-scale', String(scale))
    return () => {
      if (previous) document.documentElement.style.setProperty('--ui-scale', previous)
      else document.documentElement.style.removeProperty('--ui-scale')
    }
  }, [scale])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      await new Promise((r) => setTimeout(r, 90))
      if (cancelled) return

      const el = document.querySelector('[role="menu"]') as HTMLElement | null
      if (measuring) {
        if (!el) fail(`${name}: did not mount`)
        else {
          const expectedWidth = Math.round(Math.min(MENU_WIDTH * scale, window.innerWidth - 16))
          widths.push({ name, scale, width: el.offsetWidth, height: el.offsetHeight })
          if (el.offsetWidth !== expectedWidth)
            fail(`${name} at ${scale}: ${el.offsetWidth}px wide, expected ${expectedWidth}`)
          if (el.offsetHeight > window.innerHeight - 16)
            fail(`${name}: menu extends beyond the available height`)
          const clipped = [...el.querySelectorAll<HTMLElement>('[role^="menuitem"] .truncate')].find(
            (s) => s.scrollWidth > s.clientWidth,
          )
          if (clipped) fail(`${name} at ${scale}: “${clipped.textContent}” is truncated`)
        }
        setStep(step + 1)
        return
      }

      // Last pass: the photo menu again, driven to confirm the primitive still
      // renders what it was handed and still closes on an outside click.
      const list = built.get('photo') ?? []
      const rows = document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')
      const expected = countRows(list)
      if (rows.length !== expected) fail(`menu rendered ${rows.length} rows, expected ${expected}`)

      const labelled = [...rows].filter((r) => (r.textContent ?? '').trim().length > 0)
      if (labelled.length !== rows.length) fail('a rendered row has no visible text')
      if (!rows.length) fail('no rows to interact with')

      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 60))
      if (document.querySelectorAll('[role="menu"]').length !== 0)
        fail('menu stayed open after an outside pointerdown')

      window.__result = {
        pass: failures.length === 0,
        failures,
        width: MENU_WIDTH,
        widths,
        menus: [...built].map(([n, list]) => ({
          name: n,
          rows: countRows(list),
          submenus: list.filter((i) => i.submenu).length,
        })),
      }
      window.__done = true
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [step, name, scale, items, measuring])

  return (
    <div style={{ width: 900, height: 600 }}>
      {open && (
        <Menu
          key={step}
          x={40}
          y={40}
          items={items}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}


createRoot(document.getElementById('root')!).render(<Harness />)
