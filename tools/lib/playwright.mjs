import { existsSync } from 'node:fs'
import { chromium, firefox, webkit } from 'playwright'

export const browserNames = () => (process.env.ESQUE_BROWSERS || 'chromium,firefox,webkit').split(',')

export function launchBrowser(name) {
  const engine = { chromium, firefox, webkit }[name]
  if (!engine) throw new Error(`Unknown browser: ${name}`)
  const installed = process.env.ESQUE_CHROMIUM_PATH || [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync)
  return engine.launch({
    // Headless Firefox on macOS advertises WebGPU but has no GPU adapter.
    headless: !(name === 'firefox' && process.platform === 'darwin') && process.env.ESQUE_HEADED !== '1',
    ...(name === 'chromium' && installed ? { executablePath: installed } : {}),
  })
}
