/**
 * Filter bar and smart collection drive.
 *
 * Both features are thin surfaces over query code that already worked — the
 * risk isn't the maths, it's that a control writes the wrong key and the grid
 * quietly stops agreeing with the bar. So this drives the real DOM and checks
 * the grid count after every interaction, rather than reading the store back.
 *
 *   node tools/filterdrive.mjs
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
// Vite steps to the next free port when 5173 is taken, so the drive follows.
const ORIGIN = process.env.ESQUE_ORIGIN ?? 'http://localhost:5173'
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text())
})

await page.goto(ORIGIN, { waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 1200))

// Nine photos spread across every axis the bar can filter on, so each control
// has a different right answer and a stuck one can't pass by coincidence.
const SEED = [
  { r: 5, flag: 'pick', label: 'red', cam: 'Canon EOS R5', raw: true, edited: true, kw: ['portrait'] },
  { r: 4, flag: 'pick', label: 'red', cam: 'Canon EOS R5', raw: true, edited: false, kw: ['portrait', 'studio'] },
  { r: 3, flag: 'none', label: 'green', cam: 'Canon EOS R5', raw: false, edited: true, kw: ['landscape'] },
  { r: 2, flag: 'none', label: 'none', cam: 'Nikon Z8', raw: true, edited: false, kw: [] },
  { r: 0, flag: 'reject', label: 'none', cam: 'Nikon Z8', raw: false, edited: false, kw: ['test'] },
  { r: 5, flag: 'pick', label: 'blue', cam: 'Nikon Z8', raw: false, edited: true, kw: ['landscape'] },
  { r: 1, flag: 'none', label: 'none', cam: 'Fujifilm X-T5', raw: true, edited: false, kw: [] },
  { r: 0, flag: 'none', label: 'yellow', cam: 'Fujifilm X-T5', raw: false, edited: false, kw: ['test'] },
  { r: 3, flag: 'reject', label: 'none', cam: 'Fujifilm X-T5', raw: true, edited: false, kw: ['studio'] },
]
const EDITED = SEED.filter((s) => s.edited)

await page.evaluate(async (seed, ORIGIN) => {
  const { db } = await import(`${ORIGIN}/src/catalog/db.ts`)
  const { defaultEdits } = await import(`${ORIGIN}/src/core/defaults.ts`)
  await db.photos.clear()
  await db.collections.clear()
  await db.folders.clear()
  await db.folders.put({ id: 'f1', name: 'Drive', handle: null, addedAt: 0, photoCount: seed.length })
  await db.photos.bulkPut(
    seed.map((s, i) => ({
      id: `p${i}`,
      folderId: 'f1',
      relPath: `p${i}.${s.raw ? 'cr2' : 'jpg'}`,
      filename: `p${i}.${s.raw ? 'cr2' : 'jpg'}`,
      ext: s.raw ? 'cr2' : 'jpg',
      isRaw: s.raw,
      fileSize: 1024,
      modifiedAt: 0,
      addedAt: i,
      // A year apart each, so date rules have something to bracket.
      width: 1200,
      height: 800,
      meta: { cameraModel: s.cam, lens: s.raw ? '24-70mm' : '50mm', iso: 100 * (i + 1), captureTime: Date.UTC(2020 + i, 0, 15) },
      rating: s.r,
      flag: s.flag,
      label: s.label,
      keywords: s.kw,
      title: '',
      caption: '',
      // An untouched photo carries a null `edits`, which is what both the
      // filter and the smart rule read. Deliberately a different count and a
      // different membership from the RAW split, so a control writing the
      // wrong key can't pass by coincidence.
      edits: s.edited ? { ...defaultEdits(), basic: { ...defaultEdits().basic, exposure: 0.5 } } : null,
      thumbKey: null,
      proxyKey: null,
    })),
  )
}, SEED, ORIGIN)
await page.reload({ waitUntil: 'networkidle2' })
await dismissWelcome(page)
await new Promise((r) => setTimeout(r, 1500))

const results = []
const check = (name, got, want, extra) =>
  results.push({ name, ok: got === want, got, want, ...(extra ?? {}) })

const gridCount = () => page.evaluate(() => document.querySelectorAll('[role="option"]').length)
const settle = (ms = 320) => new Promise((r) => setTimeout(r, ms))

// ---- The bar itself -------------------------------------------------------

check('bar starts hidden', await page.evaluate(() => !!document.querySelector('[aria-label="Search photos"]')), false)
await page.keyboard.press('Backslash')
await settle()
check('backslash reveals bar', await page.evaluate(() => !!document.querySelector('[aria-label="Search photos"]')), true)
check('all photos visible', await gridCount(), SEED.length)

// ---- Flags ----------------------------------------------------------------

const clickTitled = (title, nth = 0) =>
  page.evaluate(
    (t, n) => {
      const els = [...document.querySelectorAll(`[title="${t}"]`)]
      if (!els[n]) return false
      els[n].click()
      return true
    },
    title,
    nth,
  )

await clickTitled('Picked')
await settle()
check('flag: picked', await gridCount(), SEED.filter((s) => s.flag === 'pick').length)
await clickTitled('Rejected')
await settle()
check(
  'flag: picked or rejected',
  await gridCount(),
  SEED.filter((s) => s.flag !== 'none').length,
)
await clickTitled('Picked')
await clickTitled('Rejected')
await settle()
check('flag: toggles back off', await gridCount(), SEED.length)

// ---- Rating ---------------------------------------------------------------

await clickTitled('≥ 3')
await settle()
check('rating ≥ 3', await gridCount(), SEED.filter((s) => s.r >= 3).length)
await clickTitled('Rating comparison')
await settle()
check('rating = 3', await gridCount(), SEED.filter((s) => s.r === 3).length)
await clickTitled('Rating comparison')
await settle()
check('rating ≤ 3', await gridCount(), SEED.filter((s) => s.r <= 3).length)
await clickTitled('≤ 3')
await settle()
check('rating clears on re-click', await gridCount(), SEED.length)

// ---- Labels ---------------------------------------------------------------

await clickTitled('Red')
await settle()
check('label: red', await gridCount(), SEED.filter((s) => s.label === 'red').length)
await clickTitled('No label')
await settle()
check(
  'label: red or none',
  await gridCount(),
  SEED.filter((s) => s.label === 'red' || s.label === 'none').length,
)
await clickTitled('Red')
await clickTitled('No label')
await settle()

// ---- Text -----------------------------------------------------------------

await page.click('[aria-label="Search photos"]')
await page.type('[aria-label="Search photos"]', 'nikon')
await settle(420)
check('text: camera name', await gridCount(), SEED.filter((s) => s.cam.includes('Nikon')).length)
await page.evaluate(() => {
  const el = document.querySelector('[aria-label="Search photos"]')
  el.focus()
  el.select()
})
await page.keyboard.press('Backspace')
await settle(420)

// ---- Facet menus ----------------------------------------------------------

/**
 * Opens a facet dropdown and clicks one row. The button carries its own
 * selection, so it is addressed by whatever it currently reads — passing the
 * stale label is how a silent no-op sneaks in.
 */
async function pickFromMenu(button, rowText) {
  const opened = await page.evaluate((b) => {
    const el = [...document.querySelectorAll('button')].find(
      (x) => x.textContent.trim().startsWith(b),
    )
    el?.click()
    return !!el
  }, button)
  await settle(220)
  const picked = await page.evaluate((t) => {
    const row = [...document.querySelectorAll('[role="menuitem"]')].find((r) =>
      r.textContent.includes(t),
    )
    if (!row) return false
    row.click()
    return true
  }, rowText)
  await page.keyboard.press('Escape')
  await settle()
  if (!opened || !picked)
    results.push({ name: `menu ${button} → ${rowText}`, ok: false, got: { opened, picked }, want: 'both' })
  return opened && picked
}

check('camera facet opens and picks', await pickFromMenu('Camera', 'Fujifilm X-T5'), true)
check('camera: Fujifilm', await gridCount(), SEED.filter((s) => s.cam.includes('Fuji')).length)
await pickFromMenu('Fujifilm X-T5', 'Any')
check('camera clears via Any', await gridCount(), SEED.length)

check('file facet opens', await pickFromMenu('File', 'RAW only'), true)
check('file: RAW', await gridCount(), SEED.filter((s) => s.raw).length)
// The button now reads its own selection, so that is what it answers to.
await pickFromMenu('RAW', 'Any file type')
check('file type clears', await gridCount(), SEED.length)

await pickFromMenu('File', 'Edited')
check('edited only', await gridCount(), EDITED.length)

check('keyword facet picks', await pickFromMenu('Keyword', 'landscape'), true)
check(
  'edited + keyword compose',
  await gridCount(),
  EDITED.filter((s) => s.kw.includes('landscape')).length,
)

// ---- Clear ----------------------------------------------------------------

await page.evaluate(() => {
  ;[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Clear')?.click()
})
await settle()
check('clear restores everything', await gridCount(), SEED.length)

// ---- Smart collections ----------------------------------------------------

await page.evaluate(async (ORIGIN) => {
  const { editSmartCollection } = await import(`${ORIGIN}/src/state/smartEditor.ts`)
  editSmartCollection()
}, ORIGIN)
await settle(400)
const dialogUp = await page.evaluate(() => !!document.querySelector('[role="dialog"]'))
check('rule editor opens', dialogUp, true)

const footerCount = () =>
  page.evaluate(() => {
    const t = document.querySelector('[role="dialog"]')?.textContent ?? ''
    if (/Every photo matches/.test(t)) return -1
    return Number((t.match(/([\d,]+) photos? match/) ?? [])[1]?.replace(/,/g, '') ?? NaN)
  })

// A fresh editor opens on `rating is 3` rather than on nothing, so the count is
// already answering a question before a single control is touched.
check('live count on the opening rule', await footerCount(), SEED.filter((s) => s.r === 3).length)

// Widen it to `rating is at least 4` through the same selects a person uses.
const setNative = (el, v, event) => {
  const proto = Object.getPrototypeOf(el)
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
  el.dispatchEvent(new Event(event, { bubbles: true }))
}
await page.evaluate(
  (fn) => {
    const set = new Function('return ' + fn)()
    const d = document.querySelector('[role="dialog"]')
    set(d.querySelectorAll('select')[1], 'gte', 'change')
  },
  setNative.toString(),
)
await settle()
await page.evaluate(
  (fn) => {
    const set = new Function('return ' + fn)()
    const el = document.querySelector('[role="dialog"] [aria-label="Value"]')
    el.focus()
    set(el, '4', 'input')
  },
  setNative.toString(),
)
// Numeric fields commit on blur or Enter, not per keystroke — which is why the
// field has to hold focus for the Enter to reach it.
await page.keyboard.press('Enter')
await settle(400)
check('live count tracks the widened rule', await footerCount(), SEED.filter((s) => s.r >= 4).length)

await page.evaluate(() => {
  ;[...document.querySelectorAll('[role="dialog"] button')]
    .find((b) => /Create|Save/.test(b.textContent.trim()))
    ?.click()
})
await settle(600)

const saved = await page.evaluate(async (ORIGIN) => {
  const { db } = await import(`${ORIGIN}/src/catalog/db.ts`)
  const all = await db.collections.toArray()
  const c = all[0]
  return c ? { smart: c.smart, rules: c.rules.length, match: c.match, photoIds: c.photoIds.length } : null
}, ORIGIN)
check('collection saved as smart', saved?.smart, true, { saved })
check('rule persisted', saved?.rules, 1)
check('smart collection holds no fixed members', saved?.photoIds, 0)
check(
  'grid shows the smart membership',
  await gridCount(),
  SEED.filter((s) => s.r >= 4).length,
)

// Membership has to follow the catalog, not a snapshot of it.
await page.evaluate(async (ORIGIN) => {
  const { db } = await import(`${ORIGIN}/src/catalog/db.ts`)
  await db.photos.update('p4', { rating: 5 })
}, ORIGIN)
await settle(600)
check(
  'membership re-evaluates on edit',
  await gridCount(),
  SEED.filter((s) => s.r >= 4).length + 1,
)

console.log(
  JSON.stringify(
    {
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok),
      results,
      errors: errors.slice(0, 6),
    },
    null,
    2,
  ),
)

await page.screenshot({ path: '/tmp/esque-filter.png' })
await browser.close()
