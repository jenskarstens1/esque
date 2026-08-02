/**
 * The decode path for files the browser already understands.
 *
 * JPEG, PNG, HEIC, WebP and TIFF need no demosaic — `createImageBitmap` does
 * the work — but they still have to arrive in the same linear ProPhoto
 * half-float the RAW path produces, or the renderer would need two modes. So
 * this module undoes the sRGB curve, converts the primaries and applies EXIF
 * orientation, and hands back the identical `LinearImage`.
 *
 * The RAW path borrows the JPEG encoders here for its own thumbnails: a
 * camera's embedded preview is an ordinary JPEG once LibRaw has handed it over.
 */

import { SRGB_D65_TO_PROPHOTO_D50 } from '../core/color'
import { floatToHalf, HALF_ONE } from '../core/half'
import { applyOrientationHalf, flipTransposes, orientationTransform } from './orientation'
import { decodeDeepPng, isDeepPng } from './png16'
import { decodeTiff, isTiff } from './tiff16'
import { classify, EMBEDDED_PREVIEW_EDGE, type LinearImage } from './decoded'

/** Writes linear sRGB D65 as linear ProPhoto D50 half-float. */
function writeWorkingHalf(
  out: Uint16Array,
  offset: number,
  r: number,
  g: number,
  b: number,
) {
  const m = SRGB_D65_TO_PROPHOTO_D50
  out[offset] = floatToHalf(m[0] * r + m[1] * g + m[2] * b)
  out[offset + 1] = floatToHalf(m[3] * r + m[4] * g + m[5] * b)
  out[offset + 2] = floatToHalf(m[6] * r + m[7] * g + m[8] * b)
  out[offset + 3] = HALF_ONE
}

/** 8-bit source (rendered files) -> linear float, undoing the sRGB curve. */
let srgbToLinear: Float32Array | null = null
function getSrgbLUT(): Float32Array {
  if (!srgbToLinear) {
    srgbToLinear = new Float32Array(256)
    for (let i = 0; i < 256; i++) {
      const c = i / 255
      const lin = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
      srgbToLinear[i] = lin
    }
  }
  return srgbToLinear
}

/**
 * The same curve at 16 bits, kept as float rather than half because deep PNGs
 * are averaged *after* linearisation and the accumulator needs the headroom.
 * 256 KB, built once and only when a 16-bit file actually shows up.
 */
let srgb16ToLinear: Float32Array | null = null
function getSrgb16LUT(): Float32Array {
  if (!srgb16ToLinear) {
    srgb16ToLinear = new Float32Array(65536)
    for (let i = 0; i < 65536; i++) {
      const c = i / 65535
      srgb16ToLinear[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    }
  }
  return srgb16ToLinear
}

export async function encodeJpeg(
  bitmap: ImageBitmap,
  maxEdge: number,
  flip: number,
  quality: number,
): Promise<Blob> {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const sw = Math.max(1, Math.round(bitmap.width * scale))
  const sh = Math.max(1, Math.round(bitmap.height * scale))
  const o = orientationTransform(flip, sw, sh)

  const canvas = new OffscreenCanvas(o.w, o.h)
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  const [ta, tb, tc, td, te, tf] = o.transform
  ctx.setTransform(ta, tb, tc, td, te, tf)
  ctx.drawImage(bitmap, 0, 0, sw, sh)
  bitmap.close()
  return canvas.convertToBlob({ type: 'image/jpeg', quality })
}

/**
 * How much of a file to read looking for a gain map.
 *
 * Every container announces one in metadata near the front — a JPEG's XMP sits
 * in an APP1 segment a few kilobytes in — so the pixels never have to be
 * touched. A quarter of a megabyte clears even a file carrying a full Exif
 * thumbnail ahead of its XMP.
 */
const GAIN_MAP_SCAN_BYTES = 256 * 1024

/**
 * Above this, handing back the original costs more memory and cache than the
 * extra range is worth: the preview would decode at the full sensor size every
 * time the loupe opened it. Phone HDR files land around 2–5 MB.
 */
const GAIN_MAP_MAX_BYTES = 32 * 1024 * 1024

const GAIN_MAP_MARKERS = [
  'hdrgm:', // Ultra HDR's XMP namespace prefix
  'urn:iso:std:iso:ts:21496', // ISO 21496-1, the standardised gain map
  'GainMap', // the multi-picture container's item semantic
]

/**
 * Whether a rendered file is a JPEG carrying an HDR gain map.
 *
 * Only JPEG qualifies, for two reasons: it is what phones and Lightroom
 * actually write gain maps into, and it is what the preview cache stores, so a
 * file passed through still matches the type the cache hands back. HEIC can't
 * be drawn by the browser at all and has to be re-encoded regardless.
 */
function hasGainMap(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength > GAIN_MAP_MAX_BYTES) return false
  const bytes = new Uint8Array(buffer)
  // SOI plus the first byte of the marker that must follow it.
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return false
  const head = new TextDecoder('latin1').decode(
    bytes.subarray(0, Math.min(bytes.length, GAIN_MAP_SCAN_BYTES)),
  )
  return GAIN_MAP_MARKERS.some((m) => head.includes(m))
}

/**
 * JPEG/PNG/HEIC path: the browser already knows how to render these.
 *
 * `preserveHdr` hands an HDR original straight back instead. Re-encoding runs
 * the picture through a canvas, which only ever holds the base image — the gain
 * map that makes it HDR is dropped on the way in, and no quality setting brings
 * it back. The loupe and the Develop placeholder show this blob in an `<img>`,
 * where the browser applies the gain map itself.
 */
export async function renderedThumb(
  buffer: ArrayBuffer,
  maxEdge: number,
  quality: number,
  preserveHdr = false,
): Promise<Blob> {
  if (preserveHdr && hasGainMap(buffer)) return new Blob([buffer], { type: 'image/jpeg' })
  const bmp = await createImageBitmap(new Blob([buffer]), { imageOrientation: 'from-image' })
  return encodeJpeg(bmp, maxEdge > 0 ? maxEdge : EMBEDDED_PREVIEW_EDGE, 0, quality)
}

export async function imageDataToJpeg(
  data: Uint8Array | Uint16Array,
  w: number,
  h: number,
  channels: number,
  bits: number,
  maxEdge: number,
  flip: number,
  quality: number,
): Promise<Blob> {
  const scale = Math.min(1, maxEdge / Math.max(w, h))
  const dw = Math.max(1, Math.round(w * scale))
  const dh = Math.max(1, Math.round(h * scale))
  const rgba = new Uint8ClampedArray(dw * dh * 4)
  const shift = bits === 16 ? 8 : 0
  const xRatio = w / dw
  const yRatio = h / dh

  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * yRatio)
    const y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) * yRatio)))
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * xRatio)
      const x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) * xRatio)))
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let sy = y0; sy < y1; sy++) {
        let si = (sy * w + x0) * channels
        for (let sx = x0; sx < x1; sx++) {
          r += data[si] as number
          g += data[si + 1] as number
          b += data[si + 2] as number
          si += channels
          n++
        }
      }
      const o = (y * dw + x) * 4
      rgba[o] = (r / n) >> shift
      rgba[o + 1] = (g / n) >> shift
      rgba[o + 2] = (b / n) >> shift
      rgba[o + 3] = 255
    }
  }

  const bmp = await createImageBitmap(new ImageData(rgba, dw, dh))
  return encodeJpeg(bmp, maxEdge, flip, quality)
}

/** JPEG/PNG/TIFF/HEIC path: decode, undo sRGB, hand back linear half-float. */
export async function decodeRenderedLinear(
  buffer: ArrayBuffer,
  maxEdge: number,
): Promise<LinearImage> {
  // A 16-bit PNG has to bypass the canvas, which would quantise it to 8 bits
  // before we ever see it.
  const bytes = new Uint8Array(buffer)
  if (isDeepPng(bytes)) {
    const png = await decodeDeepPng(bytes).catch(() => null)
    if (png) return samplesToLinear(png, maxEdge, false)
  }

  // TIFF isn't a precision problem but an availability one: no Chromium build
  // decodes it at all, so without this a .tif import simply fails.
  if (isTiff(bytes)) {
    const tif = await decodeTiff(bytes).catch(() => null)
    if (tif) {
      const image = samplesToLinear(tif, maxEdge, tif.linear)
      return orientLinear(image, EXIF_TO_FLIP[tif.orientation - 1] ?? 0)
    }
  }

  let bmp: ImageBitmap
  try {
    // 'from-image' makes the browser honour the EXIF orientation tag for us,
    // which is why rendered files skip applyOrientationHalf entirely.
    bmp = await createImageBitmap(new Blob([buffer]), { imageOrientation: 'from-image' })
  } catch (err) {
    throw classify(err)
  }
  return bitmapToLinear(bmp, maxEdge, false)
}

/**
 * EXIF orientation (1..8) to LibRaw's dcraw flip bitfield, which is what
 * `applyOrientationHalf` speaks. Derived rather than guessed: the bitfield
 * mirrors first and transposes second, so e.g. 90° CW is mirror-vertical plus
 * transpose, which is 6.
 */
const EXIF_TO_FLIP = [0, 1, 3, 2, 4, 6, 7, 5]

/** Rotates a decoded image and repairs the full-resolution bookkeeping. */
export function orientLinear(image: LinearImage, flip: number): LinearImage {
  if (!flip) return image
  const oriented = applyOrientationHalf(image.data, image.width, image.height, flip)
  const rotated = flipTransposes(flip)
  const fullWidth = rotated ? image.fullHeight : image.fullWidth
  const fullHeight = rotated ? image.fullWidth : image.fullHeight
  return {
    ...oriented,
    scale: oriented.width / fullWidth,
    fullWidth,
    fullHeight,
    fromRaw: image.fromRaw,
    meta: image.meta,
    whiteLevel: image.whiteLevel,
  }
}

/**
 * Box-downsamples 16-bit integer samples straight into linear half-float RGBA.
 *
 * The transfer curve is undone *before* averaging — averaging sRGB code values
 * is the classic way to get a muddy, too-dark downsample. Alpha is dropped, as
 * everywhere else in the pipeline.
 *
 * `alreadyLinear` covers float TIFFs, where scene-linear values are the
 * convention and running the sRGB curve over them would crush the shadows.
 *
 * Orientation is applied by the caller: PNG has none of its own, and TIFF's
 * lives in a tag the caller has already read.
 */
function samplesToLinear(
  src: { width: number; height: number; channels: number; data: Uint16Array },
  maxEdge: number,
  alreadyLinear: boolean,
): LinearImage {
  const lut = alreadyLinear ? null : getSrgb16LUT()
  const { width: sw, height: sh, channels, data } = src
  const grey = channels < 3
  const value = (v: number) => (lut ? lut[v] : v / 65535)

  const scale = Math.min(1, maxEdge / Math.max(sw, sh))
  const dw = Math.max(1, Math.round(sw * scale))
  const dh = Math.max(1, Math.round(sh * scale))
  const out = new Uint16Array(dw * dh * 4)
  const xRatio = sw / dw
  const yRatio = sh / dh

  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * yRatio)
    const y1 = Math.min(sh, Math.max(y0 + 1, Math.floor((y + 1) * yRatio)))
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * xRatio)
      const x1 = Math.min(sw, Math.max(x0 + 1, Math.floor((x + 1) * xRatio)))
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let sy = y0; sy < y1; sy++) {
        let si = (sy * sw + x0) * channels
        for (let sx = x0; sx < x1; sx++) {
          if (grey) {
            const v = value(data[si])
            r += v
            g += v
            b += v
          } else {
            r += value(data[si])
            g += value(data[si + 1])
            b += value(data[si + 2])
          }
          si += channels
          n++
        }
      }
      const o = (y * dw + x) * 4
      writeWorkingHalf(out, o, r / n, g / n, b / n)
    }
  }

  return {
    width: dw,
    height: dh,
    data: out,
    scale,
    fullWidth: sw,
    fullHeight: sh,
    fromRaw: false,
    meta: null,
    whiteLevel: 1,
  }
}

/** Shared tail of every rendered-image decode. */
export function bitmapToLinear(bmp: ImageBitmap, maxEdge: number, fromRaw: boolean): LinearImage {
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bmp, 0, 0, w, h)
  const full = { w: bmp.width, h: bmp.height }
  bmp.close()

  const px = ctx.getImageData(0, 0, w, h).data
  const lut = getSrgbLUT()
  const out = new Uint16Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const s = i * 4
    const r = lut[px[s]]
    const g = lut[px[s + 1]]
    const b = lut[px[s + 2]]
    writeWorkingHalf(out, s, r, g, b)
  }
  return {
    width: w,
    height: h,
    data: out,
    scale,
    fullWidth: full.w,
    fullHeight: full.h,
    fromRaw,
    meta: null,
    whiteLevel: 1,
  }
}
