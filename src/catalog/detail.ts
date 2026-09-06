/**
 * The 1:1 preview tier for the Library loupe.
 *
 * The standard preview tops out at 1920px, which is plenty at Fit and visibly
 * upsampled the moment anyone zooms in. Rather than cache a full-resolution
 * JPEG per photo on disk — which would exhaust the origin's quota after a few
 * dozen frames — a detail render is produced on demand and held in a very
 * small in-memory LRU, the same tiering the Develop proxy cache uses.
 */
import { useEffect, useRef, useState } from 'react'
import { db } from './db'
import { loadPhotoFile } from './previews'
import { loadProxy } from '../develop/proxy'
import { renderThumbInWorker } from '../export/client'
import { rawPool } from '../raw/pool'
import { createDemandQueue } from '../lib/demandQueue'
import type { Photo } from '../core/types'

export interface Detail {
  photoId: string
  /** The long edge that was *asked for*; the render may be smaller. */
  edge: number
  url: string
}

/**
 * A decoded 8192px frame already costs ~180 MB of image memory, and browsers
 * refuse to decode much beyond it anyway.
 */
const MAX_EDGE = 8192
/** Fallback quantisation for catalog rows whose native dimensions are unknown. */
const STEP = 512
const KEEP = 2

const cache = new Map<string, Detail>()

export function peekDetail(photoId: string): Detail | null {
  const hit = cache.get(photoId)
  if (!hit) return null
  cache.delete(photoId)
  cache.set(photoId, hit)
  return hit
}

function store(detail: Detail) {
  const replaced = cache.get(detail.photoId)
  cache.set(detail.photoId, detail)
  // The image element may still be pointing at the URL we're replacing for
  // another frame or two, so it is released a beat later rather than under it.
  if (replaced) setTimeout(() => URL.revokeObjectURL(replaced.url), 1000)
  while (cache.size > KEEP) {
    const oldest = cache.keys().next().value
    if (!oldest || oldest === detail.photoId) break
    URL.revokeObjectURL(cache.get(oldest)!.url)
    cache.delete(oldest)
  }
}

async function render(
  photoId: string,
  edge: number,
  signal: AbortSignal,
): Promise<Detail | null> {
  const photo = await db.photos.get(photoId)
  if (!photo) return null
  signal.throwIfAborted()

  // An edited photo is rendered rather than decoded, for the same reason the
  // preview tier below it is: zooming in must not swap the photographer's work
  // for the camera's rendering of the uncropped frame.
  if (photo.edits) {
    const proxy = await loadProxy(photoId, edge, signal)
    if (!proxy) return null
    signal.throwIfAborted()
    const blob = await renderThumbInWorker({
      width: proxy.width,
      height: proxy.height,
      // The proxy stays in the LRU, so the worker gets a copy it can detach.
      data: proxy.data.slice(),
      isRaw: proxy.isRaw,
      asShot: proxy.asShot,
      whiteLevel: proxy.whiteLevel,
      edits: photo.edits,
      edge,
      quality: 0.92,
    })
    signal.throwIfAborted()
    return blob ? { photoId, edge, url: URL.createObjectURL(blob) } : null
  }

  // Virtual copies share the master's pixels.
  const file = await loadPhotoFile(photo.masterId ?? photo.id)
  if (!file) return null
  // A half-size demosaic can't resolve past half the sensor's long edge, so
  // anything sharper has to pay for the real thing.
  const halfSize = edge <= Math.max(photo.width, photo.height) / 2
  const blob = await rawPool.makePreview(
    await file.arrayBuffer(),
    photo.isRaw,
    edge,
    halfSize,
    photo.meta.iso,
    photo.meta.rawCrop,
    true,
    'foreground',
    signal,
  )
  signal.throwIfAborted()
  return blob ? { photoId, edge, url: URL.createObjectURL(blob) } : null
}

const requestDetail = createDemandQueue<string, Detail>({
  peek: peekDetail,
  satisfies: (detail, edge) => detail.edge >= edge,
  produce: render,
  store,
})

export function loadDetail(
  photoId: string,
  edge: number,
  signal?: AbortSignal,
): Promise<Detail | null> {
  return requestDetail(photoId, edge, signal)
}

export function clearDetails() {
  for (const d of cache.values()) URL.revokeObjectURL(d.url)
  cache.clear()
}

/**
 * Drops one photo's 1:1 render.
 *
 * Called when its settings change: the cache is keyed by photo alone, so
 * without this the loupe would keep zooming into the render of an edit the
 * photographer has already moved past.
 */
export function dropDetail(photoId: string) {
  const hit = cache.get(photoId)
  if (!hit) return
  cache.delete(photoId)
  setTimeout(() => URL.revokeObjectURL(hit.url), 1000)
}

/**
 * Resolves a detail render once the view asks for more pixels than the standard
 * preview holds. Returns `null` until one exists, so callers keep showing what
 * they already have instead of flashing an empty frame, and reports whether one
 * is on its way so they can say so.
 */
export function useDetailRender(
  photo: Photo | undefined,
  neededEdge: number,
): { url: string | null; pending: boolean } {
  const id = photo?.id ?? null
  const native = photo ? Math.max(photo.width, photo.height) : 0
  const requestedEdge = Math.max(0, neededEdge)
  // LibRaw has two useful decode costs: half-size and full-size. Asking for
  // several intermediate JPEG sizes repeats the same demosaic each time, so
  // cache the complete tier and let the browser scale it while zooming.
  const tier =
    requestedEdge <= 0
      ? 0
      : native
        ? photo?.isRaw && requestedEdge <= native / 2
          ? Math.floor(native / 2)
          : native
        : Math.ceil(requestedEdge / STEP) * STEP
  const want = Math.min(
    MAX_EDGE,
    native || MAX_EDGE,
    tier,
  )

  const [url, setUrl] = useState<string | null>(() => (id ? (peekDetail(id)?.url ?? null) : null))
  // The debounce and the decode are one wait as far as anyone watching is
  // concerned, so the flag is raised for both rather than only the second half.
  const [pending, setPending] = useState(false)
  const requested = useRef(0)
  // Identity, not contents: the catalogue hands back a fresh row when the
  // photo is saved, and that is precisely when the render stops being valid.
  const edits = photo?.edits ?? null

  useEffect(() => {
    requested.current = 0
    setUrl(id ? (peekDetail(id)?.url ?? null) : null)
  }, [id, edits])

  useEffect(() => {
    if (!id || !want) return
    const have = peekDetail(id)
    if (have && have.edge >= want) {
      setUrl(have.url)
      return
    }
    if (requested.current >= want) return

    let alive = true
    const controller = new AbortController()
    setPending(true)
    // Zooming is a continuous gesture; only the level it settles on is worth
    // spending a full decode on.
    const timer = setTimeout(() => {
      requested.current = want
      loadDetail(id, want, controller.signal)
        .then((d) => {
          if (!alive) return
          if (d) setUrl(d.url)
        })
        .catch(() => {
          requested.current = 0
        })
        .finally(() => {
          if (alive) setPending(false)
        })
    }, 260)
    return () => {
      alive = false
      setPending(false)
      controller.abort()
      clearTimeout(timer)
    }
  }, [id, want, edits])

  return { url, pending }
}
