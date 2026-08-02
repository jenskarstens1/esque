/**
 * Baseline TIFF reader.
 *
 * TIFF is the only common photo format no browser can decode: `createImageBitmap`
 * rejects it outright in Chrome and Firefox, so a `.tif` import didn't lose
 * precision here — it failed completely. Safari decodes it through ImageIO but
 * hands back 8 bits, which throws away exactly the depth a 16-bit TIFF exists to
 * carry.
 *
 * So TIFF is read here instead. The scope is "what real photo editors write":
 * uncompressed, LZW, Deflate and PackBits; strips and tiles; chunky and planar;
 * 8, 16 and 32 bits per sample; horizontal and floating-point predictors.
 *
 * Deliberately not handled, because a wrong image is worse than an honest
 * failure: JPEG-in-TIFF (compression 6/7), palette colour, CMYK and BigTIFF.
 * Those return null and the caller falls back to the browser.
 *
 * Colour: samples are assumed to be sRGB-encoded, matching how every other
 * rendered file enters this pipeline. An embedded ICC profile for a wider space
 * is not honoured — that limitation is shared with the PNG path and is a colour
 * management question rather than a precision one.
 */

export interface TiffImage {
  width: number
  height: number
  /** 1 (grey) or 3 (RGB). Alpha and other extra samples are dropped. */
  channels: number
  /** Interleaved samples normalised to 16-bit unsigned, native endian. */
  data: Uint16Array
  /** EXIF-style orientation, 1..8. */
  orientation: number
  /** True when samples are already linear, which is the convention for float. */
  linear: boolean
  /** Bits per sample as stored, so callers can tell 8-bit files from deep ones. */
  depth: number
}

const TAG = {
  subfileType: 254,
  width: 256,
  height: 257,
  bits: 258,
  compression: 259,
  photometric: 262,
  stripOffsets: 273,
  orientation: 274,
  samplesPerPixel: 277,
  rowsPerStrip: 278,
  stripByteCounts: 279,
  planar: 284,
  predictor: 317,
  tileWidth: 322,
  tileLength: 323,
  tileOffsets: 324,
  tileByteCounts: 325,
  sampleFormat: 339,
} as const

const COMPRESSION = { none: 1, lzw: 5, deflate: 8, packbits: 32773, deflateAlt: 32946 }

/** Byte width of each IFD value type, indexed by the type code. */
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8]

export function isTiff(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false
  const le = bytes[0] === 0x49 && bytes[1] === 0x49
  const be = bytes[0] === 0x4d && bytes[1] === 0x4d
  if (!le && !be) return false
  const magic = le ? bytes[2] | (bytes[3] << 8) : (bytes[2] << 8) | bytes[3]
  // 42 is TIFF; 43 is BigTIFF, which has a different header and offset width.
  return magic === 42
}

interface Ifd {
  entries: Map<number, number>
  next: number
}

function readIfd(view: DataView, le: boolean, offset: number): Ifd | null {
  if (offset <= 0 || offset + 2 > view.byteLength) return null
  const count = view.getUint16(offset, le)
  const end = offset + 2 + count * 12
  if (end + 4 > view.byteLength) return null
  const entries = new Map<number, number>()
  for (let i = 0; i < count; i++) {
    const at = offset + 2 + i * 12
    entries.set(view.getUint16(at, le), at)
  }
  return { entries, next: view.getUint32(end, le) }
}

/** Reads an IFD entry's values, following the offset when they don't fit inline. */
function values(view: DataView, le: boolean, entry: number | undefined): number[] {
  if (entry === undefined) return []
  const type = view.getUint16(entry + 2, le)
  const count = view.getUint32(entry + 4, le)
  const size = TYPE_SIZE[type] ?? 0
  // A count that large is a corrupt file, not a big image.
  if (!size || !count || count > 1 << 26) return []

  const total = size * count
  let at = entry + 8
  if (total > 4) {
    at = view.getUint32(entry + 8, le)
    if (at + total > view.byteLength) return []
  }

  const out = new Array<number>(count)
  for (let i = 0; i < count; i++) {
    const o = at + i * size
    switch (type) {
      case 1:
      case 2:
      case 7:
        out[i] = view.getUint8(o)
        break
      case 3:
        out[i] = view.getUint16(o, le)
        break
      case 4:
        out[i] = view.getUint32(o, le)
        break
      case 5:
        out[i] = view.getUint32(o, le) / (view.getUint32(o + 4, le) || 1)
        break
      case 6:
        out[i] = view.getInt8(o)
        break
      case 8:
        out[i] = view.getInt16(o, le)
        break
      case 9:
        out[i] = view.getInt32(o, le)
        break
      case 10:
        out[i] = view.getInt32(o, le) / (view.getInt32(o + 4, le) || 1)
        break
      case 11:
        out[i] = view.getFloat32(o, le)
        break
      case 12:
        out[i] = view.getFloat64(o, le)
        break
      default:
        return []
    }
  }
  return out
}

const first = (v: number[], fallback: number) => (v.length ? v[0] : fallback)

// --- decompression ----------------------------------------------------------

/**
 * TIFF's LZW: MSB-first packing, and the code width grows one code *early*
 * compared with GIF, which is the detail that breaks naive ports.
 */
function lzw(src: Uint8Array, expected: number): Uint8Array | null {
  const CLEAR = 256
  const EOI = 257
  const prefix = new Int32Array(4096)
  const suffix = new Uint8Array(4096)
  const length = new Int32Array(4096)
  const stack = new Uint8Array(4096)
  const out = new Uint8Array(expected)

  let outAt = 0
  let bitPos = 0
  const bitEnd = src.length * 8

  let next = 258
  let width = 9
  let old = -1

  const reset = () => {
    next = 258
    width = 9
    old = -1
  }
  for (let i = 0; i < 256; i++) {
    suffix[i] = i
    prefix[i] = -1
    length[i] = 1
  }

  const read = (): number => {
    if (bitPos + width > bitEnd) return EOI
    let code = 0
    for (let i = 0; i < width; i++) {
      const p = bitPos + i
      code = (code << 1) | ((src[p >> 3] >> (7 - (p & 7))) & 1)
    }
    bitPos += width
    return code
  }

  const emit = (code: number): number => {
    let depth = 0
    let c = code
    while (c >= 0 && depth < 4096) {
      stack[depth++] = suffix[c]
      c = prefix[c]
    }
    if (outAt + depth > out.length) return -1
    for (let i = depth - 1; i >= 0; i--) out[outAt++] = stack[i]
    return depth
  }

  for (;;) {
    const code = read()
    if (code === EOI) break
    if (code === CLEAR) {
      reset()
      const seed = read()
      if (seed === EOI) break
      if (seed >= next) return null
      if (emit(seed) < 0) break
      old = seed
      continue
    }
    if (old < 0) return null

    if (code < next) {
      if (emit(code) < 0) break
      if (next < 4096) {
        prefix[next] = old
        // The new entry's first byte is the first byte of `code`'s string.
        suffix[next] = stack[length[code] - 1]
        length[next] = length[old] + 1
        next++
      }
    } else {
      // The not-yet-in-table case: the string is `old` plus its own first byte.
      const at = outAt
      if (emit(old) < 0) break
      if (outAt >= out.length) break
      out[outAt++] = out[at]
      if (next < 4096) {
        prefix[next] = old
        suffix[next] = out[at]
        length[next] = length[old] + 1
        next++
      }
    }
    old = code

    // Early change: widen one code before the table is actually full.
    if (next + 1 >= 1 << width && width < 12) width++
  }

  return outAt ? out.subarray(0, outAt) : null
}

function packBits(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected)
  let o = 0
  let i = 0
  while (i < src.length && o < expected) {
    const n = (src[i++] << 24) >> 24
    if (n >= 0) {
      const run = Math.min(n + 1, src.length - i, expected - o)
      out.set(src.subarray(i, i + run), o)
      o += run
      i += n + 1
    } else if (n !== -128) {
      const run = Math.min(1 - n, expected - o)
      const b = src[i++]
      out.fill(b, o, o + run)
      o += run
    }
  }
  return out
}

async function inflate(src: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([src as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// --- predictors -------------------------------------------------------------

/** Horizontal differencing, undone in the sample width and the file's endianness. */
function unpredictHorizontal(
  row: Uint8Array,
  samples: number,
  stride: number,
  bytes: number,
  le: boolean,
): void {
  if (bytes === 1) {
    for (let i = stride; i < samples; i++) row[i] = (row[i] + row[i - stride]) & 0xff
    return
  }
  if (bytes === 2) {
    const view = new DataView(row.buffer, row.byteOffset, row.byteLength)
    for (let i = stride; i < samples; i++) {
      const prev = view.getUint16((i - stride) * 2, le)
      const cur = view.getUint16(i * 2, le)
      view.setUint16(i * 2, (cur + prev) & 0xffff, le)
    }
    return
  }
  if (bytes === 4) {
    const view = new DataView(row.buffer, row.byteOffset, row.byteLength)
    for (let i = stride; i < samples; i++) {
      const prev = view.getUint32((i - stride) * 4, le)
      const cur = view.getUint32(i * 4, le)
      view.setUint32(i * 4, (cur + prev) >>> 0, le)
    }
  }
}

/**
 * TIFF Technical Note 3's float predictor: bytes are differenced across the row
 * and then split into byte planes, so both have to be undone in that order.
 */
function unpredictFloat(
  row: Uint8Array,
  samples: number,
  stride: number,
  bytes: number,
  le: boolean,
): void {
  const n = samples * bytes
  // Differencing restarts at each byte plane. Letting it run across the plane
  // boundary adds the tail of one significance byte to the head of the next.
  for (let plane = 0; plane < bytes; plane++) {
    const start = plane * samples
    const end = start + samples
    for (let i = start + stride; i < end; i++) {
      row[i] = (row[i] + row[i - stride]) & 0xff
    }
  }

  const tmp = row.slice(0, n)
  for (let s = 0; s < samples; s++) {
    for (let b = 0; b < bytes; b++) {
      // Predictor 3 stores the most-significant byte plane first.
      const dest = le ? bytes - b - 1 : b
      row[s * bytes + dest] = tmp[b * samples + s]
    }
  }
}

// --- main -------------------------------------------------------------------

export async function decodeTiff(bytes: Uint8Array): Promise<TiffImage | null> {
  if (!isTiff(bytes)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const le = bytes[0] === 0x49

  // Some writers park a reduced-resolution preview in IFD0, so walk to the
  // first full-resolution image rather than trusting the first directory.
  let ifd = readIfd(view, le, view.getUint32(4, le))
  for (let guard = 0; ifd && guard < 8; guard++) {
    const sub = first(values(view, le, ifd.entries.get(TAG.subfileType)), 0)
    if (!(sub & 1)) break
    ifd = readIfd(view, le, ifd.next)
  }
  if (!ifd) return null

  const num = (tag: number, fallback: number) =>
    first(values(view, le, ifd!.entries.get(tag)), fallback)

  const width = num(TAG.width, 0)
  const height = num(TAG.height, 0)
  if (width <= 0 || height <= 0 || width * height > 1 << 30) return null

  const bitsPer = values(view, le, ifd.entries.get(TAG.bits))
  const depth = bitsPer.length ? bitsPer[0] : 1
  if (depth !== 8 && depth !== 16 && depth !== 32) return null
  if (bitsPer.some((b) => b !== depth)) return null

  const spp = num(TAG.samplesPerPixel, bitsPer.length || 1)
  const photometric = num(TAG.photometric, spp >= 3 ? 2 : 1)
  if (photometric !== 0 && photometric !== 1 && photometric !== 2) return null

  const channels = photometric === 2 ? 3 : 1
  if (spp < channels) return null

  const format = first(values(view, le, ifd.entries.get(TAG.sampleFormat)), 1)
  const isFloat = format === 3
  const isSigned = format === 2
  if (isFloat && depth !== 32) return null
  if (!isFloat && format !== 1 && !isSigned) return null

  const compression = num(TAG.compression, COMPRESSION.none)
  const predictor = num(TAG.predictor, 1)
  if (predictor !== 1 && predictor !== 2 && predictor !== 3) return null
  if (predictor === 3 && !isFloat) return null
  const planar = num(TAG.planar, 1) === 2
  const orientation = Math.min(8, Math.max(1, num(TAG.orientation, 1)))

  const tileWidth = num(TAG.tileWidth, 0)
  const tileHeight = num(TAG.tileLength, 0)
  const tiled = tileWidth > 0 && tileHeight > 0

  const offsets = values(view, le, ifd.entries.get(tiled ? TAG.tileOffsets : TAG.stripOffsets))
  const counts = values(
    view,
    le,
    ifd.entries.get(tiled ? TAG.tileByteCounts : TAG.stripByteCounts),
  )
  if (!offsets.length || offsets.length !== counts.length) return null

  const rowsPerStrip = tiled ? tileHeight : Math.min(height, num(TAG.rowsPerStrip, height))
  if (rowsPerStrip <= 0) return null

  const chunkCols = tiled ? tileWidth : width
  const across = tiled ? Math.ceil(width / tileWidth) : 1
  const down = Math.ceil(height / rowsPerStrip)
  const perPlane = across * down
  // Planar files repeat the whole chunk grid once per sample plane.
  const planes = planar ? spp : 1
  if (offsets.length < perPlane * planes) return null

  const bytesPer = depth >> 3
  const samplesPerRow = chunkCols * (planar ? 1 : spp)
  const rowBytes = samplesPerRow * bytesPer
  const out = new Uint16Array(width * height * channels)

  for (let c = 0; c < perPlane * planes; c++) {
    const plane = planar ? Math.floor(c / perPlane) : 0
    // Extra samples (alpha and friends) have their own planes; skip them.
    if (planar && plane >= channels) continue

    const index = planar ? c % perPlane : c
    const col0 = tiled ? (index % across) * tileWidth : 0
    const row0 = Math.floor(index / across) * rowsPerStrip
    if (row0 >= height) continue

    const start = offsets[c]
    const size = counts[c]
    if (start < 0 || size <= 0 || start + size > bytes.length) continue
    const raw = bytes.subarray(start, start + size)

    // Tiles are always stored full size; strips are clipped by the image edge.
    const rows = tiled ? tileHeight : Math.min(rowsPerStrip, height - row0)
    const expected = rowBytes * rows

    let data: Uint8Array | null
    switch (compression) {
      case COMPRESSION.none:
        data = raw
        break
      case COMPRESSION.lzw:
        data = lzw(raw, expected)
        break
      case COMPRESSION.deflate:
      case COMPRESSION.deflateAlt:
        data = await inflate(raw).catch(() => null)
        break
      case COMPRESSION.packbits:
        data = packBits(raw, expected)
        break
      default:
        return null
    }
    if (!data || data.length < rowBytes) continue

    const usableRows = Math.min(rows, Math.floor(data.length / rowBytes))
    const stride = planar ? 1 : spp
    const validCols = Math.min(chunkCols, width - col0)

    for (let r = 0; r < usableRows; r++) {
      const y = row0 + r
      if (y >= height) break

      // subarray keeps the predictor writing back into `data`, which is what
      // the next row's differencing needs.
      const row = data.subarray(r * rowBytes, (r + 1) * rowBytes)
      if (predictor === 2) unpredictHorizontal(row, samplesPerRow, stride, bytesPer, le)
      else if (predictor === 3) unpredictFloat(row, samplesPerRow, stride, bytesPer, le)

      const rv = new DataView(row.buffer, row.byteOffset, row.byteLength)
      for (let x = 0; x < validCols; x++) {
        const o = ((y * width + col0 + x) * channels + (planar ? plane : 0)) * 1
        const limit = planar ? 1 : channels
        for (let ch = 0; ch < limit; ch++) {
          const s = planar ? x : x * spp + ch
          let v: number
          if (isFloat) {
            v = Math.max(0, Math.min(1, rv.getFloat32(s * 4, le))) * 65535
          } else if (depth === 8) {
            // 257 maps 255 to exactly 65535 rather than leaving a dark gap.
            v = (isSigned ? rv.getInt8(s) + 128 : row[s]) * 257
          } else if (depth === 16) {
            v = isSigned ? rv.getInt16(s * 2, le) + 32768 : rv.getUint16(s * 2, le)
          } else {
            const code = isSigned
              ? rv.getInt32(s * 4, le) + 2147483648
              : rv.getUint32(s * 4, le)
            v = code / 65537
          }
          // WhiteIsZero stores an inverted image, as scanners and fax do.
          if (photometric === 0) v = 65535 - v
          out[o + ch] = v
        }
      }
    }
  }

  return { width, height, channels, data: out, orientation, linear: isFloat, depth }
}
