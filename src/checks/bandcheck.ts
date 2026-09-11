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

interface CheckContext {
  api: Comlink.Remote<RawWorkerApi>
  file: ArrayBuffer
  meta: Awaited<ReturnType<RawWorkerApi['readMeta']>>
  threads: number
}

function countDifferences(
  whole: Awaited<ReturnType<RawWorkerApi['decodeLinear']>>,
  banded: Awaited<ReturnType<typeof rawPool.decodeLinear>>,
) {
  let maxDelta = -1
  let differing = 0
  const where: string[] = []
  if (whole && banded && whole.data.length === banded.data.length) {
    maxDelta = 0
    for (let i = 0; i < whole.data.length; i++) {
      const delta = Math.abs(whole.data[i] - banded.data[i])
      if (delta === 0) continue
      differing++
      if (where.length < 12) {
        const pixel = Math.floor(i / 4)
        where.push(`${pixel % banded.width},${Math.floor(pixel / banded.width)}`)
      }
      if (delta > maxDelta) maxDelta = delta
    }
  }
  return { maxDelta, differing, where }
}

async function checkQuality(
  context: CheckContext,
  label: string,
  quality: 'interactive' | 'full',
  edge: number,
) {
  const { api, file, meta, threads } = context
  const wholeStarted = performance.now()
  const whole = await api.decodeLinear(
    Comlink.transfer(file.slice(0), [] as Transferable[]),
    true, edge, 0, meta?.rawCrop ?? null, quality, null, threads,
  )
  const wholeMs = Math.round(performance.now() - wholeStarted)

  const bandedStarted = performance.now()
  const banded = await rawPool.decodeLinear(
    file.slice(0), true, edge, 0, meta?.rawCrop ?? null, quality, 'foreground',
  )
  const bandedMs = Math.round(performance.now() - bandedStarted)

  const repeat = await api.decodeLinear(
    Comlink.transfer(file.slice(0), [] as Transferable[]),
    true, edge, 0, meta?.rawCrop ?? null, quality, null, threads,
  )
  let selfDiffer = 0
  if (whole && repeat) {
    for (let i = 0; i < whole.data.length; i++) {
      if (whole.data[i] !== repeat.data[i]) selfDiffer++
    }
  }
  const differences = countDifferences(whole, banded)
  return {
    label,
    result: {
      wholeMs,
      bandedMs,
      speedup: Math.round((wholeMs / bandedMs) * 100) / 100,
      size: `${banded?.width}x${banded?.height}`,
      selfDiffer,
      where: differences.where,
      bandBoundaries: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) =>
        Math.floor((i * (banded?.height ?? 0)) / 12),
      ),
      exact: differences.maxDelta === 0,
      differing: differences.differing,
      maxDelta: differences.maxDelta,
    },
  }
}

async function main() {
  const out: Record<string, unknown> = { cores: navigator.hardwareConcurrency, fixture }
  const file = await (await fetch(fixture)).arrayBuffer()
  const worker = new Worker(new URL('../raw/rawWorker.ts', import.meta.url), { type: 'module' })
  const api = Comlink.wrap<RawWorkerApi>(worker)
  const threads = await api.threadCapacity()
  const meta = await api.readMeta(file.slice(0), true)
  const native = Math.max(meta?.width ?? 0, meta?.height ?? 0)
  const context = { api, file, meta, threads }
  out.threads = threads
  out.native = native
  out.filters = meta?.filters
  out.xtrans = meta?.filters === 9

  for (const [label, quality, edge] of [
    ['interactive 2560', 'interactive', 2560],
    ['full native', 'full', native],
  ] as const) {
    const checked = await checkQuality(context, label, quality, edge)
    out[checked.label] = checked.result
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
