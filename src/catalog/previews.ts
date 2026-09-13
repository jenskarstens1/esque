import { db } from './db'
import { cacheDelete, cacheHas, cacheWrite, previewKey, scheduleEvict, thumbKey } from './opfs'
import { loadPhotoFile } from './originals'
import { RAW_POOL_SIZE, rawPool } from '../raw/pool'
import type { Photo } from '../core/types'

/** In-flight and completed jobs, so a fast scroll can't queue dupes. */
const inflight = new Map<string, Promise<boolean>>()

/**
 * Decoding is the expensive part, so only a few run at once. Without this a
 * grid of 500 photos would try to open 500 RAW files the moment it scrolls.
 */
const MAX_CONCURRENT = Math.max(1, RAW_POOL_SIZE - 1)
let running = 0
const waiting: Array<() => void> = []

async function slot<T>(job: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve))
  }
  running++
  try {
    return await job()
  } finally {
    running--
    waiting.shift()?.()
  }
}

export { loadPhotoFile } from './originals'

/**
 * Generates the standard preview for a photo if it isn't cached yet.
 * Returns true when a preview is available afterwards.
 */
export function ensurePreview(photoId: string, maxEdge?: number): Promise<boolean> {
  return ensure(
    `preview:${photoId}`,
    (photo) => previewKey(photo.id, photo.previewRev ?? 0),
    async (photo, source) => {
      const edge = maxEdge ?? (photo.isRaw ? 0 : 1920)
      // An edited photo has to come through the graph. Decoding the file alone
      // gives the camera's rendering, so the Library would keep showing a look
      // the photographer has since moved away from — and, with a crop applied,
      // the wrong framing as well. Same reason the grid thumbnail is re-rendered.
      if (photo.edits) return renderEdited(photo, edge)
      return rawPool.makePreview(
        await source(),
        photo.isRaw,
        edge,
        true,
        photo.meta.iso,
        photo.meta.rawCrop,
      )
    },
    photoId,
  )
}

/**
 * Long edge an edited preview is rendered at.
 *
 * The unedited path can hand back the embedded JPEG at whatever size the
 * camera wrote, but rendering costs a decode into memory, and a grid scroll
 * can ask for a great many of these at once. This is the Develop proxy's own
 * standard tier, which is both plenty for the loupe and already cached when
 * the photo being browsed is the one open in Develop.
 */
const EDITED_PREVIEW_EDGE = 2560

/** Renders a photo's saved edits at `edge`, via the shared export worker. */
async function renderEdited(photo: Photo, edge: number): Promise<Blob | null> {
  if (!photo.edits) return null
  // Imported dynamically: `develop/proxy` reads `loadPhotoFile` from this
  // module, so a static import here would close the cycle.
  const [{ loadProxy }, { renderThumbInWorker }] = await Promise.all([
    import('../develop/proxy'),
    import('../export/client'),
  ])
  // `edge` is 0 for a RAW, meaning "whatever the file gives"; the render needs
  // a real number, and the standard tier is the one the Library shows.
  const want = Math.min(edge > 0 ? edge : EDITED_PREVIEW_EDGE, EDITED_PREVIEW_EDGE)
  const proxy = await loadProxy(photo.id, want)
  if (!proxy) return null
  return renderThumbInWorker({
    width: proxy.width,
    height: proxy.height,
    // The proxy stays in the LRU, so the worker gets a copy it can detach.
    data: proxy.data.slice(),
    isRaw: proxy.isRaw,
    asShot: proxy.asShot,
    whiteLevel: proxy.whiteLevel,
    edits: photo.edits,
    edge: want,
    quality: 0.9,
  })
}

/** Long edge of a grid thumbnail. Also what the loupe stands in with. */
export const THUMB_EDGE = 512

/**
 * Retires everything rendered from a photo's old settings.
 *
 * Bumping the revision is the load-bearing part: it changes the preview's
 * cache key, which retires the memoised blob URL the Library is displaying and
 * tells a render still in flight that its result is no longer wanted. Deleting
 * the file alone leaves both of those pointing at the previous look.
 */
export async function invalidateRendered(photoId: string): Promise<void> {
  const photo = await db.photos.get(photoId)
  if (!photo) return
  const stale = previewKey(photoId, photo.previewRev ?? 0)
  await db.photos.update(photoId, { previewRev: (photo.previewRev ?? 0) + 1 })
  await cacheDelete(stale)
  const [{ dropDetail }, { forgetCachedUrl }] = await Promise.all([
    import('./detail'),
    import('./hooks'),
  ])
  forgetCachedUrl(stale)
  dropDetail(photoId)
}

/**
 * Regenerates a grid thumbnail. Import writes these, but the OPFS cache can be
 * evicted under quota pressure, so the grid has to be able to heal itself.
 */
export function ensureThumb(photoId: string, maxEdge = THUMB_EDGE): Promise<boolean> {
  return ensure(`thumb:${photoId}`, (photo) => thumbKey(photo.id), async (photo, source) => {
    return rawPool.makeThumb(await source(), photo.isRaw, maxEdge)
  }, photoId)
}

async function ensure(
  token: string,
  keyFor: (photo: Photo) => string,
  render: (photo: Photo, source: () => Promise<ArrayBuffer>) => Promise<Blob | null>,
  photoId: string,
): Promise<boolean> {
  const existing = inflight.get(token)
  if (existing) return existing

  const job = (async () => {
    const photo = await db.photos.get(photoId)
    if (!photo) return false
    const key = keyFor(photo)
    if (await cacheHas(key)) return true
    // Virtual copies have no file of their own.
    const sourceId = photo.masterId ?? photo.id
    return slot(async () => {
      // Read lazily: the edit-aware path loads the file through the proxy
      // cache instead, and reading it here as well would decode it twice.
      let buffer: Promise<ArrayBuffer> | null = null
      const source = () => {
        buffer ??= (async () => {
          const file = await loadPhotoFile(sourceId)
          if (!file) throw new Error('missing file')
          return file.arrayBuffer()
        })()
        return buffer
      }
      const blob = await render(photo, source)
      if (!blob) return false
      // A render started before the last edit is finishing against settings
      // that are no longer the photo's. Its key has been retired, so writing
      // it would restore a stale image the Library had already let go.
      const current = await db.photos.get(photoId)
      if (!current || keyFor(current) !== key) return false
      await cacheWrite(key, blob)
      // Browsing a large folder writes previews continuously, so the cache is
      // trimmed as it grows rather than only at import time.
      scheduleEvict()
      // Keep the catalog row honest so the grid stops guessing.
      if (key.startsWith('thumb/') && current.thumbKey !== key) {
        await db.photos.update(photoId, { thumbKey: key })
      }
      return true
    })
  })()
    .catch(() => false)
    .finally(() => {
      // Held briefly so a burst of requests coalesces, then released.
      setTimeout(() => inflight.delete(token), 1000)
    })

  inflight.set(token, job)
  return job
}
