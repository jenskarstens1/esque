/**
 * Local-editing drive: masks, spot removal and red eye.
 *
 * Seeds a photo, opens Develop, and drives the on-canvas overlays with real
 * pointer events, reading the resulting geometry back out of the store.
 *
 * The maths lives in three places that all have to agree — the overlay's
 * CSS-pixel frame box, the normalised geometry in `Edits`, and the shader's
 * sampling — and only a real pointer drag exercises the first two together.
 *
 *   node tools/maskdrive.mjs
 */
import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
]
const executablePath = process.env.ESQUE_BROWSER ?? CANDIDATES.find((p) => existsSync(p))
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text())
})

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 1200))

await page.evaluate(async () => {
  const { db } = await import('/src/catalog/db.ts')
  const { defaultEdits } = await import('/src/core/defaults.ts')
  await db.folders.put({ id: 'f1', name: 'Mask', handle: null, addedAt: 0, photoCount: 1 })
  await db.photos.put({
    id: 'p1',
    folderId: 'f1',
    relPath: 'p1.jpg',
    filename: 'p1.jpg',
    ext: 'jpg',
    isRaw: false,
    fileSize: 1024,
    modifiedAt: 0,
    addedAt: 0,
    width: 1200,
    height: 800,
    meta: {},
    rating: 0,
    flag: 'none',
    label: 'none',
    keywords: [],
    title: '',
    caption: '',
    edits: defaultEdits(),
    thumbKey: null,
    proxyKey: null,
  })
})
await page.reload({ waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 2000))

const results = []
const ok = (name, cond, why = '') => results.push({ name, ok: !!cond, why })
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol

async function selectPhoto() {
  for (let i = 0; i < 20; i++) {
    const id = await page.evaluate(async () => {
      const { useCatalog } = window.__esque
      const c = useCatalog.getState()
      if (c.visibleIds.includes('p1')) c.select('p1')
      return useCatalog.getState().primaryId
    })
    if (id === 'p1') return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

// JSON on purpose: immer drafts carry a symbol key puppeteer cannot serialise.
async function state() {
  const raw = await page.evaluate(() => {
    const { useDevelop, useMasking, useUI } = window.__esque
    const d = useDevelop.getState()
    const m = useMasking.getState()
    return JSON.stringify({
      masks: d.edits.masks,
      selectedMaskId: m.selectedMaskId,
      selectedComponentId: m.selectedComponentId,
      pendingKind: m.pendingKind,
      overlay: m.overlay,
      brushSize: m.brushSize,
      brushFeather: m.brushFeather,
      tool: useUI.getState().developTool,
    })
  })
  return JSON.parse(raw)
}

async function retouch() {
  const raw = await page.evaluate(() => {
    const { useDevelop, useRetouch, useUI } = window.__esque
    const d = useDevelop.getState()
    const r = useRetouch.getState()
    return JSON.stringify({
      spots: d.edits.spots,
      redEye: d.edits.redEye,
      spotRadius: r.spotRadius,
      eyeRadius: r.eyeRadius,
      tool: useUI.getState().developTool,
    })
  })
  return JSON.parse(raw)
}

/** The photo's on-screen box in page coordinates. */
const frameBox = () =>
  page.evaluate(() => {
    const { useDevelop } = window.__esque
    const { geometryOutputSize } = window.__esque.geometry
    const host = document.querySelector('canvas')?.parentElement
    if (!host) return null
    const r = host.getBoundingClientRect()
    const s = useDevelop.getState()
    const size = geometryOutputSize(1200, 800, s.edits)
    const scale = Math.min(r.width / size.width, r.height / size.height)
    const w = size.width * scale
    const h = size.height * scale
    return { x: r.x + (r.width - w) / 2, y: r.y + (r.height - h) / 2, w, h }
  })

async function drag(from, to, steps = 14) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    )
  }
  await page.mouse.up()
  await new Promise((r) => setTimeout(r, 250))
}

const addMask = (kind) =>
  page.evaluate((k) => {
    const { useDevelop, useMasking, useUI, masks } = window.__esque
    const list = useDevelop.getState().edits.masks
    const mask = masks.newMask(list, k)
    useDevelop.getState().update('masks.add', 'Add Mask', (e) => {
      e.masks.push(mask)
    }, false)
    useMasking.getState().select(mask.id, mask.components[0].id)
    useUI.getState().openDevelopTool('mask')
    if (k === 'linear' || k === 'radial' || k === 'brush')
      useMasking.getState().setPending(k, 'new')
    return mask.id
  }, kind)

const clearMasks = () =>
  page.evaluate(() => {
    const { useDevelop, useMasking } = window.__esque
    useDevelop.getState().update('masks.clear', 'Clear', (e) => {
      e.masks = []
    }, false)
    useMasking.getState().select(null)
  })

// ---------------------------------------------------------------------------

ok('photo selected', await selectPhoto())
await page.mouse.click(800, 500)
await page.keyboard.press('d')
await new Promise((r) => setTimeout(r, 2500))
for (let i = 0; i < 20; i++) {
  const id = await page.evaluate(async () => {
    const { useDevelop } = window.__esque
    const { db } = await import('/src/catalog/db.ts')
    if (useDevelop.getState().photoId !== 'p1') {
      await useDevelop.getState().load(await db.photos.get('p1'))
    }
    return useDevelop.getState().photoId
  })
  if (id === 'p1') break
  await new Promise((r) => setTimeout(r, 300))
}
await new Promise((r) => setTimeout(r, 800))

// -- M opens the tool -------------------------------------------------------
await page.keyboard.press('m')
await new Promise((r) => setTimeout(r, 400))
let s = await state()
ok('M opens masking', s.tool === 'mask', `tool=${s.tool}`)

// -- Create a linear mask and drag it into place ----------------------------
await addMask('linear')
await new Promise((r) => setTimeout(r, 350))
s = await state()
ok('mask created', s.masks.length === 1, `${s.masks.length}`)
ok('mask selected', s.selectedMaskId === s.masks[0]?.id)
ok('linear armed', s.pendingKind === 'linear', `${s.pendingKind}`)

const fb = await frameBox()
ok('frame box found', fb && fb.w > 100, JSON.stringify(fb))
const at = (nx, ny) => ({ x: fb.x + nx * fb.w, y: fb.y + ny * fb.h })

await drag(at(0.3, 0.2), at(0.3, 0.7))
s = await state()
let g = s.masks[0].components[0].geometry
ok('linear start placed', near(g.start.x, 0.3) && near(g.start.y, 0.2), JSON.stringify(g.start))
ok('linear end placed', near(g.end.x, 0.3) && near(g.end.y, 0.7), JSON.stringify(g.end))
ok('placing disarms', s.pendingKind === null, `${s.pendingKind}`)

// Dragging the end line again should move only the end.
await drag(at(0.3, 0.7), at(0.3, 0.9))
s = await state()
g = s.masks[0].components[0].geometry
ok('linear end re-drags', near(g.end.y, 0.9, 0.04), JSON.stringify(g.end))
ok('linear start unmoved', near(g.start.y, 0.2, 0.04), JSON.stringify(g.start))

// -- Radial ------------------------------------------------------------------
await clearMasks()
await addMask('radial')
await new Promise((r) => setTimeout(r, 300))
await drag(at(0.5, 0.5), at(0.75, 0.65))
s = await state()
g = s.masks[0].components[0].geometry
ok('radial centred', near(g.center.x, 0.5) && near(g.center.y, 0.5), JSON.stringify(g.center))
ok('radial rx', near(g.radiusX, 0.25, 0.03), `${g.radiusX}`)
ok('radial ry', near(g.radiusY, 0.15, 0.03), `${g.radiusY}`)

// The x handle sits at centre + rx: drag it out and only rx should change.
const beforeRy = g.radiusY
await drag(at(0.75, 0.5), at(0.85, 0.5))
s = await state()
g = s.masks[0].components[0].geometry
ok('radial x handle resizes', near(g.radiusX, 0.35, 0.03), `${g.radiusX}`)
ok('radial y unchanged', near(g.radiusY, beforeRy, 0.01), `${g.radiusY}`)

// Centre handle moves the whole ellipse without resizing it.
const rx = g.radiusX
await drag(at(0.5, 0.5), at(0.4, 0.4))
s = await state()
g = s.masks[0].components[0].geometry
ok('radial moves', near(g.center.x, 0.4, 0.03) && near(g.center.y, 0.4, 0.03), JSON.stringify(g.center))
ok('radial keeps size', near(g.radiusX, rx, 0.01), `${g.radiusX}`)

// -- Brush -------------------------------------------------------------------
await clearMasks()
await addMask('brush')
await new Promise((r) => setTimeout(r, 300))
await drag(at(0.2, 0.5), at(0.8, 0.5), 20)
s = await state()
g = s.masks[0].components[0].geometry
ok('brush laid dabs', g.dabs?.length > 5, `kind=${g.kind} n=${g.dabs?.length}`)
if (g.dabs?.length) {
  ok('brush dabs span the stroke',
    near(Math.min(...g.dabs.map((d) => d.x)), 0.2, 0.06) &&
      near(Math.max(...g.dabs.map((d) => d.x)), 0.8, 0.06),
    `${Math.min(...g.dabs.map((d) => d.x))}..${Math.max(...g.dabs.map((d) => d.x))}`)
  ok('brush stays on the line', g.dabs.every((d) => near(d.y, 0.5, 0.03)))
  // Dabs are spaced by radius, so a long stroke must not be a dotted line.
  const xs = g.dabs.map((d) => d.x).sort((a, b) => a - b)
  const maxGap = Math.max(...xs.slice(1).map((x, i) => x - xs[i]))
  ok('brush has no gaps', maxGap <= g.dabs[0].radius, `gap=${maxGap.toFixed(4)} r=${g.dabs[0].radius}`)
}

// -- Brush size keys ---------------------------------------------------------
{
  const before = (await state()).brushSize
  await page.keyboard.press(']')
  await page.keyboard.press(']')
  const bigger = (await state()).brushSize
  await page.keyboard.press('[')
  await page.keyboard.press('[')
  const back = (await state()).brushSize
  ok('] grows the brush', bigger > before, `${before} → ${bigger}`)
  ok('[ shrinks it back', near(back, before, 1e-6), `${back}`)

  await page.keyboard.down('Shift')
  await page.keyboard.press(']')
  await page.keyboard.up('Shift')
  const feather = (await state()).brushFeather
  ok('⇧] grows feather', feather > 50, `${feather}`)
}

// -- Overlay cycling ---------------------------------------------------------
{
  const a = (await state()).overlay
  await page.keyboard.press('o')
  const b = (await state()).overlay
  await page.keyboard.press('o')
  const c = (await state()).overlay
  ok('O cycles the overlay', a !== b && b !== c, `${a} → ${b} → ${c}`)
}

// -- Menu items --------------------------------------------------------------
{
  const labels = await page.evaluate(() => {
    const items = window.__esque.menus.maskMenuItems()
    return items.map((i) => i.label ?? '—')
  })
  ok('mask menu lists Create Mask', labels.includes('Create Mask'), labels.join(', '))
  ok('mask menu lists Select Mask', labels.includes('Select Mask'), labels.join(', '))
  ok('mask menu offers Invert', labels.includes('Invert Mask'), labels.join(', '))
  ok('mask menu offers Delete', labels.includes('Delete Mask'), labels.join(', '))

  const inverted = await page.evaluate(() => {
    const items = window.__esque.menus.maskMenuItems()
    items.find((i) => i.label === 'Invert Mask').onSelect()
    return window.__esque.useDevelop.getState().edits.masks[0].inverted
  })
  ok('menu Invert flips the mask', inverted === true)

  const count = await page.evaluate(() => {
    const items = window.__esque.menus.maskMenuItems()
    items.find((i) => i.label === 'Duplicate Mask').onSelect()
    return window.__esque.useDevelop.getState().edits.masks.length
  })
  ok('menu Duplicate adds a mask', count === 2, `${count}`)

  const left = await page.evaluate(() => {
    const items = window.__esque.menus.maskMenuItems()
    items.find((i) => i.label === 'Delete All Masks').onSelect()
    return window.__esque.useDevelop.getState().edits.masks.length
  })
  ok('menu Delete All clears', left === 0, `${left}`)
}

// -- The Masking panel --------------------------------------------------------
{
  // The section is collapsed by default; open it the way a user would.
  const opened = await page.evaluate(() => {
    const header = [...document.querySelectorAll('button, [role="button"]')].find(
      (b) => b.textContent.trim().startsWith('Masking'),
    )
    if (!header) return false
    header.click()
    return true
  })
  ok('masking panel present', opened)
  await new Promise((r) => setTimeout(r, 300))

  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'Create Mask',
    )
    if (!btn) return false
    btn.click()
    return true
  })
  ok('panel offers Create Mask', clicked)
  await new Promise((r) => setTimeout(r, 300))

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((b) =>
      b.textContent.trim(),
    ),
  )
  ok('Create Mask lists every kind', rows.length >= 5, rows.join(', '))
  ok('Create Mask lists Radial', rows.some((r) => /Radial/i.test(r)), rows.join(', '))

  const made = await page.evaluate(() => {
    const item = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((b) =>
      /Radial/i.test(b.textContent),
    )
    item?.click()
    return true
  })
  void made
  await new Promise((r) => setTimeout(r, 400))
  s = await state()
  ok('panel creates a mask', s.masks.length === 1, `${s.masks.length}`)
  ok('panel opens the tool', s.tool === 'mask', `${s.tool}`)
  ok('panel arms placement', s.pendingKind === 'radial', `${s.pendingKind}`)

  // Sliders only appear once a mask is selected, and they must drive the mask
  // rather than the top-level Edits tree.
  const exposed = await page.evaluate(() => {
    const { useDevelop, useMasking } = window.__esque
    const id = useMasking.getState().selectedMaskId
    useDevelop.getState().update('masks.adj.exposure', 'Exposure', (e) => {
      const m = e.masks.find((x) => x.id === id)
      if (m) m.adjustments.exposure = 1.5
    })
    const st = useDevelop.getState()
    return JSON.stringify({
      local: st.edits.masks[0].adjustments.exposure,
      global: st.edits.basic.exposure,
    })
  })
  const ex = JSON.parse(exposed)
  ok('mask exposure is local', ex.local === 1.5 && ex.global === 0, exposed)

  await clearMasks()
}

// -- Retouch: spots ----------------------------------------------------------
{
  await page.keyboard.press('q')
  await new Promise((r) => setTimeout(r, 400))
  let r = await retouch()
  ok('Q opens spot removal', r.tool === 'heal', `${r.tool}`)

  // Click-drag creates a spot and sizes it.
  await drag(at(0.35, 0.4), at(0.42, 0.4))
  r = await retouch()
  ok('spot created', r.spots.length === 1, `${r.spots.length}`)
  if (r.spots.length) {
    const sp = r.spots[0]
    ok('spot target is the click', near(sp.target.x, 0.35) && near(sp.target.y, 0.4), JSON.stringify(sp.target))
    // The drag was 0.07 of the frame width; radii are normalised to the long
    // edge, so 0.07 * width / long === 0.07 here (width is the long edge).
    ok('drag sizes the spot', near(sp.radius, 0.07, 0.02), `${sp.radius}`)
    ok('spot has a source', sp.source.x !== sp.target.x || sp.source.y !== sp.target.y, JSON.stringify(sp.source))
    ok('source clears the target',
      Math.hypot(sp.source.x - sp.target.x, sp.source.y - sp.target.y) >= sp.radius,
      `${Math.hypot(sp.source.x - sp.target.x, sp.source.y - sp.target.y)} vs ${sp.radius}`)
    ok('spot defaults to heal', sp.mode === 'heal', sp.mode)
  }

  // The source circle drags independently.
  {
    const sp = (await retouch()).spots[0]
    const from = at(sp.source.x, sp.source.y)
    await drag(from, { x: from.x + 60, y: from.y })
    const after = (await retouch()).spots[0]
    ok('source drags', after.source.x > sp.source.x + 0.03, `${sp.source.x} → ${after.source.x}`)
    ok('target stays put', near(after.target.x, sp.target.x, 0.005), `${after.target.x}`)
  }

  // Moving the target takes the source with it, so the repair patch is kept.
  {
    const sp = (await retouch()).spots[0]
    const offset = { x: sp.source.x - sp.target.x, y: sp.source.y - sp.target.y }
    const from = at(sp.target.x, sp.target.y)
    await drag(from, { x: from.x, y: from.y + 80 })
    const after = (await retouch()).spots[0]
    ok('target drags', after.target.y > sp.target.y + 0.05, `${sp.target.y} → ${after.target.y}`)
    ok('source follows the target',
      near(after.source.x - after.target.x, offset.x, 0.005) &&
        near(after.source.y - after.target.y, offset.y, 0.005),
      `${after.source.y - after.target.y} vs ${offset.y}`)
  }

  // Brackets resize the *next* spot.
  {
    const before = (await retouch()).spotRadius
    await page.keyboard.press(']')
    const after = (await retouch()).spotRadius
    ok('] grows the spot tool', after > before, `${before} → ${after}`)
  }

  // -- Red eye ---------------------------------------------------------------
  await page.keyboard.down('Shift')
  await page.keyboard.press('q')
  await page.keyboard.up('Shift')
  await new Promise((r) => setTimeout(r, 400))
  r = await retouch()
  ok('⇧Q opens red eye', r.tool === 'redeye', `${r.tool}`)

  await drag(at(0.5, 0.3), at(0.55, 0.3))
  r = await retouch()
  ok('red eye created', r.redEye.length === 1, `${r.redEye.length}`)
  if (r.redEye.length) {
    const eye = r.redEye[0]
    ok('red eye centred on the click', near(eye.center.x, 0.5) && near(eye.center.y, 0.3), JSON.stringify(eye.center))
    ok('drag sizes the pupil', near(eye.radius, 0.05, 0.02), `${eye.radius}`)
    ok('red eye defaults to human', eye.kind === 'human', eye.kind)
  }

  // -- Retouch menu ----------------------------------------------------------
  {
    const labels = await page.evaluate(() =>
      window.__esque.menus.retouchMenuItems().map((i) => i.label ?? '—'),
    )
    ok('retouch menu offers Spot Removal', labels.includes('Spot Removal'), labels.join(', '))
    ok('retouch menu lists spot deletion',
      labels.some((l) => /Delete \d+ Spot/.test(l)), labels.join(', '))

    const cloned = await page.evaluate(() => {
      const items = window.__esque.menus.retouchMenuItems()
      items.find((i) => i.label === 'New Spots Clone').onSelect()
      return window.__esque.useRetouch.getState().spotMode
    })
    ok('menu switches new spots to clone', cloned === 'clone', cloned)

    const healed = await page.evaluate(() => {
      const items = window.__esque.menus.retouchMenuItems()
      items.find((i) => i.label === 'Heal All Spots').onSelect()
      return window.__esque.useDevelop.getState().edits.spots.every((s) => s.mode === 'heal')
    })
    ok('menu heals all spots', healed === true)

    const left = await page.evaluate(() => {
      const items = window.__esque.menus.retouchMenuItems()
      items.find((i) => /Delete \d+ Spot/.test(i.label ?? '')).onSelect()
      const after = window.__esque.menus.retouchMenuItems()
      after.find((i) => /Delete \d+ Red Eye/.test(i.label ?? ''))?.onSelect()
      const st = window.__esque.useDevelop.getState().edits
      return st.spots.length + st.redEye.length
    })
    ok('menu clears retouching', left === 0, `${left}`)
  }
}

// -- Panel layout: nothing may overflow the right panel ----------------------
// `Button` carries `shrink-0`, so two `full` buttons in one flex row silently
// push the second one off the edge of the panel where it can never be clicked.
for (const tool of ['mask', 'heal', 'redeye']) {
  await page.evaluate((t) => window.__esque.useUI.getState().openDevelopTool(t), tool)
  await new Promise((r) => setTimeout(r, 300))
  const spill = await page.evaluate(() => {
    const panel = document.querySelector('[data-panel="develop-right"]')
    if (!panel) return 'no panel'
    const box = panel.getBoundingClientRect()
    const bad = []
    for (const el of panel.querySelectorAll('button, select, input')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      if (r.right > box.right + 1 || r.left < box.left - 1) {
        bad.push(`${el.textContent.trim().slice(0, 20) || el.tagName}@${Math.round(r.left)}..${Math.round(r.right)}`)
      }
    }
    return bad
  })
  ok(`no control overflows the panel with the ${tool} tool open`,
    Array.isArray(spill) && spill.length === 0,
    Array.isArray(spill) ? spill.join(', ') : spill)
}

// -- Escape closes the tool --------------------------------------------------
await page.keyboard.press('Escape')
await new Promise((r) => setTimeout(r, 250))
ok('Escape closes the open tool', (await state()).tool === 'none')

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.why ? '  — ' + r.why : ''}`)
if (errors.length) {
  console.log('\npage errors:')
  for (const e of errors.slice(0, 12)) console.log('  ' + e)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
await browser.close()
process.exit(failed.length || errors.length ? 1 : 0)
