import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// LibRaw is compiled with OpenMP, so its demosaic threads need SharedArrayBuffer,
// which the browser only hands out to cross-origin-isolated documents. Static
// hosts need the same two headers; see public/_headers.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
