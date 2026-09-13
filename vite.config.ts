import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// LibRaw is compiled with OpenMP, so its demosaic threads need SharedArrayBuffer,
// which the browser only hands out to cross-origin-isolated documents. Static
// hosts need the same two headers; see vercel.json (Vercel) and public/_headers
// (Cloudflare Pages, Netlify).
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// Vite's transform 304 responses bypass server.headers. WebKit requires the
// isolation policy on revalidated worker modules as well as their first load.
function isolationHeaders(_req: IncomingMessage, res: ServerResponse, next: () => void) {
  for (const [name, value] of Object.entries(crossOriginIsolation)) res.setHeader(name, value)
  next()
}

const isolation: Plugin = {
  name: 'worker-isolation-headers',
  configureServer(server) { server.middlewares.use(isolationHeaders) },
  configurePreviewServer(server) { server.middlewares.use(isolationHeaders) },
}

export default defineConfig({
  plugins: [isolation, react(), tailwindcss()],
  worker: { format: 'es' },
  // libraw-wasm and @jsquash/jpeg both resolve their wasm via
  // `new URL('...', import.meta.url)`. Pre-bundling rewrites those URLs and
  // breaks the lookup, so they have to stay external.
  optimizeDeps: { exclude: ['libraw-wasm', '@jsquash/jpeg'] },
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  build: {
    target: 'esnext',
  },
})
