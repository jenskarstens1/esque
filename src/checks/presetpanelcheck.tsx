import { createRoot } from 'react-dom/client'
import { useEffect } from 'react'

import { DevelopLeftPanel } from '../modules/develop/DevelopLeftPanel'
import { ToastHost } from '../design/ToastHost'
import { PromptHost } from '../design/PromptHost'
import { db } from '../catalog/db'
import { useUI } from '../state/ui'
import '../styles/index.css'

/*
 * Develop's left panel, driven.
 *
 * The preset library is the one part of Develop you can lose your way in: it is
 * a tree of other people's files, it is the only list in the panel that grows
 * without bound, and the two routes into it — saving what you have, importing
 * what you bought — are worth nothing if they aren't on screen. So this checks
 * the shape of the thing rather than the numbers: groups fold, folded groups
 * are untouchable, Save and Import are visible without a hover, the tree is the
 * only part that scrolls, and a built-in never offers to delete itself.
 */

declare global {
  interface Window {
    __result?: unknown
    __done?: boolean
  }
}

const failures: string[] = []
const fail = (m: string) => failures.push(m)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const GROUPS = /^(COLOUR NEGATIVE|CINEMATIC|BLACK & WHITE|GENRE|TOOLS|USER PRESETS)/i

const groupRows = () =>
  [...document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].filter((b) =>
    GROUPS.test((b.textContent ?? '').trim()),
  )

const groupRow = (label: string) =>
  groupRows().find((b) => (b.textContent ?? '').trim().toUpperCase().startsWith(label.toUpperCase()))

const presetRow = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === name,
  )

const menuText = () => document.querySelector('[role="menu"]')?.textContent ?? ''

function rightClick(el: Element) {
  const r = el.getBoundingClientRect()
  el.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 4, clientY: r.top + 4 }),
  )
}

const escape = () =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

async function run() {
  // This runs against the live catalog when opened in a real browser, so the
  // user's own presets are put back exactly as they were — including if an
  // assertion throws on the way through.
  const saved = await db.presets.toArray()
  const savedGroups = useUI.getState().expandedPresetGroups
  try {
    await drive()
  } catch (e) {
    fail(`threw: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    await db.presets.clear()
    if (saved.length) await db.presets.bulkAdd(saved)
    useUI.getState().setPresetGroupsExpanded(savedGroups)
  }

  window.__result = failures.length ? { error: true, failures } : { ok: true }
  window.__done = true
}

async function drive() {
  await db.presets.clear()
  await db.presets.bulkAdd([
    {
      id: 'u1',
      name: 'My Warm Look',
      group: 'User Presets',
      builtin: false,
      sections: ['basic'],
      paths: ['basic.contrast'],
      edits: { basic: { contrast: 10 } },
      createdAt: 1,
    },
    {
      id: 'u2',
      name: 'Studio Flat',
      group: 'User Presets',
      builtin: false,
      sections: ['basic'],
      paths: ['basic.contrast'],
      edits: { basic: { contrast: -5 } },
      createdAt: 2,
    },
  ] as never)
  useUI.getState().setPresetGroupsExpanded([])
  await sleep(500)

  // --- Only the preset tree scrolls; the Navigator stays put. ---------------
  const scrollers = [...document.querySelectorAll<HTMLElement>('.esq-scroll')]
  const navigator = [...document.querySelectorAll('*')].find(
    (n) => n.textContent?.trim() === 'Navigator',
  )
  if (scrollers.some((s) => s.contains(navigator ?? document.body)))
    fail('the Navigator sits inside a scroll area')
  const presetScroll = scrollers.find((s) => GROUPS.test(s.textContent ?? ''))
  if (!presetScroll) fail('the preset tree is not in a scroll area')
  const header = [...document.querySelectorAll('header')].find((h) =>
    h.textContent?.includes('Presets'),
  )
  if (!header) fail('no Presets header')
  else if (presetScroll?.contains(header)) fail('the Presets header scrolls with the tree')

  // --- Groups start closed, one row each, with a count. ---------------------
  const rows = groupRows()
  if (rows.length !== 6) fail(`expected 6 group rows, saw ${rows.length}`)
  if (rows.some((r) => r.getAttribute('aria-expanded') !== 'false'))
    fail('a group started expanded')
  if (rows.some((r) => /\d/.test(r.textContent ?? '')))
    fail(`a group row still shows a count: ${rows.map((r) => r.textContent).join(' | ')}`)
  if (!presetRow('My Warm Look')?.closest('[inert]'))
    fail('closed group contents are not inert')

  // --- Clicking a group opens it and remembers. -----------------------------
  groupRow('Cinematic')?.click()
  await sleep(450)
  if (groupRow('Cinematic')?.getAttribute('aria-expanded') !== 'true') fail('group did not open')
  if (!useUI.getState().expandedPresetGroups.includes('Cinematic'))
    fail('open state was not persisted')
  if (presetRow('Teal & Orange')?.closest('[inert]')) fail('open group contents stayed inert')

  groupRow('Cinematic')?.click()
  await sleep(450)
  if (useUI.getState().expandedPresetGroups.includes('Cinematic')) fail('group did not close')

  // --- One always-visible ⋯ is the whole interaction layer. -----------------
  const bar = header?.lastElementChild
  if (bar && getComputedStyle(bar).opacity !== '1')
    fail(`the header action is hidden (opacity ${getComputedStyle(bar).opacity})`)
  const actions = [...(header?.querySelectorAll<HTMLButtonElement>('button[title]') ?? [])]
  if (actions.length !== 1)
    fail(`expected one header action, saw ${actions.map((b) => b.title).join(' | ')}`)

  // --- …and it carries save, both imports, and expand all. -----------------
  actions.at(-1)?.click()
  await sleep(180)
  const lib = document.body.textContent ?? ''
  for (const want of [
    'Save Current Settings as Preset…',
    'Import Presets…',
    'Import Preset Folder…',
    'Expand All',
  ])
    if (!lib.includes(want)) fail(`library menu missing "${want}"`)
  escape()
  await sleep(180)

  // --- The same menu answers a right-click on the header. -------------------
  if (header) {
    rightClick(header)
    await sleep(180)
    if (!menuText().includes('Save Current Settings as Preset…'))
      fail('the header right-click menu does not offer saving')
    escape()
    await sleep(180)
  }

  // --- A user preset offers rename / move / export / delete. ----------------
  useUI.getState().setPresetGroupsExpanded(['User Presets'])
  await sleep(450)
  const mine = presetRow('My Warm Look')
  if (!mine) fail('user preset row not found')
  else {
    rightClick(mine)
    await sleep(180)
    const items = document.body.textContent ?? ''
    for (const want of ['Rename…', 'Move to Group…', 'Export as .xmp…', 'Delete'])
      if (!items.includes(want)) fail(`preset menu missing "${want}"`)
    escape()
    await sleep(180)
  }

  // --- A built-in offers no destructive edits. ------------------------------
  useUI.getState().setPresetGroupsExpanded(['Cinematic'])
  await sleep(450)
  const builtin = presetRow('Teal & Orange')
  if (!builtin) fail('built-in preset row not found')
  else {
    rightClick(builtin)
    await sleep(180)
    const items = menuText()
    if (items.includes('Delete')) fail('built-in preset offers Delete')
    if (items.includes('Rename')) fail('built-in preset offers Rename')
    if (!items.includes('Export as .xmp…')) fail(`built-in cannot be exported (saw "${items}")`)
    escape()
    await sleep(180)
  }

  // --- Group header menu exports the group. --------------------------------
  const gm = groupRow('User Presets')
  if (!gm) fail('group row for the menu test not found')
  else {
    rightClick(gm)
    await sleep(180)
    if (!(document.body.textContent ?? '').includes('Export Group…'))
      fail('group menu missing Export Group…')
    escape()
    await sleep(180)
  }

  // --- A full tree overflows the preset area alone. -------------------------
  const navBefore = navigator?.getBoundingClientRect().top
  const headBefore = header?.getBoundingClientRect().top
  useUI
    .getState()
    .setPresetGroupsExpanded(['Colour Negative', 'Cinematic', 'Black & White', 'Genre', 'Tools', 'User Presets'])
  await sleep(600)
  const view = presetScroll as HTMLElement | undefined
  if (!view || view.scrollHeight <= view.clientHeight + 1)
    fail(`the expanded tree does not overflow (${view?.scrollHeight} vs ${view?.clientHeight})`)
  else {
    view.scrollTop = view.scrollHeight
    await sleep(120)
    if (view.scrollTop <= 0) fail('the preset area did not scroll')
    if (navigator?.getBoundingClientRect().top !== navBefore) fail('the Navigator moved on scroll')
    if (header?.getBoundingClientRect().top !== headBefore)
      fail('the Presets header moved on scroll')
    if (document.documentElement.scrollTop || document.body.scrollTop)
      fail('the panel itself scrolled')
    await sleep(120)
    if (!header?.nextElementSibling?.firstElementChild?.className.includes('hairline-t'))
      fail('no rule appears under the header once content is hidden behind it')
    view.scrollTop = 0
    await sleep(120)
    if (header?.nextElementSibling?.firstElementChild?.className.includes('hairline-t'))
      fail('the header rule stayed after scrolling back to the top')
  }

  // Leave the panel in its busiest state, so the screenshot shows the tree.
  useUI
    .getState()
    .setPresetGroupsExpanded(['Colour Negative', 'Cinematic', 'Black & White', 'User Presets'])
  await sleep(500)
  if (view) view.scrollTop = 90
  await sleep(200)
}
export function Harness() {
  useEffect(() => {
    void run()
  }, [])

  return (
    <div className="h-full bg-base">
      <div className="h-[560px] w-[240px] border-r border-hairline">
        <DevelopLeftPanel />
      </div>
      <ToastHost />
      <PromptHost />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Harness />)
