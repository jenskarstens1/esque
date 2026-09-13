import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { browserNames, launchBrowser } from './lib/playwright.mjs'
import { dismissWelcome } from './lib/welcome.mjs'

const origin = process.env.ESQUE_ORIGIN
assert(origin, 'Set ESQUE_ORIGIN to the dedicated esque preview.')
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
let failed = false

const workerUrl = new URL('/src/raw/rawWorker.ts?worker_file&type=module', origin)
const workerResponse = await fetch(workerUrl)
const etag = workerResponse.headers.get('etag')
assert(etag, 'The development worker should support revalidation')
await workerResponse.arrayBuffer()
const revalidated = await fetch(workerUrl, { headers: { 'If-None-Match': etag } })
assert.equal(revalidated.status, 304)
assert.equal(revalidated.headers.get('cross-origin-opener-policy'), 'same-origin')
assert.equal(revalidated.headers.get('cross-origin-embedder-policy'), 'require-corp')

async function waitForResult(page, callback, arg) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const result = await page.evaluate(callback, arg)
    if (result) return result
    await page.waitForTimeout(50)
  }
  throw new Error(`Timed out awaiting browser result: ${callback}`)
}

function unzipStored(bytes) {
  const entries = new Map()
  let at = 0
  while (bytes.readUInt32LE(at) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(at + 8), 0, 'Expected a store-only ZIP')
    const size = bytes.readUInt32LE(at + 18)
    const nameLength = bytes.readUInt16LE(at + 26)
    const extraLength = bytes.readUInt16LE(at + 28)
    const name = bytes.toString('utf8', at + 30, at + 30 + nameLength)
    assert(!entries.has(name), `Duplicate archive member: ${name}`)
    const start = at + 30 + nameLength + extraLength
    entries.set(name, bytes.subarray(start, start + size))
    at = start + size
  }
  assert.equal(bytes.readUInt32LE(at), 0x02014b50, 'Central directory is missing')
  return entries
}

for (const name of browserNames()) {
  let browser
  let page
  let stage = 'launch'
  const errors = []
  const consoleErrors = []
  const results = []
  const scratch = await mkdtemp(join(tmpdir(), `esque-${name}-workflow-`))
  const record = (message) => results.push(message)
  try {
    browser = await launchBrowser(name)
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 }, acceptDownloads: true, reducedMotion: 'reduce',
    })
    await context.addInitScript(({ disableOpfs, disableGpu }) => {
      Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true })
      Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true })
      if (disableOpfs) Object.defineProperty(navigator.storage, 'getDirectory', { value: undefined })
      if (disableGpu) Object.defineProperty(navigator, 'gpu', { value: undefined })
    }, { disableOpfs: process.env.ESQUE_DISABLE_OPFS === '1', disableGpu: process.env.ESQUE_DISABLE_WEBGPU === '1' })
    page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.setDefaultTimeout(20000)
    await page.goto(origin)
    assert.match((await page.title()).toLowerCase(), /^esque\b/)
    await page.waitForFunction(() => !!window.__esque)
    await dismissWelcome(page)
    await page.addStyleTag({ content: '[data-agentation-root], [data-agentation-toolbar] { display: none !important; }' })

    const capture = async (label) => {
      if (process.env.ESQUE_CAPTURE_DIR) {
        await page.screenshot({ path: join(process.env.ESQUE_CAPTURE_DIR, `${name}-${label}.png`) })
      }
    }
    const bytes = Buffer.from(await page.evaluate(async () => {
      const canvas = new OffscreenCanvas(384, 256)
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#406080'
      ctx.fillRect(0, 0, 384, 256)
      ctx.fillStyle = '#a06040'
      ctx.fillRect(0, 0, 80, 80)
      return Array.from(new Uint8Array(await (await canvas.convertToBlob({
        type: 'image/jpeg', quality: 0.95,
      })).arrayBuffer()))
    }))
    const firstPath = join(scratch, 'browser-photo.jpg')
    const secondPath = join(scratch, 'second-photo.jpg')
    await writeFile(firstPath, bytes)
    await writeFile(secondPath, bytes)
    const catalogCount = async () => page.evaluate(async () => {
      const { db } = await import('/src/catalog/db.ts')
      return db.photos.count()
    })
    const waitCount = (count) => waitForResult(page, async (expected) => {
      const { db } = await import('/src/catalog/db.ts')
      return await db.photos.count() === expected
    }, count)
    const choose = async (label, paths) => {
      await page.waitForFunction(() => !window.__esque.useImporter.getState().active)
      await page.getByRole('menu').waitFor({ state: 'detached' })
      await page.getByRole('button', { name: 'Add folders or photos', exact: true }).click()
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByRole('menuitem', { name: label, exact: true }).click(),
      ])
      await chooser.setFiles(paths)
      await page.waitForFunction(() => !document.querySelector('input[type="file"]'))
    }
    const importFiles = (paths) => choose('Import Photos…', paths)
    const importFolder = (path) => choose('Import Folder…', path)
    const grid = () => page.getByRole('listbox', { name: 'Photo grid' })
    const allPhotos = () => page.getByRole('button', { name: /^All Photos\b/ }).click()

    stage = 'file input import'
    assert.equal(await catalogCount(), 0, 'Test context must have an empty catalog')
    await importFiles([firstPath, secondPath])
    await waitCount(2)
    await grid().getByRole('option', { name: 'browser-photo.jpg', exact: true }).waitFor()
    record('Real file inputs import photos without native filesystem APIs')
    await importFiles([firstPath, secondPath])
    await page.waitForFunction(() => !window.__esque.useImporter.getState().active)
    assert.equal(await catalogCount(), 2, 'Reimport duplicated unchanged originals')
    record('Reimporting unchanged files preserves their existing records')

    stage = 'standard file drop'
    const transfer = await page.evaluateHandle((data) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([new Uint8Array(data)], 'dropped-photo.jpg', {
        type: 'image/jpeg', lastModified: 1234567890000,
      }))
      return transfer
    }, [...bytes])
    await grid().dispatchEvent('drop', { dataTransfer: transfer })
    await transfer.dispose()
    await waitCount(3)
    record('Standard File drops work without native handle APIs')

    stage = 'directory input import'
    const folder = join(scratch, 'folder-import')
    await mkdir(join(folder, 'north'), { recursive: true })
    await mkdir(join(folder, 'south'), { recursive: true })
    await writeFile(join(folder, 'north', 'twin.jpg'), bytes)
    await writeFile(join(folder, 'south', 'twin.jpg'), bytes)
    await importFolder(folder)
    await waitCount(5)
    await importFolder(folder)
    await page.waitForFunction(() => !window.__esque.useImporter.getState().active)
    assert.equal(await catalogCount(), 5, 'Folder reimport duplicated photos')
    const twins = await page.evaluate(async () => {
      const { db } = await import('/src/catalog/db.ts')
      return (await db.photos.toArray()).filter((photo) => photo.filename === 'twin.jpg')
        .map((photo) => photo.relPath)
    })
    assert.equal(new Set(twins).size, 2, 'Nested duplicate basenames lost their folder identity')
    record('Directory inputs preserve nested paths and deduplicate folder reimports')

    stage = 'editing actual rendered pixels'
    await allPhotos()
    await grid().getByRole('option', { name: 'browser-photo.jpg', exact: true }).click()
    await page.getByRole('tab', { name: 'Develop', exact: true }).click()
    await page.waitForFunction(() => !!window.__esque.useDevelop.getState().photoId)
    if (process.env.ESQUE_DISABLE_WEBGPU === '1') {
      const alert = page.getByRole('alert').filter({ hasText: 'WebGPU' })
      await alert.waitFor()
      assert.match(await alert.innerText(), /graphics acceleration/)
      const secondId = await page.evaluate(async () => {
        const { db } = await import('/src/catalog/db.ts')
        const second = await db.photos.filter((photo) => photo.filename === 'second-photo.jpg').first()
        window.__esque.useCatalog.getState().select(second.id)
        return second.id
      })
      await page.waitForFunction((id) => window.__esque.useDevelop.getState().photoId === id &&
        !!window.__esque.proxy.peek(id), secondId)
      await alert.waitFor()
      assert.equal(await catalogCount(), 5)
      record('Unavailable WebGPU gives actionable guidance, including after changing photos')
      assert.deepEqual(errors, [])
      console.log(JSON.stringify({ browser: name, version: browser.version(), ok: true, results }))
      continue
    }
    const photoId = await page.evaluate(() => window.__esque.useDevelop.getState().photoId)
    const sample = () => waitForResult(page, async () => {
      const { activeRenderer } = await import('/src/modules/develop/activeRenderer.ts')
      const photo = window.__esque.useDevelop.getState().photoId
      const proxy = window.__esque.proxy.peek(photo)
      if (!proxy || proxy.preview) return null
      const pixels = await activeRenderer()?.readPixels('srgb', 8, null)
      if (!pixels) return null
      const at = (Math.floor(pixels.height / 2) * pixels.width + Math.floor(pixels.width / 2)) * 4
      return [...pixels.data.slice(at, at + 4)]
    })
    const before = await sample()
    assert(before, 'Develop did not render the imported original')
    const exposure = page.getByRole('slider', { name: 'Exposure', exact: true })
    const box = await exposure.boundingBox()
    assert(box, 'Exposure is not reachable')
    for (let step = 0; step < 10; step++) await exposure.press('Shift+ArrowRight')
    await page.waitForFunction(() => {
      const state = window.__esque.useDevelop.getState()
      return state.edits.basic.exposure === 1 && state.saveStatus === 'saved'
    })
    const after = await sample()
    assert(after[2] > before[2] + 10, 'Exposure did not change the visible photo')
    record('An actual Exposure control changes pixels and saves durably')
    await page.reload()
    await page.waitForFunction(() => !!window.__esque)
    await page.evaluate((id) => window.__esque.useCatalog.getState().select(id), photoId)
    await page.waitForFunction((id) => {
      const state = window.__esque.useDevelop.getState()
      return state.photoId === id && state.edits.basic.exposure === 1
    }, photoId)
    const reopened = await sample()
    assert(reopened && Math.abs(reopened[2] - after[2]) <= 2, 'Reload lost the saved appearance')
    record('Reload retains edits and access to the managed original')

    stage = 'single-image download'
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    const dialog = () => page.getByRole('dialog', { name: 'Export', exact: true })
    await dialog().waitFor()
    assert.equal(await page.evaluate(() => window.__esque.useExport.getState().delivery), 'download')
    await dialog().locator('select:has(option[value="png"])').selectOption('png')
    await dialog().getByRole('button', { name: 'Export photo', exact: true }).click()
    await page.waitForFunction(() => !window.__esque.useExport.getState().running &&
      !!window.__esque.useExport.getState().readyDownload)
    const getDownload = async (filename) => {
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        dialog().getByRole('button', { name: 'Download', exact: true }).click(),
      ])
      assert.equal(await download.failure(), null)
      const path = join(scratch, filename)
      await download.saveAs(path)
      return { bytes: await readFile(path), name: download.suggestedFilename() }
    }
    const png = await getDownload('edited.png')
    assert(png.name.endsWith('.png'), 'Single image should not be zipped')
    const decoded = await page.evaluate(async (data) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: 'image/png' }))
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = canvas.getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      return { width: canvas.width, height: canvas.height,
        pixel: [...ctx.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data] }
    }, [...png.bytes])
    assert.equal(decoded.width, 384)
    assert.equal(decoded.height, 256)
    assert(Math.abs(decoded.pixel[2] - after[2]) <= 3, 'Downloaded pixels disagree with the edited viewport')
    record('A real browser download contains the edited full-resolution image')
    await dialog().getByRole('button', { name: 'Close', exact: true }).click()

    stage = 'batch download with XMP'
    await page.getByRole('tab', { name: 'Library', exact: true }).click()
    await allPhotos()
    await grid().getByRole('option', { name: 'browser-photo.jpg', exact: true }).click()
    await grid().getByRole('option', { name: 'second-photo.jpg', exact: true }).click({ modifiers: [modifier] })
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    await dialog().locator('select:has(option[value="original"])').selectOption('original')
    await dialog().getByRole('textbox', { name: 'Filename template', exact: true }).fill('shared')
    await dialog().getByRole('checkbox', { name: 'Also write an .xmp sidecar', exact: true }).check()
    await dialog().getByRole('button', { name: 'Export 2 photos', exact: true }).click()
    await page.waitForFunction(() => !window.__esque.useExport.getState().running &&
      !!window.__esque.useExport.getState().readyDownload)
    await capture('download-desktop')
    await page.setViewportSize({ width: 390, height: 844 })
    const actionBox = await waitForResult(page, () => {
      if (innerWidth !== 390 || innerHeight !== 844) return false
      const button = [...document.querySelectorAll('[role="dialog"] button')]
        .find((element) => element.textContent.trim() === 'Download')
      const rect = button?.getBoundingClientRect()
      return rect && rect.width > 0 && rect.height > 0 &&
        rect.x >= 0 && rect.right <= innerWidth && rect.y >= 0 && rect.bottom <= innerHeight
        ? rect.toJSON() : null
    })
    await capture('download-phone')
    assert(actionBox && actionBox.x >= 0 && actionBox.x + actionBox.width <= 390 &&
      actionBox.y >= 0 && actionBox.y + actionBox.height <= 844,
    `Phone download action is clipped: ${JSON.stringify({ actionBox, viewport: await page.evaluate(() => [innerWidth, innerHeight]) })}`)
    const zip = await getDownload('batch.zip')
    assert(zip.name.endsWith('.zip'))
    const members = unzipStored(zip.bytes)
    assert.deepEqual([...members.keys()].sort(), ['shared (1).jpg', 'shared (1).xmp', 'shared.jpg', 'shared.xmp'])
    assert.deepEqual(members.get('shared.jpg'), bytes, 'Original export changed source bytes')
    assert.deepEqual(members.get('shared (1).jpg'), bytes, 'Second original export changed source bytes')
    assert([...members].some(([name, data]) => name.endsWith('.xmp') && /crs:Exposure2012="\+?1(?:\.0+)?"/.test(data.toString())),
      'Sidecars do not include the saved exposure')
    record('Batch downloads preserve originals, saved XMP, and collision-free paired names')
    record('The completed export remains usable at phone width')
    assert.deepEqual(errors, [], 'Uncaught application errors occurred')
    console.log(JSON.stringify({ browser: name, version: browser.version(), ok: true, results }))
  } catch (error) {
    failed = true
    const diagnostics = page && !page.isClosed() ? await page.evaluate(async () => {
      return {
        active: window.__esque?.useImporter.getState().active,
        menus: [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
        inputs: document.querySelectorAll('input[type="file"]').length,
        toasts: [...document.querySelectorAll('[data-tone]')].map((item) => item.textContent),
      }
    }).catch((failure) => ({ error: failure.message })) : null
    console.error(JSON.stringify({ browser: name, ok: false, stage, results, error: error.stack, errors, consoleErrors, diagnostics }))
    if (page && process.env.ESQUE_CAPTURE_DIR) {
      await page.screenshot({ path: join(process.env.ESQUE_CAPTURE_DIR, `${name}-failure.png`) })
    }
  } finally {
    await browser?.close()
    await rm(scratch, { recursive: true, force: true })
  }
}
if (failed) process.exitCode = 1
