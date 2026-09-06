import * as Comlink from 'comlink'
import type { RawWorkerApi } from './rawWorker'
import type {
  DecodedMeta,
  IngestResult,
  LinearImage,
  RawCrop,
  RawDecodeQuality,
  RawFailure,
} from './decoded'
import { applyOrientationHalf } from './orientation'
import {
  XTRANS_FILTERS,
  bandRanges,
  canBandDecode,
  hasThreadedDemosaic,
  type BandResult,
} from './bands'

/**
 * Pool of RAW decode workers.
 *
 * Each worker owns its own libraw-wasm instance (and therefore its own nested
 * decode worker + wasm heap), so the pool is sized conservatively: RAW decoding
 * is memory-hungry and four concurrent 45 MP decodes already saturate most
 * machines.
 */

interface Slot {
  worker: Worker
  api: Comlink.Remote<RawWorkerApi>
  busy: boolean
}

export type RawPriority = 'foreground' | 'normal' | 'background'

const PRIORITY: Record<RawPriority, number> = {
  foreground: 2,
  normal: 1,
  background: 0,
}

const cores = navigator.hardwareConcurrency ?? 4
const memory =
  'deviceMemory' in navigator && typeof navigator.deviceMemory === 'number'
    ? navigator.deviceMemory
    : null
const coreLimit = Math.max(1, Math.floor(cores / 2))
const memoryLimit = memory ? Math.max(1, Math.floor(memory / 2)) : 4
const SIZE = Math.min(4, coreLimit, memoryLimit)

/**
 * How many decodes can be in flight at once. Exported so callers that hold a
 * whole file in memory per job — import, mainly — can size their own queues to
 * match instead of piling up buffers behind a busy pool.
 */
export const RAW_POOL_SIZE = SIZE

/**
 * How wide a band decode may burst past {@link SIZE}.
 *
 * {@link SIZE} budgets for whole-frame decodes, where every concurrent job
 * holds a full-resolution demosaic — for the Bayer full tier that is LibRaw's
 * `image` buffer plus DCB's two float scratch planes, around 32 bytes per
 * output pixel. A band holds `1/N` of exactly that, so N bands cost about what
 * one whole-frame decode costs no matter how large N is. What does scale with N
 * is the part every band repeats: the file itself and the unpacked CFA, a few
 * bytes per sensor pixel.
 *
 * Bursting is what makes the unthreaded tiers use the whole machine. DCB and
 * VNG carry no `#pragma omp`, so bands are their only parallelism, and at
 * {@link SIZE} they leave two thirds of a typical laptop idle.
 */
const BAND_LIMIT = Math.max(SIZE, Math.min(12, cores, memory ? memory * 2 : 8))

/**
 * OpenMP team size one decoder can form on this machine, resolved once.
 *
 * The vendored libraw-wasm is compiled with `-fopenmp`, so LibRaw's AHD and
 * Markesteijn demosaics run across a pthread team — but wasm threads need
 * SharedArrayBuffer, which the browser only grants a cross-origin-isolated
 * document. Both conditions are checked before the worker is even asked, so a
 * page served without COOP/COEP degrades to the banded path instead of paying
 * for a probe that can only answer 1.
 */
let capability: Promise<number> | null = null

function threadCapability(): Promise<number> {
  capability ??= (async () => {
    if (typeof SharedArrayBuffer === 'undefined') return 1
    if (!globalThis.crossOriginIsolated) return 1
    try {
      const n = await run((api) => api.threadCapacity(), 'foreground')
      return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 16) : 1
    } catch {
      return 1
    }
  })()
  return capability
}

let slots: Slot[] | null = null
/** Slots currently running work. Tracked apart from the pool's length because a
 * band burst grows the pool past what a whole-frame decode is allowed to use. */
let busy = 0

function pool(): Slot[] {
  if (!slots) slots = []
  return slots
}

function createSlot(): Slot {
  const worker = new Worker(new URL('./rawWorker.ts', import.meta.url), { type: 'module' })
  return { worker, api: Comlink.wrap<RawWorkerApi>(worker), busy: false }
}

interface Waiter {
  priority: number
  order: number
  limit: number
  signal?: AbortSignal
  onAbort?: () => void
  resolve: (slot: Slot) => void
  reject: (reason: unknown) => void
}

const waiting: Waiter[] = []
let nextOrder = 0

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('RAW decode cancelled', 'AbortError')
}

/** Cancellation must reach the caller; every other failure has a fallback. */
const isAbort = (err: unknown, signal?: AbortSignal) =>
  signal?.aborted === true || (err instanceof DOMException && err.name === 'AbortError')

function acquire(priority: RawPriority, signal?: AbortSignal, limit = SIZE): Promise<Slot> {
  if (signal?.aborted) return Promise.reject(abortReason(signal))

  const current = pool()
  if (busy < limit) {
    const available = current.find((slot) => !slot.busy)
    const slot = available ?? createSlot()
    if (!available) current.push(slot)
    slot.busy = true
    busy++
    return Promise.resolve(slot)
  }

  return new Promise<Slot>((resolve, reject) => {
    const waiter: Waiter = {
      priority: PRIORITY[priority],
      order: nextOrder++,
      limit,
      signal,
      resolve,
      reject,
    }
    if (signal) {
      waiter.onAbort = () => {
        const index = waiting.indexOf(waiter)
        if (index !== -1) waiting.splice(index, 1)
        reject(abortReason(signal))
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
    }
    waiting.push(waiter)
    waiting.sort((a, b) => b.priority - a.priority || a.order - b.order)
  })
}

/**
 * Hands a freed slot to the next waiter that is allowed to run in it.
 *
 * Waiters carry their own concurrency limit, so a band burst leaves the pool
 * holding more slots than a whole-frame decode may use at once. Skipping past a
 * waiter whose limit is already met is what keeps that extra width from leaking
 * into work that was budgeted for {@link SIZE}.
 */
function handOff(slot: Slot): boolean {
  const index = waiting.findIndex((waiter) => busy < waiter.limit)
  if (index === -1) return false
  const [waiter] = waiting.splice(index, 1)
  if (waiter.signal && waiter.onAbort) {
    waiter.signal.removeEventListener('abort', waiter.onAbort)
  }
  busy++
  // Claimed on the slot itself, not just in the counter: `destroy` hands off a
  // freshly created replacement, which starts idle, and an unclaimed idle slot
  // is exactly what `acquire` scans for. Without this the same worker could be
  // handed to a waiter and to the next caller at once.
  slot.busy = true
  waiter.resolve(slot)
  return true
}

function release(slot: Slot) {
  if (!slots?.includes(slot)) return
  busy--
  if (handOff(slot)) return
  slot.busy = false
}

function destroy(slot: Slot) {
  const current = slots
  if (!current) return
  const index = current.indexOf(slot)
  if (index === -1) return
  current.splice(index, 1)
  slot.worker.terminate()
  // `release` refuses a slot the pool no longer owns, so the seat this decode
  // occupied has to be given up here instead.
  busy--

  // A terminated worker cannot be reused, but the seat it freed can be.
  const replacement = createSlot()
  current.push(replacement)
  if (!handOff(replacement)) replacement.busy = false
}

async function run<T>(
  fn: (api: Comlink.Remote<RawWorkerApi>) => Promise<T>,
  priority: RawPriority = 'normal',
  signal?: AbortSignal,
  limit?: number,
): Promise<T> {
  const slot = await acquire(priority, signal, limit)
  try {
    if (!signal) return await fn(slot.api)
    if (signal.aborted) {
      destroy(slot)
      throw abortReason(signal)
    }

    const operation = fn(slot.api)
    return await new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (cb: () => void) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        cb()
      }
      const onAbort = () =>
        finish(() => {
          // LibRaw itself is not cancellable. Terminating this slot is the only
          // way to stop a large decode from consuming CPU after its import was
          // cancelled; the next waiter receives a fresh worker immediately.
          destroy(slot)
          reject(abortReason(signal))
        })

      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
      operation.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      )
    })
  } finally {
    release(slot)
  }
}

const transfer = (buffer: ArrayBuffer) => Comlink.transfer(buffer, [buffer])

const REASONS: Record<RawFailure, string> = {
  unsupported: "This camera's RAW format isn't supported yet",
  corrupt: 'The file appears to be damaged or incomplete',
  'out-of-memory': 'Ran out of memory decoding this file',
  'no-pixels': 'No image data could be read from this file',
  unknown: "This file couldn't be read",
}

/**
 * Recovers the failure kind from an error that crossed the worker boundary.
 * Comlink rebuilds thrown errors as plain `Error`s, so the kind is read back
 * out of the name that {@link RawError} encoded it into.
 */
export function rawFailure(err: unknown): { kind: RawFailure; reason: string; detail: string } {
  const name = err instanceof Error ? err.name : ''
  const kind = (name.startsWith('RawError:') ? name.slice(9) : 'unknown') as RawFailure
  const safe = kind in REASONS ? kind : 'unknown'
  return {
    kind: safe,
    reason: REASONS[safe],
    detail: err instanceof Error ? err.message : String(err ?? ''),
  }
}

/** The same wording as {@link rawFailure}, for a kind that never was an Error. */
export const failureReason = (kind: RawFailure): string => REASONS[kind] ?? REASONS.unknown

/**
 * Runs a demosaic as parallel horizontal bands across the pool.
 *
 * Returns `null` when the frame is not worth splitting or the split cannot be
 * proven exact, in which case the caller falls back to the whole-frame decode.
 *
 * Orchestration lives here rather than inside a worker on purpose: a worker
 * that called back into the pool would hold a slot while waiting for slots, and
 * deadlock. This function holds none — it issues N independent {@link run}
 * calls and lets the pool schedule them.
 */
async function decodeLinearBands(
  buffer: ArrayBuffer,
  meta: DecodedMeta,
  rawCrop: RawCrop | null,
  maxEdge: number,
  iso: number,
  quality: RawDecodeQuality,
  priority: RawPriority,
  threads: number,
  signal?: AbortSignal,
): Promise<LinearImage | null> {
  if (SIZE < 2) return null

  const xtrans = meta.filters === XTRANS_FILTERS
  if (!canBandDecode(xtrans, quality)) return null

  // The band grid is defined on LibRaw's unrotated frame, which is the space
  // `cropbox` and every row index it returns live in.
  const srcWidth = rawCrop ? rawCrop[2] : meta.frameWidth
  const srcHeight = rawCrop ? rawCrop[3] : meta.frameHeight
  if (!(srcWidth > 0) || !(srcHeight > 0)) return null

  const scale = Math.min(1, maxEdge / Math.max(srcWidth, srcHeight))
  const dstWidth = Math.max(1, Math.round(srcWidth * scale))
  const dstHeight = Math.max(1, Math.round(srcHeight * scale))

  // A tier whose demosaic is already threaded is split only {@link SIZE} ways,
  // because bands and OpenMP compose: bands additionally split the unpack, the
  // copy out of the wasm heap, and the reduction, and past that point the two
  // just compete for the same cores. A tier with no pragmas has nothing else,
  // so it is cut as fine as the machine and the row floor allow.
  const width = hasThreadedDemosaic(xtrans, quality) ? SIZE : BAND_LIMIT
  const ranges = bandRanges(dstHeight, width)
  if (ranges.length < 2) return null

  // Bands run concurrently, so the machine is divided between them. The
  // demosaic itself is single-threaded on this path by definition, but the
  // unpack stage is not — CR3, RAF, and Panasonic 8 all parallelise there.
  const perBand = Math.max(1, Math.floor(threads / ranges.length))

  const bands = await Promise.all(
    ranges.map(([yFrom, yTo]) =>
      run<BandResult>(
        (api) =>
          api.decodeLinearBand(transfer(buffer.slice(0)), {
            iso,
            quality,
            xtrans,
            rawCrop,
            srcWidth,
            srcHeight,
            dstWidth,
            dstHeight,
            yFrom,
            yTo,
            threads: perBand,
          }),
        priority,
        signal,
        ranges.length,
      ),
    ),
  )

  // Each band ran its own scale_colors(), so each built its own half-float LUT.
  // Identical multipliers are what makes the bands share one tone scale; a
  // mismatch would read as banding, so hand the frame back to the whole-frame
  // path rather than assemble something subtly wrong.
  const whiteLevel = bands[0].whiteLevel
  if (!bands.every((band) => Math.abs(band.whiteLevel - whiteLevel) <= whiteLevel * 1e-4)) {
    return null
  }

  const data = new Uint16Array(dstWidth * dstHeight * 4)
  for (const band of bands) {
    if (band.data.length !== dstWidth * band.rows * 4) return null
    data.set(band.data, band.yFrom * dstWidth * 4)
  }

  // One rotation, at the end. Rotating each band would have transposed them
  // independently; letting LibRaw apply `S.flip` per band would have done the
  // same thing one level lower.
  const oriented = applyOrientationHalf(data, dstWidth, dstHeight, meta.flip)
  const fullWidth = meta.width
  const fullHeight = meta.height
  return {
    width: oriented.width,
    height: oriented.height,
    data: oriented.data,
    scale: oriented.width / fullWidth,
    fullWidth,
    fullHeight,
    fromRaw: true,
    meta: {
      ...meta,
      camMul: bands[0].camMul,
      preMul: bands[0].preMul,
      black: bands[0].black,
      maximum: bands[0].maximum,
    },
    whiteLevel,
  }
}

export const rawPool = {
  /**
   * Metadata and thumbnail in one pass. Import uses this rather than calling
   * {@link rawPool.readMeta} and {@link rawPool.makeThumb} back to back, which
   * needed two copies of the file and two full LibRaw opens per photo.
   */
  ingest: (
    buffer: ArrayBuffer,
    isRaw: boolean,
    maxEdge?: number,
    signal?: AbortSignal,
  ): Promise<IngestResult> =>
    run((api) => api.ingest(transfer(buffer), isRaw, maxEdge), 'background', signal),

  /** Throws a {@link RawError}-shaped error; read it with {@link rawFailure}. */
  readMeta: (buffer: ArrayBuffer, isRaw: boolean): Promise<DecodedMeta | null> =>
    run((api) => api.readMeta(transfer(buffer), isRaw)),

  makeThumb: (buffer: ArrayBuffer, isRaw: boolean, maxEdge?: number): Promise<Blob | null> =>
    run((api) => api.makeThumb(transfer(buffer), isRaw, maxEdge), 'background'),

  /**
   * The camera's embedded JPEG as a linear working image — the instant tier.
   * Roughly 150 ms against seconds for a demosaic, so Develop has something
   * real and editable on screen while {@link rawPool.decodeLinear} runs.
   */
  decodeEmbedded: (
    buffer: ArrayBuffer,
    isRaw: boolean,
    maxEdge?: number,
    signal?: AbortSignal,
  ): Promise<LinearImage | null> =>
    run((api) => api.decodeEmbedded(transfer(buffer), isRaw, maxEdge), 'foreground', signal),

  makePreview: (
    buffer: ArrayBuffer,
    isRaw: boolean,
    maxEdge?: number,
    halfSize?: boolean,
    iso?: number,
    rawCrop?: RawCrop | null,
    preferEmbedded?: boolean,
    priority: RawPriority = 'normal',
    signal?: AbortSignal,
  ): Promise<Blob | null> =>
    run(
      (api) =>
        api.makePreview(
          transfer(buffer),
          isRaw,
          maxEdge,
          halfSize,
          iso,
          rawCrop,
          preferEmbedded,
        ),
      priority,
      signal,
    ),

  decodeLinear: async (
    buffer: ArrayBuffer,
    isRaw: boolean,
    maxEdge?: number,
    iso?: number,
    rawCrop?: RawCrop | null,
    quality: RawDecodeQuality = 'full',
    priority: RawPriority = 'foreground',
    signal?: AbortSignal,
  ): Promise<LinearImage | null> => {
    if (!isRaw) {
      return run((api) => api.decodeLinear(transfer(buffer), false, maxEdge), priority, signal)
    }

    // One header read, shared by the band planner and — when the split is
    // declined — by the whole-frame decode, which would otherwise open the file
    // a second time just to learn its CFA layout.
    const [header, threads] = await Promise.all([
      run((api) => api.readMeta(transfer(buffer.slice(0)), true), priority, signal).catch(
        (err: unknown) => {
          if (isAbort(err, signal)) throw err
          return null
        },
      ),
      threadCapability(),
    ])

    const crop = rawCrop === undefined ? (header?.rawCrop ?? null) : rawCrop

    // Two ways to spend the machine on one frame, and they compose. Bands split
    // everything — unpack, demosaic, the 180 MB copy out of the wasm heap, and
    // the box filter down to proxy size — at the cost of repeating the unpack
    // per band. Threads split only what LibRaw annotated, but for free. The
    // one place they do not compose is three-pass Markesteijn, whose bands are
    // never exact; there `canBandDecode` declines and threading carries it.
    if (header) {
      const tiled = await decodeLinearBands(
        buffer,
        header,
        crop,
        maxEdge ?? 2560,
        iso ?? 0,
        quality,
        priority,
        threads,
        signal,
      ).catch((err: unknown) => {
        if (isAbort(err, signal)) throw err
        return null
      })
      if (tiled) return tiled
    }

    return run(
      (api) =>
        api.decodeLinear(transfer(buffer), true, maxEdge, iso, crop, quality, header, threads),
      priority,
      signal,
    )
  },

  dispose() {
    const error = new Error('RAW decoder pool disposed')
    for (const waiter of waiting.splice(0)) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort)
      }
      waiter.reject(error)
    }
    slots?.forEach((s) => s.worker.terminate())
    slots = null
  },
}

export type { DecodedMeta, IngestResult, LinearImage, RawCrop, RawFailure }
