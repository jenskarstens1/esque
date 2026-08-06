/**
 * Linear proxy cache for the Develop viewport.
 *
 * Two tiers land here. The camera's embedded JPEG arrives in roughly 150 ms and
 * is what Develop paints first; the real RAW conversion replaces it as soon as
 * the worker finishes. Both are half-float RGBA in the same working space, so
 * the whole edit pipeline runs on either. Only a handful fit in a sane heap (a
 * 2560 px proxy is ~35 MB), so memory is a small LRU while the standard tier is
 * persisted in OPFS. Non-RAW files take the ImageBitmap path and get linearised
 * on a scratch canvas.
 */
import { rawPool, rawFailure } from '../raw/pool'
import { loadPhotoFile } from '../catalog/previews'
import { db } from '../catalog/db'
import { decodedAsShotTempTint } from '../core/color'
import { RENDERED_WHITE_POINT, type SourceImage } from '../core/workingImage'
import { createDemandQueue } from '../lib/demandQueue'
import { readProxyCache, writeProxyCache } from './proxyCache'
import { useUI, type PreviewQuality } from '../state/ui'

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
 * Every tier gets the same full-quality demosaic — this selects how much of the
 * result is kept, not how it was interpolated. 2560 covers a retina viewport
 * with room to zoom; 1600 halves the memory a large catalogue holds; 4096
 * reaches 1:1 on most sensors so a close inspection never waits for a decode.
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
  const nativeEdge = Math.max(photo.width, photo.height)
  const quality =
    maxEdge > standard || (nativeEdge > 0 && nativeEdge <= standard)
      ? 'full'
      : 'interactive'
  if (photo.isRaw && maxEdge <= standard) {
    const cached = await readProxyCache(photo, standard, signal)
    if (
      cached &&
      (cached.scale >= 1 || Math.max(cached.width, cached.height) >= maxEdge) &&
      (quality === 'interactive' || cached.quality === 'full')
    ) {
      return cached
    }
  }
  // Virtual copies share the master's pixels; only the edits differ.
  const sourceId = photo.masterId ?? photo.id
  const file = await loadPhotoFile(sourceId)
  if (!file) return null

  const buffer = await file.arrayBuffer()
  signal.throwIfAborted()
  let rawCrop = photo.meta.rawCrop
  if (photo.isRaw && rawCrop === undefined) {
    const probed = await rawPool.readMeta(buffer.slice(0), true)
    signal.throwIfAborted()
    rawCrop = probed?.rawCrop ?? null
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
  }

  // The camera JPEG is already on screen while this runs. The editable tier
  // always uses a proper native-resolution demosaic before downsampling; direct
  // CFA binning was faster but produced visible false colour on large Bayer and
  // X-Trans files.
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
    .catch((err: unknown) => {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      throw new ProxyError(rawFailure(err).reason)
    })
  if (!linear) throw new ProxyError("This file couldn't be read")
  signal.throwIfAborted()

  if (
    linear.fromRaw &&
    linear.meta &&
    (photo.width !== linear.meta.width ||
      photo.height !== linear.meta.height ||
      photo.meta.rawCrop === undefined)
  ) {
    // Repairs rows imported by the old double-orientation path as soon as the
    // real pixels are decoded.
    await db.photos.update(photoId, {
      width: linear.meta.width,
      height: linear.meta.height,
      meta: {
        ...photo.meta,
        rawCrop: linear.meta.rawCrop,
        embeddedWidth: linear.meta.thumbWidth,
        embeddedHeight: linear.meta.thumbHeight,
      },
    })
  } else if (
    !photo.isRaw &&
    linear.fullWidth > 0 &&
    linear.fullHeight > 0 &&
    (photo.width !== linear.fullWidth || photo.height !== linear.fullHeight)
  ) {
    // And rows imported from an EXIF header alone, which describes a rendered
    // file's frame *before* its orientation tag is applied. These are the
    // pixels after it, which is the photograph every view lays out against.
    await db.photos.update(photoId, { width: linear.fullWidth, height: linear.fullHeight })
  }

  const proxy: Proxy = {
    photoId,
    width: linear.width,
    height: linear.height,
    data: linear.data,
    // Camera-rendered fallback pixels already have a tone curve baked in, so
    // the RAW base curve must not be applied a second time.
    isRaw: photo.isRaw && linear.fromRaw,
    asShot: linear.fromRaw
      ? decodedAsShotTempTint(
          linear.meta?.camMul ?? null,
          linear.meta?.preMul ?? null,
          linear.meta?.camXyz ?? null,
        )
      : RENDERED_WHITE_POINT,
    whiteLevel: linear.whiteLevel,
    scale: linear.scale,
    fullWidth: linear.fullWidth,
    fullHeight: linear.fullHeight,
    bytes: linear.data.byteLength,
    preview: false,
    quality: linear.fromRaw ? quality : 'preview',
  }
  if (
    photo.isRaw &&
    proxy.quality !== 'preview' &&
    maxEdge >= standard &&
    Math.max(proxy.width, proxy.height) <= standard
  ) {
    void writeProxyCache(photo, proxy, standard).catch((error: unknown) => {
      console.warn('[esque] Could not persist the RAW working proxy.', error)
    })
  }
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
