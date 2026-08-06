/**
 * Crop overlay drive. Seeds a photo, opens Develop, presses R, then drags the
 * real handles with real pointer events and reads the resulting crop rect back
 * out of the store.
 *
 * This is the only check that covers the overlay end to end: the CSS-pixel
 * frame box, the handle hit targets, the normalised drag maths and the aspect
 * lock all have to agree for the numbers to land.
 *
 *   node tools/cropdrive.mjs
 */
import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import { dismissWelcome } from './lib/welcome.mjs'

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
]
const executablePath = process.env.ESQUE_BROWSER ?? CANDIDATES.find((p) => existsSync(p))

/**
 * Where the dev server is. Vite moves to the next free port when 5173 is taken,
 * and a drive that keeps asking for 5173 regardless will run its whole suite
 * against whatever else is sitting there — passing or failing for reasons that
 * have nothing to do with esque.
 */
const ORIGIN = (process.env.ESQUE_ORIGIN ?? 'http://localhost:5173').replace(/\/$/, '')
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

await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 1200))

// A 3:2 photo. No pixels needed: the overlay's geometry comes from the
// catalog's recorded dimensions, so it lays out before any decode finishes.
await page.evaluate(async () => {
  const { db } = await import('/src/catalog/db.ts')
  const { defaultEdits } = await import('/src/core/defaults.ts')
  await db.folders.put({ id: 'f1', name: 'Crop', handle: null, addedAt: 0, photoCount: 1 })
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
await dismissWelcome(page)
await new Promise((r) => setTimeout(r, 2000))

const results = []
const ok = (name, cond, why = '') => results.push({ name, ok: !!cond, why })

/** The catalog's own sync can clear a selection made too early, so retry. */
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

// JSON round-trip on purpose: immer's drafts carry a symbol key that puppeteer
// cannot serialise, and a plain spread copies it straight through.
const crop = async () =>
  JSON.parse(
    await page.evaluate(async () => {
      const { useDevelop } = window.__esque
      return JSON.stringify(useDevelop.getState().edits.crop)
    }),
  )

const setCrop = (patch) =>
  page.evaluate(async (p) => {
    const { useDevelop } = window.__esque
    useDevelop.getState().update('crop.rect', 'Seed', (e) => {
      Object.assign(e.crop, p)
    }, false)
  }, patch)

/** The photo's on-screen box, straight off the overlay's own geometry. */
const frameBox = () =>
  page.evaluate(async () => {
    const { useDevelop } = window.__esque
    const { geometryOutputSize, uncrop } = window.__esque.geometry
    const { useUI } = window.__esque
    const host = document.querySelector('canvas')?.parentElement
    if (!host) return null
    const r = host.getBoundingClientRect()
    const s = useDevelop.getState()
    const size = geometryOutputSize(1200, 800, uncrop(s.edits, true))
    void useUI
    return { host: { x: r.x, y: r.y, w: r.width, h: r.height }, size }
  })

async function drag(from, to, steps = 12) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    )
  }
  await page.mouse.up()
  await new Promise((r) => setTimeout(r, 220))
}

// ---------------------------------------------------------------------------

ok('photo selected', await selectPhoto())
// Click first so the document has focus, then use the app's own shortcut.
await page.mouse.click(800, 500)
await page.keyboard.press('d')
await new Promise((r) => setTimeout(r, 2500))
// The develop session normally loads off the selection; drive it directly so
// the harness does not race the subscription.
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

// -- R opens the tool -------------------------------------------------------
await page.keyboard.press('r')
await new Promise((r) => setTimeout(r, 400))
let tool = await page.evaluate(async () => {
  const { useUI } = window.__esque
  return useUI.getState().developTool
})
ok('R opens crop', tool === 'crop', `tool=${tool}`)

const overlay = await page.evaluate(() => !!document.querySelector('[data-crop-frame]'))
ok('overlay renders', overlay)
if (!overlay) {
  const why = await page.evaluate(async () => {
    const { useDevelop } = window.__esque
    const { useUI } = window.__esque
    const { useCatalog } = window.__esque
    const ui = useUI.getState()
    return {
      tool: ui.developTool, module: ui.module, viewMode: ui.viewMode,
      photoId: useDevelop.getState().photoId,
      sel: useCatalog.getState().selected,
      visible: useCatalog.getState().visibleIds,
      canvases: document.querySelectorAll('canvas').length,
      body: document.body.innerText.slice(0, 300),
    }
  })
  console.log('DIAG', JSON.stringify(why, null, 2))
  console.log('errors', errors.slice(0, 8))
  await browser.close()
  process.exit(1)
}

const fb = await frameBox()
ok('frame is 3:2', fb && Math.abs(fb.size.width / fb.size.height - 1.5) < 0.01, JSON.stringify(fb?.size))

// -- the rectangle covers the photo at rest ---------------------------------
{
  const box = await page.evaluate(() => {
    const o = document.querySelector('[data-crop-frame]')
    const r = o.getBoundingClientRect()
    return { w: r.width, h: r.height }
  })
  ok('full-frame rect is 3:2', Math.abs(box.w / box.h - 1.5) < 0.02, `${box.w}x${box.h}`)
}

// -- drag the SE corner in --------------------------------------------------
{
  await setCrop({ left: 0, top: 0, right: 1, bottom: 1, aspect: 'free', aspectLocked: false })
  const el = await page.evaluate(() => {
    const r = document.querySelector('[data-crop-frame]').getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  await drag({ x: el.x + el.w - 1, y: el.y + el.h - 1 }, { x: el.x + el.w * 0.6, y: el.y + el.h * 0.5 })
  const c = await crop()
  ok('SE drag sets right', Math.abs(c.right - 0.6) < 0.03, `right=${c.right.toFixed(3)}`)
  ok('SE drag sets bottom', Math.abs(c.bottom - 0.5) < 0.03, `bottom=${c.bottom.toFixed(3)}`)
  ok('SE drag keeps origin', c.left === 0 && c.top === 0, `${c.left},${c.top}`)
}

// -- drag the W edge --------------------------------------------------------
{
  await setCrop({ left: 0, top: 0, right: 1, bottom: 1, aspect: 'free', aspectLocked: false })
  const el = await page.evaluate(() => {
    const r = document.querySelector('[data-crop-frame]').getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  await drag({ x: el.x, y: el.y + el.h / 2 }, { x: el.x + el.w * 0.25, y: el.y + el.h / 2 })
  const c = await crop()
  ok('W drag sets left', Math.abs(c.left - 0.25) < 0.03, `left=${c.left.toFixed(3)}`)
  ok('W drag holds bottom', Math.abs(c.bottom - 1) < 0.001 && Math.abs(c.top) < 0.001, `${c.top},${c.bottom}`)
}

// -- move ------------------------------------------------------------------
{
  await setCrop({ left: 0.1, top: 0.1, right: 0.5, bottom: 0.5, aspect: 'free', aspectLocked: false })
  const el = await page.evaluate(() => {
    const r = document.querySelector('[data-crop-frame]').getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  const before = await crop()
  await drag({ x: el.x + el.w / 2, y: el.y + el.h / 2 }, { x: el.x + el.w / 2 + 60, y: el.y + el.h / 2 })
  const c = await crop()
  ok('move keeps size', Math.abs(c.right - c.left - (before.right - before.left)) < 0.002, `w=${(c.right - c.left).toFixed(3)}`)
  ok('move shifts right', c.left > before.left + 0.02, `left ${before.left}→${c.left.toFixed(3)}`)
  ok('move holds top', Math.abs(c.top - before.top) < 0.002, `top=${c.top.toFixed(3)}`)
}

// -- clamping ---------------------------------------------------------------
{
  await setCrop({ left: 0.6, top: 0.6, right: 1, bottom: 1, aspect: 'free', aspectLocked: false })
  const el = await page.evaluate(() => {
    const r = document.querySelector('[data-crop-frame]').getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  await drag({ x: el.x + el.w / 2, y: el.y + el.h / 2 }, { x: el.x + el.w / 2 + 900, y: el.y + el.h / 2 + 900 })
  const c = await crop()
  ok('move clamps inside frame', c.right <= 1.0001 && c.bottom <= 1.0001 && c.left >= -0.0001, JSON.stringify(c))
  ok('move clamp keeps size', Math.abs(c.right - c.left - 0.4) < 0.002, `w=${(c.right - c.left).toFixed(3)}`)
}

// -- aspect lock ------------------------------------------------------------
{
  await setCrop({ left: 0, top: 0, right: 1, bottom: 1 })
  // Through the real menu command, so the harness covers the caller too.
  await page.evaluate(() => {
    const items = window.__esque.menus.cropMenuItems()
    items.find((i) => i.label === 'Aspect').submenu.find((i) => i.label === '1 × 1').onSelect()
  })
  await new Promise((r) => setTimeout(r, 250))
  const fit = await crop()
  const pxAspect = ((fit.right - fit.left) * 1200) / ((fit.bottom - fit.top) * 800)
  ok('1x1 fit is square', Math.abs(pxAspect - 1) < 0.01, `aspect=${pxAspect.toFixed(3)}`)

  const el = await page.evaluate(() => {
    const r = document.querySelector('[data-crop-frame]').getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  ok('locked rect is square on screen', Math.abs(el.w / el.h - 1) < 0.02, `${el.w.toFixed(0)}x${el.h.toFixed(0)}`)

  await drag({ x: el.x + el.w - 1, y: el.y + el.h - 1 }, { x: el.x + el.w - 90, y: el.y + el.h - 30 })
  const c = await crop()
  const a2 = ((c.right - c.left) * 1200) / ((c.bottom - c.top) * 800)
  ok('drag holds 1:1', Math.abs(a2 - 1) < 0.02, `aspect=${a2.toFixed(3)}`)
  ok('drag shrank it', c.right - c.left < fit.right - fit.left - 0.01, `w ${(fit.right - fit.left).toFixed(3)}→${(c.right - c.left).toFixed(3)}`)
}

// -- straighten by dragging outside ----------------------------------------
{
  await page.evaluate(async () => {
    const { useDevelop } = window.__esque
    useDevelop.getState().update('crop.rect', 'Seed', (e) => {
      Object.assign(e.crop, { left: 0.25, top: 0.25, right: 0.75, bottom: 0.75, angle: 0, aspect: 'free', aspectLocked: false })
    }, false)
  })
  await new Promise((r) => setTimeout(r, 250))
  const el = await page.evaluate(() => {
    const r = document.querySelector('[data-crop-frame]').getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  // Well outside the rectangle: the straighten surface.
  await drag({ x: el.x - 60, y: el.y + el.h / 2 }, { x: el.x - 20, y: el.y + el.h / 2 })
  const c = await crop()
  ok('outside drag straightens', Math.abs(c.angle) > 0.2, `angle=${c.angle}`)
  ok('straighten stays in range', c.angle >= -45 && c.angle <= 45, `angle=${c.angle}`)
}

// -- Escape closes ----------------------------------------------------------
await page.keyboard.press('Escape')
await new Promise((r) => setTimeout(r, 350))
tool = await page.evaluate(async () => {
  const { useUI } = window.__esque
  return useUI.getState().developTool
})
ok('Escape closes crop', tool === 'none', `tool=${tool}`)
ok('overlay unmounts', !(await page.evaluate(() => !!document.querySelector('[data-crop-frame]'))))

// -- menu commands ----------------------------------------------------------
{
  const turns = await page.evaluate(async () => {
    const { cropMenuItems } = window.__esque.menus
    const { useDevelop } = window.__esque
    const items = cropMenuItems()
    const find = (l) => items.find((i) => i.label === l)
    find('Rotate Right').onSelect()
    const a = useDevelop.getState().edits.crop.quarterTurns
    find('Rotate Right').onSelect()
    const b = useDevelop.getState().edits.crop.quarterTurns
    find('Rotate Left').onSelect()
    const c = useDevelop.getState().edits.crop.quarterTurns
    find('Flip Horizontal').onSelect()
    const h = useDevelop.getState().edits.crop.flipH
    find('Reset Crop').onSelect()
    const r = JSON.parse(JSON.stringify(useDevelop.getState().edits.crop))
    return { a, b, c, h, r, labels: items.map((i) => i.label ?? '—') }
  })
  ok('Rotate Right steps 0→1', turns.a === 1, `${turns.a}`)
  ok('Rotate Right wraps 1→2', turns.b === 2, `${turns.b}`)
  ok('Rotate Left steps back', turns.c === 1, `${turns.c}`)
  ok('Flip Horizontal toggles', turns.h === true)
  ok('Reset Crop clears turns', turns.r.quarterTurns === 0 && turns.r.angle === 0, JSON.stringify(turns.r))
  ok('Reset Crop restores full frame', turns.r.left === 0 && turns.r.right === 1, JSON.stringify(turns.r))
}

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
