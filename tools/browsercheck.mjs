/**
 * Check driver for pages that need a *real* browser.
 *
 * `tools/headless.mjs` drives Chromium through puppeteer, which cannot run
 * WebGPU: headless Edge reports `navigator.gpu` undefined under every flag
 * combination tried, including `--enable-unsafe-webgpu`, a swiftshader adapter
 * and headed mode. So WebGPU checks are opened in the browser the user
 * actually has, and the page posts its result back here.
 *
 *   node tools/browsercheck.mjs /checks/comparecheck.html [safari|edge|chrome] [timeoutMs]
 *
 * Requires the vite dev server; it is started if nothing answers on 5173.
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

const PORT = 8951
const page = process.argv[2] ?? '/checks/comparecheck.html'
const which = (process.argv[3] ?? 'edge').toLowerCase()
const timeout = Number(process.argv[4] ?? 300_000)

const APPS = {
  edge: 'Microsoft Edge',
  safari: 'Safari',
  chrome: 'Google Chrome',
}
const app = APPS[which]
if (!app) {
  console.error(`Unknown browser "${which}". Use one of: ${Object.keys(APPS).join(', ')}`)
  process.exit(1)
}

async function devServerUp() {
  try {
    const r = await fetch('http://localhost:5173/', { method: 'HEAD' })
    return r.ok || r.status === 404
  } catch {
    return false
  }
}

let vite = null
if (!(await devServerUp())) {
  console.log('starting vite...')
  vite = spawn('npx', ['vite', '--port', '5173', '--strictPort'], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: 'ignore',
    detached: false,
  })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && !(await devServerUp())) {
    await new Promise((r) => setTimeout(r, 400))
  }
  if (!(await devServerUp())) {
    console.error('vite did not come up on 5173')
    process.exit(1)
  }
}

let settle
const done = new Promise((resolve) => {
  settle = resolve
})

const collector = createServer((req, res) => {
  // The dev server sets COEP; without these the cross-origin POST is blocked.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(200).end('ok')
    return
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    res.writeHead(200).end('ok')
    try {
      settle(JSON.parse(body))
    } catch (e) {
      settle({ error: `bad payload: ${e.message}`, body: body.slice(0, 2000) })
    }
  })
})
collector.listen(PORT)

const url = `http://localhost:5173${page}?report=${encodeURIComponent(`http://localhost:${PORT}/r`)}`
console.log(`opening ${app}: ${url}`)
// -g keeps the window from stealing focus.
spawn('open', ['-g', '-a', app, url], { stdio: 'ignore' })

const timer = setTimeout(() => settle({ error: `timed out after ${timeout}ms` }), timeout)

const result = await done
clearTimeout(timer)
collector.close()
if (vite) vite.kill()

console.log(JSON.stringify(result, null, 2))
process.exit(result && result.ok ? 0 : 1)
