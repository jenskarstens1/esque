/**
 * Drives real touch input at a phone viewport to prove the touch affordances
 * work, not merely that they measure well: long-press raises a context menu,
 * a slider tracks a drag, and a sheet dismisses on a downward throw.
 *
 *   node tools/touchcheck.mjs [url]
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
if (!executablePath) {
  console.error('No Chromium-based browser found. Set ESQUE_BROWSER to one.')
  process.exit(1)
}

const url = process.argv[2] ?? 'http://localhost:5177/'
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
})
const page = await browser.newPage()
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const cdp = await page.createCDPSession()
await cdp.send('Emulation.setEmulatedMedia', {
  features: [
    { name: 'pointer', value: 'coarse' },
    { name: 'any-pointer', value: 'coarse' },
    { name: 'hover', value: 'none' },
    { name: 'any-hover', value: 'none' },
  ],
})

const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 })
await new Promise((r) => setTimeout(r, 1500))

// Same OPFS + IndexedDB seed the other harnesses use, so the grid is populated.
await page.evaluate(async (fixture) => {
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle('touchsrc', { create: true })
  const bytes = new Uint8Array(await (await fetch(fixture)).arrayBuffer())
  const name = fixture.slice(fixture.lastIndexOf('/') + 1)
  const fh = await dir.getFileHandle(name, { create: true })
  const ws = await fh.createWritable()
  await ws.write(bytes)
  await ws.close()
  const { db } = await import('/src/catalog/db.ts')
  const { defaultEdits } = await import('/src/core/defaults.ts')
  await db.folders.put({ id: 'ft', name: 'Touch', handle: dir, addedAt: 0, photoCount: 2 })
  for (let n = 0; n < 2; n++) {
    await db.photos.put({
      id: `pt${n}`, folderId: 'ft', relPath: name, filename: name,
      ext: name.slice(name.lastIndexOf('.') + 1), isRaw: true, fileSize: bytes.length,
      modifiedAt: 0, addedAt: n, width: 0, height: 0, meta: {}, rating: 0,
      flag: 'none', label: 'none', keywords: [], title: '', caption: '',
      edits: defaultEdits(), thumbKey: null, proxyKey: null,
    })
  }
}, '/raw-fixtures/canon-5d2.cr2')
await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 })
await new Promise((r) => setTimeout(r, 2500))

/*
 * A fresh profile opens the welcome dialog over the app. Every gesture below
 * targets the app behind it, so it has to go before anything is measured.
 */
for (let i = 0; i < 3; i++) {
  const open = await page.evaluate(() => !!document.querySelector('[role="dialog"]'))
  if (!open) break
  const closed = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]')
    const btn = [...(dlg?.querySelectorAll('button') ?? [])].find((b) =>
      /not now|continue|close|done|got it/i.test(b.textContent || ''),
    )
    if (btn) {
      btn.click()
      return true
    }
    return false
  })
  if (!closed) await page.keyboard.press('Escape')
  await new Promise((r) => setTimeout(r, 500))
}

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const touch = (type, points) =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p) => ({ x: p.x, y: p.y, radiusX: 12, radiusY: 12, force: 1, id: 1 })),
  })

async function longPress(x, y, ms = 700) {
  await touch('touchStart', [{ x, y }])
  await new Promise((r) => setTimeout(r, ms))
  await touch('touchEnd', [])
}

// --- 1. Long press raises the context menu -----------------------------------
await page.evaluate(() => {
  const ui = window.__esque.useUI.getState()
  ui.setModule('library')
  ui.setViewMode('grid')
})
await new Promise((r) => setTimeout(r, 1200))

const tile = await page.evaluate(() => {
  const el = document.querySelector('[data-photo-id], [role="gridcell"], main button')
  if (!el) return null
  const b = el.getBoundingClientRect()
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
})

if (!tile) {
  check('long-press context menu', false, 'no grid tile found to press')
} else {
  await longPress(tile.x, tile.y)
  await new Promise((r) => setTimeout(r, 400))
  const menuOpen = await page.evaluate(
    () => !!document.querySelector('[role="menu"]') && document.querySelectorAll('[role="menuitem"]').length > 0,
  )
  check('long-press context menu', menuOpen, menuOpen ? 'menu opened on a grid tile' : 'no [role=menu] appeared')
  if (menuOpen) {
    await touch('touchStart', [{ x: 5, y: 400 }])
    await touch('touchEnd', [])
    await new Promise((r) => setTimeout(r, 300))
  }
}

// --- 2. A short tap does NOT raise the menu ----------------------------------
if (tile) {
  await touch('touchStart', [{ x: tile.x, y: tile.y }])
  await new Promise((r) => setTimeout(r, 80))
  await touch('touchEnd', [])
  await new Promise((r) => setTimeout(r, 350))
  const spurious = await page.evaluate(() => !!document.querySelector('[role="menu"]'))
  check('short tap keeps menu closed', !spurious, spurious ? 'a tap opened the menu' : 'tap stayed a tap')
}

// --- 3. A slider tracks a touch drag ----------------------------------------
await page.evaluate(() => {
  const ui = window.__esque.useUI.getState()
  ui.setModule('develop')
  ui.setOverlayPanel('right')
})
await new Promise((r) => setTimeout(r, 1400))

const slider = await page.evaluate(() => {
  const el = [...document.querySelectorAll('[role="slider"]')].find((s) => {
    const b = s.getBoundingClientRect()
    return b.width > 80 && b.top > 0 && b.bottom < window.innerHeight
  })
  if (!el) return null
  const b = el.getBoundingClientRect()
  return {
    label: el.getAttribute('aria-label') ?? '',
    before: el.getAttribute('aria-valuenow'),
    x: Math.round(b.left + b.width / 2),
    y: Math.round(b.top + b.height / 2),
    right: Math.round(b.right - 8),
  }
})

if (!slider) {
  check('slider tracks a touch drag', false, 'no on-screen slider found in the edit sheet')
} else {
  await touch('touchStart', [{ x: slider.x, y: slider.y }])
  for (let i = 1; i <= 6; i++) {
    const x = slider.x + ((slider.right - slider.x) * i) / 6
    await touch('touchMove', [{ x: Math.round(x), y: slider.y }])
    await new Promise((r) => setTimeout(r, 30))
  }
  await touch('touchEnd', [])
  await new Promise((r) => setTimeout(r, 400))
  const after = await page.evaluate((lbl) => {
    const el = [...document.querySelectorAll('[role="slider"]')].find(
      (s) => (s.getAttribute('aria-label') ?? '') === lbl,
    )
    return el?.getAttribute('aria-valuenow') ?? null
  }, slider.label)
  const moved = after !== null && after !== slider.before
  check('slider tracks a touch drag', moved, `${slider.label || 'slider'} ${slider.before} -> ${after}`)
}

// --- 4. Swiping the sheet down dismisses it ----------------------------------
const grip = await page.evaluate(() => {
  const ui = window.__esque.useUI.getState()
  ui.setOverlayPanel('right')
  return true
})
if (grip) {
  await new Promise((r) => setTimeout(r, 700))
  const handle = await page.evaluate(() => {
    // `[role=dialog]` is the full-screen wrapper; the draggable grab area is on
    // the sheet surface itself.
    const panel = document.querySelector('[data-overlay-surface]')
    if (!panel) return null
    const b = panel.getBoundingClientRect()
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + 10) }
  })
  if (!handle) {
    check('swipe dismisses the panel', false, 'no [data-overlay-surface] found')
  } else {
    await touch('touchStart', [{ x: handle.x, y: handle.y }])
    for (let i = 1; i <= 8; i++) {
      await touch('touchMove', [{ x: handle.x, y: handle.y + i * 40 }])
      await new Promise((r) => setTimeout(r, 16))
    }
    await touch('touchEnd', [])
    await new Promise((r) => setTimeout(r, 700))
    const closed = await page.evaluate(() => window.__esque.useUI.getState().overlayPanel === null)
    check('swipe dismisses the panel', closed, closed ? 'throw closed the sheet' : 'sheet stayed open')
  }
}

// --- 5. No runtime errors ----------------------------------------------------
check('no runtime errors', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()
const failed = results.filter((r) => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
