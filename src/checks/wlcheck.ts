/**
 * Throwaway. Checks whether widening the split makes bands disagree about the
 * RAW white ceiling, which is what the assembler's tolerance would let through
 * as a one-ULP difference.
 */
import * as Comlink from 'comlink'
import type { RawWorkerApi } from '../raw/rawWorker'

declare global {
  interface Window {
    __done?: boolean
    __result?: unknown
  }
}

const params = new URLSearchParams(location.search)
const fixture = params.get('fixture') ?? '/raw-fixtures/nikon-d800.nef'

async function main() {
  const file = await (await fetch(fixture)).arrayBuffer()
  const workers: Worker[] = []
  const apis: Comlink.Remote<RawWorkerApi>[] = []
  for (let i = 0; i < 12; i++) {
    const w = new Worker(new URL('../raw/rawWorker.ts', import.meta.url), { type: 'module' })
    workers.push(w)
    apis.push(Comlink.wrap<RawWorkerApi>(w))
  }
  const meta = await apis[0].readMeta(file.slice(0), true)
  if (!meta) throw new Error('no meta')
  const srcWidth = meta.rawCrop ? meta.rawCrop[2] : meta.frameWidth
  const srcHeight = meta.rawCrop ? meta.rawCrop[3] : meta.frameHeight

  const out: Record<string, unknown> = { fixture, frame: `${srcWidth}x${srcHeight}` }

  for (const count of [4, 12]) {
    const levels = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        apis[i]
          .decodeLinearBand(Comlink.transfer(file.slice(0), [] as Transferable[]), {
            iso: 0,
            quality: 'full',
            xtrans: false,
            rawCrop: meta.rawCrop ?? null,
            srcWidth,
            srcHeight,
            dstWidth: srcWidth,
            dstHeight: srcHeight,
            yFrom: Math.floor((i * srcHeight) / count),
            yTo: Math.floor(((i + 1) * srcHeight) / count),
            threads: 1,
          })
          .then((b) => b.whiteLevel),
      ),
    )
    out[`bands ${count}`] = { levels, distinct: [...new Set(levels)] }
  }

  for (const w of workers) w.terminate()
  window.__result = out
  console.log(JSON.stringify(out, null, 2))
  window.__done = true
}

main().catch((err) => {
  window.__result = `FAILED: ${err?.message ?? err}`
  window.__done = true
})
