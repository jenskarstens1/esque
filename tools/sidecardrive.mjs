/**
 * XMP sidecar drive.
 *
 * `checks/xmpcheck.html` covers the parsing and the merge — what a sidecar's
 * contents become. This covers the part that only exists once it is wired up:
 * the Metadata commands in the photo menu, and what they do when the file
 * system cannot answer.
 *
 * That last case is the one worth a drive. Sidecars live next to the original,
 * so both commands depend on a directory handle esque may no longer hold — a
 * folder imported in a previous session, or a photo picked as a loose file that
 * never had a directory at all. The File System Access API fails quietly there,
 * and a "Metadata saved" toast over a write that never happened is worse than
 * no command at all.
 *
 *   node tools/sidecardrive.mjs
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

// A folder with a null handle — the state a catalog is in after a reload, and
// before the photographer has granted permission again.
await page.evaluate(async () => {
  const { db } = await import('/src/catalog/db.ts')
  await db.folders.put({ id: 'f1', name: 'Sidecar', handle: null, addedAt: 0, photoCount: 1 })
  await db.photos.put({
    id: 'p1',
    folderId: 'f1',
    relPath: 'IMG_0001.ARW',
    filename: 'IMG_0001.ARW',
    ext: 'arw',
    isRaw: true,
    fileSize: 1024,
    modifiedAt: 0,
    addedAt: 0,
    width: 1200,
    height: 800,
    meta: {},
    rating: 3,
    flag: 'none',
    label: 'blue',
    keywords: ['coast'],
    title: 'Harbour',
    caption: '',
    edits: null,
    thumbKey: null,
    proxyKey: null,
  })
})
await page.reload({ waitUntil: 'networkidle2' })
await dismissWelcome(page)
await new Promise((r) => setTimeout(r, 2000))

const results = []
const ok = (name, cond, why = '') => results.push({ name, ok: !!cond, why })

const closeMenus = async () => {
  await page.evaluate(() =>
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })),
  )
  await new Promise((r) => setTimeout(r, 200))
}

/** Latest toast message and detail, or null. */
const lastToast = () =>
  page.evaluate(() => {
    const t = [...document.querySelectorAll('[data-tone]')].pop()
    if (!t) return null
    const lines = [...t.querySelectorAll('div')].map((d) => d.textContent.trim()).filter(Boolean)
    return { tone: t.getAttribute('data-tone'), text: t.textContent.trim(), lines }
  })

const clearToasts = () =>
  page.evaluate(async () => {
    const { toast } = await import('/src/design/toast.ts')
    for (const t of [...document.querySelectorAll('[data-tone]')]) t.click()
    return !!toast
  })

/** Right-clicks the first thumbnail and returns the open menu's row labels. */
async function openPhotoMenu() {
  await closeMenus()
  const pt = await page.evaluate(() => {
    const el = document.querySelector('[role="option"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (r.width <= 0) return null
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  if (!pt) return null
  await page.mouse.click(pt.x, pt.y, { button: 'right' })
  await new Promise((r) => setTimeout(r, 350))
  return page.evaluate(() =>
    [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((b) =>
      b.textContent.trim(),
    ),
  )
}

/** Centre of the first visible menu row whose label starts with `text`. */
const rowPoint = (text) =>
  page.evaluate((t) => {
    const row = [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].find(
      (b) => b.textContent.trim().startsWith(t) && b.getBoundingClientRect().width > 0,
    )
    if (!row) return null
    const r = row.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }, text)

/**
 * Opens the Metadata submenu and clicks one of its rows.
 *
 * Real pointer movement rather than synthesised events: the submenu opens on
 * `onPointerEnter`, which React derives from a genuine `pointerover` carrying a
 * `relatedTarget`, and a dispatched event does not reproduce it.
 */
async function pickMetadata(text) {
  const rows = await openPhotoMenu()
  if (!rows) return { opened: false }
  const parent = await rowPoint('Metadata')
  if (!parent) return { opened: false, rows }

  // Approaching from outside the row is what makes it a crossing.
  await page.mouse.move(parent.x - 60, parent.y - 40)
  await page.mouse.move(parent.x, parent.y)
  await new Promise((r) => setTimeout(r, 450))

  const target = await rowPoint(text)
  if (!target) {
    const seen = await page.evaluate(() =>
      [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((b) => b.textContent.trim()),
    )
    return { opened: true, picked: false, seen }
  }
  // Along the row first, so the pointer never leaves the parent on the way.
  await page.mouse.move(target.x, parent.y)
  await page.mouse.move(target.x, target.y)
  await page.mouse.click(target.x, target.y)
  await new Promise((r) => setTimeout(r, 600))
  return { opened: true, picked: true }
}


const rows = await openPhotoMenu()
ok('the photo menu opens', !!rows && rows.length > 0, JSON.stringify(rows?.slice(0, 4)))
ok('the menu offers Metadata', !!rows?.some((r) => r.startsWith('Metadata')), JSON.stringify(rows))
await closeMenus()

// --- Reading with no folder permission ---------------------------------------

await clearToasts()
const read = await pickMetadata('Read Metadata')
ok('Read Metadata is reachable', read.picked === true, JSON.stringify(read))
await closeMenus()
const readToast = await lastToast()
ok('reading says nothing was found', !!readToast?.text.includes('No sidecars'), JSON.stringify(readToast))
ok(
  'reading explains where it looked',
  !!readToast?.text.includes('.xmp'),
  JSON.stringify(readToast?.lines),
)

// The record must be exactly as it was: a failed read that quietly blanked a
// rating would be the worst possible outcome of this command.
const after = JSON.parse(
  await page.evaluate(async () => {
    const { db } = await import('/src/catalog/db.ts')
    const p = await db.photos.get('p1')
    return JSON.stringify({ rating: p.rating, label: p.label, title: p.title, keywords: p.keywords, edits: p.edits })
  }),
)
ok('a failed read leaves the rating alone', after.rating === 3, `${after.rating}`)
ok('a failed read leaves the label alone', after.label === 'blue', after.label)
ok('a failed read leaves the title alone', after.title === 'Harbour', after.title)
ok('a failed read leaves the keywords alone', JSON.stringify(after.keywords) === '["coast"]')
ok('a failed read invents no edits', after.edits === null, JSON.stringify(after.edits))

// --- Writing with no folder permission ---------------------------------------

await clearToasts()
const save = await pickMetadata('Save Metadata')
ok('Save Metadata is reachable', save.picked === true, JSON.stringify(save))
await closeMenus()
const saveToast = await lastToast()
ok('saving reports the failure', saveToast?.tone === 'error', JSON.stringify(saveToast))
ok(
  'saving does not claim success',
  !!saveToast && !saveToast.text.includes('Metadata saved'),
  JSON.stringify(saveToast),
)
ok(
  'saving explains why',
  !!saveToast?.text.includes('permission'),
  JSON.stringify(saveToast?.lines),
)

// --- The parse layer, reachable from a real page ------------------------------

const applied = JSON.parse(
  await page.evaluate(async () => {
    const { applySidecarText, sidecarNames } = await import('/src/catalog/sidecar.ts')
    const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:xmp="http://ns.adobe.com/xap/1.0/"
   xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   xmp:Rating="5" xmp:Label="Red" crs:Exposure2012="+1.25"/>
 </rdf:RDF>
</x:xmpmeta>`
    const r = applySidecarText(xml)
    return JSON.stringify({
      names: sidecarNames('a/IMG_0001.ARW'),
      rating: r?.changes.rating,
      label: r?.changes.label,
      exposure: r?.changes.edits?.basic.exposure,
      applied: r?.applied,
    })
  }),
)
ok('a real sidecar yields its rating', applied.rating === 5, `${applied.rating}`)
ok('a real sidecar yields its label', applied.label === 'red', applied.label)
ok('a real sidecar yields its exposure', Math.abs(applied.exposure - 1.25) < 1e-6, `${applied.exposure}`)
ok('both sidecar spellings are looked for', applied.names.length === 2, JSON.stringify(applied.names))
ok(
  'Adobe’s spelling is written',
  applied.names[0] === 'a/IMG_0001.xmp',
  applied.names[0],
)

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
