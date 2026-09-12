/**
 * Reload drive: does the app come back to the photograph you left it on?
 *
 * A browser tab is not a session boundary. The catalogue, the previews and the
 * edits all survive a reload in IndexedDB and OPFS, so the only thing a refresh
 * used to throw away was the part held in the photographer's head: which folder
 * they were working through, how it was filtered, and which frame was open. The
 * app reopened on the first photo of "All Photographs" every time.
 *
 * Selection is also the hardest thing to restore, because it has to survive the
 * frames where a live query has no answer yet — restore it too eagerly and the
 * Library publishes an empty view over it, restore it too late and Develop
 * mounts on someone else's photograph. So this drives a real reload in the real
 * chrome and reads the selection back out of the running stores.
 *
 *   node tools/reloaddrive.mjs
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
  results.push({ name, ok: !!pass, ...(pass ? {} : { detail }) })
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass || detail === undefined ? '' : `  (${detail})`}`)
}

const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms))

const ready = async () => {
  await page.waitForFunction('!!window.__esque', { timeout: 30_000, polling: 100 })
  await settle(1200)
  await dismissWelcome(page)
}

const state = () =>
  page.evaluate(() => {
    const c = window.__esque.useCatalog.getState()
    const u = window.__esque.useUI.getState()
    return {
      primary: c.primaryId,
      selected: c.selected.join(','),
      visible: c.visibleIds.length,
      source: JSON.stringify(c.source),
      rating: c.filters.rating,
      sortKey: c.sortKey,
      sortAsc: c.sortAsc,
      module: u.module,
      viewMode: u.viewMode,
    }
  })

await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle2' })
await ready()

// Eight frames across two folders, so a restored folder source is telling the
// truth about which photographs it holds rather than matching the whole roll.
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
await settle(1200)

// --- The photograph survives a reload -------------------------------------
await page.evaluate(() => window.__esque.useCatalog.getState().select('p6'))
await settle(500)
await page.reload({ waitUntil: 'networkidle2' })
await ready()
let s = await state()
ok('the reload comes back on the same photograph', s.primary === 'p6', s.primary)
ok('with the catalogue still in view', s.visible === 8, `${s.visible}`)

// --- A whole selection, not just its primary ------------------------------
await page.evaluate(() => window.__esque.useCatalog.getState().selectMany(['p1', 'p2', 'p3']))
await settle(500)
await page.reload({ waitUntil: 'networkidle2' })
await ready()
s = await state()
ok('a multiple selection survives intact', s.selected === 'p1,p2,p3', s.selected)
ok('and keeps its primary', s.primary === 'p3', s.primary)

// --- The view it was in ---------------------------------------------------
await page.evaluate(() => {
  const c = window.__esque.useCatalog.getState()
  c.setSource({ kind: 'folder', id: 'f2' })
  c.setSort('filename', false)
  window.__esque.useUI.getState().setViewMode('loupe')
})
await settle(700)
await page.evaluate(() => window.__esque.useCatalog.getState().select('p7'))
await settle(500)
await page.reload({ waitUntil: 'networkidle2' })
await ready()
s = await state()
ok('the folder it was working through comes back', s.source === '{"kind":"folder","id":"f2"}', s.source)
ok('showing only that folder', s.visible === 3, `${s.visible}`)
ok('on the photograph it was open on', s.primary === 'p7', s.primary)
ok('in the loupe it was left in', s.viewMode === 'loupe', s.viewMode)
ok('with the sort it was ordered by', s.sortKey === 'filename' && !s.sortAsc, `${s.sortKey}/${s.sortAsc}`)

// --- Develop reopens on its own subject -----------------------------------
await page.evaluate(() => window.__esque.useUI.getState().setModule('develop'))
await settle(900)
await page.reload({ waitUntil: 'networkidle2' })
await ready()
await settle(900)
s = await state()
ok('Develop reopens where it was', s.module === 'develop', s.module)
ok('on the photograph it was editing', s.primary === 'p7', s.primary)
const developing = await page.evaluate(() => window.__esque.useDevelop.getState().photoId)
ok('and hands that photo to the develop session', developing === 'p7', developing)

// --- A source that no longer exists ---------------------------------------
await page.evaluate(async (ORIGIN) => {
  window.__esque.useUI.getState().setModule('library')
  const { db } = await import(`${ORIGIN}/src/catalog/db.ts`)
  await db.folders.delete('f2')
  await db.photos.where('folderId').equals('f2').delete()
}, ORIGIN)
await settle(900)
await page.reload({ waitUntil: 'networkidle2' })
await ready()
await settle(900)
s = await state()
ok('a deleted folder falls back to the whole catalogue', s.source === '{"kind":"all"}', s.source)
ok('rather than stranding the viewer in an empty view', s.visible === 5, `${s.visible}`)
ok('and finds a photograph to be on', s.primary !== null, s.primary)

// --- A filtered view comes back filtered ----------------------------------
await page.evaluate(() => {
  const c = window.__esque.useCatalog.getState()
  c.setFilters({ rating: 3, ratingOp: 'gte' })
})
await settle(800)
await page.reload({ waitUntil: 'networkidle2' })
await ready()
s = await state()
ok('the filter it was culling under comes back', s.rating === 3, `${s.rating}`)
ok('and narrows the view as it did', s.visible === 2, `${s.visible}`)

await page.evaluate(async (ORIGIN) => {
  window.__esque.useCatalog.getState().clearFilters()
  const { db } = await import(`${ORIGIN}/src/catalog/db.ts`)
  await db.photos.clear()
  await db.folders.clear()
}, ORIGIN)
await settle()

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
