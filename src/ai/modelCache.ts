/**
 * Fetching and keeping model weights.
 *
 * The first subject mask on a machine costs a download; every one after it
 * costs an OPFS read. That asymmetry is the whole design: the fetch is
 * streamed so the UI can show real progress against a known total, the result
 * is written next to the proxies under a pinned prefix the evictor leaves
 * alone, and a second caller arriving mid-download joins the first rather than
 * starting its own.
 *
 * Two sources, in order. A deployment that ran `tools/fetch-models.sh` has the
 * weights in `public/models`, so the fetch is same-origin and esque never talks
 * to anyone else — which is the point of a local-first editor and the only
 * version of "runs locally" worth claiming. Without that the upstream release
 * is used, once, and then it is on disk like the vendored copy would have been.
 */
import { cacheDelete, cacheRead, cacheWrite, modelKey } from '../catalog/opfs'
import type { SegmentModel } from './models'

export interface DownloadProgress {
  loaded: number
  /** The model's advertised size when the response has no length header. */
  total: number
}

export class ModelFetchError extends Error {}

const inflight = new Map<string, Promise<ArrayBuffer>>()

/** True when the weights are already on disk, so no download is implied. */
export async function isModelCached(model: SegmentModel): Promise<boolean> {
  const file = await cacheRead(modelKey(model.id))
  return !!file && file.size > 0
}

/**
 * Whether any weights are on disk — a stand-in for "has detection ever run".
 *
 * Used only to decide whether to quote the runtime download. There is no way to
 * ask whether a given URL is in the HTTP cache, but a model on disk means the
 * runtime was fetched at least once, and it is far stickier than a cache entry
 * the browser may have dropped. Being wrong here overstates a wait rather than
 * hiding one, which is the right direction to err.
 */
export async function anyModelCached(models: SegmentModel[]): Promise<boolean> {
  const hits = await Promise.all(models.map(isModelCached))
  return hits.some(Boolean)
}

export async function forgetModel(model: SegmentModel): Promise<void> {
  inflight.delete(model.id)
  await cacheDelete(modelKey(model.id))
}

/**
 * Streams a response into one buffer, reporting progress as it goes.
 *
 * `Content-Length` is missing often enough — any compressed or chunked
 * transfer — that the registry's own byte count is used as the denominator
 * when it is. The number only drives a progress bar, so an estimate that is
 * close beats a bar that sits at zero and then jumps to done.
 */
async function drain(
  response: Response,
  fallbackTotal: number,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const header = Number(response.headers.get('content-length') ?? 0)
  const total = header > 0 ? header : fallbackTotal
  const body = response.body

  if (!body) return response.arrayBuffer()

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  try {
    for (;;) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      loaded += value.byteLength
      onProgress?.({ loaded, total: Math.max(total, loaded) })
    }
  } finally {
    reader.releaseLock()
  }

  const out = new Uint8Array(loaded)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out.buffer
}

async function download(
  model: SegmentModel,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const sources = [model.local, model.remote]
  let lastError: unknown = null

  for (const url of sources) {
    try {
      signal?.throwIfAborted()
      const response = await fetch(url, { signal, mode: 'cors' })
      // A dev server that rewrites unknown paths to index.html answers 200 with
      // markup, so the status alone does not prove the weights are there.
      const type = response.headers.get('content-type') ?? ''
      if (!response.ok || type.includes('text/html')) {
        lastError = new ModelFetchError(`${url} responded ${response.status}`)
        continue
      }
      const buffer = await drain(response, model.bytes, onProgress, signal)
      if (buffer.byteLength < 1024) {
        lastError = new ModelFetchError(`${url} returned ${buffer.byteLength} bytes`)
        continue
      }
      return buffer
    } catch (err) {
      if (signal?.aborted) throw err
      lastError = err
    }
  }

  throw new ModelFetchError(
    `Could not download ${model.label} weights. ${
      lastError instanceof Error ? lastError.message : 'No source responded.'
    }`,
  )
}

/**
 * The model's weights, from OPFS if they are there and from the network if not.
 *
 * The write-back is deliberately not awaited against the caller's success: a
 * full origin quota should cost the *next* mask a re-download, not this one an
 * error, so a failed cache write is swallowed and the buffer returned anyway.
 */
export async function loadModelWeights(
  model: SegmentModel,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const key = modelKey(model.id)

  const hit = await cacheRead(key)
  if (hit && hit.size > 0) {
    onProgress?.({ loaded: hit.size, total: hit.size })
    return hit.arrayBuffer()
  }

  const existing = inflight.get(model.id)
  if (existing) return existing

  const task = (async () => {
    const buffer = await download(model, onProgress, signal)
    try {
      await cacheWrite(key, buffer)
    } catch {
      /* out of quota — the session still has its copy in memory */
    }
    return buffer
  })()

  inflight.set(model.id, task)
  try {
    return await task
  } finally {
    inflight.delete(model.id)
  }
}
