/**
 * Drag-and-drop import drive.
 *
 * The drop is the one import path that cannot be exercised from the picker: it
 * has to be *dropped*, anywhere in the window, while the application is in
 * whatever state the photographer left it in. Three things have to hold, and
 * none of them are visible from the code:
 *
 *   1. A folder and a loose file dropped together both import, as one job.
 *   2. The window comes back to the Library, because Develop cannot show them.
 *   3. Dropping a folder while Develop is open still works — the old handler
 *      lived on the empty-catalog screen, which by then is not even mounted.
 *
 * Real handles, not fakes: the sources are built in OPFS, so `importFolder`
 * scans a real directory and `importFiles` keeps a handle it could re-read. The
 * only thing stubbed is the part a synthetic drag cannot carry —
 * `DataTransferItem.getAsFileSystemHandle`, which Chromium only fills in for a
 * drag that came from the desktop.
 *
 *   node tools/dropdrive.mjs
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
  console.log(
    `${pass ? 'ok  ' : 'FAIL'}  ${name}${pass || detail === undefined ? '' : `  (${detail})`}`,
  )
}
const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms))

await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle2' })
await page.waitForFunction('!!window.__esque', { timeout: 30_000, polling: 100 })
await settle(1200)
await dismissWelcome(page)

// --- Sources on disk, and a drag that can carry them -----------------------
await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory()
  const jpeg = async (label) => {
    const canvas = new OffscreenCanvas(64, 48)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = label
    ctx.fillRect(0, 0, 64, 48)
    return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
  }
  const write = async (dir, name, blob) => {
    const handle = await dir.getFileHandle(name, { create: true })
    const w = await handle.createWritable()
    await w.write(blob)
    await w.close()
    return handle
  }

  await root.removeEntry('dropdrive', { recursive: true }).catch(() => {})
  const dir = await root.getDirectoryHandle('dropdrive', { create: true })
  const folder = await dir.getDirectoryHandle('Shoot', { create: true })
  await write(folder, 'one.jpg', await jpeg('#c33'))
  await write(folder, 'two.jpg', await jpeg('#3c3'))
  const loose = await write(dir, 'loose.jpg', await jpeg('#33c'))

  // A synthetic drag has no handles behind its items, so the queue stands in
  // for the desktop. Everything downstream of it is the real thing.
  window.__dropQueue = [folder, loose]
  DataTransferItem.prototype.getAsFileSystemHandle = function () {
    return Promise.resolve(window.__dropQueue.shift() ?? null)
  }
  window.__drag = (type) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['x'], 'Shoot'))
    transfer.items.add(new File(['x'], 'loose.jpg'))
    document.body.dispatchEvent(
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
    )
  }
})

const photos = () =>
  page.evaluate(async (ORIGIN) => {
    const { db } = await import(`${ORIGIN}/src/catalog/db.ts`)
    return {
      count: await db.photos.count(),
      names: (await db.photos.toArray()).map((p) => p.filename).sort(),
      folders: (await db.folders.toArray()).map((f) => f.name).sort(),
    }
  }, ORIGIN)

const before = await photos()

// --- Dropped into Develop, which is where the old handler was not ----------
await page.evaluate(() => window.__esque.useUI.getState().setModule('develop'))
await settle(500)

await page.evaluate(() => window.__drag('dragenter'))
await page.evaluate(() => window.__drag('dragover'))
await settle(250)
const dragging = await page.evaluate(() => ({
  over: window.__esque.useDropZone.getState().over,
  edge: !![...document.querySelectorAll('div')].find((d) => {
    const style = getComputedStyle(d)
    return (
      d.className.includes('inset-2') &&
      style.opacity === '1' &&
      style.boxShadow.includes('inset')
    )
  }),
}))
ok('a drag carrying files is acknowledged anywhere in the window', dragging.over, JSON.stringify(dragging))
ok('and the accent edge is drawn while it is held', dragging.edge, JSON.stringify(dragging))

await page.evaluate(() => window.__drag('drop'))
await page.waitForFunction(
  () => !window.__esque.useImporter.getState().active && window.__esque.useUI.getState().module === 'library',
  { timeout: 60_000, polling: 200 },
)
await settle(1200)

const after = await photos()
const state = await page.evaluate(() => ({
  module: window.__esque.useUI.getState().module,
  over: window.__esque.useDropZone.getState().over,
  source: window.__esque.useCatalog.getState().source,
  toast: [...document.querySelectorAll('[data-tone]')].map((n) => n.textContent).join(' | '),
}))

ok('the drop switches to the Library', state.module === 'library', state.module)
ok(
  'the folder and the loose file both import',
  after.count === before.count + 3,
  `${before.count} → ${after.count} (${after.names.join(', ')})`,
)
ok(
  'the folder keeps its own name and the loose file lands in Imported Files',
  after.folders.includes('Shoot') && after.folders.includes('Imported Files'),
  after.folders.join(', '),
)
ok('the Library opens on what was imported', state.source?.kind === 'folder', JSON.stringify(state.source))
ok('one summary reports the whole drop', /Imported 3 photos/.test(state.toast), state.toast)
ok('the affordance is cleared once the drop is taken', state.over === false, String(state.over))

// --- Nothing importable is said, not silently ignored ----------------------
await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle('dropdrive')
  const handle = await dir.getFileHandle('notes.txt', { create: true })
  const w = await handle.createWritable()
  await w.write('not a photograph')
  await w.close()
  window.__dropQueue = [handle]
  window.__drag('drop')
})
await settle(900)
const refused = await page.evaluate(() =>
  [...document.querySelectorAll('[data-tone]')].map((n) => n.textContent).join(' | '),
)
ok('a drop with no photos in it says so', /Nothing to import/.test(refused), refused)

await page.evaluate(async (ORIGIN) => {
  const { db } = await import(`${ORIGIN}/src/catalog/db.ts`)
  await db.photos.clear()
  await db.folders.clear()
  const root = await navigator.storage.getDirectory()
  await root.removeEntry('dropdrive', { recursive: true }).catch(() => {})
}, ORIGIN)

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
