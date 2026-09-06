/**
 * Headless smoke driver. Loads a URL in the system Chromium browser via
 * puppeteer-core (so nothing extra is downloaded), waits for `window.__done`,
 * prints `window.__result` and writes a screenshot.
 *
 *   node tools/headless.mjs [path-or-url] [timeoutMs]
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

const path = process.argv[2] ?? '/'
const timeout = Number(process.argv[3] ?? 180_000)
const origin = process.env.ESQUE_ORIGIN ?? 'http://localhost:5173'
const url = new URL(path, origin).href
const screenshot = process.env.ESQUE_SCREENSHOT ?? '/tmp/esque-headless.png'

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--enable-features=Vulkan',
    '--disable-dev-shm-usage',
    '--js-flags=--max-old-space-size=4096',
  ],
})

let passed = false
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
  const errors = []
  page.on('console', (m) => console.log(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (error) => {
    errors.push(error.message)
    console.log(`[pageerror] ${error.message}`)
  })
  page.on('requestfailed', (r) => console.log(`[reqfail] ${r.url()} ${r.failure()?.errorText}`))

  console.log(`→ ${url}`)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction('window.__done === true', { timeout, polling: 500 })
  const result = await page.evaluate(() => window.__result ?? null)
  console.log('\n=== RESULT ===')
  console.log(JSON.stringify(result, null, 2))
  passed = !!result && !result.error && result.pass !== false && result.ok !== false &&
    (!Array.isArray(result.failures) || result.failures.length === 0) && errors.length === 0
  await page.screenshot({ path: screenshot, fullPage: false })
  console.log(`\nscreenshot → ${screenshot}`)
} catch (error) {
  passed = false
  console.error(error)
} finally {
  await browser.close()
}
process.exit(passed ? 0 : 1)
