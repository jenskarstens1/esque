/**
 * Linear proxy cache for the Develop viewport.
 *
 * Two tiers land here. The camera's embedded JPEG arrives in roughly 150 ms and
 * is what Develop paints first; the real RAW conversion replaces it as soon as
 * the worker finishes. Both are half-float RGBA in the same working space, so
 * the whole edit pipeline runs on either. Only a handful fit in a sane heap (a
 * 2560 px proxy is ~35 MB), so memory is a small LRU while RAW working and detail
 * tiers persist in OPFS. Non-RAW files take the ImageBitmap path and get linearised
 * on a scratch canvas.
 */
import { rawPool, rawFailure } from '../raw/pool'
import { loadPhotoFile } from '../catalog/previews'
import { db } from '../catalog/db'
import { decodedAsShotTempTint } from '../core/color'
import { RENDERED_WHITE_POINT, type SourceImage } from '../core/workingImage'
import { createDemandQueue } from '../lib/demandQueue'
import { hasProxyCache, readProxyCache, writeProxyCache } from './proxyCache'
import { useUI, type PreviewQuality } from '../state/ui'
import type { Photo } from '../core/types'
import type { DecodedMeta, LinearImage, RawCrop } from '../raw/decoded'

export interface Proxy extends SourceImage {
  photoId: string
  scale: number
  fullWidth: number
  fullHeight: number
  bytes: number
  /**
   * True for the camera's embedded rendering. It is a stand-in: good enough to
   * frame, crop and judge an edit against, but it must never overwrite the real
   * conversion, and it must never be the source a thumbnail or export is
   * rendered from.
   */
  preview: boolean
  /** Fast working interpolation or the final native-detail algorithm. */
  quality: 'preview' | 'interactive' | 'full'
}

/** Carries a human-readable reason up to the viewport. */
export class ProxyError extends Error {}

/**
 * Long edge of the standard proxy, by quality tier.
 *
 * 2560 covers a retina viewport with room to zoom; 1600 halves the memory a
 * large catalogue holds; 4096 keeps more detail in the working tier. Zooming
 * beyond it requests the final native-detail demosaic.
 */
export const PREVIEW_EDGES: Record<PreviewQuality, number> = {
  standard: 1600,
  high: 2560,
  full: 4096,
}

/** The standard tier as the Display pane currently has it. */
export const proxyEdge = () =>
  PREVIEW_EDGES[useUI.getState().previewQuality] ?? PREVIEW_EDGES.high

const LIMIT_BYTES = 420 * 1024 * 1024
const cache = new Map<string, Proxy>()
let bytes = 0

function touch(id: string): Proxy | undefined {
  const hit = cache.get(id)
  if (hit) {
    cache.delete(id)
    cache.set(id, hit)
  }
  return hit
}

function evict() {
  while (bytes > LIMIT_BYTES && cache.size > 1) {
    const oldest = cache.keys().next().value
    if (!oldest) break
    const victim = cache.get(oldest)
    cache.delete(oldest)
    bytes -= victim?.bytes ?? 0
  }
}

export function peekProxy(photoId: string): Proxy | null {
  return touch(photoId) ?? null
}

function remember(proxy: Proxy) {
  const prev = cache.get(proxy.photoId)
  if (prev) bytes -= prev.bytes
  cache.set(proxy.photoId, proxy)
  bytes += proxy.bytes
  evict()
}

type WorkingProxyQuality = 'interactive' | 'full'

function decodeQuality(
  photo: Photo,
  maxEdge: number,
  standard: number,
): WorkingProxyQuality {
  const nativeEdge = Math.max(photo.width, photo.height)
  return maxEdge > standard || (nativeEdge > 0 && nativeEdge <= standard)
    ? 'full'
    : 'interactive'
}

function cachedProxySatisfies(
  cached: Proxy,
  maxEdge: number,
  quality: WorkingProxyQuality,
): boolean {
  const largeEnough =
    cached.scale >= 1 || Math.max(cached.width, cached.height) >= maxEdge
  const detailedEnough = quality === 'interactive' || cached.quality === 'full'
  return largeEnough && detailedEnough
}

async function cachedRawProxy(
  photo: Photo,
  maxEdge: number,
  standard: number,
  quality: WorkingProxyQuality,
  signal: AbortSignal,
): Promise<Proxy | null> {
  if (!photo.isRaw) return null
  const cached = await readProxyCache(photo, maxEdge, signal, {
    quality,
    maxCachedEdge: maxEdge <= standard ? standard : Infinity,
  })
  if (!cached || !cachedProxySatisfies(cached, maxEdge, quality)) return null
  return cached
}

async function resolveRawCrop(
  photo: Photo,
  photoId: string,
  buffer: ArrayBuffer,
  signal: AbortSignal,
): Promise<RawCrop | null | undefined> {
  if (!photo.isRaw || photo.meta.rawCrop !== undefined) return photo.meta.rawCrop

  const probed = await rawPool.readMeta(buffer.slice(0), true)
  signal.throwIfAborted()
  const rawCrop = probed?.rawCrop ?? null
  if (probed) {
    await db.photos.update(photoId, {
      width: probed.width,
      height: probed.height,
      meta: {
        ...photo.meta,
        rawCrop,
        embeddedWidth: probed.thumbWidth,
        embeddedHeight: probed.thumbHeight,
      },
    })
  }
  return rawCrop
}

async function decodeWorkingImage(
  photo: Photo,
  buffer: ArrayBuffer,
  maxEdge: number,
  rawCrop: RawCrop | null | undefined,
  quality: WorkingProxyQuality,
  signal: AbortSignal,
): Promise<LinearImage> {
  const linear = await rawPool
    .decodeLinear(
      buffer,
      photo.isRaw,
      maxEdge,
      photo.meta.iso,
      rawCrop,
      quality,
      'foreground',
      signal,
    )
    .catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      throw new ProxyError(rawFailure(error).reason)
    })
  if (!linear) throw new ProxyError("This file couldn't be read")
  signal.throwIfAborted()
  return linear
}

function rawDimensionsChanged(photo: Photo, meta: DecodedMeta): boolean {
  return (
    photo.width !== meta.width ||
    photo.height !== meta.height ||
    photo.meta.rawCrop === undefined
  )
}

function renderedDimensionsChanged(photo: Photo, linear: LinearImage): boolean {
  return (
    !photo.isRaw &&
    linear.fullWidth > 0 &&
    linear.fullHeight > 0 &&
    (photo.width !== linear.fullWidth || photo.height !== linear.fullHeight)
  )
}

async function repairCatalogDimensions(
  photo: Photo,
  photoId: string,
  linear: LinearImage,
): Promise<void> {
  const meta = linear.meta
  if (linear.fromRaw && meta && rawDimensionsChanged(photo, meta)) {
    // Repairs rows imported by the old double-orientation path as soon as the
    // real pixels are decoded.
    await db.photos.update(photoId, {
      width: meta.width,
      height: meta.height,
      meta: {
        ...photo.meta,
        rawCrop: meta.rawCrop,
        embeddedWidth: meta.thumbWidth,
        embeddedHeight: meta.thumbHeight,
      },
    })
    return
  }

  if (renderedDimensionsChanged(photo, linear)) {
    // Rows imported from an EXIF header alone describe the frame before its
    // orientation tag is applied. These are the pixels after it.
    await db.photos.update(photoId, {
      width: linear.fullWidth,
      height: linear.fullHeight,
    })
  }
}

function proxyAsShot(linear: LinearImage) {
  if (!linear.fromRaw) return RENDERED_WHITE_POINT
  return decodedAsShotTempTint(
    linear.meta?.camMul ?? null,
    linear.meta?.preMul ?? null,
    linear.meta?.camXyz ?? null,
  )
}

function proxyFrom(
  photo: Photo,
  photoId: string,
  linear: LinearImage,
  quality: WorkingProxyQuality,
): Proxy {
  return {
    photoId,
    width: linear.width,
    height: linear.height,
    data: linear.data,
    // Camera-rendered fallback pixels already have a tone curve baked in, so
    // the RAW base curve must not be applied a second time.
    isRaw: photo.isRaw && linear.fromRaw,
    asShot: proxyAsShot(linear),
    whiteLevel: linear.whiteLevel,
    scale: linear.scale,
    fullWidth: linear.fullWidth,
    fullHeight: linear.fullHeight,
    bytes: linear.data.byteLength,
    preview: false,
    quality: linear.fromRaw ? quality : 'preview',
  }
}

async function persistProxy(
  photo: Photo,
  proxy: Proxy,
  maxEdge: number,
): Promise<void> {
  if (!photo.isRaw || proxy.quality === 'preview') return
  try {
    await writeProxyCache(photo, proxy, maxEdge)
  } catch (error) {
    // A cache failure must not discard a successful decode or block editing.
    console.warn('[esque] Could not persist the RAW decode; it remains available in memory.', error)
  }
}

async function decode(
  photoId: string,
  maxEdge: number,
  signal: AbortSignal,
): Promise<Proxy | null> {
  const photo = await db.photos.get(photoId)
  if (!photo) return null
  signal.throwIfAborted()
  // A small RAW reaches 1:1 in the standard tier, so there is no later zoom
  // escalation that could replace its working interpolation with the final one.
  const standard = proxyEdge()
  const quality = decodeQuality(photo, maxEdge, standard)
  const cached = await cachedRawProxy(photo, maxEdge, standard, quality, signal)
  if (cached) return cached

  // Virtual copies share the master's pixels; only the edits differ.
  const sourceId = photo.masterId ?? photo.id
  const file = await loadPhotoFile(sourceId)
  if (!file) return null

  const buffer = await file.arrayBuffer()
  signal.throwIfAborted()
  const rawCrop = await resolveRawCrop(photo, photoId, buffer, signal)

  // The camera JPEG is already on screen while this runs. The editable tier
  // always uses a proper native-resolution demosaic before downsampling; direct
  // CFA binning was faster but produced visible false colour on large Bayer and
  // X-Trans files.
  const linear = await decodeWorkingImage(
    photo,
    buffer,
    maxEdge,
    rawCrop,
    quality,
    signal,
  )
  await repairCatalogDimensions(photo, photoId, linear)

  const proxy = proxyFrom(photo, photoId, linear, quality)
  // Commit before publishing completion; reloading just after "ready" must not
  // cancel the only disk write of an expensive demosaic.
  await persistProxy(photo, proxy, maxEdge)
  return proxy
}

const requestProxy = createDemandQueue<string, Proxy>({
  peek: peekProxy,
  satisfies: (proxy, edge) =>
    proxy.scale >= 1 || Math.max(proxy.width, proxy.height) >= edge,
  produce: decode,
  store: remember,
})

export function loadProxy(
  photoId: string,
  maxEdge = proxyEdge(),
  signal?: AbortSignal,
): Promise<Proxy | null> {
  return requestProxy(photoId, maxEdge, signal)
}

/**
 * Whether this photo's conversion can be served without decoding it again —
 * either from the tier already in memory or from the one on disk.
 *
 * Develop asks before it orders the camera's embedded rendering as a stand-in.
 * The stand-in exists to cover seconds of demosaic; covering a file read with
 * it just means opening the original a second time and decoding a JPEG whose
 * only destiny is to be replaced before anyone sees it.
 */
export async function proxyIsReady(
  photoId: string,
  maxEdge = proxyEdge(),
): Promise<boolean> {
  const cached = peekProxy(photoId)
  const photo = await db.photos.get(photoId)
  if (!photo) return false
  const standard = proxyEdge()
  const quality = decodeQuality(photo, maxEdge, standard)
  if (cached && !cached.preview && cachedProxySatisfies(cached, maxEdge, quality)) return true
  return hasProxyCache(photo, maxEdge, {
    quality,
    maxCachedEdge: maxEdge <= standard ? standard : Infinity,
  })
}

/**
 * The camera's own rendering of a photo, as a working image.
 *
 * Develop paints this first and swaps it for {@link loadProxy}'s result when
 * the RAW conversion finishes. It is kept out of the LRU on purpose: it is only
 * ever wanted for the photo currently on screen, and caching it would let a
 * stand-in outlive the real thing.
 *
 * White balance is reported as the RAW's own as-shot point rather than the sRGB
 * white a JPEG would imply, so a photo opened with a custom temperature does not
 * lurch when the tiers swap. Every offset is measured from the same origin.
 */
export async function loadPreview(
  photoId: string,
  maxEdge = proxyEdge(),
  signal?: AbortSignal,
): Promise<Proxy | null> {
  const photo = await db.photos.get(photoId)
  if (!photo) return null
  signal?.throwIfAborted()
  const file = await loadPhotoFile(photo.masterId ?? photo.id)
  if (!file) return null
  const buffer = await file.arrayBuffer()
  signal?.throwIfAborted()

  const linear = await rawPool
    .decodeEmbedded(buffer, photo.isRaw, maxEdge, signal)
    .catch(() => null)
  if (!linear) return null
  signal?.throwIfAborted()

  return {
    photoId,
    width: linear.width,
    height: linear.height,
    data: linear.data,
    // Camera-rendered pixels already carry a tone curve; the RAW base curve
    // must not run over them a second time.
    isRaw: false,
    asShot: photo.isRaw
      ? decodedAsShotTempTint(
          photo.meta.camMul ?? linear.meta?.camMul ?? null,
          photo.meta.preMul ?? linear.meta?.preMul ?? null,
          photo.meta.camXyz ?? linear.meta?.camXyz ?? null,
        )
      : RENDERED_WHITE_POINT,
    whiteLevel: linear.whiteLevel,
    scale: linear.scale,
    fullWidth: linear.fullWidth,
    fullHeight: linear.fullHeight,
    bytes: linear.data.byteLength,
    preview: true,
    quality: 'preview',
  }
}

export function dropProxy(photoId: string) {
  const hit = cache.get(photoId)
  if (hit) {
    bytes -= hit.bytes
    cache.delete(photoId)
  }
}

export function clearProxies() {
  cache.clear()
  bytes = 0
}

export const proxyStats = () => ({ count: cache.size, bytes })
