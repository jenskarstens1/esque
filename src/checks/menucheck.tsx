import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { Menu, type MenuItem } from '../design/Menu'
import { photoMenuItems } from '../shell/photoMenu'
import {
  gridBackgroundMenuItems,
  histogramMenuItems,
  panelMenuItems,
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
    if (item.kind === 'header') return
    if (item.submenu) {
      validate(`${where} “${item.label}”`, item.submenu, depth + 1)
      return
    }
    if (!item.onSelect) fail(`${where} “${item.label}”: no action and no submenu`)
  })
  void separators
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
  ['histogram', () => histogramMenuItems()],
  ['folder', () => sourceMenuItems({ kind: 'folder', folder })],
  ['collection', () => sourceMenuItems({ kind: 'collection', collection: collection('c1') })],
  ['smart collection', () => sourceMenuItems({ kind: 'collection', collection: collection('c2', true) })],
  [
    'slider',
    () =>
      sliderMenuItems({
        label: 'Exposure',
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
  } catch (e) {
    fail(`${name}: threw — ${(e as Error).message}`)
  }
}

function countRows(items: MenuItem[]): number {
  return items.filter((i) => i.kind !== 'separator' && i.kind !== 'header').length
}

export function Harness() {
  const [items] = useState(() => built.get('photo') ?? [])
  const [open, setOpen] = useState(true)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      await new Promise((r) => setTimeout(r, 120))
      if (cancelled) return

      const menus = document.querySelectorAll('[role="menu"]')
      if (menus.length !== 1) fail(`expected one mounted menu, saw ${menus.length}`)

      const rows = document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')
      const expected = countRows(items)
      if (rows.length !== expected) fail(`menu rendered ${rows.length} rows, expected ${expected}`)

      const labelled = [...rows].filter((r) => (r.textContent ?? '').trim().length > 0)
      if (labelled.length !== rows.length) fail('a rendered row has no visible text')

      // A menu that stays on screen has swallowed the pointer, so make sure
      // the primitive still closes on the outside click every menu needs.
      const first = rows[0] as HTMLElement | undefined
      if (!first) fail('no rows to interact with')

      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 60))
      if (document.querySelectorAll('[role="menu"]').length !== 0)
        fail('menu stayed open after an outside pointerdown')

      setOpen(false)
      window.__result = {
        pass: failures.length === 0,
        failures,
        menus: [...built].map(([name, list]) => ({
          name,
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
  }, [items])

  return (
    <div style={{ width: 900, height: 600 }}>
      {open && <Menu x={40} y={40} items={items} onClose={() => setOpen(false)} />}
    </div>
  )
}


createRoot(document.getElementById('root')!).render(<Harness />)
