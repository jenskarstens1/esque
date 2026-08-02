/**
 * Linear DNG writer.
 *
 * "Export original" hands back the camera's own file, which is useful but
 * cannot travel with anything esque knows. A **linear DNG** is the other half
 * of that story: the demosaiced, white-balanced, scene-linear pixels straight
 * out of the decoder, wrapped in a real digital negative that Lightroom,
 * Camera Raw and Capture One will happily develop from scratch.
 *
 * Nothing from the Develop module is baked into the pixels — that is what makes
 * it a negative rather than a rendering. The develop settings ride along in the
 * embedded XMP packet instead, in Camera Raw's own `crs:` namespace, so
 * reopening the file elsewhere lands on the same starting point.
 *
 * The colour story is simple because the working space is fixed: esque edits in
 * linear ProPhoto (D50), so ProPhoto *is* the camera space this DNG declares.
 * ColorMatrix1 is therefore XYZ(D50) → ProPhoto, ForwardMatrix1 its inverse,
 * and the image is already balanced so AsShotNeutral is a flat 1,1,1.
 */
import { PROPHOTO_TO_XYZ_D50, XYZ_D50_TO_PROPHOTO } from '../core/color'
import { resolutionUnitCode } from './exif'
import {
  IfdType,
  ascii,
  assembleTiff,
  byte,
  long,
  rational,
  short,
  srational,
  undefinedBytes,
  type IfdEntry,
} from './ifd'
import { xmpBytes } from './tiff'
import type { ResolutionUnit } from './types'

/** CalibrationIlluminant value for D50, the white point ProPhoto is built on. */
const ILLUMINANT_D50 = 23
/** PhotometricInterpretation for demosaiced raw. */
const LINEAR_RAW = 34892

export interface DngOptions {
  width: number
  height: number
  /** Interleaved 16-bit RGB, scene-linear, no alpha. */
  data: Uint16Array
  uniqueCameraModel: string
  resolution?: number
  resolutionUnit?: ResolutionUnit
  software?: string
  /** Descriptive tags and EXIF/GPS sub-IFDs, from `exif.ts`. */
  metadata?: IfdEntry[]
  /** Camera Raw settings packet, written to tag 700. */
  xmp?: string
  /** Default-render compensation for values normalised to the integer ceiling. */
  baselineExposure?: number
}

/** Half-float bit pattern → 16-bit code value, via a table built once. */
let halfToCode: Uint16Array | null = null
let halfToCodeWhiteLevel = 0

function halfTable(whiteLevel: number): Uint16Array {
  if (halfToCode && Math.abs(whiteLevel - halfToCodeWhiteLevel) < 1e-6) return halfToCode
  const out = new Uint16Array(65536)
  const buf = new ArrayBuffer(4)
  const u32 = new Uint32Array(buf)
  const f32 = new Float32Array(buf)
  for (let h = 0; h < 65536; h++) {
    const sign = (h & 0x8000) << 16
    let exponent = (h >> 10) & 0x1f
    let mantissa = h & 0x3ff
    if (exponent === 0) {
      if (mantissa === 0) {
        u32[0] = sign
      } else {
        // Subnormal: renormalise into a float32 exponent.
        exponent = 1
        while (!(mantissa & 0x400)) {
          mantissa <<= 1
          exponent--
        }
        mantissa &= 0x3ff
        u32[0] = sign | ((exponent + 112) << 23) | (mantissa << 13)
      }
    } else if (exponent === 0x1f) {
      u32[0] = sign | 0x7f800000 | (mantissa << 13)
    } else {
      u32[0] = sign | ((exponent + 112) << 23) | (mantissa << 13)
    }
    const v = f32[0] / whiteLevel
    out[h] = v > 0 ? (v >= 1 ? 65535 : Math.round(v * 65535)) : 0
  }
  halfToCode = out
  halfToCodeWhiteLevel = whiteLevel
  return out
}

/**
 * Half-float RGBA → 16-bit RGB.
 *
 * The working buffer keeps RAW headroom above 1. Integer DNG cannot, so the
 * decoder's ceiling is mapped to WhiteLevel and BaselineExposure tells a DNG
 * reader how to restore the working brightness for its default rendering.
 */
export function halfRgbaToRgb16(
  data: Uint16Array,
  pixels: number,
  whiteLevel = 1,
): Uint16Array {
  const safeWhite = Number.isFinite(whiteLevel) && whiteLevel >= 1 ? whiteLevel : 1
  const lut = halfTable(safeWhite)
  const out = new Uint16Array(pixels * 3)
  for (let i = 0; i < pixels; i++) {
    const s = i * 4
    const o = i * 3
    out[o] = lut[data[s]]
    out[o + 1] = lut[data[s + 1]]
    out[o + 2] = lut[data[s + 2]]
  }
  return out
}

export function encodeDng(opts: DngOptions): Blob {
  const { width, height, data } = opts
  const samples = 3

  const body = new Uint8Array(data.length * 2)
  const view = new DataView(body.buffer)
  for (let i = 0; i < data.length; i++) view.setUint16(i * 2, data[i], true)

  const res = Math.max(1, Math.round(opts.resolution ?? 300))
  const entries: IfdEntry[] = [
    long(254, 0), // NewSubfileType: full-resolution image
    long(256, width), // ImageWidth
    long(257, height), // ImageLength
    short(258, 16, 16, 16), // BitsPerSample
    // Uncompressed. DNG's Deflate mode is only safe for floating-point data, and
    // a negative that half the readers reject is worse than a large one.
    short(259, 1), // Compression
    short(262, LINEAR_RAW), // PhotometricInterpretation
    { tag: 273, type: IfdType.LONG, value: [0], stripOffset: true }, // StripOffsets
    short(274, 1), // Orientation: the decoder already rotated the pixels
    short(277, samples), // SamplesPerPixel
    long(278, height), // RowsPerStrip
    long(279, body.length), // StripByteCounts
    rational(282, res), // XResolution
    rational(283, res), // YResolution
    short(284, 1), // PlanarConfiguration: chunky
    short(296, resolutionUnitCode(opts.resolutionUnit ?? 'inch')),

    long(50717, 65535, 65535, 65535), // WhiteLevel
    byte(50706, 1, 4, 0, 0), // DNGVersion 1.4.0.0
    byte(50707, 1, 1, 0, 0), // DNGBackwardVersion: readable by DNG 1.1 tools
    ascii(50708, opts.uniqueCameraModel.slice(0, 63) || 'esque linear'),
    srational(50721, ...XYZ_D50_TO_PROPHOTO), // ColorMatrix1: XYZ(D50) → ProPhoto
    rational(50727, 1, 1, 1), // AnalogBalance
    rational(50728, 1, 1, 1), // AsShotNeutral: already white balanced
    srational(50730, opts.baselineExposure ?? 0), // BaselineExposure
    short(50778, ILLUMINANT_D50), // CalibrationIlluminant1
    srational(50964, ...PROPHOTO_TO_XYZ_D50), // ForwardMatrix1
    ...(opts.metadata ?? []),
  ]
  if (opts.software) entries.push(ascii(305, opts.software))
  if (opts.xmp) entries.push(undefinedBytes(700, xmpBytes(opts.xmp)))

  const head = assembleTiff({ entries, stripLength: body.length })
  return new Blob([head as BlobPart, body as BlobPart], { type: 'image/x-adobe-dng' })
}
