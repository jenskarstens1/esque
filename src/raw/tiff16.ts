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
 * Colour: an embedded ICC profile is handed back for the caller to honour, so
 * a ProPhoto or Adobe RGB file — including esque's own 16-bit exports — comes
 * back the way it was written. Files with no profile are assumed to be sRGB,
 * matching how every other rendered file enters this pipeline.
 */

export interface TiffImage {
  width: number
  height: number
  /** 1 (grey) or 3 (RGB). Alpha and other extra samples are dropped. */
  channels: number
  /** Interleaved samples normalised to 16-bit unsigned, native endian. */
  data: Uint16Array | Float32Array
  /** EXIF-style orientation, 1..8. */
  orientation: number
  /** True when samples are already linear, which is the convention for float. */
  linear: boolean
  /** Bits per sample as stored, so callers can tell 8-bit files from deep ones. */
  depth: number
  /** The embedded ICC profile, if the writer left one. */
  icc: Uint8Array | null
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
  icc: 34675,
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

/** An entry's raw bytes, for tags whose value is an opaque blob. */
function rawBytes(
  bytes: Uint8Array,
  view: DataView,
  le: boolean,
  entry: number | undefined,
): Uint8Array | null {
  if (entry === undefined) return null
  const count = view.getUint32(entry + 4, le)
  if (!count || count > 1 << 24) return null
  let at = entry + 8
  if (count > 4) {
    at = view.getUint32(entry + 8, le)
    if (at + count > view.byteLength) return null
  }
  return bytes.subarray(at, at + count)
}

function valueAt(
  view: DataView,
  le: boolean,
  type: number,
  offset: number,
): number | undefined {
  switch (type) {
    case 1:
    case 2:
    case 7:
      return view.getUint8(offset)
    case 3:
      return view.getUint16(offset, le)
    case 4:
      return view.getUint32(offset, le)
    case 5:
      return view.getUint32(offset, le) / (view.getUint32(offset + 4, le) || 1)
    case 6:
      return view.getInt8(offset)
    case 8:
      return view.getInt16(offset, le)
    case 9:
      return view.getInt32(offset, le)
    case 10:
      return view.getInt32(offset, le) / (view.getInt32(offset + 4, le) || 1)
    case 11:
      return view.getFloat32(offset, le)
    case 12:
      return view.getFloat64(offset, le)
    default:
      return undefined
  }
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
    const value = valueAt(view, le, type, at + i * size)
    if (value === undefined) return []
    out[i] = value
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
  // Differencing runs continuously over the whole shuffled row, straight
  // through the byte-plane boundaries. That reads like an off-by-one waiting to
  // happen, but it is what Technical Note 3 specifies and what libtiff's fpAcc
  // does, so restarting per plane silently corrupts every file but the first
  // plane's worth of samples.
  for (let i = stride; i < n; i++) {
    row[i] = (row[i] + row[i - stride]) & 0xff
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

interface ImageSpec {
  width: number
  height: number
  depth: number
  spp: number
  photometric: number
  channels: number
  isFloat: boolean
  isSigned: boolean
  compression: number
  predictor: number
  planar: boolean
  orientation: number
  icc: Uint8Array | null
}

interface StorageSpec {
  tiled: boolean
  tileWidth: number
  tileHeight: number
  offsets: number[]
  counts: number[]
  rowsPerStrip: number
  chunkCols: number
  across: number
  perPlane: number
  planes: number
  bytesPer: number
  samplesPerRow: number
  rowBytes: number
}

interface DecodeContext {
  bytes: Uint8Array
  le: boolean
  image: ImageSpec
  storage: StorageSpec
  out: Uint16Array | Float32Array
}

interface Chunk {
  plane: number
  col0: number
  row0: number
  rows: number
  expected: number
  raw: Uint8Array
}

function fullResolutionIfd(view: DataView, le: boolean): Ifd | null {
  // Some writers park a reduced-resolution preview in IFD0, so walk to the
  // first full-resolution image rather than trusting the first directory.
  let ifd = readIfd(view, le, view.getUint32(4, le))
  for (let guard = 0; ifd && guard < 8; guard++) {
    const sub = first(values(view, le, ifd.entries.get(TAG.subfileType)), 0)
    if (!(sub & 1)) break
    ifd = readIfd(view, le, ifd.next)
  }
  return ifd
}

function tagNumber(
  view: DataView,
  le: boolean,
  ifd: Ifd,
  tag: number,
  fallback: number,
): number {
  return first(values(view, le, ifd.entries.get(tag)), fallback)
}

function imageDimensions(
  view: DataView,
  le: boolean,
  ifd: Ifd,
): Pick<ImageSpec, 'width' | 'height'> | null {
  const width = tagNumber(view, le, ifd, TAG.width, 0)
  const height = tagNumber(view, le, ifd, TAG.height, 0)
  if (width <= 0 || height <= 0 || width * height > 1 << 30) return null
  return { width, height }
}

function sampleSpec(
  view: DataView,
  le: boolean,
  ifd: Ifd,
): Pick<
  ImageSpec,
  'depth' | 'spp' | 'photometric' | 'channels' | 'isFloat' | 'isSigned'
> | null {
  const bitsPer = values(view, le, ifd.entries.get(TAG.bits))
  const depth = bitsPer.length ? bitsPer[0] : 1
  if (![8, 16, 32].includes(depth)) return null
  if (bitsPer.some((bits) => bits !== depth)) return null

  const spp = tagNumber(view, le, ifd, TAG.samplesPerPixel, bitsPer.length || 1)
  const photometric = tagNumber(
    view,
    le,
    ifd,
    TAG.photometric,
    spp >= 3 ? 2 : 1,
  )
  if (![0, 1, 2].includes(photometric)) return null

  const channels = photometric === 2 ? 3 : 1
  if (spp < channels) return null

  const format = first(values(view, le, ifd.entries.get(TAG.sampleFormat)), 1)
  const isFloat = format === 3
  const isSigned = format === 2
  if (isFloat && depth !== 32) return null
  if (!isFloat && format !== 1 && !isSigned) return null
  return { depth, spp, photometric, channels, isFloat, isSigned }
}

function encodingSpec(
  view: DataView,
  le: boolean,
  ifd: Ifd,
  isFloat: boolean,
): Pick<ImageSpec, 'compression' | 'predictor' | 'planar' | 'orientation'> | null {
  const compression = tagNumber(view, le, ifd, TAG.compression, COMPRESSION.none)
  const predictor = tagNumber(view, le, ifd, TAG.predictor, 1)
  if (![1, 2, 3].includes(predictor)) return null
  if (predictor === 3 && !isFloat) return null
  return {
    compression,
    predictor,
    planar: tagNumber(view, le, ifd, TAG.planar, 1) === 2,
    orientation: Math.min(
      8,
      Math.max(1, tagNumber(view, le, ifd, TAG.orientation, 1)),
    ),
  }
}

function imageSpec(
  bytes: Uint8Array,
  view: DataView,
  le: boolean,
  ifd: Ifd,
): ImageSpec | null {
  const dimensions = imageDimensions(view, le, ifd)
  if (!dimensions) return null
  const samples = sampleSpec(view, le, ifd)
  if (!samples) return null
  const encoding = encodingSpec(view, le, ifd, samples.isFloat)
  if (!encoding) return null
  return {
    ...dimensions,
    ...samples,
    ...encoding,
    icc: rawBytes(bytes, view, le, ifd.entries.get(TAG.icc)),
  }
}

function storageSpec(
  view: DataView,
  le: boolean,
  ifd: Ifd,
  image: ImageSpec,
): StorageSpec | null {
  const tileWidth = tagNumber(view, le, ifd, TAG.tileWidth, 0)
  const tileHeight = tagNumber(view, le, ifd, TAG.tileLength, 0)
  const tiled = tileWidth > 0 && tileHeight > 0
  const offsetTag = tiled ? TAG.tileOffsets : TAG.stripOffsets
  const countTag = tiled ? TAG.tileByteCounts : TAG.stripByteCounts
  const offsets = values(view, le, ifd.entries.get(offsetTag))
  const counts = values(view, le, ifd.entries.get(countTag))
  if (!offsets.length || offsets.length !== counts.length) return null

  const rowsPerStrip = tiled
    ? tileHeight
    : Math.min(
        image.height,
        tagNumber(view, le, ifd, TAG.rowsPerStrip, image.height),
      )
  if (rowsPerStrip <= 0) return null

  const chunkCols = tiled ? tileWidth : image.width
  const across = tiled ? Math.ceil(image.width / tileWidth) : 1
  const perPlane = across * Math.ceil(image.height / rowsPerStrip)
  // Planar files repeat the whole chunk grid once per sample plane.
  const planes = image.planar ? image.spp : 1
  if (offsets.length < perPlane * planes) return null

  const bytesPer = image.depth >> 3
  const samplesPerRow = chunkCols * (image.planar ? 1 : image.spp)
  return {
    tiled,
    tileWidth,
    tileHeight,
    offsets,
    counts,
    rowsPerStrip,
    chunkCols,
    across,
    perPlane,
    planes,
    bytesPer,
    samplesPerRow,
    rowBytes: samplesPerRow * bytesPer,
  }
}

function chunkAt(context: DecodeContext, chunkIndex: number): Chunk | null {
  const { bytes, image, storage } = context
  const plane = image.planar
    ? Math.floor(chunkIndex / storage.perPlane)
    : 0
  // Extra samples (alpha and friends) have their own planes; skip them.
  if (image.planar && plane >= image.channels) return null

  const index = image.planar
    ? chunkIndex % storage.perPlane
    : chunkIndex
  const col0 = storage.tiled
    ? (index % storage.across) * storage.tileWidth
    : 0
  const row0 = Math.floor(index / storage.across) * storage.rowsPerStrip
  if (row0 >= image.height) return null

  const start = storage.offsets[chunkIndex]
  const size = storage.counts[chunkIndex]
  if (start < 0 || size <= 0 || start + size > bytes.length) return null

  // Tiles are always stored full size; strips are clipped by the image edge.
  const rows = storage.tiled
    ? storage.tileHeight
    : Math.min(storage.rowsPerStrip, image.height - row0)
  return {
    plane,
    col0,
    row0,
    rows,
    expected: storage.rowBytes * rows,
    raw: bytes.subarray(start, start + size),
  }
}

async function decompressChunk(
  raw: Uint8Array,
  compression: number,
  expected: number,
): Promise<Uint8Array | null | undefined> {
  switch (compression) {
    case COMPRESSION.none:
      return raw
    case COMPRESSION.lzw:
      return lzw(raw, expected)
    case COMPRESSION.deflate:
    case COMPRESSION.deflateAlt:
      return inflate(raw).catch(() => null)
    case COMPRESSION.packbits:
      return packBits(raw, expected)
    default:
      return undefined
  }
}

function applyPredictor(
  row: Uint8Array,
  context: DecodeContext,
  stride: number,
): void {
  const { image, storage, le } = context
  if (image.predictor === 2) {
    unpredictHorizontal(
      row,
      storage.samplesPerRow,
      stride,
      storage.bytesPer,
      le,
    )
  } else if (image.predictor === 3) {
    unpredictFloat(
      row,
      storage.samplesPerRow,
      stride,
      storage.bytesPer,
      le,
    )
  }
}

function integerSample(
  view: DataView,
  row: Uint8Array,
  sample: number,
  depth: number,
  isSigned: boolean,
  le: boolean,
): number {
  switch (depth) {
    case 8:
      // 257 maps 255 to exactly 65535 rather than leaving a dark gap.
      return (isSigned ? view.getInt8(sample) + 128 : row[sample]) * 257
    case 16:
      return isSigned
        ? view.getInt16(sample * 2, le) + 32768
        : view.getUint16(sample * 2, le)
    default: {
      const code = isSigned
        ? view.getInt32(sample * 4, le) + 2147483648
        : view.getUint32(sample * 4, le)
      return code / 65537
    }
  }
}

function storedSample(
  view: DataView,
  row: Uint8Array,
  sample: number,
  image: ImageSpec,
  le: boolean,
): number {
  let value: number
  if (image.isFloat) {
    value = view.getFloat32(sample * 4, le)
    // NaN and negatives are what a compositing app leaves behind in untouched
    // regions; they poison every average downstream.
    if (!(value > 0)) value = 0
  } else {
    value = integerSample(
      view,
      row,
      sample,
      image.depth,
      image.isSigned,
      le,
    )
  }
  // WhiteIsZero stores an inverted image, as scanners and fax do.
  if (image.photometric === 0) {
    return image.isFloat ? 1 - value : 65535 - value
  }
  return value
}

function writeChunkRow(
  context: DecodeContext,
  chunk: Chunk,
  row: Uint8Array,
  y: number,
  validCols: number,
): void {
  const { image, le, out } = context
  const view = new DataView(row.buffer, row.byteOffset, row.byteLength)
  const channelLimit = image.planar ? 1 : image.channels
  for (let x = 0; x < validCols; x++) {
    const output =
      (y * image.width + chunk.col0 + x) * image.channels +
      (image.planar ? chunk.plane : 0)
    for (let channel = 0; channel < channelLimit; channel++) {
      const sample = image.planar ? x : x * image.spp + channel
      out[output + channel] = storedSample(view, row, sample, image, le)
    }
  }
}

function decodeChunkRows(
  context: DecodeContext,
  chunk: Chunk,
  data: Uint8Array,
): void {
  const { image, storage } = context
  const usableRows = Math.min(
    chunk.rows,
    Math.floor(data.length / storage.rowBytes),
  )
  const stride = image.planar ? 1 : image.spp
  const validCols = Math.min(storage.chunkCols, image.width - chunk.col0)

  for (let rowIndex = 0; rowIndex < usableRows; rowIndex++) {
    const y = chunk.row0 + rowIndex
    if (y >= image.height) break
    // subarray keeps the predictor writing back into `data`, which is what the
    // next row's differencing needs.
    const row = data.subarray(
      rowIndex * storage.rowBytes,
      (rowIndex + 1) * storage.rowBytes,
    )
    applyPredictor(row, context, stride)
    writeChunkRow(context, chunk, row, y, validCols)
  }
}

async function decodeChunks(context: DecodeContext): Promise<boolean> {
  const { image, storage } = context
  for (let index = 0; index < storage.perPlane * storage.planes; index++) {
    const chunk = chunkAt(context, index)
    if (!chunk) continue
    const data = await decompressChunk(
      chunk.raw,
      image.compression,
      chunk.expected,
    )
    if (data === undefined) return false
    if (!data || data.length < storage.rowBytes) continue
    decodeChunkRows(context, chunk, data)
  }
  return true
}

export async function decodeTiff(bytes: Uint8Array): Promise<TiffImage | null> {
  if (!isTiff(bytes)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const le = bytes[0] === 0x49
  const ifd = fullResolutionIfd(view, le)
  if (!ifd) return null

  const image = imageSpec(bytes, view, le, ifd)
  if (!image) return null
  const storage = storageSpec(view, le, ifd, image)
  if (!storage) return null

  // A float TIFF is scene-linear and may carry values above 1. Quantising it
  // into 16-bit integers would clip exactly the highlights it was written to
  // preserve, so the float path keeps its own buffer.
  const out = image.isFloat
    ? new Float32Array(image.width * image.height * image.channels)
    : new Uint16Array(image.width * image.height * image.channels)
  const decoded = await decodeChunks({ bytes, le, image, storage, out })
  if (!decoded) return null
  return {
    width: image.width,
    height: image.height,
    channels: image.channels,
    data: out,
    orientation: image.orientation,
    linear: image.isFloat,
    depth: image.depth,
    icc: image.icc,
  }
}
