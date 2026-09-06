/**
 * Context-menu smoke drive. Seeds one photo into the catalog so the develop
 * panels have a subject, then right-clicks every surface that should raise a
 * menu and checks exactly one opened with rows in it.
 *
 *   node tools/.appmenu.mjs
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

/**
 * Where the dev server is. Vite moves to the next free port when 5173 is taken,
 * and a drive that keeps asking for 5173 regardless will run its whole suite
 * against whatever else is sitting there — passing or failing for reasons that
 * have nothing to do with esque.
 */
const ORIGIN = (process.env.ESQUE_ORIGIN ?? 'http://localhost:5173').replace(/\/$/, '')
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()) })

await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 1200))

// Seed a folder, a collection and a photo straight into Dexie.
await page.evaluate(async () => {
  const { db } = await import('/src/catalog/db.ts')
  const { defaultEdits } = await import('/src/core/defaults.ts')
  await db.folders.put({ id: 'f1', name: 'Test Shoot', handle: null, addedAt: 0, photoCount: 1 })
  await db.collections.put({ id: 'c1', name: 'Keepers', smart: false, rules: [], match: 'all', photoIds: ['p1'], createdAt: 0, setId: null })
  await db.photos.put({
    id: 'p1', folderId: 'f1', relPath: 'p1.jpg', filename: 'p1.jpg', ext: 'jpg', isRaw: false,
    fileSize: 1024, modifiedAt: 0, addedAt: 0, width: 1200, height: 800, meta: {},
    rating: 0, flag: 'none', label: 'none', keywords: [], title: '', caption: '',
    edits: defaultEdits(), thumbKey: null, proxyKey: null,
  })
})
await page.reload({ waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 2000))

const results = []
async function closeMenus() {
  await page.keyboard.press('Escape')
  await new Promise((r) => setTimeout(r, 200))
  const left = await page.evaluate(() => document.querySelectorAll('[role="menu"]').length)
  if (left) {
    await page.evaluate(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    await new Promise((r) => setTimeout(r, 200))
  }
  return left
}

async function probe(name, findPoint, arg) {
  const stale = await closeMenus()
  const pt = await page.evaluate(findPoint, arg)
  if (!pt) { results.push({ name, ok: false, why: 'target not found', stale }); return }
  if (pt.y < 0 || pt.y > 1000 || pt.x < 0 || pt.x > 1600) {
    results.push({ name, ok: false, why: `target off-screen at ${Math.round(pt.x)},${Math.round(pt.y)}`, stale })
    return
  }
  await page.mouse.click(pt.x, pt.y, { button: 'right' })
  await new Promise((r) => setTimeout(r, 300))
  const info = await page.evaluate(() => {
    const menus = [...document.querySelectorAll('[role="menu"]')]
    const m = menus[0]
    return {
      count: menus.length,
      rows: m ? m.querySelectorAll('[role^="menuitem"]').length : 0,
      first: m ? [...m.querySelectorAll('[role^="menuitem"]')].slice(0, 3).map((b) => b.textContent.trim()) : [],
    }
  })
  // A submenu counts as a second [role=menu], and one often opens because the
  // pointer lands on a row with children. Only the leading menu is asserted.
  results.push({ name, ok: info.count >= 1 && info.rows > 0, stale, ...info })
  await closeMenus()
}

/** Runs in the page: centres on the innermost element starting with `text`. */
function byText({ text, tag, exact }) {
  const hits = [...document.querySelectorAll(tag)].filter((el) => {
    const t = (el.textContent ?? '').trim()
    return (exact ? t === text : t.startsWith(text)) && el.getBoundingClientRect().width > 0
  })
  const el = hits[hits.length - 1]
  if (!el) return null
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  return { x: r.x + Math.min(r.width / 2, 70), y: r.y + r.height / 2 }
}

// --- Library -------------------------------------------------------------
await probe('sidebar · folder row', byText, { text: 'Test Shoot', tag: 'div[role="button"]' })
await probe('sidebar · collection row', byText, { text: 'Keepers', tag: 'div[role="button"]' })
await probe('library · thumbnail', () => {
  const r = document.querySelector('[role="option"]')?.getBoundingClientRect()
  return r && r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null
})
await probe('library · grid background', () => {
  const grid = [...document.querySelectorAll('div')].find((d) => d.className.includes('relative') && d.clientHeight > 400 && d.clientWidth > 600)
  const r = grid?.getBoundingClientRect()
  return r ? { x: r.x + r.width - 30, y: r.y + r.height - 30 } : null
})

// --- Develop -------------------------------------------------------------
await page.keyboard.press('d')
await new Promise((r) => setTimeout(r, 2500))
await probe('develop · viewport', () => {
  const c = document.querySelector('canvas')
  const r = c?.getBoundingClientRect()
  return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null
})
await probe('develop · panel header (Basic)', byText, { text: 'Basic', tag: 'section header' })
await probe('develop · panel header (Tone)', () => {
  const h = [...document.querySelectorAll('section header')].find((el) =>
    (el.textContent ?? '').trim().replace(/\s+/g, ' ').startsWith('Tone') &&
    !(el.textContent ?? '').includes('Curve'))
  if (!h) return null
  h.scrollIntoView({ block: 'center' })
  const r = h.getBoundingClientRect()
  return { x: r.x + 40, y: r.y + r.height / 2 }
})
await probe('develop · histogram', () => {
  const el = [...document.querySelectorAll('canvas')].find((c) => c.clientHeight > 0 && c.clientHeight <= 90)
  const r = el?.getBoundingClientRect()
  return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null
})
await probe('develop · slider row', () => {
  const row = [...document.querySelectorAll('div.group\\/row')].find((d) =>
    (d.textContent ?? '').trim().startsWith('Exposure'))
  if (!row) return null
  row.scrollIntoView({ block: 'center' })
  const r = row.getBoundingClientRect()
  return { x: r.x + 30, y: r.y + 6 }
})
await probe('develop · filmstrip cell', () => {
  const cell = document.querySelector('button.group\\/fs')
  if (!cell) return null
  const r = cell.getBoundingClientRect()
  return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null
})
await probe('develop · filmstrip background', () => {
  const cell = document.querySelector('button.group\\/fs')
  const strip = cell?.closest('div.flex.h-full.flex-col')
  const r = strip?.getBoundingClientRect()
  // Mid-strip empty space: the dev toolbar overlay owns the bottom-right.
  return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null
})

const suppressed = await page.evaluate(() => {
  const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  document.body.dispatchEvent(e)
  return e.defaultPrevented
})

const failed = results.filter((r) => !r.ok).map((r) => r.name)
console.log(JSON.stringify({ pass: failed.length === 0, failed, results, suppressed, errors: errors.slice(0, 6) }, null, 2))
await page.screenshot({ path: '/tmp/esque-appmenu.png' })
await browser.close()
