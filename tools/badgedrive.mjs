/**
 * "Developing RAW" badge drive.
 *
 * A RAW opens in two stages: a working proxy, then a full-resolution decode
 * once the viewport zooms past what that proxy can resolve. The badge has to
 * cover both, because between them the viewport is showing an upscaled proxy —
 * which is exactly the state the badge exists to explain.
 *
 * Seeds a real RAW through OPFS, opens Develop, zooms to 1:1, and samples the
 * badge against the proxy tier actually in the cache.
 *
 *   node tools/badgedrive.mjs
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
const FIXTURE = process.env.ESQUE_FIXTURE ?? '/raw-fixtures/canon-5d2.cr2'
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
  args: ['--no-sandbox', '--use-gl=angle', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text())
})

await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 1200))

const seeded = await page.evaluate(async (fixture) => {
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle('badgesrc', { create: true })
  const bytes = new Uint8Array(await (await fetch(fixture)).arrayBuffer())
  const name = fixture.slice(fixture.lastIndexOf('/') + 1)
  const fh = await dir.getFileHandle(name, { create: true })
  const ws = await fh.createWritable()
  await ws.write(bytes)
  await ws.close()

  const { db } = await import('/src/catalog/db.ts')
  const { defaultEdits } = await import('/src/core/defaults.ts')
  await db.folders.put({ id: 'fb', name: 'Badge', handle: dir, addedAt: 0, photoCount: 1 })
  await db.photos.put({
    id: 'pb',
    folderId: 'fb',
    relPath: name,
    filename: name,
    ext: name.slice(name.lastIndexOf('.') + 1),
    isRaw: true,
    fileSize: bytes.length,
    modifiedAt: 0,
    addedAt: 0,
    width: 0,
    height: 0,
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
  return name
}, FIXTURE)

await page.reload({ waitUntil: 'networkidle2' })
await dismissWelcome(page)
await new Promise((r) => setTimeout(r, 1500))

for (let i = 0; i < 40; i++) {
  const ok = await page.evaluate(() => {
    const { useCatalog, useUI } = window.__esque
    const c = useCatalog.getState()
    if (!c.visibleIds.includes('pb')) return false
    c.select('pb')
    useUI.getState().setModule?.('develop')
    return true
  })
  if (ok) break
  await new Promise((r) => setTimeout(r, 300))
}

const badge = () =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find(
      (d) => d.children.length <= 2 && /^(Developing RAW|Decoding)$/.test(d.textContent.trim()),
    )
    return !!el
  })

// Stage one: the working proxy. The badge must be up for all of it, and the
// canvas must be showing pixels once it clears.
let firstBadge = false
let settled = false
for (let i = 0; i < 300; i++) {
  const b = await badge()
  if (b) firstBadge = true
  if (firstBadge && !b) {
    settled = true
    break
  }
  await new Promise((r) => setTimeout(r, 100))
}

const info = await page.evaluate(async () => {
  const { db } = await import('/src/catalog/db.ts')
  const p = await db.photos.get('pb')
  return { width: p?.width ?? 0, height: p?.height ?? 0 }
})

// Stage two: zoom to 1:1 and watch the badge against the tier that lands.
await page.evaluate(() => window.__esque.zoomCommands()?.actual())

const samples = []
const t0 = Date.now()
let sawBadge = false
let escalated = false
for (let i = 0; i < 300; i++) {
  const s = await page.evaluate(async () => {
    const el = [...document.querySelectorAll('div')].find(
      (d) => d.children.length <= 2 && /^(Developing RAW|Decoding)$/.test(d.textContent.trim()),
    )
    const canvas = document.querySelector('canvas')
    return {
      badge: !!el,
      w: canvas?.width ?? 0,
    }
  })
  samples.push({ t: Date.now() - t0, badge: s.badge })
  if (s.badge) sawBadge = true
  if (sawBadge && !s.badge) {
    escalated = true
    break
  }
  await new Promise((r) => setTimeout(r, 60))
}

// Stage three: the handoff. A photo that opens while the viewport is already
// at 1:1 runs both phases back to back, and the badge must not blink between
// them — so sample it every animation frame rather than on a poll.
await page.evaluate(async () => {
  const { db } = await import('/src/catalog/db.ts')
  const p = await db.photos.get('pb')
  await db.photos.put({ ...p, id: 'pb2' })
})
await page.reload({ waitUntil: 'networkidle2' })
await dismissWelcome(page)
await new Promise((r) => setTimeout(r, 1500))

await page.evaluate(() => {
  const seen = []
  globalThis.__badgeFrames = seen
  const tick = () => {
    const el = [...document.querySelectorAll('div')].find(
      (d) => d.children.length <= 2 && /^(Developing RAW|Decoding)$/.test(d.textContent.trim()),
    )
    seen.push(!!el)
    globalThis.__badgeRaf = requestAnimationFrame(tick)
  }
  tick()
  const { useCatalog, useUI } = window.__esque
  useCatalog.getState().select('pb2')
  useUI.getState().setModule?.('develop')
})
// Pin to 1:1 before the first tier lands, so the escalation is queued the
// instant the working proxy arrives.
for (let i = 0; i < 20; i++) {
  const ok = await page.evaluate(() => {
    const z = window.__esque.zoomCommands()
    if (!z) return false
    z.actual()
    return true
  })
  if (ok) break
  await new Promise((r) => setTimeout(r, 50))
}
await new Promise((r) => setTimeout(r, 12000))
const handoff = await page.evaluate(() => {
  cancelAnimationFrame(globalThis.__badgeRaf)
  const f = globalThis.__badgeFrames
  const first = f.indexOf(true)
  const last = f.lastIndexOf(true)
  // Every frame between the badge's first and last appearance must have it up.
  let gaps = 0
  for (let i = first; i <= last; i++) if (!f[i]) gaps++
  return { frames: f.length, first, last, visibleFrames: last - first + 1, gapFrames: gaps }
})

const badgeSpan = samples.filter((s) => s.badge).length * 60
console.log(
  JSON.stringify(
    {
      fixture: seeded,
      native: `${info.width}x${info.height}`,
      stageOne: { badgeSeen: firstBadge, settled },
      stageTwo: {
        badgeSeenAfterZoom: sawBadge,
        badgeClearedAfter: escalated,
        badgeVisibleMs: badgeSpan,
      },
      handoff,
      errors: errors.slice(0, 5),
    },
    null,
    2,
  ),
)

await page.screenshot({ path: '/tmp/esque-badge.png' })
await browser.close()
