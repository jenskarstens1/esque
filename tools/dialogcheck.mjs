/**
 * Settings, export options, legacy preferences and shared icon regression checks.
 * Uses a fresh browser profile and synthetic photos, never the user's catalog.
 *
 * node tools/dialogcheck.mjs [dev-server origin]
 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBrowser } from './lib/playwright.mjs'
import { dismissWelcome } from './lib/welcome.mjs'

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:5173/')
const screenshots = process.env.ESQUE_DIALOG_SCREENSHOTS
const viewports = [
  { name: 'desktop', width: 1440, height: 900, touch: false },
  { name: 'tablet', width: 834, height: 1112, touch: true },
  { name: 'phone', width: 390, height: 844, touch: true },
  { name: 'narrow', width: 320, height: 568, touch: true },
]
if (screenshots) await mkdir(screenshots, { recursive: true })

async function layout(dialog, description) {
  const result = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const overflow = [...element.querySelectorAll('button, input, select, [role="slider"]')]
      .filter((control) => {
        const box = control.getBoundingClientRect()
        if (!box.width || !box.height) return false
        const rail = control.closest('[role="tablist"]')
        if (rail && getComputedStyle(rail).overflowX === 'auto') return false
        return box.left < bounds.left - 1 || box.right > bounds.right + 1
      })
      .map((control) => control.getAttribute('aria-label') || control.textContent?.trim())
    return {
      fits: bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight,
      overflow,
    }
  })
  assert.ok(result.fits, `${description}: dialog fits the viewport`)
  assert.deepEqual(result.overflow, [], `${description}: controls stay within the dialog`)
}

async function preferences(page) {
  return page.evaluate(() => {
    const { useUI } = window.__esque
    const state = useUI.getState()
    return {
      accentRetained: 'accent' in state || 'setAccent' in state,
      appearance: state.appearance,
      surround: state.surround,
      textSize: state.textSize,
      thumbSize: state.thumbSize,
      showGridExtras: state.showGridExtras,
      importSidecars: state.importSidecars,
      stored: JSON.parse(localStorage.getItem('esque.ui')).state,
    }
  })
}

async function exportState(page) {
  return page.evaluate(() => {
    const { useExport } = window.__esque
    const { settings, presets, activePreset } = useExport.getState()
    return { settings, presets, activePreset }
  })
}

async function seedPhoto(page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/catalog/db.ts')
    const { defaultEdits } = await import('/src/core/defaults.ts')
    const { useExport } = window.__esque
    const root = await navigator.storage.getDirectory()
    const folder = await root.getDirectoryHandle('dialog-check-originals', { create: true })
    const handle = await folder.getFileHandle('Landscape-01.jpg', { create: true })
    const canvas = document.createElement('canvas')
    canvas.width = 1800
    canvas.height = 1200
    const context = canvas.getContext('2d')
    context.fillStyle = '#777777'
    context.fillRect(0, 0, canvas.width, canvas.height)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg'))
    if (!blob) throw new Error('Could not create the test photo')
    const writable = await handle.createWritable()
    await writable.write(blob)
    await writable.close()
    const file = await handle.getFile()
    await db.folders.put({
      id: 'dialog-check-folder', name: 'Sample photos', handle: folder, addedAt: 0, photoCount: 1,
    })
    await db.photos.put({
      id: 'dialog-check-photo', folderId: 'dialog-check-folder',
      filename: file.name, relPath: file.name, ext: 'jpg', isRaw: false,
      fileSize: file.size, modifiedAt: file.lastModified, addedAt: 0,
      width: 1800, height: 1200, meta: {}, rating: 0, flag: 'none', label: 'none',
      keywords: [], title: '', caption: '', edits: defaultEdits(), thumbKey: null, proxyKey: null,
    })
    const destination = await root.getDirectoryHandle('dialog-check-exports', { create: true })
    useExport.getState().setDestination(destination)
    useExport.getState().openDialog(['dialog-check-photo'])
  })
}

const browser = await launchBrowser('chromium')
const failures = []
try {
  for (const viewport of viewports) {
    const { name, width, height, touch } = viewport
    const phone = width < 768
    const context = await browser.newContext({
      viewport: { width, height }, hasTouch: touch, reducedMotion: 'reduce',
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const shot = async (scene) => {
      if (screenshots && (name === 'desktop' || name === 'phone'))
        await page.screenshot({ path: join(screenshots, `${scene}-${name}.png`), animations: 'disabled' })
    }
    try {
      await context.addInitScript((expectedOrigin) => {
        if (location.origin !== expectedOrigin || sessionStorage.getItem('dialog-check-seeded')) return
        localStorage.setItem('esque.ui', JSON.stringify({
          version: 0,
          state: {
            accent: 'purple', appearance: 'dim', surround: 'grey', textSize: 'large',
            thumbSize: 224, showGridExtras: false,
          },
        }))
        sessionStorage.setItem('dialog-check-seeded', 'true')
      }, origin.origin)
      await page.goto(origin.href, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => !!window.__esque)
      await page.getByRole('dialog', { name: 'esque', exact: true }).waitFor()
      assert.ok(await dismissWelcome(page))

      const previous = await preferences(page)
      assert.equal(previous.accentRetained, false)
      assert.equal('accent' in previous.stored, false)
      assert.equal(previous.appearance, 'dim')
      assert.equal(previous.surround, 'grey')
      assert.equal(previous.textSize, 'large')
      assert.equal(previous.thumbSize, 224)
      assert.equal(previous.showGridExtras, false)
      assert.equal(await page.locator('html').getAttribute('data-accent'), null)
      const strokes = await page.locator('svg.lucide').evaluateAll((icons) =>
        icons.map((icon) => Number(icon.getAttribute('stroke-width')) * Number(icon.getAttribute('width')) / 24),
      )
      assert.ok(strokes.length > 0)
      assert.ok(strokes.every((stroke) => Math.abs(stroke - 1.4) < 0.0001), 'Shared icons use the lighter stroke')

      await page.evaluate(() => window.dispatchEvent(new Event('esque:settings')))
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
      await settings.waitFor()
      assert.equal(await settings.getByText('Changes apply immediately.', { exact: true }).count(), 0)
      const tabs = settings.getByRole('tablist', { name: 'Settings sections' })
      assert.equal(await tabs.getAttribute('aria-orientation'), 'horizontal')
      assert.equal(await tabs.getByRole('tab').count(), 7)
      await settings.getByRole('tab', { name: 'Display', exact: true }).focus()
      await page.keyboard.press('ArrowRight')
      assert.equal(await settings.getByRole('tab', { name: 'Interface', exact: true }).getAttribute('aria-selected'), 'true')
      assert.equal(await settings.getByRole('radiogroup', { name: /Accent/ }).count(), 0)
      assert.equal(await settings.getByText('Accent', { exact: true }).count(), 0)
      await layout(settings, `${name} large text`)

      for (const appearance of ['light', 'dim', 'dark']) {
        await settings.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption(appearance)
        assert.equal(await page.locator('html').getAttribute('data-appearance'), appearance)
        const accent = await page.evaluate(() => {
          document.documentElement.dataset.accent = 'purple'
          const color = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()
          delete document.documentElement.dataset.accent
          return color
        })
        assert.equal(accent, '#0a84ff')
      }
      await settings.getByRole('combobox', { name: 'Text size', exact: true }).selectOption('default')
      await settings.getByRole('checkbox', { name: 'Show grid badges', exact: true }).click()
      assert.equal((await preferences(page)).showGridExtras, true)
      await shot('interface')

      for (const pane of ['Display', 'Files', 'Keyboard', 'Cache', 'About']) {
        await settings.getByRole('tab', { name: pane, exact: true }).click()
        await layout(settings, `${name} ${pane}`)
        if (pane === 'Display') {
          await settings.getByRole('combobox', { name: 'Backdrop', exact: true }).selectOption('match')
          for (const heading of ['Colour management', 'Previews', 'Clipping warnings'])
            assert.equal(await settings.getByRole('heading', { name: heading, exact: true }).count(), 1)
          await shot('settings')
        }
        if (pane === 'Files') {
          for (const button of ['Save backup…', 'Restore backup…', 'Reconnect originals…'])
            assert.equal(await settings.getByRole('button', { name: button, exact: true }).count(), 1)
          await settings.getByRole('checkbox', { name: 'Read sidecars on import', exact: true }).click()
          assert.equal((await preferences(page)).importSidecars, false)
          await shot('files')
        }
        if (pane === 'Keyboard') {
          await settings.getByRole('textbox', { name: 'Search shortcuts' }).fill('export')
          assert.ok(await settings.getByRole('button', { name: /Export.*Press to change/ }).count())
        }
        if (pane === 'Cache') {
          await settings.getByRole('combobox', { name: 'Cache size limit' }).selectOption('2147483648')
          assert.equal((await preferences(page)).stored.cacheLimit, 2147483648)
        }
      }
      await settings.getByRole('tab', { name: 'About', exact: true }).focus()
      await page.keyboard.press('Home')
      assert.equal(await settings.getByRole('tab', { name: 'Display', exact: true }).getAttribute('aria-selected'), 'true')
      await settings.getByRole('button', { name: 'Done', exact: true }).click()
      await settings.waitFor({ state: 'detached' })

      await seedPhoto(page)
      const exporter = page.getByRole('dialog', { name: 'Export', exact: true })
      await exporter.waitFor()
      await exporter.getByRole('button', { name: 'Export photo', exact: true }).waitFor()
      assert.ok(await exporter.getByRole('button', { name: 'Export photo', exact: true }).isEnabled())
      await shot('export')
      await layout(exporter, `${name} export`)
      assert.equal(await exporter.getByRole('heading', { name: 'File settings', exact: true }).count(), 1)
      assert.equal(await exporter.getByRole('combobox', { name: 'Export preset', exact: true }).count(), phone ? 1 : 0)

      for (const format of ['png', 'tiff', 'webp', 'dng', 'original', 'jpeg']) {
        await exporter.getByRole('combobox', { name: 'File format', exact: true }).selectOption(format)
        const rendered = format !== 'original' && format !== 'dng'
        assert.equal(await exporter.getByRole('combobox', { name: 'Resize', exact: true }).count(), rendered ? 1 : 0)
        assert.equal(await exporter.getByRole('combobox', { name: 'Bit depth', exact: true }).count(), ['png', 'tiff'].includes(format) ? 1 : 0)
        if (format === 'png')
          await exporter.getByRole('combobox', { name: 'Bit depth', exact: true }).selectOption('16')
        if (format === 'webp') {
          assert.equal((await exportState(page)).settings.bitDepth, 8)
          assert.equal((await exportState(page)).settings.colorSpace, 'srgb')
          assert.ok(await exporter.getByRole('combobox', { name: 'Colour space', exact: true }).isDisabled())
        }
        await layout(exporter, `${name} ${format}`)
      }
      for (const mode of ['longEdge', 'shortEdge', 'width', 'height', 'fit', 'megapixels', 'percent', 'none']) {
        await exporter.getByRole('combobox', { name: 'Resize', exact: true }).selectOption(mode)
        assert.equal((await exportState(page)).settings.resizeMode, mode)
        await layout(exporter, `${name} resize ${mode}`)
      }
      await exporter.getByRole('combobox', { name: 'Resize', exact: true }).selectOption('fit')
      await exporter.getByRole('textbox', { name: 'Width', exact: true }).fill('2400')
      await exporter.getByRole('textbox', { name: 'Width', exact: true }).press('Tab')
      assert.equal((await exportState(page)).settings.resizeWidth, 2400)
      await exporter.getByRole('combobox', { name: 'Sharpen for', exact: true }).selectOption('matte')
      await exporter.getByRole('combobox', { name: 'Sharpening amount', exact: true }).selectOption('high')
      await exporter.getByRole('switch', { name: 'Enable watermark', exact: true }).click()
      await exporter.getByRole('textbox', { name: 'Watermark text', exact: true }).fill('esque')
      await exporter.getByRole('combobox', { name: 'Watermark colour', exact: true }).selectOption('black')
      await exporter.getByRole('combobox', { name: 'Watermark position', exact: true }).selectOption('top-left')
      await layout(exporter, `${name} expanded watermark`)
      await shot('export-watermark')

      const presetName = 'Editorial export'
      await exporter.getByRole('button', { name: phone ? 'Save export preset' : 'Save preset…', exact: true }).click()
      await exporter.getByRole('textbox', { name: 'Preset name', exact: true }).fill(presetName)
      await exporter.getByRole('textbox', { name: 'Preset name', exact: true }).press('Enter')
      await exporter.getByRole('textbox', { name: 'Preset name', exact: true }).waitFor({ state: 'detached' })
      assert.equal((await exportState(page)).presets[0]?.name, presetName)
      await exporter.getByRole('combobox', { name: 'Colour space', exact: true }).selectOption('display-p3')
      assert.equal((await exportState(page)).activePreset, null)
      if (phone) await exporter.getByText('Manage saved presets', { exact: true }).click()
      await exporter.getByRole('button', { name: `Update ${presetName} with the current settings`, exact: true }).click()
      assert.equal((await exportState(page)).presets[0]?.settings.colorSpace, 'display-p3')
      await exporter.getByRole('button', { name: `Delete ${presetName}`, exact: true }).click()
      assert.equal((await exportState(page)).presets.length, 0)

      await exporter.getByRole('combobox', { name: 'Save to', exact: true }).selectOption('download')
      assert.equal(await exporter.getByRole('textbox', { name: 'Subfolder', exact: true }).count(), 0)
      assert.ok(await exporter.getByRole('button', { name: 'Export photo', exact: true }).isEnabled())
      await layout(exporter, `${name} browser download`)
      await exporter.getByRole('button', { name: 'Cancel', exact: true }).click()
      await exporter.waitFor({ state: 'detached' })
      assert.deepEqual(errors, [], `${name}: no browser errors`)
      console.log(`${name}: preferences, navigation, export formats/options, presets and icon weight passed`)
    } catch (error) {
      if (screenshots)
        await page.screenshot({ path: join(screenshots, `failure-${name}.png`), animations: 'disabled' })
      failures.push(`${name}: ${error.stack ?? error}`)
    } finally {
      await context.close()
    }
  }
} finally {
  await browser.close()
}
assert.deepEqual(failures, [], failures.join('\n\n'))
