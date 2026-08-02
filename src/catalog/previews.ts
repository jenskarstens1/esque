import { db } from './db'
import { cacheHas, cacheWrite, previewKey, scheduleEvict, thumbKey } from './opfs'
import { resolveFile } from './fs'
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

export async function loadPhotoFile(photoId: string): Promise<File | null> {
  const photo = await db.photos.get(photoId)
  if (!photo) return null
  // Individually imported files carry their own handle; there is no folder to
  // walk a relative path against.
  if (photo.fileHandle) {
    try {
      return await photo.fileHandle.getFile()
    } catch {
      return null
    }
  }
  const folder = await db.folders.get(photo.folderId)
  if (!folder?.handle) return null
  // Virtual copies reference the master's file on disk.
  return resolveFile(folder.handle, photo.relPath)
}

/**
 * Generates the standard preview for a photo if it isn't cached yet.
 * Returns true when a preview is available afterwards.
 */
export function ensurePreview(photoId: string, maxEdge?: number): Promise<boolean> {
  return ensure(`preview:${photoId}`, previewKey(photoId), async (photo, buffer) => {
    const edge = maxEdge ?? (photo.isRaw ? 0 : 1920)
    return rawPool.makePreview(
      buffer,
      photo.isRaw,
      edge,
      true,
      photo.meta.iso,
      photo.meta.rawCrop,
    )
  }, photoId)
}

/** Long edge of a grid thumbnail. Also what the loupe stands in with. */
export const THUMB_EDGE = 512

/**
 * Regenerates a grid thumbnail. Import writes these, but the OPFS cache can be
 * evicted under quota pressure, so the grid has to be able to heal itself.
 */
export function ensureThumb(photoId: string, maxEdge = THUMB_EDGE): Promise<boolean> {
  return ensure(`thumb:${photoId}`, thumbKey(photoId), async (photo, buffer) => {
    return rawPool.makeThumb(buffer, photo.isRaw, maxEdge)
  }, photoId)
}

async function ensure(
  token: string,
  key: string,
  render: (photo: Photo, buffer: ArrayBuffer) => Promise<Blob | null>,
  photoId: string,
): Promise<boolean> {
  const existing = inflight.get(token)
  if (existing) return existing

  const job = (async () => {
    if (await cacheHas(key)) return true
    const photo = await db.photos.get(photoId)
    if (!photo) return false
    // Virtual copies have no file of their own.
    const sourceId = photo.masterId ?? photo.id
    return slot(async () => {
      const file = await loadPhotoFile(sourceId)
      if (!file) return false
      const blob = await render(photo, await file.arrayBuffer())
      if (!blob) return false
      await cacheWrite(key, blob)
      // Browsing a large folder writes previews continuously, so the cache is
      // trimmed as it grows rather than only at import time.
      scheduleEvict()
      // Keep the catalog row honest so the grid stops guessing.
      if (key.startsWith('thumb/') && photo.thumbKey !== key) {
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
