/**
 * Throwaway. Verifies the widened band split against the whole-frame decode it
 * replaces, and times both.
 *
 * Bands are only allowed to exist because they are *identical* to the frame
 * they stand in for, so the pass condition is bit equality, not similarity.
 *
 *   node tools/headless.mjs '/checks/bandcheck.html' 900000
 */
import * as Comlink from 'comlink'
import { rawPool } from '../raw/pool'
import type { RawWorkerApi } from '../raw/rawWorker'

declare global {
  interface Window {
    __done?: boolean
    __result?: unknown
  }
}

const params = new URLSearchParams(location.search)
const fixture = params.get('fixture') ?? '/raw-fixtures/canon-5d2.cr2'

async function main() {
  const out: Record<string, unknown> = { cores: navigator.hardwareConcurrency, fixture }
  const file = await (await fetch(fixture)).arrayBuffer()

  const worker = new Worker(new URL('../raw/rawWorker.ts', import.meta.url), { type: 'module' })
  const api = Comlink.wrap<RawWorkerApi>(worker)
  const threads = await api.threadCapacity()
  out.threads = threads

  const meta = await api.readMeta(file.slice(0), true)
  const native = Math.max(meta?.width ?? 0, meta?.height ?? 0)
  out.native = native
  out.filters = meta?.filters
  out.xtrans = meta?.filters === 9

  for (const [label, quality, edge] of [
    ['interactive 2560', 'interactive', 2560],
    ['full native', 'full', native],
  ] as const) {
    // Whole frame, straight at the worker, so the pool's band path is bypassed.
    const w0 = performance.now()
    const whole = await api.decodeLinear(
      Comlink.transfer(file.slice(0), [] as Transferable[]),
      true,
      edge,
      0,
      meta?.rawCrop ?? null,
      quality,
      null,
      threads,
    )
    const wholeMs = Math.round(performance.now() - w0)

    const b0 = performance.now()
    const banded = await rawPool.decodeLinear(
      file.slice(0),
      true,
      edge,
      0,
      meta?.rawCrop ?? null,
      quality,
      'foreground',
    )
    const bandedMs = Math.round(performance.now() - b0)

    // Same worker, same arguments, twice: separates a band seam from plain
    // nondeterminism in the decode itself.
    const repeat = await api.decodeLinear(
      Comlink.transfer(file.slice(0), [] as Transferable[]),
      true,
      edge,
      0,
      meta?.rawCrop ?? null,
      quality,
      null,
      threads,
    )
    let selfDiffer = 0
    if (whole && repeat) {
      for (let i = 0; i < whole.data.length; i++) {
        if (whole.data[i] !== repeat.data[i]) selfDiffer++
      }
    }

    let maxDelta = -1
    let differing = 0
    const where: string[] = []
    if (whole && banded && whole.data.length === banded.data.length) {
      maxDelta = 0
      for (let i = 0; i < whole.data.length; i++) {
        const d = Math.abs(whole.data[i] - banded.data[i])
        if (d !== 0) {
          differing++
          if (where.length < 12) {
            const px = Math.floor(i / 4)
            where.push(`${px % (banded?.width ?? 1)},${Math.floor(px / (banded?.width ?? 1))}`)
          }
          if (d > maxDelta) maxDelta = d
        }
      }
    }
    out[label] = {
      wholeMs,
      bandedMs,
      speedup: Math.round((wholeMs / bandedMs) * 100) / 100,
      size: `${banded?.width}x${banded?.height}`,
      selfDiffer,
      where,
      bandBoundaries: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) =>
        Math.floor((i * (banded?.height ?? 0)) / 12),
      ),
      exact: maxDelta === 0,
      differing,
      maxDelta,
    }
  }

  worker.terminate()
  window.__result = out
  console.log(JSON.stringify(out, null, 2))
  window.__done = true
}

main().catch((err) => {
  window.__result = `FAILED: ${err?.message ?? err}`
  window.__done = true
})
