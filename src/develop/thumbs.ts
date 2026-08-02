/**
 * Edit-aware grid thumbnails.
 *
 * Import writes a thumbnail straight from the file — for a RAW that means the
 * camera's embedded JPEG, which already carries the manufacturer's own picture
 * style. That's the right thing to show for an untouched photo (it's fast, and
 * it's what the photographer saw on the back of the camera), but it's wrong the
 * moment you edit: the Library grid would keep showing the camera's rendering
 * of a photo you've since taken somewhere else entirely.
 *
 * So after edits are saved we re-render the thumbnail through esque's own
 * pipeline. The key carries a revision counter, which is what makes the grid
 * invalidate — `useThumbUrl` reads `photo.thumbKey`, so changing it swaps the
 * image without any cache-busting hacks.
 *
 * The downscale, render and JPEG encode all happen in the export worker. They
 * used to run here on the main thread, which meant every slider release paid
 * for a fresh GPU device and a few million lines of per-pixel JS right where
 * the UI needed to stay responsive.
 */
import { db } from '../catalog/db'
import { cacheDelete, cacheWrite, scheduleEvict, thumbKey } from '../catalog/opfs'
import { renderThumbInWorker } from '../export/client'
import { THUMB_EDGE } from '../export/types'
import type { Edits } from '../core/types'
import { loadProxy } from './proxy'

/** Only one refresh per photo at a time; a fast slider drag queues many. */
const inflight = new Map<string, Promise<void>>()
const pending = new Map<string, Edits>()

/**
 * Queues a thumbnail re-render for `photoId` using `edits`.
 *
 * Coalescing rather than debouncing: while a render is in flight the newest
 * edits are parked, and exactly one more render runs when it finishes. That
 * bounds the work at two renders per burst however fast you scrub.
 */
export function refreshThumb(photoId: string, edits: Edits) {
  if (inflight.has(photoId)) {
    pending.set(photoId, edits)
    return
  }
  const job = run(photoId, edits)
    .catch(() => {})
    .finally(() => {
      inflight.delete(photoId)
      const next = pending.get(photoId)
      if (next) {
        pending.delete(photoId)
        refreshThumb(photoId, next)
      }
    })
  inflight.set(photoId, job)
}

async function run(photoId: string, edits: Edits) {
  const photo = await db.photos.get(photoId)
  if (!photo) return

  // The develop session usually has a 2560px proxy in memory already, so
  // editing the photo you're looking at costs a copy and one shader pass. Only
  // a background photo — a synced or pasted edit — has to touch the disk. RAWs
  // still take the full native demosaic before being reduced to thumbnail size;
  // a thumbnail must not reintroduce the false-colour shortcut removed from
  // Develop.
  const proxy = await loadProxy(photoId, THUMB_EDGE)
  if (!proxy) return

  const blob = await renderThumbInWorker({
    width: proxy.width,
    height: proxy.height,
    // The proxy stays in the LRU cache, so the worker gets a copy to own and
    // detach rather than the cached buffer itself.
    data: proxy.data.slice(),
    isRaw: proxy.isRaw,
    asShot: proxy.asShot,
    whiteLevel: proxy.whiteLevel,
    edits,
  })
  if (!blob) return

  // Revision-suffixed so the browser can't serve a stale blob URL, and so a
  // half-written file can never replace a good one.
  const rev = (photo.thumbRev ?? 0) + 1
  const key = `thumb/${photoId}.${rev}.jpg`
  await cacheWrite(key, blob)

  const stale = photo.thumbKey
  await db.photos.update(photoId, { thumbKey: key, thumbRev: rev })
  if (stale && stale !== key) await cacheDelete(stale)
  scheduleEvict()
}

/**
 * Drops the rendered thumbnail and falls back to the import-time one.
 * Used when a photo is reset to its original state.
 */
export async function resetThumb(photoId: string) {
  const photo = await db.photos.get(photoId)
  if (!photo?.thumbRev) return
  const stale = photo.thumbKey
  await db.photos.update(photoId, { thumbKey: thumbKey(photoId), thumbRev: 0 })
  if (stale) await cacheDelete(stale)
}
