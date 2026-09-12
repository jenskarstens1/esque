/**
 * RAW proxy cache drive: is a RAW decode still there after a reload?
 *
 * Converting a RAW is the most expensive thing esque does — seconds of demosaic
 * for a frame the photographer is about to sit in front of — and a page reload
 * throws away every in-memory tier. What it must not throw away is the decode
 * itself: the working proxy is written to OPFS precisely so that coming back to
 * a photograph is a file read rather than a second conversion.
 *
 * Reading a timing and calling it proof is how a cache that never hits passes
 * its own test, so the second open is made *impossible* to serve any other way:
 * the original file is removed from OPFS first. A decode would have nothing to
 * decode. Real pixels on the canvas can then only have come from the cache.
 *
 *   node tools/rawcachedrive.mjs
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
const ORIGIN = (process.env.ESQUE_ORIGIN ?? 'http://localhost:5173').replace(/\/$/, '')

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
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
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms))

const ready = async () => {
  await page.waitForFunction('!!window.__esque', { timeout: 30_000, polling: 100 })
  await settle(1200)
  await dismissWelcome(page)
}

await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle2' })
await ready()

const seeded = await page.evaluate(async (fixture) => {
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle('rawcachesrc', { create: true })
  const bytes = new Uint8Array(await (await fetch(fixture)).arrayBuffer())
  const name = fixture.slice(fixture.lastIndexOf('/') + 1)
  const fh = await dir.getFileHandle(name, { create: true })
  const ws = await fh.createWritable()
  await ws.write(bytes)
  await ws.close()

  const { db } = await import('/src/catalog/db.ts')
  const { defaultEdits } = await import('/src/core/defaults.ts')
  await db.photos.clear()
  await db.folders.clear()
  await db.folders.put({ id: 'fc', name: 'Cache', handle: dir, addedAt: 0, photoCount: 1 })
  await db.photos.put({
    id: 'pc',
    folderId: 'fc',
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
  return { name, bytes: bytes.length }
}, FIXTURE)
console.log(`seeded ${seeded.name} (${(seeded.bytes / 1e6).toFixed(1)} MB)`)

/** Every cached proxy currently on disk, by key. */
const proxyEntries = () =>
  page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const out = []
    const visit = async (dir, prefix) => {
      for await (const [name, handle] of dir.entries()) {
        const key = prefix ? `${prefix}/${name}` : name
        if (handle.kind === 'directory') await visit(handle, key)
        else out.push({ key, size: (await handle.getFile()).size })
      }
    }
    try {
      await visit(await root.getDirectoryHandle('proxy'), 'proxy')
    } catch {
      /* nothing written yet */
    }
    return out
  })

/** Open Develop on the seeded photo and wait for the real conversion to land. */
const openDevelop = async (timeoutMs = 180_000) => {
  await page.evaluate(() => {
    const { useCatalog, useUI } = window.__esque
    useCatalog.getState().select('pc')
    useUI.getState().setModule('develop')
  })
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const s = await page.evaluate(() => {
      const tier = window.__esque.proxy.peek('pc')
      return {
        // The embedded camera JPEG is a stand-in, not the decode: a wait that
        // ends on it would time the fast path and report it as the slow one.
        real: !!tier && !tier.preview && tier.quality !== 'preview',
        tier,
        failed: /no longer where esque left it|couldn't be read|could not be read/i.test(
          document.body.innerText,
        ),
      }
    })
    if (s.failed) return { ms: Date.now() - t0, failed: true, tier: s.tier }
    if (s.real) return { ms: Date.now() - t0, failed: false, tier: s.tier }
    await settle(50)
  }
  return { ms: Date.now() - t0, failed: false, timedOut: true }
}

// --- First open: the decode everyone pays for once ------------------------
const first = await openDevelop()
ok('a RAW opens in Develop', !first.failed && !first.timedOut, JSON.stringify(first))
console.log(`    first open: ${first.ms} ms`)

await settle(2500) // the cache write is fire-and-forget behind the paint
let entries = await proxyEntries()
ok('the decode is written to the proxy cache', entries.length > 0, JSON.stringify(entries))
console.log(`    cached: ${entries.map((e) => `${e.key} (${(e.size / 1e6).toFixed(1)} MB)`).join(', ')}`)

// --- Reload cold, and take the original away --------------------------------
// The memory LRU outlives a module switch, so the second open has to start from
// a genuinely empty heap or it proves nothing. Coming back in the Library also
// keeps Develop from reopening — and re-reading the file — before the original
// has been moved out of reach.
await page.evaluate(() => window.__esque.useUI.getState().setModule('library'))
await settle(400)
await page.reload({ waitUntil: 'networkidle2' })
await ready()
const removed = await page.evaluate(async (name) => {
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle('rawcachesrc')
  await dir.removeEntry(name)
  try {
    await dir.getFileHandle(name)
    return false
  } catch {
    return true
  }
}, seeded.name)
ok('the original is out of reach for the second open', removed)

// The Library renders its thumbnail from the same cached decode, which is the
// behaviour we want — but it leaves the tier in memory, and a memory hit would
// prove nothing about the file on disk. Drop it, so the reopen has to read.
await page.evaluate(() => window.__esque.proxy.drop('pc'))
const cold = await page.evaluate(() => window.__esque.proxy.stats())
ok('nothing is left decoded in memory', cold.count === 0, JSON.stringify(cold))

const second = await openDevelop(60_000)
ok(
  'the photograph still opens, from the cached decode alone',
  !second.failed && !second.timedOut,
  JSON.stringify(second),
)
console.log(`    second open: ${second.ms} ms`)
ok(
  'and it is faster than converting the RAW again',
  second.ms < first.ms / 2,
  `${second.ms} ms vs ${first.ms} ms`,
)
ok(
  'and it is the real conversion, not the camera JPEG',
  !!second.tier && second.tier.preview === false && second.tier.quality !== 'preview',
  JSON.stringify(second.tier),
)

// --- Cleanup ---------------------------------------------------------------
await page.evaluate(async () => {
  const { db } = await import('/src/catalog/db.ts')
  await db.photos.clear()
  await db.folders.clear()
  const { cacheClear } = await import('/src/catalog/opfs.ts')
  await cacheClear({ previewsOnly: true })
  const root = await navigator.storage.getDirectory()
  await root.removeEntry('rawcachesrc', { recursive: true }).catch(() => {})
})

const failed = results.filter((r) => !r.ok)
console.log(
  JSON.stringify(
    {
      passed: results.length - failed.length,
      of: results.length,
      firstOpenMs: first.ms,
      secondOpenMs: second.ms,
      failed,
      errors: errors.slice(0, 6),
    },
    null,
    2,
  ),
)
await browser.close()
process.exit(failed.length ? 1 : 0)
