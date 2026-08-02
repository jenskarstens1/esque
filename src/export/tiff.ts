/**
 * Baseline TIFF writer.
 *
 * The browser can encode JPEG, PNG and WebP but not TIFF, and TIFF is the only
 * one of the four that carries 16 bits per channel — which is the whole point
 * of a linear-light editor. Baseline uncompressed RGB with an optional Adobe
 * Deflate stream is enough for every reader that matters (Photoshop, Capture
 * One, Preview, ImageMagick, Pillow).
 */
import { resolutionUnitCode } from './exif'
import {
  IfdType,
  ascii,
  assembleTiff,
  long,
  rational,
  short,
  undefinedBytes,
  type IfdEntry,
} from './ifd'
import type { ResolutionUnit } from './types'

export interface TiffOptions {
  width: number
  height: number
  /** 8 or 16 bits per channel; data must match. */
  depth: 8 | 16
  /** Interleaved RGB, no alpha. */
  data: Uint8Array | Uint16Array
  icc?: Uint8Array | null
  /** Adobe Deflate (tag 8). Roughly halves a typical photo. */
  compress?: boolean
  resolution?: number
  resolutionUnit?: ResolutionUnit
  software?: string
  /** Descriptive tags and EXIF/GPS sub-IFDs, from `exif.ts`. */
  metadata?: IfdEntry[]
  /** XMP packet written to tag 700. */
  xmp?: string
}

export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  // 'deflate' emits a zlib wrapper, which is exactly what Adobe Deflate wants.
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** UTF-8 bytes for an XMP packet, which TIFF stores as an untyped byte run. */
export function xmpBytes(xml: string): Uint8Array {
  return new TextEncoder().encode(xml)
}

/** Little-endian on the wire, which is what TIFF's 'II' header promises. */
function toBytes(data: Uint8Array | Uint16Array, depth: 8 | 16): Uint8Array {
  if (depth !== 16) return data as Uint8Array
  const src = data as Uint16Array
  const out = new Uint8Array(src.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < src.length; i++) view.setUint16(i * 2, src[i], true)
  return out
}

export async function encodeTiff(opts: TiffOptions): Promise<Blob> {
  const { width, height, depth } = opts
  const compress = opts.compress !== false
  const pixels = toBytes(opts.data, depth)
  const body = compress ? await deflate(pixels) : pixels

  const res = Math.max(1, Math.round(opts.resolution ?? 300))
  const entries: IfdEntry[] = [
    long(256, width), // ImageWidth
    long(257, height), // ImageLength
    short(258, depth, depth, depth), // BitsPerSample
    short(259, compress ? 8 : 1), // Compression
    short(262, 2), // PhotometricInterpretation: RGB
    { tag: 273, type: IfdType.LONG, value: [0], stripOffset: true }, // StripOffsets
    short(277, 3), // SamplesPerPixel
    long(278, height), // RowsPerStrip
    long(279, body.length), // StripByteCounts
    rational(282, res), // XResolution
    rational(283, res), // YResolution
    short(284, 1), // PlanarConfiguration: chunky
    short(296, resolutionUnitCode(opts.resolutionUnit ?? 'inch')),
    ...(opts.metadata ?? []),
  ]
  if (compress) entries.push(short(317, 1)) // Predictor: none
  if (opts.software) entries.push(ascii(305, opts.software))
  if (opts.xmp) entries.push(undefinedBytes(700, xmpBytes(opts.xmp)))
  if (opts.icc?.length) entries.push(undefinedBytes(34675, opts.icc))

  const head = assembleTiff({ entries, stripLength: body.length })
  return new Blob([head as BlobPart, body as BlobPart], { type: 'image/tiff' })
}

/** Strips alpha and, for 16-bit, keeps the full precision. */
export function rgbaToRgb(
  data: Uint8ClampedArray | Uint16Array,
  pixels: number,
): Uint8Array | Uint16Array {
  if (data instanceof Uint16Array) {
    const out = new Uint16Array(pixels * 3)
    for (let i = 0; i < pixels; i++) {
      out[i * 3] = data[i * 4]
      out[i * 3 + 1] = data[i * 4 + 1]
      out[i * 3 + 2] = data[i * 4 + 2]
    }
    return out
  }
  const out = new Uint8Array(pixels * 3)
  for (let i = 0; i < pixels; i++) {
    out[i * 3] = data[i * 4]
    out[i * 3 + 1] = data[i * 4 + 1]
    out[i * 3 + 2] = data[i * 4 + 2]
  }
  return out
}
