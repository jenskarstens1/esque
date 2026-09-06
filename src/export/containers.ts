/**
 * Post-processing for browser-encoded containers.
 *
 * `OffscreenCanvas.convertToBlob` gives us valid JPEG/PNG/WebP bytes but no way
 * to attach an ICC profile or EXIF, so the marker segments are spliced in here.
 * Without the profile, a Display P3 or Adobe RGB export is silently wrong
 * everywhere it's opened.
 */

import { crc32 } from './crc32'

const concat = (parts: Uint8Array[]) => {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

// --- JPEG -------------------------------------------------------------------

const ICC_HEADER = 'ICC_PROFILE\0'
/** APP2 payload limit: 65533 segment bytes minus the 14-byte ICC header. */
const ICC_CHUNK = 65519

export function iccApp2Segments(icc: Uint8Array): Uint8Array[] {
  const count = Math.ceil(icc.length / ICC_CHUNK)
  const out: Uint8Array[] = []
  for (let i = 0; i < count; i++) {
    const slice = icc.subarray(i * ICC_CHUNK, (i + 1) * ICC_CHUNK)
    const length = slice.length + ICC_HEADER.length + 2 + 2
    const seg = new Uint8Array(length + 2)
    seg[0] = 0xff
    seg[1] = 0xe2
    seg[2] = length >> 8
    seg[3] = length & 0xff
    for (let k = 0; k < ICC_HEADER.length; k++) seg[4 + k] = ICC_HEADER.charCodeAt(k)
    seg[4 + ICC_HEADER.length] = i + 1
    seg[5 + ICC_HEADER.length] = count
    seg.set(slice, 6 + ICC_HEADER.length)
    out.push(seg)
  }
  return out
}

const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0'

/**
 * The standard XMP APP1 segment.
 *
 * Only the compact form is written: a packet past ~64 KB would need Adobe's
 * ExtendedXMP split, and nothing esque puts in one comes close.
 */
export function xmpApp1Segment(xml: string): Uint8Array | null {
  const payload = new TextEncoder().encode(xml)
  if (payload.length + XMP_HEADER.length + 2 > 0xffff) return null
  const length = payload.length + XMP_HEADER.length + 2
  const seg = new Uint8Array(length + 2)
  seg[0] = 0xff
  seg[1] = 0xe1
  seg[2] = length >> 8
  seg[3] = length & 0xff
  for (let i = 0; i < XMP_HEADER.length; i++) seg[4 + i] = XMP_HEADER.charCodeAt(i)
  seg.set(payload, 4 + XMP_HEADER.length)
  return seg
}

const startsWith = (bytes: Uint8Array, at: number, sig: string) => {
  for (let i = 0; i < sig.length; i++) if (bytes[at + i] !== sig.charCodeAt(i)) return false
  return true
}

/**
 * Inserts APP segments after SOI and any APP0/JFIF.
 *
 * Chrome's JPEG encoder embeds its own APP2 ICC profile, so any pre-existing
 * ICC or Exif segment is dropped first — two ICC profiles in one file is
 * malformed, and readers disagree about which one wins.
 */
export function jpegWithSegments(jpeg: Uint8Array, segments: Uint8Array[]): Uint8Array {
  const kept: Uint8Array[] = []
  let at = 2
  let insertAt = -1

  while (at + 3 < jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1]
    // Everything from SOF onwards is image data; metadata must precede it.
    if (marker < 0xe0 || marker > 0xef) break
    const len = 2 + ((jpeg[at + 2] << 8) | jpeg[at + 3])
    const body = at + 4
    const isIcc = marker === 0xe2 && startsWith(jpeg, body, ICC_HEADER)
    const isExif = marker === 0xe1 && startsWith(jpeg, body, 'Exif\0\0')
    const isXmp = marker === 0xe1 && startsWith(jpeg, body, XMP_HEADER)
    if (!isIcc && !isExif && !isXmp) {
      kept.push(jpeg.subarray(at, at + len))
      // Ours go after JFIF, before anything else the encoder wrote.
      if (marker !== 0xe0 && insertAt < 0) insertAt = kept.length - 1
    }
    at += len
  }

  if (insertAt < 0) insertAt = kept.length
  return concat([
    jpeg.subarray(0, 2),
    ...kept.slice(0, insertAt),
    ...segments,
    ...kept.slice(insertAt),
    jpeg.subarray(at),
  ])
}

export const jpegWithIcc = (jpeg: Uint8Array, icc: Uint8Array) =>
  jpegWithSegments(jpeg, iccApp2Segments(icc))

// --- PNG --------------------------------------------------------------------

export function pngChunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(data.length + 12)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  dv.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)))
  return out
}

/** Inserts iCCP (and pHYs, iTXt) immediately after IHDR, per the PNG spec's ordering. */
export async function pngWithMetadata(
  png: Uint8Array,
  icc: Uint8Array | null,
  dpi: number | null,
  xmp?: string | null,
): Promise<Uint8Array> {
  const extra: Uint8Array[] = []

  if (icc) {
    const name = 'esque\0'
    const stream = new Blob([icc as BlobPart])
      .stream()
      .pipeThrough(new CompressionStream('deflate'))
    const deflated = new Uint8Array(await new Response(stream).arrayBuffer())
    const data = new Uint8Array(name.length + 1 + deflated.length)
    for (let i = 0; i < name.length; i++) data[i] = name.charCodeAt(i)
    data[name.length] = 0 // compression method: deflate
    data.set(deflated, name.length + 1)
    extra.push(pngChunk('iCCP', data))
  }

  if (dpi) {
    const ppm = Math.round(dpi / 0.0254)
    const data = new Uint8Array(9)
    const dv = new DataView(data.buffer)
    dv.setUint32(0, ppm)
    dv.setUint32(4, ppm)
    data[8] = 1 // unit: metre
    extra.push(pngChunk('pHYs', data))
  }

  if (xmp) {
    // The XMP spec pins the keyword and requires the uncompressed iTXt form.
    const keyword = 'XML:com.adobe.xmp'
    const head = new Uint8Array(keyword.length + 5)
    for (let i = 0; i < keyword.length; i++) head[i] = keyword.charCodeAt(i)
    // null terminator, compression flag 0, compression method 0, empty language
    // tag and empty translated keyword, each null-terminated.
    const payload = new TextEncoder().encode(xmp)
    const data = new Uint8Array(head.length + payload.length)
    data.set(head)
    data.set(payload, head.length)
    extra.push(pngChunk('iTXt', data))
  }

  if (!extra.length) return png

  // The PNG spec forbids iCCP alongside sRGB, and gAMA/cHRM would contradict
  // the profile we're attaching, so the encoder's versions are dropped.
  const drop = new Set<string>()
  if (icc) for (const t of ['sRGB', 'gAMA', 'cHRM', 'iCCP']) drop.add(t)
  if (dpi) drop.add('pHYs')
  if (xmp) drop.add('iTXt')
  const head = 8 + 25 // 8-byte signature + IHDR chunk
  const rest: Uint8Array[] = []
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let at = head
  while (at + 8 <= png.length) {
    const len = dv.getUint32(at)
    const type = String.fromCharCode(png[at + 4], png[at + 5], png[at + 6], png[at + 7])
    const total = len + 12
    if (type === 'IDAT') break
    if (!drop.has(type)) rest.push(png.subarray(at, at + total))
    at += total
  }

  return concat([png.subarray(0, head), ...extra, ...rest, png.subarray(at)])
}
