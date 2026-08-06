import { db } from '../catalog/db'
import {
  cacheDelete,
  cacheRead,
  cacheWrite,
  proxyKey,
  scheduleEvict,
} from '../catalog/opfs'
import type { Photo } from '../core/types'
import type { Proxy } from './proxy'

const MAGIC = 0x45535150
const VERSION = 1
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
function keyFor(photo: Photo, edge: number) {
  return proxyKey(photo.masterId ?? photo.id, photo.modifiedAt, photo.fileSize, edge)
}

async function clearStaleKey(photo: Photo, expected: string) {
  const stale = photo.proxyKey
  if (!stale || stale === expected) return
  await cacheDelete(stale)
  await db.photos.update(photo.id, { proxyKey: null })
}

/**
 * Reads a standard linear proxy and verifies it against the source fingerprint.
 * A truncated OPFS write or a changed original is a cache miss, never a decoder
 * substitute.
 */
export async function readProxyCache(
  photo: Photo,
  edge: number,
  signal?: AbortSignal,
): Promise<Proxy | null> {
  if (!photo.isRaw) return null
  const key = keyFor(photo, edge)
  await clearStaleKey(photo, key)
  signal?.throwIfAborted()

  const file = await cacheRead(key)
  if (!file) {
    if (photo.proxyKey === key) await db.photos.update(photo.id, { proxyKey: null })
    return null
  }
  const buffer = await file.arrayBuffer()
  signal?.throwIfAborted()
  if (buffer.byteLength < HEADER_BYTES) {
    await cacheDelete(key)
    return null
  }

  const header = new DataView(buffer, 0, HEADER_BYTES)
  const width = header.getUint32(8, true)
  const height = header.getUint32(12, true)
  const fullWidth = header.getUint32(16, true)
  const fullHeight = header.getUint32(20, true)
  const modifiedAt = header.getFloat64(40, true)
  const fileSize = header.getFloat64(48, true)
  const scale = header.getFloat32(24, true)
  const whiteLevel = header.getFloat32(28, true)
  const temp = header.getFloat32(32, true)
  const tint = header.getFloat32(36, true)
  const qualityCode = header.getUint32(56, true)
  const dataBytes = header.getUint32(60, true)
  const valid =
    header.getUint32(0, true) === MAGIC &&
    header.getUint32(4, true) === VERSION &&
    width > 0 &&
    height > 0 &&
    fullWidth >= width &&
    fullHeight >= height &&
    modifiedAt === photo.modifiedAt &&
    fileSize === photo.fileSize &&
    Number.isFinite(scale) &&
    scale > 0 &&
    scale <= 1 &&
    Number.isFinite(whiteLevel) &&
    whiteLevel > 0 &&
    Number.isFinite(temp) &&
    Number.isFinite(tint) &&
    (qualityCode === QUALITY_CODE.interactive || qualityCode === QUALITY_CODE.full) &&
    dataBytes === width * height * 8 &&
    buffer.byteLength === HEADER_BYTES + dataBytes

  if (!valid) {
    await cacheDelete(key)
    if (photo.proxyKey === key) await db.photos.update(photo.id, { proxyKey: null })
    return null
  }

  const quality = qualityCode === QUALITY_CODE.full ? 'full' : 'interactive'
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

/** Persists only the bounded standard tier; native-detail proxies stay in RAM. */
export async function writeProxyCache(
  photo: Photo,
  proxy: Proxy,
  edge: number,
): Promise<void> {
  if (!photo.isRaw || proxy.preview || proxy.quality === 'preview') return
  const key = keyFor(photo, edge)
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

  let pixels: Uint8Array<ArrayBuffer>
  if (proxy.data.buffer instanceof ArrayBuffer) {
    pixels = new Uint8Array(proxy.data.buffer, proxy.data.byteOffset, proxy.data.byteLength)
  } else {
    const copy = new Uint16Array(proxy.data)
    pixels = new Uint8Array(copy.buffer)
  }

  await cacheWrite(key, new Blob([header, pixels]))
  const stale = photo.proxyKey
  await db.photos.update(photo.id, { proxyKey: key })
  if (stale && stale !== key) await cacheDelete(stale)
  scheduleEvict()
}
