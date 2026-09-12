import { db } from '../catalog/db'
import {
  cacheDelete,
  cacheRead,
  cacheTouch,
  cacheWrite,
  proxyKey,
  scheduleEvict,
} from '../catalog/opfs'
import type { Photo } from '../core/types'
import type { Proxy } from './proxy'
import type { RawDecodeQuality } from '../raw/decoded'

const MAGIC = 0x45535150
/**
 * Bumped to 2 when the RAW decode moved to scene-linear. A v1 payload holds
 * pixels on dcraw's 0.45/4.5 curve, which the renderer would now multiply as
 * though it were radiance — so every one of them has to be re-decoded rather
 * than reinterpreted. A mismatch here already deletes the entry and falls
 * through to a fresh decode, so the bump is the whole invalidation.
 */
const VERSION = 2
const HEADER_BYTES = 64

const QUALITY_CODE = {
  interactive: 1,
  full: 2,
} as const

/**
 * The cached proxy's key.
 *
 * The tier's long edge is part of it. Without it, dropping the Display pane's
 * preview quality would go on being served the larger proxy already on disk —
 * the setting would look broken until something evicted the entry — and raising
 * it would silently overwrite the smaller one under the same name.
 */
function keyFor(photo: Photo, edge: number, quality: RawDecodeQuality = 'interactive') {
  return proxyKey(photo.masterId ?? photo.id, photo.modifiedAt, photo.fileSize, edge, quality)
}

export interface ProxyCacheRequest {
  quality?: RawDecodeQuality
  /** A lower Display quality must not silently load a larger working tier. */
  maxCachedEdge?: number
}

async function candidateKeys(photo: Photo, edge: number): Promise<string[]> {
  const rows = await db.cacheMetadata.where('raw.sourceId').equals(photo.masterId ?? photo.id).toArray()
  const indexed = rows.filter(({ raw }) =>
    raw && raw.modifiedAt === photo.modifiedAt && raw.fileSize === photo.fileSize,
  ).sort((a, b) => a.raw!.edge - b.raw!.edge)
  const keys = [
    keyFor(photo, edge, 'full'),
    keyFor(photo, edge),
    ...indexed.map((row) => row.key),
  ]
  // Existing v2 caches have no index until first used. Their payload is still
  // valid, including the full-quality tier used for small sensors.
  const prefix = `proxy/v2/${photo.masterId ?? photo.id}-${photo.modifiedAt}-${photo.fileSize}-`
  if (photo.proxyKey?.startsWith(prefix)) keys.push(photo.proxyKey)
  return [...new Set(keys)]
}

interface ProxyHeader {
  width: number
  height: number
  fullWidth: number
  fullHeight: number
  modifiedAt: number
  fileSize: number
  scale: number
  whiteLevel: number
  temp: number
  tint: number
  qualityCode: number
  dataBytes: number
}

function readHeader(view: DataView): ProxyHeader {
  return {
    width: view.getUint32(8, true),
    height: view.getUint32(12, true),
    fullWidth: view.getUint32(16, true),
    fullHeight: view.getUint32(20, true),
    scale: view.getFloat32(24, true),
    whiteLevel: view.getFloat32(28, true),
    temp: view.getFloat32(32, true),
    tint: view.getFloat32(36, true),
    modifiedAt: view.getFloat64(40, true),
    fileSize: view.getFloat64(48, true),
    qualityCode: view.getUint32(56, true),
    dataBytes: view.getUint32(60, true),
  }
}

function validHeader(
  view: DataView,
  header: ProxyHeader,
  photo: Photo,
  bufferBytes: number,
) {
  const { width, height, fullWidth, fullHeight, scale, whiteLevel, temp, tint } = header
  if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== VERSION) return false
  if (width <= 0 || height <= 0 || fullWidth < width || fullHeight < height) return false
  if (header.modifiedAt !== photo.modifiedAt || header.fileSize !== photo.fileSize) return false
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) return false
  if (!Number.isFinite(whiteLevel) || whiteLevel <= 0) return false
  if (!Number.isFinite(temp) || !Number.isFinite(tint)) return false
  if (header.qualityCode !== QUALITY_CODE.interactive && header.qualityCode !== QUALITY_CODE.full) {
    return false
  }
  if (header.dataBytes !== width * height * 8) return false
  return bufferBytes === HEADER_BYTES + header.dataBytes
}

/**
 * Whether this photo's decode is already on disk, without reading 35 MB to
 * find out.
 *
 * Develop opens a RAW by racing the camera's embedded rendering against the
 * real conversion. Read just the header here, so a corrupt or lower-quality
 * entry cannot suppress the camera preview during a necessary re-decode.
 */
export async function hasProxyCache(
  photo: Photo,
  edge: number,
  request: ProxyCacheRequest = {},
): Promise<boolean> {
  if (!photo.isRaw) return false
  return (await findCachedFile(photo, edge, request)) !== null
}

async function findCachedFile(
  photo: Photo,
  edge: number,
  request: ProxyCacheRequest,
  signal?: AbortSignal,
): Promise<{ key: string; file: File } | null> {
  for (const key of await candidateKeys(photo, edge)) {
    signal?.throwIfAborted()
    const file = await cacheRead(key, false)
    if (!file) continue
    const buffer = await file.slice(0, HEADER_BYTES).arrayBuffer()
    signal?.throwIfAborted()
    const header = new DataView(buffer)
    const values = buffer.byteLength === HEADER_BYTES ? readHeader(header) : null
    if (!values || !validHeader(header, values, photo, file.size)) {
      console.warn('[esque] Discarding an invalid RAW decode cache entry.', key)
      await cacheDelete(key)
      continue
    }
    const largeEnough = values.scale >= 1 || Math.max(values.width, values.height) >= edge
    const detailedEnough = request.quality !== 'full' || values.qualityCode === QUALITY_CODE.full
    const withinTier = Math.max(values.width, values.height) <= (request.maxCachedEdge ?? Infinity)
    if (largeEnough && detailedEnough && withinTier) return { key, file }
  }
  return null
}

/**
 * Reads a linear proxy and verifies it against the catalog's source fingerprint.
 * A truncated OPFS write or a changed original is a cache miss, never a decoder
 * substitute.
 */
export async function readProxyCache(
  photo: Photo,
  edge: number,
  signal?: AbortSignal,
  request: ProxyCacheRequest = {},
): Promise<Proxy | null> {
  if (!photo.isRaw) return null
  const cached = await findCachedFile(photo, edge, request, signal)
  if (!cached) return null
  const { key, file } = cached
  const buffer = await file.arrayBuffer()
  signal?.throwIfAborted()
  if (buffer.byteLength < HEADER_BYTES) {
    await cacheDelete(key)
    return null
  }

  const header = new DataView(buffer, 0, HEADER_BYTES)
  const values = readHeader(header)
  if (!validHeader(header, values, photo, buffer.byteLength)) {
    await cacheDelete(key)
    return null
  }

  const {
    width,
    height,
    fullWidth,
    fullHeight,
    scale,
    whiteLevel,
    temp,
    tint,
    qualityCode,
    dataBytes,
  } = values
  const quality = qualityCode === QUALITY_CODE.full ? 'full' : 'interactive'
  await cacheTouch(key, true)
  if (!(await db.cacheMetadata.get(key))?.raw) {
    await db.cacheMetadata.update(key, {
      raw: {
        sourceId: photo.masterId ?? photo.id,
        modifiedAt: photo.modifiedAt,
        fileSize: photo.fileSize,
        edge: Math.max(width, height),
        quality,
      },
    })
  }
  return {
    photoId: photo.id,
    width,
    height,
    data: new Uint16Array(buffer, HEADER_BYTES, dataBytes / 2),
    isRaw: true,
    asShot: { temp, tint },
    whiteLevel,
    scale,
    fullWidth,
    fullHeight,
    bytes: dataBytes,
    preview: false,
    quality,
  }
}

/** Working and detail tiers share the quota-aware LRU, but never overwrite each other. */
export async function writeProxyCache(
  photo: Photo,
  proxy: Proxy,
  edge: number,
): Promise<void> {
  if (!photo.isRaw || !proxy.isRaw || proxy.preview || proxy.quality === 'preview') return
  const key = keyFor(photo, edge, proxy.quality)
  const header = new ArrayBuffer(HEADER_BYTES)
  const view = new DataView(header)
  view.setUint32(0, MAGIC, true)
  view.setUint32(4, VERSION, true)
  view.setUint32(8, proxy.width, true)
  view.setUint32(12, proxy.height, true)
  view.setUint32(16, proxy.fullWidth, true)
  view.setUint32(20, proxy.fullHeight, true)
  view.setFloat32(24, proxy.scale, true)
  view.setFloat32(28, proxy.whiteLevel, true)
  view.setFloat32(32, proxy.asShot.temp, true)
  view.setFloat32(36, proxy.asShot.tint, true)
  view.setFloat64(40, photo.modifiedAt, true)
  view.setFloat64(48, photo.fileSize, true)
  view.setUint32(56, QUALITY_CODE[proxy.quality], true)
  view.setUint32(60, proxy.data.byteLength, true)
  if (!validHeader(view, readHeader(view), photo, HEADER_BYTES + proxy.data.byteLength)) {
    throw new Error('The RAW decode is not a valid RGBA16F cache payload.')
  }

  let pixels: Uint8Array<ArrayBuffer>
  if (proxy.data.buffer instanceof ArrayBuffer) {
    pixels = new Uint8Array(proxy.data.buffer, proxy.data.byteOffset, proxy.data.byteLength)
  } else {
    const copy = new Uint16Array(proxy.data)
    pixels = new Uint8Array(copy.buffer)
  }

  await cacheWrite(key, new Blob([header, pixels]))
  await db.cacheMetadata.update(key, {
    raw: {
      sourceId: photo.masterId ?? photo.id,
      modifiedAt: photo.modifiedAt,
      fileSize: photo.fileSize,
      edge,
      quality: proxy.quality,
    },
  })
  await db.photos.update(photo.id, { proxyKey: key })
  scheduleEvict()
}
