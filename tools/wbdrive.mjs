/**
 * White-balance dropper drive.
 *
 * `checks/wbcheck.html` proves the maths — that the CPU coordinate map matches
 * the geometry shader, and that balancing on a patch cancels its cast. None of
 * that is reachable from a mouse, so this covers the other half: the panel
 * button, the overlay that appears with it, and the lifetime of the armed
 * state.
 *
 * Arming is the part worth guarding. It is a mode, and a mode that outlives its
 * surface is the worst kind of bug to find by hand: the button stays lit in a
 * module that is no longer listening, and the next click goes somewhere the
 * photographer did not intend.
 *
 *   node tools/wbdrive.mjs
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
await page.evaluate(async (ORIGIN) => {
  const { db } = await import(`${ORIGIN}/src/catalog/db.ts`)
  await db.folders.put({ id: 'f1', name: 'WB', handle: null, addedAt: 0, photoCount: 1 })
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
    edits: null,
    thumbKey: null,
    proxyKey: null,
  })
}, ORIGIN)
await page.reload({ waitUntil: 'networkidle2' })
await dismissWelcome(page)
await new Promise((r) => setTimeout(r, 2000))

const results = []
const ok = (name, cond, why = '') => results.push({ name, ok: !!cond, why })

/** The catalog's own sync can clear a selection made too early, so retry. */
async function selectPhoto() {
  for (let i = 0; i < 20; i++) {
    const id = await page.evaluate(() => {
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

const armed = () => page.evaluate(() => window.__esque.useUI.getState().wbPicking)
const overlayUp = () =>
  page.evaluate(() => !!document.querySelector('[data-wb-dropper]'))

ok('photo selected', await selectPhoto())

await page.evaluate(() => window.__esque.useUI.getState().setModule('develop'))
await new Promise((r) => setTimeout(r, 1500))
ok('develop opened', await page.evaluate(() => window.__esque.useUI.getState().module === 'develop'))

// --- The button -------------------------------------------------------------

const dropperButton = await page.evaluateHandle(() =>
  [...document.querySelectorAll('button')].find((b) =>
    (b.getAttribute('aria-label') ?? '').toLowerCase().includes('neutral'),
  ),
)
const hasButton = await dropperButton.evaluate((b) => !!b)
ok('dropper button is in the Basic panel', hasButton)

if (hasButton) {
  ok('starts disarmed', (await armed()) === false)
  ok('no overlay while disarmed', (await overlayUp()) === false)

  await dropperButton.evaluate((b) => b.click())
  await new Promise((r) => setTimeout(r, 250))
  ok('clicking the button arms it', (await armed()) === true)
  ok('arming shows the overlay', (await overlayUp()) === true)
  ok(
    'the button reads as pressed',
    await dropperButton.evaluate((b) => b.getAttribute('aria-pressed') === 'true'),
  )

  await dropperButton.evaluate((b) => b.click())
  await new Promise((r) => setTimeout(r, 250))
  ok('clicking again disarms it', (await armed()) === false)
  ok('disarming removes the overlay', (await overlayUp()) === false)

  // --- Escape ---------------------------------------------------------------
  await dropperButton.evaluate((b) => b.click())
  await new Promise((r) => setTimeout(r, 250))
  await page.keyboard.press('Escape')
  await new Promise((r) => setTimeout(r, 250))
  ok('Escape disarms', (await armed()) === false)
}

// --- The armed state does not outlive Develop -------------------------------

await page.evaluate(() => window.__esque.useUI.getState().setWbPicking(true))
await new Promise((r) => setTimeout(r, 250))
ok('armed again for the module test', (await armed()) === true)

await page.evaluate(() => window.__esque.useUI.getState().setModule('library'))
await new Promise((r) => setTimeout(r, 600))
ok('leaving Develop disarms', (await armed()) === false)

await page.evaluate(() => window.__esque.useUI.getState().setModule('develop'))
await new Promise((r) => setTimeout(r, 1200))

// --- Clicking the viewport commits a white balance ---------------------------
//
// The click path is exercised against a synthetic frame rather than a decode,
// because what is unproven here is the wiring — that a pick lands on the edits
// as a *custom* balance and as one undoable step. Whether it lands on the right
// pixel is what `checks/wbcheck.html` measures.

const picked = JSON.parse(
  await page.evaluate(async (ORIGIN) => {
    const { useDevelop, wbPicker } = window.__esque
    const { floatToHalf } = await import(`${ORIGIN}/src/core/half.ts`)
    const W = 64
    const H = 64
    const data = new Uint16Array(W * H * 4)
    // A uniform warm grey: red-heavy, so the answer has to move and has to move
    // downwards in Kelvin.
    const cast = [0.52, 0.4, 0.3, 1]
    for (let i = 0; i < W * H; i++) {
      for (let c = 0; c < 4; c++) data[i * 4 + c] = floatToHalf(cast[c])
    }
    const image = {
      width: W,
      height: H,
      data,
      isRaw: false,
      asShot: { temp: 6504, tint: 0 },
      whiteLevel: 1,
    }
    const before = useDevelop.getState()
    const beforeSteps = before.history?.length ?? 0
    const beforeTemp = before.edits.basic.temp
    const returned = wbPicker.pickWhiteBalanceAt(image, { x: 0.5, y: 0.5 })
    const after = useDevelop.getState()
    return JSON.stringify({
      returned,
      beforeTemp,
      beforeSteps,
      afterSteps: after.history?.length ?? 0,
      mode: after.edits.basic.wbMode,
      temp: after.edits.basic.temp,
      tint: after.edits.basic.tint,
    })
  }, ORIGIN),
)

ok('a pick reports success', picked.returned === true, JSON.stringify(picked))
ok('a pick switches the mode to custom', picked.mode === 'custom', picked.mode)
ok(
  'a pick moves the temperature',
  Math.abs(picked.temp - picked.beforeTemp) > 1,
  `${picked.beforeTemp} → ${picked.temp}`,
)
ok(
  'a warm-lit patch reads below the as-shot temperature',
  picked.temp < 6504,
  `${picked.temp}K`,
)
ok('temperature is in range', picked.temp >= 2000 && picked.temp <= 50000, `${picked.temp}K`)
ok('tint is in range', picked.tint >= -150 && picked.tint <= 150, `${picked.tint}`)
ok(
  'a pick is one undoable step',
  picked.afterSteps === picked.beforeSteps + 1,
  `${picked.beforeSteps} → ${picked.afterSteps}`,
)

// A patch with nothing to say must refuse rather than answer confidently.
const refused = JSON.parse(
  await page.evaluate(async (ORIGIN) => {
    const { useDevelop, wbPicker } = window.__esque
    const { floatToHalf } = await import(`${ORIGIN}/src/core/half.ts`)
    const W = 32
    const H = 32
    const make = (v) => {
      const data = new Uint16Array(W * H * 4)
      for (let i = 0; i < W * H; i++) {
        for (let c = 0; c < 3; c++) data[i * 4 + c] = floatToHalf(v)
        data[i * 4 + 3] = floatToHalf(1)
      }
      return { width: W, height: H, data, isRaw: false, asShot: { temp: 6504, tint: 0 }, whiteLevel: 1 }
    }
    const temp = useDevelop.getState().edits.basic.temp
    const black = wbPicker.pickWhiteBalanceAt(make(0), { x: 0.5, y: 0.5 })
    const blown = wbPicker.pickWhiteBalanceAt(make(1), { x: 0.5, y: 0.5 })
    const off = wbPicker.pickWhiteBalanceAt(make(0.4), { x: 4, y: 0.5 })
    return JSON.stringify({ black, blown, off, temp, after: useDevelop.getState().edits.basic.temp })
  }, ORIGIN),
)
ok('black refuses', refused.black === false)
ok('a blown patch refuses', refused.blown === false)
ok('a point outside the frame refuses', refused.off === false)
ok('a refusal changes nothing', refused.temp === refused.after, `${refused.temp} → ${refused.after}`)

const failed = results.filter((r) => !r.ok)
console.log(
  JSON.stringify(
    { passed: results.length - failed.length, of: results.length, failed, errors: errors.slice(0, 6) },
    null,
    2,
  ),
)
await browser.close()
process.exit(failed.length ? 1 : 0)
