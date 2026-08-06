/**
 * Finds controls that cannot be clicked where they appear.
 *
 * For every visible interactive element it asks what the browser would actually
 * hit at that element's own centre. If the answer is not the element or one of
 * its descendants, something is covering it, and the reported blocker is the
 * thing in the way.
 *
 *   node tools/hittest.mjs [url] [width] [height]
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
const width = Number(process.argv[3] ?? 1600)
const height = Number(process.argv[4] ?? 1000)

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
})
const page = await browser.newPage()
await page.setViewport({ width, height, deviceScaleFactor: 1 })
// A desktop mouse, explicitly: this run is about proving the touch adaptations
// did not follow the user back to a pointer that never needed them.
const cdp = await page.createCDPSession()
await cdp.send('Emulation.setEmulatedMedia', {
  features: [
    { name: 'pointer', value: 'fine' },
    { name: 'any-pointer', value: 'fine' },
    { name: 'hover', value: 'hover' },
    { name: 'any-hover', value: 'hover' },
  ],
})

await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 })
await new Promise((r) => setTimeout(r, 1500))

await page.evaluate(async (fixture) => {
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle('hitsrc', { create: true })
  const bytes = new Uint8Array(await (await fetch(fixture)).arrayBuffer())
  const name = fixture.slice(fixture.lastIndexOf('/') + 1)
  const fh = await dir.getFileHandle(name, { create: true })
  const ws = await fh.createWritable()
  await ws.write(bytes)
  await ws.close()
  const { db } = await import('/src/catalog/db.ts')
  const { defaultEdits } = await import('/src/core/defaults.ts')
  await db.folders.put({ id: 'fh', name: 'Hit', handle: dir, addedAt: 0, photoCount: 4 })
  for (let n = 0; n < 4; n++) {
    await db.photos.put({
      id: `ph${n}`, folderId: 'fh', relPath: name, filename: name,
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
 * A fresh profile opens the welcome dialog, and everything behind a modal is
 * *meant* to be inert — leaving it up would report the whole app as blocked.
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
const stillModal = await page.evaluate(() => {
  const d = document.querySelector('[role="dialog"]')
  return d ? d.getAttribute('aria-label') : null
})
if (stillModal) {
  console.error(`Could not dismiss the "${stillModal}" dialog; results would be meaningless.`)
  await browser.close()
  process.exit(2)
}

const SCENES = [
  { name: 'library-grid', module: 'library', viewMode: 'grid' },
  { name: 'library-loupe', module: 'library', viewMode: 'loupe' },
  { name: 'develop', module: 'develop' },
]

let total = 0
for (const scene of SCENES) {
  await page.evaluate((s) => {
    const c = window.__esque.useCatalog.getState()
    if (c.visibleIds.length) c.select(c.visibleIds[0])
    const ui = window.__esque.useUI.getState()
    ui.setModule(s.module)
    if (s.viewMode) ui.setViewMode(s.viewMode)
  }, scene)
  await new Promise((r) => setTimeout(r, 1400))

  const blocked = await page.evaluate(() => {
    const desc = (el) => {
      if (!el) return 'nothing'
      const cls = typeof el.className === 'string' ? el.className.split(' ').slice(0, 3).join('.') : ''
      const txt = (el.textContent || '').trim().slice(0, 18)
      return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${txt ? ` "${txt}"` : ''}`
    }
    const ours = (el) => !el.closest('[class*="styles-module__"]')

    /*
     * getBoundingClientRect reports layout position even for content scrolled
     * out of an `overflow` ancestor, so an off-screen row still has a plausible
     * rect. Intersect against every clipping ancestor to get the rect the user
     * can actually see and click.
     */
    const visibleRect = (el) => {
      let r = el.getBoundingClientRect()
      let p = el.parentElement
      while (p && p !== document.documentElement) {
        const o = getComputedStyle(p)
        if (o.overflow !== 'visible' || o.overflowX !== 'visible' || o.overflowY !== 'visible') {
          const c = p.getBoundingClientRect()
          const left = Math.max(r.left, c.left)
          const top = Math.max(r.top, c.top)
          const right = Math.min(r.right, c.right)
          const bottom = Math.min(r.bottom, c.bottom)
          if (right <= left || bottom <= top) return null
          r = { left, top, right, bottom, width: right - left, height: bottom - top }
        }
        p = p.parentElement
      }
      return r
    }

    return [...document.querySelectorAll('button, a, [role="button"], [role="tab"], input, select')]
      .filter(ours)
      .map((el) => ({ el, b: visibleRect(el) }))
      .filter(({ el, b }) => {
        if (!b) return false
        if (b.width < 2 || b.height < 2) return false
        if (b.right < 0 || b.bottom < 0 || b.left > innerWidth || b.top > innerHeight) return false
        const cs = getComputedStyle(el)
        // An element that opts out of the pointer is not "blocked", it is off.
        return cs.pointerEvents !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0'
      })
      .map(({ el, b }) => {
        const x = Math.min(innerWidth - 1, Math.max(0, b.left + b.width / 2))
        const y = Math.min(innerHeight - 1, Math.max(0, b.top + b.height / 2))
        const hit = document.elementFromPoint(x, y)
        if (hit && (hit === el || el.contains(hit) || hit.contains(el))) return null
        return {
          target: desc(el),
          blocker: desc(hit),
          // The blocker's own positioning is usually the whole story.
          blockerPos: hit ? getComputedStyle(hit).position : '',
          blockerZ: hit ? getComputedStyle(hit).zIndex : '',
        }
      })
      .filter(Boolean)
  })

  total += blocked.length
  console.log(`\n${blocked.length === 0 ? 'PASS' : 'FAIL'}  ${scene.name}  ${blocked.length} blocked`)
  const seen = new Set()
  for (const b of blocked) {
    const key = `${b.target}|${b.blocker}`
    if (seen.has(key)) continue
    seen.add(key)
    console.log(`   ${b.target}\n     blocked by ${b.blocker} (position: ${b.blockerPos}, z: ${b.blockerZ})`)
  }
}

await browser.close()
console.log(`\n${total} blocked control(s) at ${width}x${height}`)
process.exit(total ? 1 : 0)
