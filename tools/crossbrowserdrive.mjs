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
  const results = []
  const scratch = await mkdtemp(join(tmpdir(), `esque-${name}-workflow-`))
  const record = (message) => results.push(message)
  try {
    browser = await launchBrowser(name)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
    await context.addInitScript((disableOpfs) => {
      Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true })
      Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true })
      if (disableOpfs) Object.defineProperty(navigator.storage, 'getDirectory', { value: undefined })
    }, process.env.ESQUE_DISABLE_OPFS === '1')
    page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    page.setDefaultTimeout(20000)
    await page.goto(origin)
    assert.equal((await page.title()).toLowerCase(), 'esque')
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
    const waitCount = (count) => page.waitForFunction(async (expected) => {
      const { db } = await import('/src/catalog/db.ts')
      return await db.photos.count() === expected
    }, count)
    const choose = async (button, paths) => {
      const choosing = page.waitForEvent('filechooser')
      await button.click()
      await (await choosing).setFiles(paths)
    }
    const importFiles = (paths) => choose(page.getByRole('button', { name: /^Import (a )?file/ }).first(), paths)
    const importFolder = (path) => choose(page.getByRole('button', { name: /^Import (a )?folder/ }).first(), path)
    const grid = () => page.getByRole('listbox', { name: 'Photo grid' })
    const allPhotos = () => page.getByRole('button', { name: 'All Photos', exact: true }).click()

    stage = 'file input import'
    assert.equal(await catalogCount(), 0, 'Test context must have an empty catalog')
    await importFiles([firstPath, secondPath])
    await waitCount(2)
    await grid().getByRole('option', { name: 'browser-photo.jpg', exact: true }).waitFor()
    record('Real file inputs import photos without native filesystem APIs')
    await importFiles([firstPath, secondPath])
    await page.waitForTimeout(800)
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
    await page.waitForTimeout(800)
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
    await page.getByRole('button', { name: 'Develop', exact: true }).click()
    await page.waitForFunction(() => !!window.__esque.useDevelop.getState().photoId)
    const photoId = await page.evaluate(() => window.__esque.useDevelop.getState().photoId)
    const sample = async () => page.evaluate(async () => {
      const { activeRenderer } = await import('/src/modules/develop/activeRenderer.ts')
      const pixels = await activeRenderer()?.readPixels('srgb', 8, null)
      if (!pixels) return null
      const at = (Math.floor(pixels.height / 2) * pixels.width + Math.floor(pixels.width / 2)) * 4
      return [...pixels.data.slice(at, at + 4)]
    })
    await page.waitForFunction(async () => {
      const { activeRenderer } = await import('/src/modules/develop/activeRenderer.ts')
      return !!activeRenderer()
    })
    const before = await sample()
    assert(before, 'Develop did not render the imported original')
    const exposure = page.getByRole('slider', { name: 'Exposure', exact: true })
    const box = await exposure.boundingBox()
    assert(box, 'Exposure is not reachable')
    await exposure.click({ position: { x: 3 + (box.width - 6) * 0.6, y: box.height / 2 } })
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
    await page.waitForFunction(async () => {
      const { activeRenderer } = await import('/src/modules/develop/activeRenderer.ts')
      return !!activeRenderer()
    })
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
      const downloading = page.waitForEvent('download')
      await dialog().getByRole('button', { name: 'Download', exact: true }).click()
      const download = await downloading
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
    await page.getByRole('button', { name: 'Library', exact: true }).click()
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
    await capture('download-phone')
    const actionBox = await dialog().getByRole('button', { name: 'Download', exact: true }).boundingBox()
    assert(actionBox && actionBox.x >= 0 && actionBox.x + actionBox.width <= 390 &&
      actionBox.y >= 0 && actionBox.y + actionBox.height <= 844, 'Phone download action is clipped')
    const zip = await getDownload('batch.zip')
    assert(zip.name.endsWith('.zip'))
    const members = unzipStored(zip.bytes)
    assert.deepEqual([...members.keys()].sort(), ['shared (1).jpg', 'shared (1).xmp', 'shared.jpg', 'shared.xmp'])
    assert.deepEqual(members.get('shared.jpg'), bytes, 'Original export changed source bytes')
    assert.deepEqual(members.get('shared (1).jpg'), bytes, 'Second original export changed source bytes')
    assert([...members].some(([name, data]) => name.endsWith('.xmp') && /crs:Exposure2012="1(?:\.0+)?"/.test(data.toString())),
      'Sidecars do not include the saved exposure')
    record('Batch downloads preserve originals, saved XMP, and collision-free paired names')
    record('The completed export remains usable at phone width')
    assert.deepEqual(errors, [], 'Uncaught application errors occurred')
    console.log(JSON.stringify({ browser: name, version: browser.version(), ok: true, results }))
  } catch (error) {
    failed = true
    console.error(JSON.stringify({ browser: name, ok: false, stage, results, error: error.stack, errors }))
    if (page && process.env.ESQUE_CAPTURE_DIR) {
      await page.screenshot({ path: join(process.env.ESQUE_CAPTURE_DIR, `${name}-failure.png`) })
    }
  } finally {
    await browser?.close()
    await rm(scratch, { recursive: true, force: true })
  }
}
if (failed) process.exitCode = 1
