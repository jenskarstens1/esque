/**
 * Responsive probe: measures overflow, hit targets and canvas area across the
 * phone / tablet / desktop tiers, and shoots each one.
 *
 *   node tools/responsivecheck.mjs [url]
 */
import { existsSync, mkdirSync } from 'node:fs'
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
const outDir = process.argv[3] ?? '/tmp/esque-responsive'
mkdirSync(outDir, { recursive: true })

const FIXTURES = ['/raw-fixtures/canon-5d2.cr2', '/raw-fixtures/nikon-d800.nef', '/raw-fixtures/fuji-xt5.raf']

/*
 * An empty catalog hides most of the app. Seeding OPFS + IndexedDB the way the
 * other drive harnesses do puts real photos on screen so the grid, filmstrip
 * and develop panels are measured rather than the empty state.
 */
async function seed(page) {
  await page.evaluate(async (fixtures) => {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('respsrc', { create: true })
    const { db } = await import('/src/catalog/db.ts')
    const { defaultEdits } = await import('/src/core/defaults.ts')
    await db.folders.put({ id: 'fr', name: 'Responsive', handle: dir, addedAt: 0, photoCount: fixtures.length })

    for (const [i, fixture] of fixtures.entries()) {
      const bytes = new Uint8Array(await (await fetch(fixture)).arrayBuffer())
      const name = fixture.slice(fixture.lastIndexOf('/') + 1)
      const fh = await dir.getFileHandle(name, { create: true })
      const ws = await fh.createWritable()
      await ws.write(bytes)
      await ws.close()
      // Repeat each fixture so the grid has enough tiles to wrap and scroll.
      for (let n = 0; n < 6; n++) {
        await db.photos.put({
          id: `pr${i}_${n}`,
          folderId: 'fr',
          relPath: name,
          filename: name,
          ext: name.slice(name.lastIndexOf('.') + 1),
          isRaw: true,
          fileSize: bytes.length,
          modifiedAt: 0,
          addedAt: i * 10 + n,
          width: 0,
          height: 0,
          meta: {},
          rating: (i + n) % 6,
          flag: 'none',
          label: 'none',
          keywords: [],
          title: '',
          caption: '',
          edits: defaultEdits(),
          thumbKey: null,
          proxyKey: null,
        })
      }
    }
  }, FIXTURES)
}

const VIEWPORTS = [
  { name: 'phone-portrait', width: 390, height: 844, touch: true },
  { name: 'phone-landscape', width: 844, height: 390, touch: true },
  { name: 'tablet-portrait', width: 768, height: 1024, touch: true },
  { name: 'tablet-landscape', width: 1024, height: 768, touch: true },
  { name: 'desktop', width: 1440, height: 900, touch: false },
]

// Each viewport is measured in every place the user actually spends time, so a
// layout that only holds together on the empty screen cannot pass.
const SCENES = [
  { name: 'library-grid', module: 'library', viewMode: 'grid' },
  { name: 'library-loupe', module: 'library', viewMode: 'loupe' },
  { name: 'develop', module: 'develop' },
]

const browser = await puppeteer.launch({  executablePath,
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--disable-dev-shm-usage'],
})

let failures = 0

for (const v of VIEWPORTS) {
  const page = await browser.newPage()
  await page.setViewport({
    width: v.width,
    height: v.height,
    deviceScaleFactor: 2,
    isMobile: v.touch,
    hasTouch: v.touch,
  })
  /*
   * `hasTouch` alone does not move the `pointer` / `hover` media features, so
   * without this the `coarse:` and `touch:` variants would never be exercised
   * and the run would report failures the real device does not have.
   * Puppeteer's own `emulateMediaFeatures` allowlist rejects `pointer`, so this
   * goes straight to CDP.
   */
  const cdp = await page.createCDPSession()
  await cdp.send('Emulation.setEmulatedMedia', {
    features: v.touch
      ? [
          { name: 'pointer', value: 'coarse' },
          { name: 'any-pointer', value: 'coarse' },
          { name: 'hover', value: 'none' },
          { name: 'any-hover', value: 'none' },
        ]
      : [
          { name: 'pointer', value: 'fine' },
          { name: 'any-pointer', value: 'fine' },
          { name: 'hover', value: 'hover' },
          { name: 'any-hover', value: 'hover' },
        ],
  })
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 })
  await new Promise((r) => setTimeout(r, 1500))
  await seed(page)
  await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 })
  await new Promise((r) => setTimeout(r, 2500))

  const measure = () =>
    page.evaluate((touch) => {
      const w = window.innerWidth
      /*
       * The dev-only Agentation toolbar mounts beside the app and parks itself
       * off-screen when collapsed. It is a devDependency's UI, not esque's, so
       * it is excluded rather than counted as an overflow the app has to fix.
       */
      const ours = (el) =>
        !el.closest('[class*="styles-module__"]') &&
        !(typeof el.className === 'string' && el.className.includes('styles-module__'))

      /*
       * A horizontal scroller (the filmstrip) is *meant* to be wider than the
       * viewport, so only content that escapes with no scrollable ancestor is a
       * real overflow bug.
       */
      const escapes = (el) => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const ox = getComputedStyle(p).overflowX
          if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return false
        }
        return true
      }

      const overflow = [...document.querySelectorAll('body *')]
        .filter(ours)
        .filter((el) => {
          const b = el.getBoundingClientRect()
          return b.width > 0 && b.height > 0 && (b.right > w + 1 || b.left < -1)
        })
        .filter(escapes)
        .slice(0, 6)
        .map((el) => {
          const b = el.getBoundingClientRect()
          const cls =
            typeof el.className === 'string' ? el.className.split(' ').slice(0, 3).join('.') : ''
          return `${el.tagName.toLowerCase()}.${cls} left=${Math.round(b.left)} right=${Math.round(b.right)}`
        })

      // Anything visible and clickable that a fingertip can't reliably land on.
      const targets = [...document.querySelectorAll('button, a, [role="button"], [role="tab"], input')]
        .filter(ours)
        .map((el) => ({ el, b: el.getBoundingClientRect() }))
        .filter(({ b }) => b.width > 0 && b.height > 0)
      /*
       * WCAG 2.2 sets two bars: SC 2.5.8 Target Size (Minimum) is 24x24 CSS px
       * at AA, and SC 2.5.5 Target Size (Enhanced) is 44x44 at AAA. Failing the
       * AA floor is a bug; missing AAA on a control that is already 44px on its
       * one meaningful axis — a horizontal drag handle, a segmented cell flush
       * against its neighbours — is reported but not failed, because forcing it
       * would overlap adjacent targets or overflow the panel.
       */
      const size = (el, b) => {
        const after = getComputedStyle(el, '::after')
        // `esq-tap` grows the hit box with a pseudo-element rather than the ink.
        const grown = after.content !== 'none' && parseFloat(after.width) >= 43
        return grown ? { w: 44, h: 44 } : { w: b.width, h: b.height }
      }
      const belowAA = targets.filter(({ el, b }) => {
        const s = size(el, b)
        return s.w < 24 || s.h < 24
      })
      const belowAAA = targets.filter(({ el, b }) => {
        const s = size(el, b)
        return Math.min(s.w, s.h) < 44 && Math.max(s.w, s.h) < 44
      })

      const canvas = document.querySelector('main')?.getBoundingClientRect()

      return {
        innerWidth: w,
        scrollWidth: document.documentElement.scrollWidth,
        coarse: matchMedia('(pointer: coarse)').matches,
        overflow,
        targets: targets.length,
        small: belowAA.length,
        advisory: belowAAA.length,
        worst: touch
          ? belowAA.slice(0, 5).map(({ el, b }) => {
              const cls =
                typeof el.className === 'string' ? el.className.split(' ').slice(0, 2).join('.') : ''
              const txt = (el.textContent || '').trim().slice(0, 14)
              return `${el.tagName.toLowerCase()}.${cls} ${Math.round(b.width)}x${Math.round(b.height)} "${txt}"`
            })
          : [],
        canvas: canvas ? { w: Math.round(canvas.width), h: Math.round(canvas.height) } : null,
      }
    }, v.touch)

  console.log(`\n=== ${v.name} (${v.width}x${v.height}) ===`)

  for (const scene of SCENES) {
    await page.evaluate((s) => {
      const { useUI, useCatalog } = window.__esque
      const c = useCatalog.getState()
      if (c.visibleIds.length) c.select(c.visibleIds[0])
      const ui = useUI.getState()
      ui.setModule(s.module)
      if (s.viewMode) ui.setViewMode(s.viewMode)
    }, scene)
    await new Promise((r) => setTimeout(r, 1200))

    const r = await measure()
    const canvasOk = !!r.canvas && r.canvas.w > r.innerWidth * 0.5 && r.canvas.h > 100
    const overflowOk = r.overflow.length === 0 && r.scrollWidth <= r.innerWidth
    // The 44px floor is a touch requirement. A mouse is served better by the
    // dense geometry the panels were spaced for.
    const targetsOk = !v.touch || r.small === 0
    const ok = canvasOk && overflowOk && targetsOk
    if (!ok) failures++

    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${scene.name.padEnd(14)} canvas ${r.canvas ? `${r.canvas.w}x${r.canvas.h}` : 'none'}${canvasOk ? '' : ' <- too small'}   targets ${r.small} <24px AA${v.touch ? `, ${r.advisory} <44px AAA` : ' (n/a for mouse)'} of ${r.targets}`,
    )
    if (r.overflow.length) console.log(`      overflow  ${r.overflow.join('\n                ')}`)
    if (r.worst.length) console.log(`      small     ${r.worst.join('\n                ')}`)

    await page.screenshot({ path: `${outDir}/${v.name}-${scene.name}.png` })
  }

  /*
   * On a phone the drawers are the only route to the panels, so a shell that
   * measures well with everything closed still proves nothing. Open each side
   * and re-measure.
   */
  if (v.touch) {
    for (const side of ['left', 'right']) {
      const opened = await page.evaluate((s) => {
        const ui = window.__esque.useUI.getState()
        if (!ui.compact) return false
        ui.setOverlayPanel(s)
        return true
      }, side)
      if (!opened) {
        console.log(`      drawer-${side}  skipped (shell is not compact at this width)`)
        continue
      }
      await new Promise((r) => setTimeout(r, 700))

      const r = await measure()
      const overflowOk = r.overflow.length === 0 && r.scrollWidth <= r.innerWidth
      const targetsOk = r.small === 0
      const ok = overflowOk && targetsOk
      if (!ok) failures++
      console.log(
        `${ok ? 'PASS' : 'FAIL'}  ${`drawer-${side}`.padEnd(14)} targets ${r.small} <24px AA, ${r.advisory} <44px AAA of ${r.targets}`,
      )
      if (r.overflow.length) console.log(`      overflow  ${r.overflow.join('\n                ')}`)
      if (r.worst.length) console.log(`      small     ${r.worst.join('\n                ')}`)

      await page.screenshot({ path: `${outDir}/${v.name}-drawer-${side}.png` })
    }
    await page.evaluate(() => window.__esque.useUI.getState().setOverlayPanel(null))

    /*
     * Dialogs are portalled and never open on their own, so the layout pass
     * above would miss them entirely. The export dialog is the widest one in
     * the app, which makes it the honest worst case.
     */
    const opened = await page.evaluate(() => {
      const c = window.__esque.useCatalog.getState()
      if (c.visibleIds.length) c.select(c.visibleIds[0])
      const ex = window.__esque.useExport?.getState()
      if (!ex || typeof ex.openDialog !== 'function') return false
      ex.openDialog(c.visibleIds.slice(0, 1))
      return true
    })
    if (opened) {
      await new Promise((r) => setTimeout(r, 900))
      const r = await measure()
      const ok = r.overflow.length === 0 && r.small === 0
      if (!ok) failures++
      console.log(
        `${ok ? 'PASS' : 'FAIL'}  ${'export-dialog'.padEnd(14)} targets ${r.small} <24px AA, ${r.advisory} <44px AAA of ${r.targets}`,
      )
      if (r.overflow.length) console.log(`      overflow  ${r.overflow.join('\n                ')}`)
      if (r.worst.length) console.log(`      small     ${r.worst.join('\n                ')}`)
      await page.screenshot({ path: `${outDir}/${v.name}-export-dialog.png` })
      await page.evaluate(() => window.__esque.useExport.getState().closeDialog())
    } else {
      console.log(`      export-dialog  skipped (export store not on the dev bridge)`)
    }
  }

  await page.close()
}

await browser.close()
console.log(`\nScreenshots in ${outDir}`)
process.exit(failures ? 1 : 0)
