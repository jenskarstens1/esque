import { createRoot } from 'react-dom/client'
import { Profiler, useEffect } from 'react'

import { DevelopLeftPanel } from '../modules/develop/DevelopLeftPanel'
import { ToastHost } from '../design/ToastHost'
import { PromptHost } from '../design/PromptHost'
import { db } from '../catalog/db'
import { defaultEdits } from '../core/defaults'
import type { Preset } from '../core/types'
import { useUI } from '../state/ui'
import { useDevelop } from '../develop/session'
import { applyPreset } from '../develop/presets'
import { sameEdits } from '../develop/equal'
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
let panelCommits = 0
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

interface PanelContext {
  header: HTMLElement | undefined
  navigator: Element | undefined
  presetScroll: HTMLElement | undefined
}

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
  await seedPresets()
  const context = checkScrollableLayout()
  await checkGroups()
  await checkHeaderActions(context.header)
  await checkLibraryMenu(context.header)
  await checkPresetMenus()
  await checkBuiltInAndGroupMenus()
  await checkTreeOverflow(context)
  await checkAdjustmentSubscriptions()
  await leaveScreenshotState(context.presetScroll)
}

async function checkAdjustmentSubscriptions() {
  const saved = useDevelop.getState()
  try {
    useDevelop.setState({ photoId: 'presetpanelcheck', edits: defaultEdits() })
    await sleep(100)
    const commits = panelCommits
    for (let i = 1; i <= 10; i++) {
      const edits = { ...useDevelop.getState().edits,
        basic: { ...useDevelop.getState().edits.basic, exposure: i / 10 } }
      useDevelop.setState({ edits })
      await sleep(20)
    }
    if (panelCommits !== commits) fail('slider changes re-render the preset tree or its closed dialog')
    const preset = await db.presets.get('u1')
    const row = presetRow('My Warm Look')
    if (!preset || !row) throw new Error('Missing preset fixture')
    const expected = applyPreset(useDevelop.getState().edits, preset)
    row.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
    await sleep(50)
    if (!sameEdits(useDevelop.getState().previewEdits, expected))
      fail('preset hover does not use the latest slider settings')
    // No catalog writes: only observe the arguments of the apply action.
    let applied = false
    useDevelop.setState({ replace: (_label, edits) => { applied = sameEdits(edits, expected) } })
    await sleep(50)
    row.click()
    await sleep(50)
    if (!applied) fail('preset apply does not use the latest slider settings')
  } finally {
    useDevelop.setState(saved)
  }
}

async function seedPresets() {
  await db.presets.clear()
  const fixtures: Preset[] = [
    {
      id: 'u1',
      name: 'My Warm Look',
      group: 'User Presets',
      builtin: false,
      sections: ['basic'],
      paths: ['basic.contrast'],
      edits: { basic: { ...defaultEdits().basic, contrast: 10 } },
      createdAt: 1,
    },
    {
      id: 'u2',
      name: 'Studio Flat',
      group: 'User Presets',
      builtin: false,
      sections: ['basic'],
      paths: ['basic.contrast'],
      edits: { basic: { ...defaultEdits().basic, contrast: -5 } },
      createdAt: 2,
    },
  ]
  await db.presets.bulkAdd(fixtures)
  useUI.getState().setPresetGroupsExpanded([])
  await sleep(500)
}

function checkScrollableLayout(): PanelContext {
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
  return { header, navigator, presetScroll }
}

async function checkGroups() {
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
}

async function checkHeaderActions(header: HTMLElement | undefined) {
  const bar = header?.lastElementChild
  if (bar && getComputedStyle(bar).opacity !== '1')
    fail(`the header action is hidden (opacity ${getComputedStyle(bar).opacity})`)
  const actions = [...(header?.querySelectorAll<HTMLButtonElement>('button[title]') ?? [])]
  if (actions.length !== 1)
    fail(`expected one header action, saw ${actions.map((b) => b.title).join(' | ')}`)
}

async function checkLibraryMenu(header: HTMLElement | undefined) {
  const actions = [...(header?.querySelectorAll<HTMLButtonElement>('button[title]') ?? [])]
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
}

async function checkPresetMenus() {
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
}

async function checkBuiltInAndGroupMenus() {
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
}

async function checkTreeOverflow(context: PanelContext) {
  const navBefore = context.navigator?.getBoundingClientRect().top
  const headBefore = context.header?.getBoundingClientRect().top
  useUI
    .getState()
    .setPresetGroupsExpanded(['Colour Negative', 'Cinematic', 'Black & White', 'Genre', 'Tools', 'User Presets'])
  await sleep(600)
  const view = context.presetScroll
  if (!view || view.scrollHeight <= view.clientHeight + 1)
    fail(`the expanded tree does not overflow (${view?.scrollHeight} vs ${view?.clientHeight})`)
  else await checkScrolledTree(context, view, navBefore, headBefore)
}

async function checkScrolledTree(
  context: PanelContext,
  view: HTMLElement,
  navBefore: number | undefined,
  headBefore: number | undefined,
) {
  view.scrollTop = view.scrollHeight
  await sleep(120)
  if (view.scrollTop <= 0) fail('the preset area did not scroll')
  if (context.navigator?.getBoundingClientRect().top !== navBefore) fail('the Navigator moved on scroll')
  if (context.header?.getBoundingClientRect().top !== headBefore)
    fail('the Presets header moved on scroll')
  if (document.documentElement.scrollTop || document.body.scrollTop)
    fail('the panel itself scrolled')
  await sleep(120)
  if (!context.header?.nextElementSibling?.firstElementChild?.className.includes('hairline-t'))
    fail('no rule appears under the header once content is hidden behind it')
  view.scrollTop = 0
  await sleep(120)
  if (context.header?.nextElementSibling?.firstElementChild?.className.includes('hairline-t'))
    fail('the header rule stayed after scrolling back to the top')
}

async function leaveScreenshotState(view: HTMLElement | undefined) {
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
        <Profiler id="left-panel" onRender={() => { panelCommits++ }}>
          <DevelopLeftPanel />
        </Profiler>
      </div>
      <ToastHost />
      <PromptHost />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Harness />)
