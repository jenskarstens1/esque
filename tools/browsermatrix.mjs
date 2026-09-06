import { browserNames, launchBrowser } from './lib/playwright.mjs'

const origin = process.env.ESQUE_ORIGIN || 'http://127.0.0.1:5179'
const checks = process.argv.slice(2)
if (!checks.length) throw new Error('Pass check names, for example: node tools/browsermatrix.mjs downloadcheck compositecheck')
let failed = false

for (const name of browserNames()) {
  let browser
  try {
    browser = await launchBrowser(name)
    for (const check of checks) {
      const context = await browser.newContext()
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      try {
        const path = check.includes('/') ? check : `/checks/${check}.html`
        const response = await page.goto(new URL(path, origin).href, { waitUntil: 'domcontentloaded' })
        if (!response?.ok()) throw new Error(`HTTP ${response?.status()}`)
        await page.waitForFunction(() => window.__done === true, undefined, { timeout: 180000 })
        const result = await page.evaluate(() => window.__result)
        if (!result || result.error || result.ok === false || result.pass === false ||
          result.failures?.length || errors.length) {
          throw new Error(JSON.stringify({ result, errors }))
        }
        console.log(JSON.stringify({ browser: name, version: browser.version(), check, result }))
      } catch (error) {
        failed = true
        console.error(JSON.stringify({ browser: name, check, error: error.message, errors }))
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser?.close()
  }
}
if (failed) process.exitCode = 1
