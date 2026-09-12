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

import {
  mul3,
  PROPHOTO_D50_TO_SRGB_D65,
  SRGB_D65_TO_PROPHOTO_D50,
  SRGB_TO_XYZ_D50,
  XYZ_D50_TO_PROPHOTO,
  type Mat3,
} from '../core/color'
import { parseIccProfile, profileFromChromaticities, type SourceProfile } from '../core/icc'
import { floatToHalf, halfToFloat, HALF_ONE } from '../core/half'
import { applyOrientationHalf, flipTransposes, orientationTransform } from './orientation'
import { findGainMap, gainLut, packUltraHdr, type GainMapMeta } from './gainmap'
import { decodeDeepPng, isDeepPng, type Chromaticities } from './png16'
import { decodeTiff, isTiff } from './tiff16'
import { classify, EMBEDDED_PREVIEW_EDGE, type LinearImage } from './decoded'

/** Writes linear sRGB D65 as linear ProPhoto D50 half-float. */
function writeWorkingHalf(
  out: Uint16Array,
  offset: number,
  r: number,
  g: number,
  b: number,
  m: Mat3 = SRGB_D65_TO_PROPHOTO_D50,
  headroom = HALF_ONE,
) {
  out[offset] = floatToHalf(m[0] * r + m[1] * g + m[2] * b)
  out[offset + 1] = floatToHalf(m[3] * r + m[4] * g + m[5] * b)
  out[offset + 2] = floatToHalf(m[6] * r + m[7] * g + m[8] * b)
  out[offset + 3] = headroom
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
 * JPEG/PNG/HEIC path: the browser already knows how to render these.
 *
 * `preserveHdr` keeps an HDR original's gain map. Re-encoding normally runs the
 * picture through a canvas, which only ever holds the base image — the map that
 * makes it HDR is dropped on the way in, and no quality setting brings it back.
 * So the two renditions are re-encoded separately and the container rebuilt
 * around them. The loupe, the grid and the Develop placeholder all show this
 * blob directly, where the browser applies the gain map itself.
 */
export async function renderedThumb(
  buffer: ArrayBuffer,
  maxEdge: number,
  quality: number,
  preserveHdr = false,
): Promise<Blob> {
  const edge = maxEdge > 0 ? maxEdge : EMBEDDED_PREVIEW_EDGE

  if (preserveHdr) {
    const hdr = await hdrThumb(buffer, edge, quality).catch(() => null)
    if (hdr) return hdr
  }

  // TIFF and 16-bit PNG have to go the long way round. No Chromium build
  // decodes TIFF at all, so `createImageBitmap` throws and the import reports a
  // blank failure — the file lands in the catalog with no thumbnail and no
  // explanation. Deep PNG would decode, but through the canvas, which quantises
  // to 8 bits and ignores the profile.
  const bytes = new Uint8Array(buffer)
  if (isTiff(bytes) || isDeepPng(bytes)) {
    const deep = await deepThumb(bytes, edge, quality)
    if (deep) return deep
  }

  const bmp = await createImageBitmap(new Blob([buffer]), { imageOrientation: 'from-image' })
  return encodeJpeg(bmp, edge, 0, quality)
}

/**
 * Scales an Ultra HDR file down without flattening it.
 *
 * Both renditions are ordinary JPEGs, so both re-encode the ordinary way. Only
 * the container around them has to be rebuilt, and only its byte offsets are
 * actually new — the metadata that describes the gain is carried across word
 * for word.
 *
 * Orientation is deliberately left alone on both. The map is stored in the
 * primary's frame, so rotating one and not the other would slide the highlights
 * off the things that are meant to be bright; leaving the primary's Exif in
 * place keeps them registered and lets the browser rotate the pair together.
 */
async function hdrThumb(buffer: ArrayBuffer, maxEdge: number, quality: number) {
  const found = findGainMap(buffer)
  if (!found) return null

  const base = await createImageBitmap(new Blob([buffer]))
  const map = await createImageBitmap(new Blob([found.bytes as BlobPart]))

  // The map is low-frequency by construction and the spec has decoders resample
  // it to the base, so it is stored at a fraction of the size. Matching the
  // base would spend most of the thumbnail's bytes describing a blur.
  const scale = Math.min(1, maxEdge / Math.max(base.width, base.height))
  const mapEdge = Math.max(1, Math.round(Math.max(map.width, map.height) * scale))

  const [baseJpeg, mapJpeg] = await Promise.all([
    encodeJpeg(base, maxEdge, 0, quality),
    encodeJpeg(map, mapEdge, 0, GAIN_MAP_QUALITY),
  ])

  const packed = packUltraHdr(
    new Uint8Array(await baseJpeg.arrayBuffer()),
    new Uint8Array(await mapJpeg.arrayBuffer()),
    found.primaryXmp,
    found.gainXmp,
  )
  return packed ? new Blob([packed as BlobPart], { type: 'image/jpeg' }) : null
}

/**
 * A gain map is a smooth ramp, not a picture, so it survives compression that
 * would visibly hurt the base — but banding in it becomes banding in the
 * highlights, which is why this is not pushed lower.
 */
const GAIN_MAP_QUALITY = 0.9

/**
 * Thumbnails a deep file by way of the working space, so the profile it carries
 * is honoured rather than assumed.
 */
async function deepThumb(
  bytes: Uint8Array,
  maxEdge: number,
  quality: number,
): Promise<Blob | null> {
  const image = await decodeDeep(bytes, maxEdge)
  if (!image) return null

  const { width: w, height: h, data } = image
  const m = PROPHOTO_D50_TO_SRGB_D65
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let i = 0, o = 0; i < w * h; i++, o += 4) {
    const r = halfToFloat(data[o])
    const g = halfToFloat(data[o + 1])
    const b = halfToFloat(data[o + 2])
    rgba[o] = encodeSrgb(m[0] * r + m[1] * g + m[2] * b) * 255
    rgba[o + 1] = encodeSrgb(m[3] * r + m[4] * g + m[5] * b) * 255
    rgba[o + 2] = encodeSrgb(m[6] * r + m[7] * g + m[8] * b) * 255
    rgba[o + 3] = 255
  }

  const bmp = await createImageBitmap(new ImageData(rgba, w, h))
  return encodeJpeg(bmp, maxEdge, 0, quality)
}

const encodeSrgb = (v: number): number => {
  if (!(v > 0)) return 0
  if (v >= 1) return 1
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

/** TIFF and deep PNG, decoded to the working space with their own profile. */
async function decodeDeep(bytes: Uint8Array, maxEdge: number): Promise<LinearImage | null> {
  if (isDeepPng(bytes)) {
    const png = await decodeDeepPng(bytes).catch(() => null)
    return png ? samplesToLinear(png, maxEdge, false, sourceProfile(png)) : null
  }
  if (isTiff(bytes)) {
    const tif = await decodeTiff(bytes).catch(() => null)
    if (!tif) return null
    const image = samplesToLinear(tif, maxEdge, tif.linear, sourceProfile(tif))
    return orientLinear(image, EXIF_TO_FLIP[tif.orientation - 1] ?? 0)
  }
  return null
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
  // A monochrome sensor gives one channel. Reading three anyway steps into the
  // following pixels and stains a grey frame with colour.
  const grey = channels < 3
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
          if (grey) {
            const v = data[si] as number
            r += v
            g += v
            b += v
          } else {
            r += data[si] as number
            g += data[si + 1] as number
            b += data[si + 2] as number
          }
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

/**
 * Samples a profile's tone curve into the same 16-bit table shape sRGB uses.
 *
 * Cached against the profile itself, because a folder import decodes many files
 * that all carry the identical embedded profile.
 */
const profileLUTs = new WeakMap<SourceProfile, Float32Array[]>()
function profileLUT(profile: SourceProfile): Float32Array[] {
  const cached = profileLUTs.get(profile)
  if (cached) return cached
  // Identical curves — the common case — share one table rather than three.
  const built = new Map<(v: number) => number, Float32Array>()
  const luts = profile.toLinear.map((f) => {
    const hit = built.get(f)
    if (hit) return hit
    const lut = new Float32Array(65536)
    for (let i = 0; i < 65536; i++) lut[i] = f(i / 65535)
    built.set(f, lut)
    return lut
  })
  profileLUTs.set(profile, luts)
  return luts
}

/** Reads a decoder's colour tags into a profile, or null to mean "assume sRGB". */
function sourceProfile(src: {
  icc: Uint8Array | null
  gamma?: number | null
  chrm?: Chromaticities | null
}): SourceProfile | null {
  if (src.icc) {
    const parsed = parseIccProfile(src.icc)
    if (parsed) return parsed
  }
  return profileFromChromaticities(
    src.gamma ?? null,
    src.chrm ?? null,
    SRGB_TO_XYZ_D50,
  )
}

/** JPEG/PNG/TIFF/HEIC path: decode, undo sRGB, hand back linear half-float. */
export async function decodeRenderedLinear(
  buffer: ArrayBuffer,
  maxEdge: number,
): Promise<LinearImage> {
  // A 16-bit PNG has to bypass the canvas, which would quantise it to 8 bits
  // before we ever see it, and TIFF has to bypass it because no Chromium build
  // decodes TIFF at all.
  const bytes = new Uint8Array(buffer)
  const deep = await decodeDeep(bytes, maxEdge)
  if (deep) return deep

  let bmp: ImageBitmap
  try {
    // 'from-image' makes the browser honour the EXIF orientation tag for us,
    // which is why rendered files skip applyOrientationHalf entirely.
    bmp = await createImageBitmap(new Blob([buffer]), { imageOrientation: 'from-image' })
  } catch (err) {
    throw classify(err)
  }

  // A gain map is the only way a rendered file carries light above white into
  // the pipeline. Without this the Develop viewport would hold a phone's HDR
  // photo at exactly the SDR base the canvas handed over, and the HDR toggle
  // would have nothing to open up.
  const gain = await loadGainMap(buffer, bmp)
  return bitmapToLinear(bmp, maxEdge, false, gain)
}

/**
 * Decodes a JPEG's gain map alongside its base image.
 *
 * Failure is answered with null rather than an error: a file whose secondary
 * image will not decode is still a perfectly good SDR photograph, and refusing
 * to open it would be a far worse outcome than showing it without its
 * highlights.
 */
async function loadGainMap(buffer: ArrayBuffer, base: ImageBitmap): Promise<GainMapSource | null> {
  const found = findGainMap(buffer)
  if (!found) return null
  try {
    // The map's own orientation metadata is explicitly not used; it is already
    // in the primary's frame. But the primary was decoded with 'from-image', so
    // the map has to be rotated the same way to stay registered with it.
    const bitmap = await createImageBitmap(new Blob([found.bytes as BlobPart]), {
      imageOrientation: 'from-image',
      resizeWidth: base.width,
      resizeHeight: base.height,
      resizeQuality: 'high',
    })
    return { bitmap, lut: gainLut(found.meta), meta: found.meta }
  } catch {
    return null
  }
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
 * convention and running any curve over them would crush the shadows. The
 * profile's *matrix* still applies: a float file is linear, not sRGB-primaried.
 *
 * `profile` is the file's own colour space when it declared one. Without it the
 * file is assumed to be sRGB, which is the safe guess for an untagged image but
 * badly wrong for a ProPhoto export — including one of esque's own.
 *
 * Orientation is applied by the caller: PNG has none of its own, and TIFF's
 * lives in a tag the caller has already read.
 */
function sampleReaders(
  data: Uint16Array | Float32Array,
  alreadyLinear: boolean,
  profile: SourceProfile | null,
) {
  const lut = alreadyLinear ? null : profile ? profileLUT(profile) : null
  const srgb = alreadyLinear || profile ? null : getSrgb16LUT()
  const raw =
    data instanceof Float32Array ? (value: number) => value : (value: number) => value / 65535
  return {
    r: lut ? (value: number) => lut[0][value] : srgb ? (value: number) => srgb[value] : raw,
    g: lut ? (value: number) => lut[1][value] : srgb ? (value: number) => srgb[value] : raw,
    b: lut ? (value: number) => lut[2][value] : srgb ? (value: number) => srgb[value] : raw,
  }
}

function samplesToLinear(
  src: { width: number; height: number; channels: number; data: Uint16Array | Float32Array },
  maxEdge: number,
  alreadyLinear: boolean,
  profile: SourceProfile | null = null,
): LinearImage {
  const { width: sw, height: sh, channels, data } = src
  const grey = channels < 3
  const toWorking = profile ? mul3(XYZ_D50_TO_PROPHOTO, profile.toXyzD50) : SRGB_D65_TO_PROPHOTO_D50
  const value = sampleReaders(data, alreadyLinear, profile)

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
            // One channel replicated, so it takes the red curve: a grey
            // profile's 'kTRC' is what all three were built from anyway.
            const v = value.r(data[si])
            r += v
            g += v
            b += v
          } else {
            r += value.r(data[si])
            g += value.g(data[si + 1])
            b += value.b(data[si + 2])
          }
          si += channels
          n++
        }
      }
      const o = (y * dw + x) * 4
      writeWorkingHalf(out, o, r / n, g / n, b / n, toWorking)
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

/** A decoded gain map, resampled to the base image and reduced to a LUT. */
interface GainMapSource {
  bitmap: ImageBitmap
  /** 8-bit sample -> linear multiplier, per channel. */
  lut: Float32Array[]
  meta: GainMapMeta
}

/**
 * Shared tail of every rendered-image decode.
 *
 * A gain map does not change the colours this produces. It rides in alpha as
 * the ratio each pixel would reach on a display with room for it, which is the
 * same thing the RAW path's shoulder records and the same thing the output
 * pass knows how to spend.
 */
export function bitmapToLinear(
  bmp: ImageBitmap,
  maxEdge: number,
  fromRaw: boolean,
  gain: GainMapSource | null = null,
): LinearImage {
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

  // The map is drawn through the same canvas at the same size, so the browser
  // does the resampling the spec asks for and the two arrays index alike.
  let map: Uint8ClampedArray | null = null
  if (gain) {
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(gain.bitmap, 0, 0, w, h)
    map = ctx.getImageData(0, 0, w, h).data
    gain.bitmap.close()
  }

  const lut = getSrgbLUT()
  const out = new Uint16Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const s = i * 4
    const r = lut[px[s]]
    const g = lut[px[s + 1]]
    const b = lut[px[s + 2]]
    writeWorkingHalf(out, s, r, g, b, SRGB_D65_TO_PROPHOTO_D50, headroomAt(gain, map, s, r, g, b))
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

/**
 * How much brighter than its SDR rendering one pixel wants to be.
 *
 * The colour channels deliberately keep the base image's own values. That base
 * *is* the SDR photograph — the rendering the phone chose, the one every other
 * viewer shows — and multiplying the gain into it would blow every highlight
 * the map covers to flat white the moment HDR was switched off. So the map is
 * carried alongside as a ratio instead, in the alpha channel nothing else uses,
 * and only the output pass spends it.
 *
 * The ratio is taken on the brightest channel so the expansion later stays a
 * single scale and cannot shift hue, and it is floored at 1: a map may encode
 * a boost below 1, but the SDR base is the reference rendering here, and HDR
 * viewing is only ever allowed to add range to it.
 */
function headroomAt(
  gain: GainMapSource | null,
  map: Uint8ClampedArray | null,
  offset: number,
  r: number,
  g: number,
  b: number,
): number {
  if (!gain || !map) return HALF_ONE
  const { lut, meta } = gain
  // A single-channel map decodes to equal RGB, so reading three channels
  // covers the grey and the per-channel cases with the same arithmetic.
  const hr = (r + meta.offsetSdr[0]) * lut[0][map[offset]] - meta.offsetHdr[0]
  const hg = (g + meta.offsetSdr[1]) * lut[1][map[offset + 1]] - meta.offsetHdr[1]
  const hb = (b + meta.offsetSdr[2]) * lut[2][map[offset + 2]] - meta.offsetHdr[2]
  const sdr = Math.max(r, g, b)
  if (!(sdr > 0)) return HALF_ONE
  const ratio = Math.max(hr, hg, hb) / sdr
  return floatToHalf(ratio > 1 ? ratio : 1)
}
