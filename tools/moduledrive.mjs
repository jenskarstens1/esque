/**
 * Module switch drive: does Develop open the photograph Library was on?
 *
 * Selection is global — `primaryId` is the one photo both modules point at — so
 * on paper crossing between them is free. In practice each module mounts its
 * own copy of `usePhotos`, and a Dexie live query has no result on the render it
 * is created: for one frame a freshly mounted module honestly believes the
 * catalogue is empty. Published as the visible set, that emptiness takes the
 * selection with it, and the answer arriving a frame later finds no primary and
 * falls back to the first photo on the roll.
 *
 * The failure is invisible from the code and obvious from the chair: you cull
 * down to the frame you want, press Develop, and it opens someone else's
 * photograph. So this drives the real switch in the real chrome, and checks the
 * other half too — that a view which is *genuinely* empty still clears the
 * selection, because a guard that keeps a primary no longer in view is the same
 * bug pointing the other way.
 *
 *   node tools/moduledrive.mjs
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

const results = []
const ok = (name, pass, detail) => {
  results.push({ name, ok: !!pass, ...(pass ? {} : { detail })})
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass || detail === undefined ? '' : `  (${detail})`}`)
}

await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle2' })
// The dev bridge is installed from inside the app's module graph, so it lands a
// beat after the document does — and a drive that starts reading before then
// fails on the harness rather than on the app.
await page.waitForFunction('!!window.__esque', { timeout: 30_000, polling: 100 })
await new Promise((r) => setTimeout(r, 1200))
await dismissWelcome(page)

// Eight frames across two folders and every rating, so a filter, a folder and a
// deletion each land on a different answer and a stuck selection cannot pass by
// coincidence. No pixels: every assertion here is about which id is current.
await page.evaluate(async (ORIGIN) => {
  const { db } = await import(`${ORIGIN}/src/catalog/db.ts`)
  await db.photos.clear()
  await db.folders.clear()
  await db.collections.clear()
  await db.folders.put({ id: 'f1', name: 'A', handle: null, addedAt: 0, photoCount: 5 })
  await db.folders.put({ id: 'f2', name: 'B', handle: null, addedAt: 0, photoCount: 3 })
  await db.photos.bulkPut(
    Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`,
      folderId: i < 5 ? 'f1' : 'f2',
      relPath: `p${i}.jpg`,
      filename: `p${i}.jpg`,
      ext: 'jpg',
      isRaw: false,
      fileSize: 1024,
      modifiedAt: 0,
      addedAt: i,
      width: 1200,
      height: 800,
      meta: { cameraModel: 'Cam', lens: '50mm', iso: 100, captureTime: Date.UTC(2020, 0, i + 1) },
      rating: i % 6,
      flag: 'none',
      label: 'none',
      keywords: [],
      title: '',
      caption: '',
      edits: null,
      thumbRev: 0,
      history: [],
    })),
  )
}, ORIGIN)
await new Promise((r) => setTimeout(r, 1200))

const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms))

const state = () =>
  page.evaluate(() => {
    const c = window.__esque.useCatalog.getState()
    return {
      primary: c.primaryId,
      selected: c.selected.join(','),
      visible: c.visibleIds.length,
      module: window.__esque.useUI.getState().module,
      developing: window.__esque.useDevelop.getState().photoId,
    }
  })

/** Press the module switch in the title bar, as a photographer would. */
const press = async (label) => {
  const hit = await page.evaluate((label) => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find(
      (b) => (b.textContent || '').trim() === label,
    )
    if (!tab) return false
    tab.click()
    return true
  }, label)
  if (!hit) throw new Error(`no "${label}" tab in the title bar`)
  await settle(1400)
}

// --- The photograph crosses the switch ------------------------------------
await page.evaluate(() => window.__esque.useCatalog.getState().select('p5'))
await settle(400)
await press('Develop')
let s = await state()
ok('Develop opens the photo Library was on', s.primary === 'p5', s.primary)
ok('and hands that photo to the develop session', s.developing === 'p5', s.developing)
ok('without emptying the view on the way', s.visible === 8, `${s.visible}`)

// Moving on inside Develop, then back, must survive the same crossing.
await page.evaluate(() => window.__esque.useCatalog.getState().step(-2))
await settle(600)
await press('Library')
s = await state()
ok('Library returns to the photo Develop was on', s.primary === 'p3', s.primary)
await press('Develop')
s = await state()
ok('and Develop still has it on the way back', s.primary === 'p3', s.primary)

// A whole selection crosses, not just its primary: Develop edits one photo but
// the filmstrip, the export sheet and every batch command read all of them.
await page.evaluate(() => window.__esque.useCatalog.getState().selectMany(['p2', 'p3', 'p4']))
await settle(400)
await press('Library')
s = await state()
ok('a multiple selection crosses intact', s.selected === 'p2,p3,p4', s.selected)
ok('and keeps its primary', s.primary === 'p4', s.primary)

// --- A genuinely empty view still clears ----------------------------------
await page.evaluate(() => window.__esque.useCatalog.getState().setFilters({ text: 'no-such-frame' }))
await settle()
s = await state()
ok('a filter that matches nothing clears the selection', s.primary === null && s.visible === 0, JSON.stringify(s))

await page.evaluate(() => window.__esque.useCatalog.getState().clearFilters())
await settle()
s = await state()
ok('clearing the filter finds a primary again', s.primary === 'p0' && s.visible === 8, JSON.stringify(s))

// A narrowing filter keeps whichever members survive it and drops the rest.
await page.evaluate(() => window.__esque.useCatalog.getState().selectMany(['p1', 'p5']))
await settle(400)
await page.evaluate(() => window.__esque.useCatalog.getState().setFilters({ rating: 5, ratingOp: 'eq' }))
await settle()
s = await state()
ok('a narrowing filter keeps only the surviving members', s.selected === 'p5', s.selected)
await page.evaluate(() => window.__esque.useCatalog.getState().clearFilters())
await settle()

// A photo that leaves the catalog cannot stay current.
await page.evaluate(() => window.__esque.useCatalog.getState().select('p3'))
await settle(400)
await page.evaluate(async (ORIGIN) => {
  const { db } = await import(`${ORIGIN}/src/catalog/db.ts`)
  await db.photos.delete('p3')
}, ORIGIN)
await settle()
s = await state()
ok('deleting the current photo re-primes the selection', s.primary === 'p0' && s.visible === 7, JSON.stringify(s))

await page.evaluate(async (ORIGIN) => {
  const { db } = await import(`${ORIGIN}/src/catalog/db.ts`)
  await db.photos.clear()
}, ORIGIN)
await settle()
s = await state()
ok('emptying the catalog clears the selection', s.primary === null && s.visible === 0, JSON.stringify(s))

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
