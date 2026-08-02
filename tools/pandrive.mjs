/**
 * Pan/zoom frame-time drive.
 *
 * Seeds a real JPEG through OPFS so the Develop canvas has actual pixels to
 * push, then drags and pinches the viewport with real input events while the
 * page records how long each animation frame took and how many of them the
 * canvas actually got redrawn on.
 *
 * A smooth pan is one redraw per frame at close to the display's interval. The
 * numbers that matter are `dropped` (frames that overran the budget) and
 * `paintsPerFrame` (a redraw that never happened is a frame the image sat
 * still while the pointer moved).
 *
 *   node tools/pandrive.mjs
 *
 * NOTE: this needs a browser that exposes WebGPU under automation. Puppeteer
 * does not today — headless and headed Chromium both report `navigator.gpu`
 * undefined, with or without `--enable-unsafe-webgpu` — so since the renderer
 * moved off WebGL2 this tool cannot drive the viewport. It bails out with that
 * message rather than quietly reporting frame times for a canvas that never
 * drew. `tools/browsercheck.mjs` is the way to run GPU work today; it opens a
 * real browser window, which is also why it cannot synthesise input.
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
  args: ['--no-sandbox', '--use-gl=angle', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: Number(process.env.DPR ?? 2) })
const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text())
})

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 1200))

const PHOTO_W = 4000
const PHOTO_H = 2667

// A real file behind a real directory handle: the proxy decoder goes through
// the same path it does for an imported folder, so the GPU work is the real
// work rather than a stand-in.
await page.evaluate(
  async (w, h) => {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('perfsrc', { create: true })

    const c = new OffscreenCanvas(w, h)
    const g = c.getContext('2d')
    for (let i = 0; i < 240; i++) {
      g.fillStyle = `hsl(${(i * 37) % 360} 70% ${20 + ((i * 13) % 60)}%)`
      g.fillRect((i * 971) % w, (i * 613) % h, 400, 300)
    }
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
    const fh = await dir.getFileHandle('p1.jpg', { create: true })
    const ws = await fh.createWritable()
    await ws.write(blob)
    await ws.close()

    const { db } = await import('/src/catalog/db.ts')
    const { defaultEdits } = await import('/src/core/defaults.ts')
    await db.folders.put({ id: 'f1', name: 'Perf', handle: dir, addedAt: 0, photoCount: 1 })
    const edits = defaultEdits()
    // A working stack, so the graph costs what a real edit costs.
    edits.basic.exposure = 0.35
    edits.basic.contrast = 12
    edits.basic.vibrance = 18
    edits.tone.shShadows = 20
    edits.tone.shHighlights = -25
    edits.detail.sharpenAmount = 45
    edits.detail.luminanceNR = 20
    edits.effects.vignetteAmount = -18
    await db.photos.put({
      id: 'p1',
      folderId: 'f1',
      relPath: 'p1.jpg',
      filename: 'p1.jpg',
      ext: 'jpg',
      isRaw: false,
      fileSize: blob.size,
      modifiedAt: 0,
      addedAt: 0,
      width: w,
      height: h,
      meta: {},
      rating: 0,
      flag: 'none',
      label: 'none',
      keywords: [],
      title: '',
      caption: '',
      edits,
      thumbKey: null,
      proxyKey: null,
    })
  },
  PHOTO_W,
  PHOTO_H,
)

await page.reload({ waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 1500))

// Select the photo and open Develop.
for (let i = 0; i < 30; i++) {
  const ok = await page.evaluate(() => {
    const { useCatalog, useUI } = window.__esque
    const c = useCatalog.getState()
    if (!c.visibleIds.includes('p1')) return false
    c.select('p1')
    useUI.getState().setModule?.('develop')
    return true
  })
  if (ok) break
  await new Promise((r) => setTimeout(r, 300))
}
await new Promise((r) => setTimeout(r, 500))

const inDevelop = await page.evaluate(() => {
  const { useUI } = window.__esque
  const s = useUI.getState()
  return { module: s.module, keys: Object.keys(s).filter((k) => /module/i.test(k)) }
})

// Wait for the proxy to actually be on the GPU: until then the canvas is blank
// and every measurement below would be of nothing at all.
if (!(await page.evaluate(() => !!navigator.gpu))) {
  console.error(
    'pandrive: navigator.gpu is undefined in this automated browser, so the ' +
      'viewport cannot render. See the note at the top of this file.',
  )
  await browser.close()
  process.exit(1)
}

let decoded = false
for (let i = 0; i < 60; i++) {
  decoded = await page.evaluate(() => {
    const c = document.querySelector('canvas')
    return !!c && c.width > 0 && Number(getComputedStyle(c).opacity) > 0.5
  })
  if (decoded) break
  await new Promise((r) => setTimeout(r, 500))
}

/** Counts frames and canvas redraws over a window of wall time. */
async function record(label, run) {
  await page.evaluate(() => {
    const w = window
    w.__frames = []
    w.__paints = 0
    // The renderer's own presents, counted where they happen. There is no
    // WebGPU equivalent of patching `drawArrays` — every submission goes
    // through a command encoder — so the renderer publishes the count itself.
    w.__frames0 = w.__esqueFrames?.() ?? 0
    let last = performance.now()
    w.__stop = false
    const tick = (now) => {
      w.__frames.push(now - last)
      last = now
      if (!w.__stop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  await run()

  return page.evaluate((label) => {
    const w = window
    w.__stop = true
    const f = w.__frames.slice(2)
    f.sort((a, b) => a - b)
    const at = (q) => Math.round(f[Math.min(f.length - 1, Math.floor(f.length * q))] * 10) / 10
    return {
      label,
      frames: f.length,
      medianMs: at(0.5),
      p95Ms: at(0.95),
      worstMs: at(1),
      over32ms: f.filter((d) => d > 32).length,
      presents: (w.__esqueFrames?.() ?? 0) - (w.__frames0 ?? 0),
    }
  }, label)
}

const CX = 800
const CY = 500

async function pan() {
  await page.mouse.move(CX, CY)
  await page.mouse.down()
  for (let i = 0; i < 90; i++) {
    const t = i / 90
    await page.mouse.move(CX + Math.sin(t * 8) * 220, CY + Math.cos(t * 6) * 140)
    await new Promise((r) => setTimeout(r, 8))
  }
  await page.mouse.up()
  await new Promise((r) => setTimeout(r, 200))
}

async function wheelZoom() {
  await page.mouse.move(CX, CY)
  for (let i = 0; i < 60; i++) {
    await page.mouse.wheel({ deltaX: 0, deltaY: i % 2 ? 4.5 : -3.5 })
    await new Promise((r) => setTimeout(r, 10))
  }
  await new Promise((r) => setTimeout(r, 200))
}

// Zoom in first: at Fit there is nothing to pan, and a fit-sized image is not
// what anyone is complaining about.
await page.evaluate(() => {
  const canvas = document.querySelector('canvas')
  canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: 800, clientY: 500, bubbles: true }))
})
await new Promise((r) => setTimeout(r, 400))
await page.keyboard.down('Meta')
await page.keyboard.press('1')
await page.keyboard.up('Meta')
await new Promise((r) => setTimeout(r, 600))

const zoomState = await page.evaluate(() => {
  const el = document.querySelector('[aria-label^="Zoom:"]')
  return el?.textContent ?? null
})

const panStats = await record('drag pan', pan)
const zoomStats = await record('wheel zoom', wheelZoom)

// -- library loupe ----------------------------------------------------------
// The loupe lays the image out once and only ever transforms it, so the check
// that matters is that the box on screen is still exactly where the zoom model
// says it should be.
await page.evaluate(() => {
  const { useUI } = window.__esque
  useUI.getState().setModule('library')
  useUI.getState().setViewMode?.('loupe')
})
await new Promise((r) => setTimeout(r, 900))

const loupe = await page.evaluate(async (nat) => {
  const img = document.querySelector('main img, img[alt="p1.jpg"]')
  if (!img) return { error: 'no loupe image' }
  const host = img.closest('.overflow-hidden')
  const h = host.getBoundingClientRect()
  const fit = Math.min(h.width / nat.w, h.height / nat.h)

  const at = () => {
    const r = img.getBoundingClientRect()
    return { x: r.x - h.x, y: r.y - h.y, w: r.width, h: r.height }
  }
  const before = at()

  // Zoom to 1:1 through the same command the keymap uses.
  const { zoomCommands } = await import('/src/lib/useZoomPan.ts')
  void zoomCommands
  img.closest('[style]')
  const evt = new MouseEvent('dblclick', {
    clientX: h.x + h.width / 2,
    clientY: h.y + h.height / 2,
    bubbles: true,
  })
  host.dispatchEvent(evt)
  await new Promise((r) => setTimeout(r, 400))
  const after = at()
  return {
    fitExpected: { w: Math.round(nat.w * fit), h: Math.round(nat.h * fit) },
    fitActual: { w: Math.round(before.w), h: Math.round(before.h) },
    fitCentred: {
      x: Math.round(before.x - (h.width - before.w) / 2),
      y: Math.round(before.y - (h.height - before.h) / 2),
    },
    zoomed: { w: Math.round(after.w), h: Math.round(after.h) },
    grew: after.w > before.w * 1.2,
  }
}, { w: PHOTO_W, h: PHOTO_H })

console.log(
  JSON.stringify(
    {
      photo: `${PHOTO_W}x${PHOTO_H}`,
      module: inDevelop,
      decoded,
      zoom: zoomState,
      panStats,
      zoomStats,
      loupe,
      errors,
    },
    null,
    2,
  ),
)
await page.screenshot({ path: '/tmp/esque-pan.png' })
await browser.close()
