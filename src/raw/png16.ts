/**
 * Minimal 16-bit PNG reader.
 *
 * The browser's own path — `createImageBitmap` into a 2D canvas and back out
 * through `getImageData` — is an 8-bit pipe. That is fine for a JPEG, but a PNG
 * someone deliberately exported at 16 bits loses half its precision before the
 * editor ever sees a pixel, which rather defeats the point of a linear
 * half-float pipeline.
 *
 * So the handful of PNG variants that can actually carry more than 8 bits are
 * read here instead, and everything else is left to the browser. Inflate comes
 * from `DecompressionStream`, so this costs no dependency and no wasm.
 *
 * Adam7-interlaced files fall through to the browser: they are rare, rarer
 * still at 16 bits, and the deinterlace would double the size of this file.
 */

export interface Png16 {
  width: number
  height: number
  /** 1 (grey), 2 (grey+alpha), 3 (RGB) or 4 (RGBA). */
  channels: number
  /** Interleaved 16-bit samples, native endian. */
  data: Uint16Array
  /** The embedded ICC profile, inflated, if the writer left one. */
  icc: Uint8Array | null
  /** `gAMA`'s encoding exponent, if present and no ICC profile overrides it. */
  gamma: number | null
  /** `cHRM` chromaticities, scaled to real numbers. */
  chrm: Chromaticities | null
}

export interface Chromaticities {
  wx: number
  wy: number
  rx: number
  ry: number
  gx: number
  gy: number
  bx: number
  by: number
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

/** Palette (colour type 3) is 8-bit by definition, so it isn't listed. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 }

const u32 = (b: Uint8Array, o: number) =>
  ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0

interface Header {
  width: number
  height: number
  depth: number
  colorType: number
  interlace: number
}

function header(bytes: Uint8Array): Header | null {
  // 8 signature + 4 length + 4 type + 13 IHDR + 4 CRC
  if (bytes.length < 33) return null
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return null
  if (u32(bytes, 8) !== 13) return null
  // 'IHDR'
  if (bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) return null
  return {
    width: u32(bytes, 16),
    height: u32(bytes, 20),
    depth: bytes[24],
    colorType: bytes[25],
    interlace: bytes[28],
  }
}

/** True only for files this module can read *and* that are worth reading. */
export function isDeepPng(bytes: Uint8Array): boolean {
  const h = header(bytes)
  return (
    !!h &&
    h.depth === 16 &&
    h.interlace === 0 &&
    !!CHANNELS[h.colorType] &&
    h.width > 0 &&
    h.height > 0
  )
}

async function inflate(parts: Uint8Array[]): Promise<Uint8Array> {
  // PNG wraps its deflate stream in zlib, which is what 'deflate' means here;
  // 'deflate-raw' would be the bare stream.
  const stream = new Blob(parts as BlobPart[])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * Reverses one scanline filter in place into `out`.
 *
 * `bpp` is the byte distance to the corresponding sample in the pixel to the
 * left — 2 bytes per sample at this depth, so 6 for RGB and 8 for RGBA.
 */
function unfilter(
  type: number,
  src: Uint8Array,
  out: Uint8Array,
  prev: Uint8Array,
  bpp: number,
): boolean {
  const n = src.length
  switch (type) {
    case 0:
      out.set(src)
      return true
    case 1:
      for (let i = 0; i < n; i++) out[i] = (src[i] + (i >= bpp ? out[i - bpp] : 0)) & 0xff
      return true
    case 2:
      for (let i = 0; i < n; i++) out[i] = (src[i] + prev[i]) & 0xff
      return true
    case 3:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? out[i - bpp] : 0
        out[i] = (src[i] + ((a + prev[i]) >> 1)) & 0xff
      }
      return true
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? out[i - bpp] : 0
        const c = i >= bpp ? prev[i - bpp] : 0
        out[i] = (src[i] + paeth(a, prev[i], c)) & 0xff
      }
      return true
    default:
      return false
  }
}

function chromaticities(bytes: Uint8Array, start: number): Chromaticities {
  const at = (index: number) => u32(bytes, start + index * 4) / 100000
  return {
    wx: at(0), wy: at(1),
    rx: at(2), ry: at(3),
    gx: at(4), gy: at(5),
    bx: at(6), by: at(7),
  }
}

function compressedProfile(bytes: Uint8Array, start: number, length: number) {
  let index = start
  const limit = Math.min(start + length, start + 80)
  while (index < limit && bytes[index] !== 0) index++
  return index + 2 <= start + length ? bytes.subarray(index + 2, start + length) : null
}

function pngChunks(bytes: Uint8Array) {
  const idat: Uint8Array[] = []
  let iccRaw: Uint8Array | null = null
  let gamma: number | null = null
  let chrm: Chromaticities | null = null
  let srgb = false
  let offset = 8

  while (offset + 8 <= bytes.length) {
    const length = u32(bytes, offset)
    const start = offset + 8
    if (start + length + 4 > bytes.length) break
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    )
    if (type === 'IDAT') idat.push(bytes.subarray(start, start + length))
    if (type === 'IEND') break
    if (type === 'iCCP') iccRaw = compressedProfile(bytes, start, length)
    if (type === 'sRGB') srgb = true
    if (type === 'gAMA' && length >= 4) {
      const value = u32(bytes, start)
      if (value > 0) gamma = value / 100000
    }
    if (type === 'cHRM' && length >= 32) chrm = chromaticities(bytes, start)
    offset = start + length + 4
  }

  return { idat, iccRaw, gamma, chrm, srgb }
}

export async function decodeDeepPng(bytes: Uint8Array): Promise<Png16 | null> {
  const h = header(bytes)
  if (!h || h.depth !== 16 || h.interlace !== 0) return null
  const channels = CHANNELS[h.colorType]
  if (!channels || !h.width || !h.height) return null

  const chunks = pngChunks(bytes)
  const { idat, iccRaw } = chunks
  let { gamma, chrm } = chunks
  if (!idat.length) return null

  // An explicit `sRGB` chunk is the authoritative answer, and it outranks any
  // `gAMA`/`cHRM` a writer left beside it for older decoders.
  if (chunks.srgb && !iccRaw) {
    gamma = null
    chrm = null
  }
  const icc = iccRaw ? await inflate([iccRaw]).catch(() => null) : null

  const inflated = await inflate(idat)
  const bpp = channels * 2
  const stride = h.width * bpp
  if (inflated.length < (stride + 1) * h.height) return null

  const raw = new Uint8Array(stride * h.height)
  let prev = new Uint8Array(stride)
  for (let y = 0; y < h.height; y++) {
    const rowStart = y * (stride + 1)
    const row = raw.subarray(y * stride, (y + 1) * stride)
    const ok = unfilter(
      inflated[rowStart],
      inflated.subarray(rowStart + 1, rowStart + 1 + stride),
      row,
      prev,
      bpp,
    )
    if (!ok) return null
    prev = row
  }

  const samples = h.width * h.height * channels
  const data = new Uint16Array(samples)
  for (let i = 0, j = 0; i < samples; i++, j += 2) {
    data[i] = (raw[j] << 8) | raw[j + 1]
  }

  return { width: h.width, height: h.height, channels, data, icc, gamma, chrm }
}
