/**
 * Selection, empty-source and tool-inspector regressions.
 *
 * ESQUE_ORIGIN=http://127.0.0.1:5179 node tools/workflowdrive.mjs
 * Optional ESQUE_CAPTURE_DIR keeps screenshots in an existing artifact folder.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import puppeteer from 'puppeteer-core'
import { dismissWelcome } from './lib/welcome.mjs'

const ORIGIN = process.env.ESQUE_ORIGIN?.replace(/\/$/, '')
assert(ORIGIN, 'Set ESQUE_ORIGIN to the dedicated esque preview; no default port is assumed.')
const executablePath = process.env.ESQUE_BROWSER ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
].find(existsSync)
assert(executablePath, 'Set ESQUE_BROWSER to an installed Chromium browser.')

const profile = mkdtempSync(join(tmpdir(), 'esque-workflow-'))
const results = []
const errors = []
const check = (name, ok, detail) => results.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) })
const settle = (ms = 260) => new Promise((resolve) => setTimeout(resolve, ms))
let browser
let page

try {
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    userDataDir: profile,
    env: { ...process.env, TMPDIR: profile },
    args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking'],
  })
  page = await browser.newPage()
  await page.evaluateOnNewDocument(() => {
    Reflect.deleteProperty(window, 'requestIdleCallback')
    Reflect.deleteProperty(window, 'cancelIdleCallback')
  })
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(ORIGIN, { waitUntil: 'networkidle2' })
  // Identity guard before anything seeds IndexedDB. Matched on the wordmark
  // rather than the whole title, which is marketing copy and changes.
  assert.match(
    (await page.title()).toLowerCase(),
    /^esque\b/,
    'Refusing to seed a different application.',
  )
  await page.waitForFunction(() => !!window.__esque?.useCatalog, { timeout: 10000 })
  // The development annotation launcher overlaps the phone's navigation.
  // Exclude that dev-only layer, not any part of the interface being tested.
  await page.addStyleTag({ content: '[data-agentation-root], [data-agentation-toolbar] { display: none !important; }' })
  assert(await dismissWelcome(page), 'Welcome dialog could not be dismissed.')

  const capture = async (name) => {
    if (process.env.ESQUE_CAPTURE_DIR) {
      await page.screenshot({ path: join(process.env.ESQUE_CAPTURE_DIR, `workflow-${name}.png`) })
    }
  }
  const heading = (text) => page.waitForFunction(
    (expected) => [...document.querySelectorAll('h1,h2')].some((el) => el.textContent === expected),
    { timeout: 6000 },
    text,
  )
  const clickButton = async (scope, label) => {
    const handle = await page.evaluateHandle((selector, name) =>
      [...document.querySelectorAll(`${selector} button`)].find((button) =>
        button.getAttribute('aria-label') === name ||
        button.textContent.replace(/\s+/g, '') === name.replace(/\s+/g, ''),
      ) ?? null,
    scope, label)
    const button = handle.asElement()
    assert(button, `Button not found: ${scope} / ${label}`)
    await button.click()
    await handle.dispose()
  }
  const marks = () => page.evaluate(async () => {
    const { db } = await import('/src/catalog/db.ts')
    return (await db.photos.bulkGet(['p1', 'p2', 'p3'])).map((p) => ({
      id: p.id, rating: p.rating, label: p.label, flag: p.flag,
    }))
  })
  const selectPair = async () => {
    await page.evaluate(() => window.__esque.useCatalog.getState().selectMany(['p2', 'p1']))
    await page.waitForFunction(() => {
      const group = document.querySelector('[data-panel="library-right"] [aria-label^="Rating"]')
      return group && !group.querySelector('button').disabled
    })
  }
  const waitGroup = (scope, field, value) => page.waitForFunction((selector, name, expected) => {
    const group = document.querySelector(`${selector} [role="group"][aria-label^="${name}"]`)
    if (!group || group.querySelector('button')?.disabled) return false
    if (expected === null) return group.getAttribute('aria-label').includes('mixed')
    const pressed = group.querySelector('button[aria-pressed="true"]')
    return expected === 'none' ? !pressed : pressed?.getAttribute('aria-label') === expected
  }, { timeout: 6000 }, scope, field, value)
  const library = '[data-panel="library-right"]'
  const toolbar = '[data-photo-toolbar]'

  await heading('No photos yet')
  check('A genuinely empty catalog retains import guidance', true)
  check('Startup supports browsers without idle callbacks', await page.evaluate(() =>
    typeof window.requestIdleCallback === 'undefined',
  ))
  await page.evaluate(async () => {
    const { db } = await import('/src/catalog/db.ts')
    const { cacheWrite, thumbKey, previewKey } = await import('/src/catalog/opfs.ts')
    const { defaultEdits } = await import('/src/core/defaults.ts')
    assertEmpty(await db.photos.count())
    function assertEmpty(count) {
      if (count) throw new Error('The isolated catalog was not empty.')
    }
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle('workflow-fixtures', { create: true })
    await db.folders.bulkAdd([
      { id: 'f1', name: 'Fixture photos', handle: directory, addedAt: 1, photoCount: 0 },
      { id: 'empty-folder', name: 'Empty folder', handle: null, addedAt: 1, photoCount: 0 },
    ])
    const seed = [
      { id: 'p1', rating: 5, label: 'red', flag: 'pick' },
      { id: 'p2', rating: 0, label: 'none', flag: 'unflagged' },
      { id: 'p3', rating: 2, label: 'blue', flag: 'reject' },
    ]
    for (let i = 0; i < seed.length; i++) {
      const photo = seed[i]
      const canvas = new OffscreenCanvas(1200, 800)
      const context = canvas.getContext('2d')
      const sky = context.createLinearGradient(0, 0, 0, 800)
      sky.addColorStop(0, `hsl(${205 + i * 10}, 28%, 68%)`)
      sky.addColorStop(1, 'hsl(38, 18%, 78%)')
      context.fillStyle = sky
      context.fillRect(0, 0, 1200, 800)
      context.fillStyle = '#4a6261'
      context.beginPath()
      context.moveTo(0, 800)
      for (let x = 0; x <= 1200; x += 50) {
        context.lineTo(x, 500 + Math.sin(x / 210 + i) * 80)
      }
      context.lineTo(1200, 800)
      context.fill()
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
      const filename = `${photo.id}.jpg`
      const handle = await directory.getFileHandle(filename, { create: true })
      const writer = await handle.createWritable()
      await writer.write(blob)
      await writer.close()
      await cacheWrite(thumbKey(photo.id), blob)
      await cacheWrite(previewKey(photo.id), blob)
      const edits = photo.id === 'p1' ? defaultEdits('rendered') : null
      if (edits) edits.basic.exposure = 0.35
      await db.photos.add({
        ...photo, folderId: 'f1', relPath: filename, filename, ext: 'jpg', isRaw: false,
        width: 1200, height: 800, fileSize: blob.size, addedAt: 1, modifiedAt: 1,
        meta: {}, keywords: [], title: '', caption: '', edits,
        thumbKey: null, proxyKey: null, masterId: null, copyName: null,
        stackId: null, stackPosition: 0, stackCollapsed: false,
      })
    }
    await db.collections.bulkAdd([
      { id: 'empty', name: 'Empty collection', smart: false, rules: [], photoIds: [], match: 'all', createdAt: 1, setId: null },
      { id: 'smart', name: 'No matching keywords', smart: true, rules: [{ field: 'keyword', op: 'contains', value: 'not-recorded' }], photoIds: [], match: 'all', createdAt: 1, setId: null },
    ])
  })
  await page.waitForFunction(() => window.__esque.useCatalog.getState().visibleIds.length === 3)
  await page.waitForFunction(() => {
    const folder = [...document.querySelectorAll('[role="button"]')].find((row) => row.textContent.startsWith('Fixture photos'))
    return folder?.lastElementChild?.textContent.trim() === '3'
  })
  check('Folder badges count actual photos despite stale cached photoCount', true)
  check('Displaying live folder counts does not rewrite preserved folder metadata', await page.evaluate(async () => {
    const { db } = await import('/src/catalog/db.ts')
    return (await db.folders.get('f1')).photoCount === 0
  }))

  // A primary photo with the chosen value must not clear a mixed selection.
  await selectPair()
  await waitGroup(library, 'Rating', null)
  await waitGroup(library, 'Color label', null)
  await waitGroup(toolbar, 'Rating', null)
  check('Library and toolbar both expose mixed ratings', true)
  check('Library exposes mixed color labels', true)
  await capture('mixed-selection')
  await clickButton(library, '5 stars')
  await waitGroup(library, 'Rating', '5 stars')
  let current = await marks()
  check('Mixed library rating click assigns five to both photos', current[0].rating === 5 && current[1].rating === 5, current)
  check('Bulk rating leaves unselected photos alone', current[2].rating === 2)
  await clickButton(library, '5 stars')
  await waitGroup(library, 'Rating', 'none')
  current = await marks()
  check('Repeated rating clears only a shared rating', current[0].rating === 0 && current[1].rating === 0, current)

  await clickButton(library, 'Red')
  await waitGroup(library, 'Color label', 'Red')
  current = await marks()
  check('Mixed color click assigns red to both photos', current[0].label === 'red' && current[1].label === 'red', current)
  await clickButton(library, 'Red')
  await waitGroup(library, 'Color label', 'none')
  current = await marks()
  check('Repeated color click clears only a shared label', current[0].label === 'none' && current[1].label === 'none', current)
  await page.evaluate(async () => {
    const { db } = await import('/src/catalog/db.ts')
    await db.photos.update('p1', { rating: 4 })
    await db.photos.update('p2', { rating: 2 })
  })
  await waitGroup(toolbar, 'Rating', null)
  await clickButton(toolbar, '4 stars')
  await waitGroup(toolbar, 'Rating', '4 stars')
  current = await marks()
  check('Toolbar assigns a chosen rating across mixed values', current[0].rating === 4 && current[1].rating === 4, current)
  await clickButton(toolbar, '4 stars')
  await waitGroup(toolbar, 'Rating', 'none')
  current = await marks()
  check('Toolbar clears a shared rating', current[0].rating === 0 && current[1].rating === 0, current)
  const pick = `${toolbar} button[title="Pick  (P)"]`
  await page.click(pick)
  await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute('aria-pressed') === 'true', {}, pick)
  current = await marks()
  check('Mixed pick flags are assigned rather than cleared', current[0].flag === 'pick' && current[1].flag === 'pick', current)
  await page.click(pick)
  await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute('aria-pressed') === 'false', {}, pick)
  current = await marks()
  check('Shared pick flags can still be cleared', current[0].flag === 'unflagged' && current[1].flag === 'unflagged', current)

  // The same inspector controls are used through the phone's Info destination.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
  await page.waitForFunction(() => window.__esque.useUI.getState().compact)
  await page.waitForSelector('nav[aria-label="Views"] button[aria-label="Info"]')
  await page.click('nav[aria-label="Views"] button[aria-label="Info"]')
  await page.evaluate(async () => {
    const { db } = await import('/src/catalog/db.ts')
    await db.photos.update('p1', { rating: 5, label: 'red' })
  })
  await waitGroup(library, 'Rating', null)
  await waitGroup(library, 'Color label', null)
  await clickButton(library, 'Red')
  await waitGroup(library, 'Color label', 'Red')
  await clickButton(library, '5 stars')
  await waitGroup(library, 'Rating', '5 stars')
  current = await marks()
  check('Phone Info uses the same safe mixed-selection behavior', current[0].rating === 5 && current[1].rating === 5 && current[0].label === 'red' && current[1].label === 'red', current)
  await page.evaluate(() => window.__esque.useUI.getState().setOverlayPanel(null))
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  await page.waitForFunction(() => !window.__esque.useUI.getState().compact)

  // Folder photoCount is deliberately zero: catalog membership is authoritative.
  await page.evaluate(() => window.__esque.useCatalog.getState().setSource({ kind: 'collection', id: 'empty' }))
  await heading('This collection is empty')
  check('An empty collection is not mistaken for an empty catalog', true)
  await capture('empty-collection')
  await clickButton('body', 'Choose photos')
  await page.waitForFunction(() => window.__esque.useCatalog.getState().visibleIds.length === 3)
  check('Choose photos opens the existing catalog in grid view', await page.evaluate(() =>
    window.__esque.useCatalog.getState().source.kind === 'all' && window.__esque.useUI.getState().viewMode === 'grid',
  ))
  await page.evaluate(() => {
    const catalog = window.__esque.useCatalog.getState()
    catalog.setFilters({ text: 'not-recorded' })
    catalog.setSource({ kind: 'folder', id: 'empty-folder' })
  })
  await heading('No photos in this folder')
  check('An empty source is not blamed on global filters', true)
  await clickButton('body', 'All Photos')
  await page.waitForFunction(() => window.__esque.useCatalog.getState().visibleIds.length === 3)
  check('All Photos recovery clears filters that would keep the view empty', await page.evaluate(() =>
    window.__esque.useCatalog.getState().filters.text === '',
  ))
  await page.evaluate(() => window.__esque.useCatalog.getState().setSource({ kind: 'collection', id: 'smart' }))
  await heading('No photos match this collection')
  await clickButton('body', 'Edit rules…')
  check('Smart collection recovery opens its existing rule editor', await page.evaluate(async () => {
    const { useSmartEditor } = await import('/src/state/smartEditor.ts')
    return useSmartEditor.getState().target?.id === 'smart'
  }))
  await clickButton('[role="dialog"]', 'Cancel')
  await clickButton('body', 'All Photos')
  await page.waitForFunction(() => window.__esque.useCatalog.getState().visibleIds.length === 3)
  await page.evaluate(() => window.__esque.useCatalog.getState().setFilters({ text: 'not-recorded' }))
  await heading('No photos match')
  await clickButton('body', 'Clear filters')
  await page.waitForFunction(() => window.__esque.useCatalog.getState().visibleIds.length === 3)
  check('A filtered-empty view retains one-click filter recovery', true)

  // Tool activation must reveal its section even when the inspector was hidden.
  await page.evaluate(() => {
    window.__esque.useCatalog.getState().select('p1')
    window.__esque.useUI.getState().setModule('develop')
  })
  await page.waitForFunction(() => window.__esque.useDevelop.getState().photoId === 'p1')
  await page.waitForSelector('[data-develop-inspector]')
  await page.mouse.move(650, 420)
  await settle()
  check('Basic has one visible Auto action at rest', await page.evaluate(() => {
    const header = [...document.querySelectorAll('[data-panel="develop-right"] header')].find((h) =>
      h.querySelector('.esq-panel-title')?.textContent === 'Basic',
    )
    const actions = [...header.querySelectorAll('button')].filter((button) => button.textContent.trim().startsWith('Auto'))
    return actions.length === 1 && actions[0].textContent.trim() === 'Auto' && getComputedStyle(actions[0].parentElement).opacity === '1'
  }))
  await page.evaluate(() => {
    const { useDevelop, useCatalog } = window.__esque
    window.__workflowFlush = useDevelop.getState().flush
    useDevelop.setState({
      flush: async () => {
        useDevelop.setState({ saveStatus: 'error', saveError: 'Fixture save failure', pendingSaveCount: 1 })
        throw new Error('Fixture save failure')
      },
    })
    useCatalog.getState().selectMany(['p2', 'p1'])
  })
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-panel="develop-right"] button')].some((button) => button.textContent.trim() === 'Sync 1'),
  )
  await clickButton('[data-panel="develop-right"]', 'Sync 1')
  await page.waitForFunction(() =>
    document.querySelector('[data-panel="develop-right"] [role="status"]')?.textContent.includes('Edits not saved'),
  )
  check('Failed flush stops Sync before copying stored source edits', await page.evaluate(async () => {
    const { db } = await import('/src/catalog/db.ts')
    return (await db.photos.get('p2')).edits === null
  }))
  check('The existing footer exposes save failure and Retry Save', await page.evaluate(() => {
    const status = document.querySelector('[data-panel="develop-right"] [role="status"]')
    return [...status.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Retry Save')
  }))
  await page.evaluate(() => {
    window.__esque.useDevelop.setState({
      flush: window.__workflowFlush, saveStatus: 'saved', saveError: null, pendingSaveCount: 0,
    })
    delete window.__workflowFlush
    window.__esque.useCatalog.getState().select('p1')
  })
  await page.evaluate(() => window.__esque.useUI.getState().toggleRightPanel())
  await page.keyboard.press('r')
  const toolVisible = (id) => page.waitForFunction((sectionId) => {
    const section = document.getElementById(sectionId)
    const scroller = section?.closest('[data-develop-inspector]')
    const button = section?.querySelector('header button')
    if (!scroller || button?.getAttribute('aria-expanded') !== 'true') return false
    const r = button.getBoundingClientRect()
    const viewport = scroller.getBoundingClientRect()
    return r.width > 0 && viewport.height > 0 && r.top >= viewport.top - 2 && r.bottom <= viewport.bottom
  }, { timeout: 6000 }, id)
  await toolVisible('develop-crop')
  check('R opens a hidden inspector and reveals Crop & Straighten', true)
  await capture('crop-inspector')
  await page.keyboard.press('r')
  await page.waitForFunction(() => document.querySelector('#develop-crop header button')?.getAttribute('aria-expanded') === 'false')
  await settle()
  const originalScroll = await page.evaluate(() => {
    const scroller = document.querySelector('[data-develop-inspector]')
    scroller.scrollTop = 180
    return scroller.scrollTop
  })
  await page.keyboard.press('r')
  await toolVisible('develop-crop')
  await settle()
  await clickButton('#develop-crop', 'DoneR')
  await page.waitForFunction(() => window.__esque.useUI.getState().developTool === 'none')
  await settle()
  check('Leaving a tool restores the previous inspector scroll position', await page.evaluate((previous) =>
    Math.abs(document.querySelector('[data-develop-inspector]').scrollTop - previous) < 3,
  originalScroll))
  check('An automatically opened section restores its previous collapsed state', await page.evaluate(() =>
    document.querySelector('#develop-crop header button').getAttribute('aria-expanded') === 'false',
  ))
  await page.evaluate(() => document.querySelector('#develop-crop header button').click())
  await settle()
  await page.keyboard.press('r')
  await toolVisible('develop-crop')
  await page.keyboard.press('r')
  await settle()
  check('A previously open section remains open after leaving its tool', await page.evaluate(() =>
    document.querySelector('#develop-crop header button').getAttribute('aria-expanded') === 'true',
  ))
  await page.evaluate(() => document.querySelector('#develop-crop header button').click())
  await page.keyboard.press('r')
  await toolVisible('develop-crop')
  for (const [tool, id] of [['mask', 'develop-mask'], ['heal', 'develop-retouch'], ['redeye', 'develop-retouch']]) {
    await page.evaluate((value) => window.__esque.useUI.getState().setDevelopTool(value), tool)
    await toolVisible(id)
    check(`${tool} activation brings its own settings into view`, true)
  }
  await page.evaluate(() => window.__esque.useUI.getState().setDevelopTool('none'))
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
  await page.waitForFunction(() => window.__esque.useUI.getState().compact)
  await page.waitForSelector('nav[aria-label="Views"] button[aria-label="Masks"]')
  await page.click('nav[aria-label="Views"] button[aria-label="Masks"]')
  await toolVisible('develop-mask')
  check('Phone Masks opens the existing inspector on Masking', await page.evaluate(() =>
    window.__esque.useUI.getState().overlayPanel === 'right',
  ))
  await page.evaluate(() => window.__esque.useUI.getState().setOverlayPanel(null))
  await settle()
  check('Dismissing the phone inspector does not exit the tool or force it open again', await page.evaluate(() =>
    window.__esque.useUI.getState().developTool === 'mask' && window.__esque.useUI.getState().overlayPanel === null,
  ))
  await page.click('nav[aria-label="Views"] button[aria-label="Masks"]')
  await toolVisible('develop-mask')
  check('Phone Masks reopens settings without toggling an active mask tool off', await page.evaluate(() =>
    window.__esque.useUI.getState().developTool === 'mask',
  ))
  await capture('phone-mask-inspector')

  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  await page.evaluate(() => {
    const { useUI } = window.__esque
    useUI.getState().setDevelopTool('none')
    useUI.getState().setOverlayPanel(null)
  })
  await settle(400)
  const blueSample = async () => page.evaluate(async () => {
    const { activeRenderer } = await import('/src/modules/develop/activeRenderer.ts')
    const pixels = await activeRenderer()?.readPixels('srgb', 8, null)
    if (!pixels) throw new Error('The Develop canvas has no rendered pixels.')
    const index = (Math.floor(pixels.height / 2) * pixels.width + Math.floor(pixels.width / 2)) * 4 + 2
    return pixels.data[index]
  })
  const beforeMask = await blueSample()
  await page.evaluate(async () => {
    const { db } = await import('/src/catalog/db.ts')
    const { alphaKey, saveAlpha } = await import('/src/ai/alpha.ts')
    const { newMask } = await import('/src/develop/masks.ts')
    const { defaultEdits } = await import('/src/core/defaults.ts')
    const photo = await db.photos.get('p1')
    const edits = structuredClone(photo.edits ?? defaultEdits())
    const mask = newMask([], 'aiSubject')
    mask.components[0].geometry.cacheKey = alphaKey('p1', 'aiSubject', 'u2netp')
    mask.adjustments.exposure = 1
    edits.masks = [mask]
    await saveAlpha(mask.components[0].geometry.cacheKey, {
      size: 8, data: new Float32Array(64).fill(1),
    })
    await db.photos.update('p1', { edits })
  })
  const modelRequests = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('.onnx')) modelRequests.push(request.url())
  })
  await page.reload({ waitUntil: 'networkidle2' })
  await page.waitForFunction(() => !!window.__esque?.useDevelop)
  await page.evaluate(() => {
    const { useUI, useCatalog } = window.__esque
    useUI.setState({ module: 'develop', developTool: 'none', rightPanelOpen: false, overlayPanel: null })
    useCatalog.getState().select('p1')
  })
  await page.waitForFunction(() => window.__esque.useDevelop.getState().photoId === 'p1')
  await page.waitForFunction(async (before) => {
    const { activeRenderer } = await import('/src/modules/develop/activeRenderer.ts')
    const pixels = await activeRenderer()?.readPixels('srgb', 8, null)
    if (!pixels) return false
    const index = (Math.floor(pixels.height / 2) * pixels.width + Math.floor(pixels.width / 2)) * 4 + 2
    return pixels.data[index] > before + 10
  }, { timeout: 10000 }, beforeMask)
  check('Reopening Develop restores saved detected coverage with its inspector closed',
    await page.evaluate(() => !window.__esque.useUI.getState().rightPanelOpen))
  check('Restored detected coverage actually changes the visible Develop pixels', await blueSample() > beforeMask + 10)
  check('Reopening a detected mask does not download model weights', modelRequests.length === 0)
  check('No uncaught page errors', errors.length === 0, errors)
} catch (error) {
  check('Workflow drive completed', false, error.stack ?? error.message)
  try {
    if (page && /^esque\b/.test((await page.title()).toLowerCase())) {
      const diagnostic = await page.evaluate(() => {
        const ui = window.__esque?.useUI.getState()
        const catalog = window.__esque?.useCatalog.getState()
        return {
          ui: ui && { module: ui.module, compact: ui.compact, overlayPanel: ui.overlayPanel, tool: ui.developTool },
          selection: catalog?.selected,
          groups: [...document.querySelectorAll('[role="group"]')].map((group) => ({
            label: group.getAttribute('aria-label'),
            text: group.textContent,
            disabled: group.querySelector('button')?.disabled,
          })),
          dialogs: [...document.querySelectorAll('[role="dialog"]')].map((dialog) => dialog.textContent.slice(0, 1200)),
        }
      })
      check('Failure context', false, { diagnostic, errors })
      if (process.env.ESQUE_CAPTURE_DIR) {
        await page.screenshot({ path: join(process.env.ESQUE_CAPTURE_DIR, 'workflow-failure.png') })
      }
    }
  } catch (diagnosticError) {
    check('Failure context unavailable', false, diagnosticError.message)
  }
} finally {
  await browser?.close()
  rmSync(profile, { recursive: true, force: true })
}

const failed = results.filter((result) => !result.ok)
console.log(JSON.stringify({
  pass: failed.length === 0,
  checks: results.length,
  failed,
  ...(failed.length ? { results } : {}),
}, null, 2))
process.exit(failed.length ? 1 : 0)
