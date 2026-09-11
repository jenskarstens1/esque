/**
 * RAW decode worker, and the Comlink surface the pool talks to.
 *
 * Runs off the main thread and wraps libraw-wasm (which spins up its own nested
 * worker for the actual C++ decode). Everything expensive that isn't LibRaw
 * itself — half-float conversion, box downsampling, JPEG encoding — happens here
 * so the UI thread never stalls while a 45 MP file is being processed.
 *
 * Files the browser can already decode never reach LibRaw at all; that path
 * lives in `./rendered`, and `./decoded` holds the vocabulary both speak.
 */

import * as Comlink from 'comlink'
import LibRaw from 'libraw-wasm'
import type {
  LibRawImageData,
  LibRawMetadata,
  LibRawSettings,
} from 'libraw-wasm'
import { floatToHalf, HALF_ONE } from '../core/half'
import { LINEAR_SETTINGS } from './settings'
import { flipTransposes } from './orientation'
import { bandMargin, XTRANS_FILTERS, type BandRequest, type BandResult } from './bands'
import {
  classify,
  EMBEDDED_PREVIEW_EDGE,
  RawError,
  type DecodedMeta,
  type IngestResult,
  type LinearImage,
  type RawCrop,
  type RawDecodeQuality,
} from './decoded'
import {
  bitmapToLinear,
  decodeRenderedLinear,
  imageDataToJpeg,
  encodeJpeg,
  orientLinear,
  renderedThumb,
} from './rendered'

// ---------------------------------------------------------------------------
// Working-space decode settings
// ---------------------------------------------------------------------------

function demosaicSettings(
  xtrans: boolean,
  quality: RawDecodeQuality = 'full',
): LibRawSettings {
  if (quality === 'interactive') return { userQual: xtrans ? 1 : 3 }
  return xtrans
    ? { userQual: 3 }
    : { userQual: 4, dcbIterations: 3, dcbEnhanceFl: true }
}

/**
 * FBDD removes chroma outliers before interpolation can spread them into larger
 * red/blue speckles. LibRaw's full-frame wavelet pass used to run here as well,
 * but on a 21 MP RAW it accounted for roughly half of the entire proxy decode
 * while duplicating the adjustable luminance denoise already done by the GPU.
 */
function rawNoiseSettings(iso: number | undefined): LibRawSettings {
  if (typeof iso !== 'number' || !Number.isFinite(iso) || iso <= 800) return {}
  return { fbddNoiserd: 1 }
}

/** Display-referred settings, only for generating the cached preview JPEG. */
const PREVIEW_SETTINGS: LibRawSettings = {
  outputColor: 1,
  outputBps: 8,
  noAutoBright: false,
  useCameraWb: true,
  useCameraMatrix: 1,
  halfSize: true,
  highlight: 2,
}

/**
 * JPEG quality for catalog thumbnails. High enough that a 512px tile shows no
 * ringing on a hard edge, low enough that 20 000 of them stay a few hundred
 * megabytes rather than a few gigabytes of OPFS.
 */
const THUMB_QUALITY = 0.82

/** u16 code value -> scaled half-float bits. Rebuilt when RAW headroom changes. */
let halfLUT: Uint16Array | null = null
let halfLUTScale = 0
function getHalfLUT(scale = 1): Uint16Array {
  if (!halfLUT || Math.abs(scale - halfLUTScale) > 1e-6) {
    halfLUT = new Uint16Array(65536)
    for (let i = 0; i < 65536; i++) halfLUT[i] = floatToHalf((i / 65535) * scale)
    halfLUTScale = scale
  }
  return halfLUT
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dms = (v: [number, number, number] | undefined, ref: string | null) => {
  if (!v) return 0
  const dec = v[0] + v[1] / 60 + v[2] / 3600
  return ref === 'S' || ref === 'W' ? -dec : dec
}

/**
 * Box-downsamples interleaved u16 RGB into RGBA half-float.
 *
 * Averaging happens in linear light — that's why the decode is linear in the
 * first place. Averaging gamma-encoded pixels is the classic way to get muddy,
 * too-dark downsamples.
 */
function downsampleToHalfRGBA(
  src: Uint16Array,
  sw: number,
  sh: number,
  channels: number,
  dw: number,
  dh: number,
  linearScale = 1,
): Uint16Array {
  return downsampleRowsToHalfRGBA(src, sw, channels, sw, sh, dw, dh, 0, dh, 0, linearScale)
}

/**
 * The same reduction restricted to destination rows `[yFrom, yTo)`.
 *
 * `src` holds source rows `[srcTop, srcTop + bandHeight)` of a `sw x sh` frame,
 * so a band decoded on its own reduces onto exactly the rows of the global grid
 * it owns. Every ratio is computed from the *global* size, which is what makes
 * bands tile without a visible join: the box boundaries are the same ones a
 * whole-frame reduction would have used.
 */
function downsampleRowsToHalfRGBA(
  src: Uint16Array,
  srcStride: number,
  channels: number,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  yFrom: number,
  yTo: number,
  srcTop: number,
  linearScale = 1,
): Uint16Array {
  const lut = getHalfLUT(linearScale)
  // A monochrome sensor gives LibRaw one channel. Reading the next two offsets
  // anyway walks into the following pixels, so a Monochrom file comes back
  // smeared with colour fringes instead of grey.
  const grey = channels < 3
  const out = new Uint16Array(dw * Math.max(0, yTo - yFrom) * 4)
  const xRatio = sw / dw
  const yRatio = sh / dh

  for (let y = yFrom; y < yTo; y++) {
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
        let si = ((sy - srcTop) * srcStride + x0) * channels
        for (let sx = x0; sx < x1; sx++) {
          if (grey) {
            const v = src[si]
            r += v
            g += v
            b += v
          } else {
            r += src[si]
            g += src[si + 1]
            b += src[si + 2]
          }
          si += channels
          n++
        }
      }
      const o = ((y - yFrom) * dw + x) * 4
      out[o] = lut[(r / n) | 0]
      out[o + 1] = lut[(g / n) | 0]
      out[o + 2] = lut[(b / n) | 0]
      out[o + 3] = HALF_ONE
    }
  }
  return out
}

/** 1:1 conversion when no downsampling is needed. */
function toHalfRGBA(
  src: Uint16Array,
  w: number,
  h: number,
  channels: number,
  linearScale = 1,
): Uint16Array {
  const lut = getHalfLUT(linearScale)
  const grey = channels < 3
  const out = new Uint16Array(w * h * 4)
  const n = w * h
  for (let i = 0; i < n; i++) {
    const s = i * channels
    const o = i * 4
    const v = lut[src[s]]
    out[o] = v
    out[o + 1] = grey ? v : lut[src[s + 1]]
    out[o + 2] = grey ? v : lut[src[s + 2]]
    out[o + 3] = HALF_ONE
  }
  return out
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// The package's worker owns one reusable C++ LibRaw object and `open()` calls
// `recycle()` before loading the next file. Recreating the JS wrapper for every
// request threw that worker and its compiled WASM instance away after each
// photo, so keep one decoder alive for the lifetime of this pool slot.
const decoder = new LibRaw()

/**
 * OpenMP team size this build can form, resolved once per worker.
 *
 * The vendored libraw-wasm is compiled with `-fopenmp`, so LibRaw's AHD and
 * three-pass Markesteijn demosaics — plus the Canon CR3 and Fujifilm RAF
 * unpackers — run across a pthread team. That needs SharedArrayBuffer, which
 * the browser withholds unless the document is cross-origin isolated, so the
 * capability has to be discovered rather than assumed: a stock single-threaded
 * build, or an isolated-less context, simply reports 1 and every caller
 * transparently falls back to the banded decode path.
 */
let threadCapacity: Promise<number> | null = null

function capacity(): Promise<number> {
  threadCapacity ??= decoder
    .maxThreads()
    .then((n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 1))
    .catch(() => 1)
  return threadCapacity
}

/**
 * Pins this instance's OpenMP team size for the decode that follows.
 *
 * Several decoders share one machine, and the pool may also be splitting a
 * frame into bands, so each instance has to be told its share instead of
 * grabbing every core and thrashing against its siblings. `undefined` leaves
 * the runtime default alone.
 */
async function limitThreads(threads: number | undefined): Promise<void> {
  if (!threads || threads < 1) return
  const max = await capacity()
  if (max <= 1) return
  await decoder.setThreads(Math.min(Math.floor(threads), max))
}

/**
 * Every setting any path in this file touches, at its LibRaw default.
 *
 * The binding keeps one C++ LibRaw object per worker, and `open()` calls
 * `recycle()` — which resets the image, not `imgdata.params`. Settings
 * therefore *merge* into whatever the previous decode left behind. A metadata
 * probe that asks for half size would otherwise silently halve the resolution
 * of the decode that follows it, and a `cropbox` would outlive the photo it
 * belonged to. Spreading this first makes every open a clean slate.
 *
 * The array resets have to be spelled out. The binding skips any array setting
 * that is `null`, so `cropbox: null` does not clear a crop — it leaves the
 * previous one in place. A banded decode followed by a whole-frame decode in
 * the same pool slot then returns a slice of the frame at full confidence.
 * These are LibRaw's own constructor values.
 */
const SETTINGS_RESET: LibRawSettings = {
  halfSize: false,
  noInterpolation: false,
  noAutoScale: false,
  fourColorRgb: false,
  userQual: 3,
  userFlip: -1,
  dcbIterations: -1,
  dcbEnhanceFl: false,
  fbddNoiserd: 0,
  medPasses: 0,
  threshold: 0,
  bright: 1,
  adjustMaximumThr: 0.75,
  autoBrightThr: 0.01,
  useAutoWb: false,
  expCorrec: false,
  greenMatching: false,
  outputTiff: false,
  outputFlags: 0,
  cropbox: [0, 0, 0xffffffff, 0xffffffff],
  greybox: [0, 0, 0xffffffff, 0xffffffff],
  userMul: [0, 0, 0, 0],
  aber: null,
}

async function openRaw(bytes: Uint8Array<ArrayBuffer>, settings: LibRawSettings) {
  const merged: LibRawSettings = { ...SETTINGS_RESET, ...settings }
  // A caller writing `cropbox: crop ?? null` means "decode the whole frame",
  // but the binding *skips* a null array instead of clearing it, so the null
  // would let the previous decode's crop through. Spreading the reset first is
  // not enough, because the explicit null overwrites it. Folding null back to
  // the reset value is what makes "no crop" mean no crop at every call site.
  merged.cropbox ??= SETTINGS_RESET.cropbox
  merged.greybox ??= SETTINGS_RESET.greybox
  merged.userMul ??= SETTINGS_RESET.userMul
  try {
    await decoder.open(bytes, merged)
    return decoder
  } catch (error) {
    await releaseRaw()
    throw error
  }
}

/**
 * Frees LibRaw's processed frame without throwing away the nested worker/WASM
 * instance. The package has no public `recycle()` method, but every `open()`
 * recycles first; an empty input therefore performs the release whether this
 * LibRaw build rejects it immediately or defers the format error until unpack.
 * Only the immediate, expected open failure is swallowed.
 */
async function releaseRaw() {
  try {
    await decoder.open(new Uint8Array(0), {})
  } catch (error) {
    if (error instanceof Error && error.message.includes('open_buffer() failed')) return
    throw error
  }
}

function cropIsUsable(
  crop: NonNullable<LibRawMetadata['raw_inset_crops']>[number],
  m: LibRawMetadata,
) {
  return (
    crop.cwidth > 0 &&
    crop.cheight > 0 &&
    crop.cleft >= m.left_margin &&
    crop.ctop >= m.top_margin &&
    crop.cleft + crop.cwidth <= m.raw_width &&
    crop.ctop + crop.cheight <= m.raw_height
  )
}

function rawCropFrom(m: LibRawMetadata): RawCrop | null {
  const inset = m.raw_inset_crops?.find((crop) => cropIsUsable(crop, m))
  if (!inset) return null
  return [
    inset.cleft - m.left_margin,
    inset.ctop - m.top_margin,
    inset.cwidth,
    inset.cheight,
  ]
}

function orientedMetaSize(
  m: LibRawMetadata,
  rawCrop: RawCrop | null,
): Pick<DecodedMeta, 'width' | 'height'> {
  if (!rawCrop) return { width: m.width, height: m.height }
  if (flipTransposes(m.flip)) {
    return { width: rawCrop[3], height: rawCrop[2] }
  }
  return { width: rawCrop[2], height: rawCrop[3] }
}

function captureTimeFrom(timestamp: unknown): number | null {
  return timestamp instanceof Date ? timestamp.getTime() : null
}

function cameraMetaFrom(
  m: LibRawMetadata,
): Pick<
  DecodedMeta,
  | 'cameraMake'
  | 'cameraModel'
  | 'lens'
  | 'iso'
  | 'shutter'
  | 'aperture'
  | 'focalLength'
  | 'captureTime'
  | 'artist'
> {
  return {
    cameraMake: m.camera_make ?? '',
    cameraModel: m.camera_model ?? '',
    lens: m.lens?.Lens?.trim() || '',
    iso: m.iso_speed ?? 0,
    shutter: m.shutter ?? 0,
    aperture: m.aperture ?? 0,
    focalLength: m.focal_len ?? 0,
    captureTime: captureTimeFrom(m.timestamp),
    artist: m.artist ?? '',
  }
}

function gpsFrom(m: LibRawMetadata): DecodedMeta['gps'] {
  const gps = m.gps_data
  if (!gps?.gpsparsed) return null
  return {
    lat: dms(gps.latitude, gps.latref),
    lon: dms(gps.longitude, gps.longref),
    alt: gps.altitude ?? 0,
  }
}

function numberArray(value: number[] | undefined): number[] | null {
  return value ? Array.from(value) : null
}

function numberMatrix(value: number[][] | undefined): number[][] | null {
  return value ? value.map((row) => Array.from(row)) : null
}

function colorMetaFrom(
  m: LibRawMetadata,
): Pick<DecodedMeta, 'camMul' | 'preMul' | 'camXyz' | 'black' | 'maximum'> {
  const color = m.color_data
  if (!color) {
    return { camMul: null, preMul: null, camXyz: null, black: null, maximum: null }
  }
  return {
    camMul: numberArray(color.cam_mul),
    preMul: numberArray(color.pre_mul),
    camXyz: numberMatrix(color.cam_xyz),
    black: color.black ?? null,
    maximum: color.maximum ?? null,
  }
}

function sensorMetaFrom(
  m: LibRawMetadata,
): Pick<DecodedMeta, 'thumbWidth' | 'thumbHeight' | 'filters'> {
  return {
    thumbWidth: m.thumb_width ?? 0,
    thumbHeight: m.thumb_height ?? 0,
    filters: m.filters ?? 0,
  }
}

/** Pulls the catalog-facing metadata out of an already-open LibRaw handle. */
async function metaFrom(raw: LibRaw): Promise<DecodedMeta | null> {
  const m = await raw.metadata(true)
  if (!m) return null
  const rawCrop = rawCropFrom(m)
  return {
    ...orientedMetaSize(m, rawCrop),
    frameWidth: m.width,
    frameHeight: m.height,
    flip: m.flip,
    ...cameraMetaFrom(m),
    gps: gpsFrom(m),
    ...colorMetaFrom(m),
    ...sensorMetaFrom(m),
    rawCrop,
  }
}

/**
 * Reads the header without decoding anything.
 *
 * The nested LibRaw worker takes ownership of whatever buffer it is handed —
 * `postMessage` transfers it — so a probe costs one copy of the file plus an
 * `open()` that stops before unpack: about 90 ms on a 54 MB RAF. That buys the
 * two facts every decode path needs *before* it can pick its settings, namely
 * the sensor's CFA layout and the frame's true size, and it makes the worker
 * independent of whatever the catalog happens to believe.
 */
async function probe(buffer: ArrayBuffer): Promise<DecodedMeta | null> {
  try {
    const raw = await openRaw(new Uint8Array(buffer), { ...PREVIEW_SETTINGS, halfSize: true })
    return await metaFrom(raw)
  } catch {
    return null
  } finally {
    await releaseRaw().catch(() => {})
  }
}

/**
 * LibRaw `highlight: 1` normalises the largest WB multiplier to one. The
 * smallest processed multiplier therefore records how much common scale mode
 * zero would have applied before clipping. Restoring that scale after the
 * integer decode puts the scene back at its familiar brightness while storing
 * the rescued top end above 1 in half-float instead of throwing it away.
 */
function workingHeadroom(meta: DecodedMeta | null): number {
  const mul = meta?.preMul?.slice(0, 4).filter((v) => Number.isFinite(v) && v > 1e-6) ?? []
  if (!mul.length) return 1
  const scale = 1 / Math.min(...mul)
  return Number.isFinite(scale) && scale >= 1 ? scale : 1
}

/**
 * Removes EXIF APP1 segments before browser decoding.
 *
 * Embedded JPEGs carry the RAW's orientation inconsistently, and Chromium may
 * honour it even when `imageOrientation: 'none'` is requested. Stripping only
 * APP1 leaves the compressed pixels untouched and lets the LibRaw flip be the
 * single source of orientation truth.
 */
function embeddedImageBlob(data: Uint8Array): Blob {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    return new Blob([data as BlobPart])
  }

  const parts: BlobPart[] = []
  let keepFrom = 0
  let at = 2
  while (at + 3 < data.length && data[at] === 0xff) {
    const marker = data[at + 1]
    if (marker === 0xda || marker === 0xd9) break
    const length = (data[at + 2] << 8) | data[at + 3]
    if (length < 2 || at + 2 + length > data.length) break
    const end = at + 2 + length
    if (marker === 0xe1) {
      if (keepFrom < at) parts.push(data.subarray(keepFrom, at) as BlobPart)
      keepFrom = end
    }
    at = end
  }
  parts.push(data.subarray(keepFrom) as BlobPart)
  return new Blob(parts, { type: 'image/jpeg' })
}

/** Small JPEG from the camera's embedded preview on an open LibRaw handle. */
async function embeddedThumbFrom(
  raw: LibRaw,
  maxEdge: number,
  quality: number,
  flip: number,
): Promise<Blob | null> {
  const thumb = await raw.thumbnailData().catch(() => undefined)
  if (thumb?.data?.length) {
    const blob = embeddedImageBlob(thumb.data as Uint8Array)
    // Embedded previews are usually JPEG but can be PPM on older bodies, so
    // let the browser sniff the bytes rather than trusting `format`.
    const bmp = await createImageBitmap(blob).catch(() => null)
    if (bmp) {
      // Preserve the camera's original full-resolution JPEG when no resize or
      // orientation pass is needed. Re-encoding it only loses fine detail.
      if (
        blob.type === 'image/jpeg' &&
        !flip &&
        (maxEdge <= 0 || maxEdge >= Math.max(bmp.width, bmp.height))
      ) {
        bmp.close()
        return blob
      }
      return await encodeJpeg(
        bmp,
        maxEdge > 0 ? maxEdge : Math.max(bmp.width, bmp.height),
        flip,
        quality,
      )
    }
  }
  return null
}

async function thumbFrom(
  raw: LibRaw,
  maxEdge: number,
  quality: number,
  flip: number,
): Promise<Blob | null> {
  // The camera render is orders of magnitude faster than demosaicing. Older
  // bodies without a browser-readable preview fall back to a half-size decode.
  const embedded = await embeddedThumbFrom(raw, maxEdge, quality, flip)
  if (embedded) return embedded
  const img = await raw.imageData()
  if (!img?.data?.length) return null
  return await imageDataToJpeg(
    img.data, img.width, img.height, img.colors, img.bits, maxEdge, 0, quality,
  )
}

/** Hands large pixel planes back to the main thread without cloning them. */
function transferLinearImage(image: LinearImage): LinearImage {
  const buffer = image.data.buffer
  return buffer instanceof ArrayBuffer ? Comlink.transfer(image, [buffer]) : image
}

interface PreviewDecodeContext {
  meta: DecodedMeta | null
}

async function previewDemosaicSettings(
  buffer: ArrayBuffer,
  halfSize: boolean,
): Promise<LibRawSettings> {
  if (halfSize) return {}
  const header = await probe(buffer.slice(0))
  return demosaicSettings(header?.filters === XTRANS_FILTERS, 'interactive')
}

async function embeddedPreviewIfLargeEnough(
  context: PreviewDecodeContext,
  raw: LibRaw,
  maxEdge: number,
  preferEmbedded: boolean,
): Promise<Blob | null> {
  if (!preferEmbedded) return null
  context.meta = await metaFrom(raw).catch(() => null)
  const embeddedEdge = Math.max(
    context.meta?.thumbWidth ?? 0,
    context.meta?.thumbHeight ?? 0,
  )
  if (!(maxEdge <= 0 || embeddedEdge >= maxEdge)) return null
  return embeddedThumbFrom(raw, maxEdge, 0.88, context.meta?.flip ?? 0)
}

async function decodedRawPreview(
  context: PreviewDecodeContext,
  raw: LibRaw,
  maxEdge: number,
  preferEmbedded: boolean,
): Promise<Blob> {
  const embedded = await embeddedPreviewIfLargeEnough(
    context,
    raw,
    maxEdge,
    preferEmbedded,
  )
  if (embedded) return embedded

  const img = await raw.imageData()
  if (!img?.data?.length) {
    throw new RawError('no-pixels', 'LibRaw returned no pixels')
  }
  return imageDataToJpeg(
    img.data,
    img.width,
    img.height,
    img.colors,
    img.bits,
    maxEdge > 0 ? maxEdge : EMBEDDED_PREVIEW_EDGE,
    0,
    0.88,
  )
}

async function fallbackRawPreview(
  context: PreviewDecodeContext,
  raw: LibRaw,
  maxEdge: number,
): Promise<Blob | null> {
  context.meta ??= await metaFrom(raw).catch(() => null)
  return embeddedThumbFrom(
    raw,
    maxEdge,
    0.88,
    context.meta?.flip ?? 0,
  )
}

async function makeRawPreview(
  buffer: ArrayBuffer,
  maxEdge: number,
  halfSize: boolean,
  iso: number,
  rawCrop: RawCrop | null | undefined,
  preferEmbedded: boolean,
): Promise<Blob | null> {
  const quality = await previewDemosaicSettings(buffer, halfSize)
  const context: PreviewDecodeContext = { meta: null }
  let raw: LibRaw | undefined
  try {
    try {
      raw = await openRaw(new Uint8Array(buffer), {
        ...PREVIEW_SETTINGS,
        ...rawNoiseSettings(iso),
        ...quality,
        halfSize,
        cropbox: rawCrop ?? null,
      })
      return await decodedRawPreview(context, raw, maxEdge, preferEmbedded)
    } catch (error) {
      if (!raw) throw error
      const fallback = await fallbackRawPreview(context, raw, maxEdge)
      if (fallback) return fallback
      throw error
    }
  } catch {
    return null
  } finally {
    if (raw) await releaseRaw()
  }
}

async function makePreview(
  buffer: ArrayBuffer,
  isRaw: boolean,
  maxEdge = 1920,
  halfSize = true,
  iso = 0,
  rawCrop?: RawCrop | null,
  preferEmbedded = true,
): Promise<Blob | null> {
  if (!isRaw) return renderedThumb(buffer, maxEdge, 0.88, true).catch(() => null)
  return makeRawPreview(
    buffer,
    maxEdge,
    halfSize,
    iso,
    rawCrop,
    preferEmbedded,
  )
}

async function rawUsesXtrans(
  buffer: ArrayBuffer,
  header: DecodedMeta | null | undefined,
): Promise<boolean> {
  const metadata = header ?? (await probe(buffer.slice(0)))
  return metadata?.filters === XTRANS_FILTERS
}

function linearImageFrom(
  img: LibRawImageData,
  meta: DecodedMeta | null,
  maxEdge: number,
  whiteLevel: number,
): LinearImage {
  const src = img.data as Uint16Array
  const sw = img.width
  const sh = img.height
  const fullWidth = meta?.width ?? sw
  const fullHeight = meta?.height ?? sh
  const scale = Math.min(1, maxEdge / Math.max(sw, sh))
  const width = Math.max(1, Math.round(sw * scale))
  const height = Math.max(1, Math.round(sh * scale))
  const data =
    width === sw && height === sh
      ? toHalfRGBA(src, sw, sh, img.colors, whiteLevel)
      : downsampleToHalfRGBA(
          src,
          sw,
          sh,
          img.colors,
          width,
          height,
          whiteLevel,
        )

  // dcraw_make_mem_image() already applies S.flip while copying its output.
  // Rotating this buffer again was the old pipeline's double-orientation bug.
  return {
    width,
    height,
    data,
    scale: width / fullWidth,
    fullWidth,
    fullHeight,
    fromRaw: true,
    meta,
    whiteLevel,
  }
}

async function decodedLinearFrom(
  raw: LibRaw,
  maxEdge: number,
): Promise<LinearImage> {
  const img = await raw.imageData()
  if (!img?.data?.length) {
    throw new RawError('no-pixels', 'LibRaw returned no pixels')
  }
  // Read this after processing: `pre_mul` has now been normalised by the exact
  // scale_colors() run that produced these pixels.
  const meta = await metaFrom(raw)
  return linearImageFrom(img, meta, maxEdge, workingHeadroom(meta))
}

async function fallbackLinearFrom(
  raw: LibRaw | undefined,
  maxEdge: number,
): Promise<LinearImage | null> {
  if (!raw) return null
  const meta = await metaFrom(raw).catch(() => null)
  return embeddedPreviewLinearFrom(raw, maxEdge, meta?.flip ?? 0).catch(() => null)
}

async function decodeLinear(
  buffer: ArrayBuffer,
  isRaw: boolean,
  maxEdge = 2560,
  iso = 0,
  rawCrop?: RawCrop | null,
  quality: RawDecodeQuality = 'full',
  header?: DecodedMeta | null,
  threads?: number,
): Promise<LinearImage | null> {
  if (!isRaw) {
    return transferLinearImage(await decodeRenderedLinear(buffer, maxEdge))
  }

  // Settings are fixed at open(), so identify the CFA before selecting its
  // demosaic algorithm. The pool has usually read the header already.
  const xtrans = await rawUsesXtrans(buffer, header)
  let raw: LibRaw | undefined
  try {
    await limitThreads(threads)
    raw = await openRaw(new Uint8Array(buffer), {
      ...LINEAR_SETTINGS,
      ...rawNoiseSettings(iso),
      ...demosaicSettings(xtrans, quality),
      cropbox: rawCrop ?? null,
    })
    return transferLinearImage(await decodedLinearFrom(raw, maxEdge))
  } catch (error) {
    // A camera LibRaw can't demosaic yet still usually has a large embedded
    // JPEG. Showing that beats showing nothing, so long as the caller knows
    // not to apply the RAW base curve to it.
    const fallback = await fallbackLinearFrom(raw, maxEdge)
    if (fallback) return transferLinearImage(fallback)
    throw classify(error)
  } finally {
    if (raw) await releaseRaw()
  }
}

const api = {
  /**
   * Size of the OpenMP team this worker's LibRaw can form, or 1 when the build
   * is single-threaded or the document is not cross-origin isolated. The pool
   * uses it to choose between OpenMP and banded decoding, and to divide the
   * machine between concurrent decoders.
   */
  threadCapacity(): Promise<number> {
    return capacity()
  },

  /**
   * Metadata *and* thumbnail from a single open — the import path.
   *
   * Reading these separately meant two full copies of the file in memory (the
   * buffer is transferred, so each call needed its own) and two complete LibRaw
   * opens per photo. At four concurrent imports of 100 MB raws that is most of
   * a gigabyte, and twice the decode work, for no reason.
   */
  async ingest(buffer: ArrayBuffer, isRaw: boolean, maxEdge = 512): Promise<IngestResult> {
    if (!isRaw) {
      const thumb = await renderedThumb(buffer, maxEdge, THUMB_QUALITY).catch(() => null)
      return { meta: null, thumb, failure: thumb ? null : 'unknown' }
    }

    let raw: LibRaw
    try {
      raw = await openRaw(new Uint8Array(buffer), { ...PREVIEW_SETTINGS, halfSize: true })
    } catch (err) {
      return { meta: null, thumb: null, failure: classify(err).kind }
    }

    try {
      // Metadata alone failing usually means the format is unknown. Keep going
      // anyway: the embedded preview may still be readable, and a photo in the
      // catalog with a clear reason beats one that silently vanished.
      const meta = await metaFrom(raw).catch(() => null)
      const thumb = await thumbFrom(raw, maxEdge, THUMB_QUALITY, meta?.flip ?? 0).catch(() => null)
      return {
        meta,
        thumb,
        failure: meta ? (thumb ? null : 'no-pixels') : 'unsupported',
      }
    } finally {
      await releaseRaw()
    }
  },

  /** Metadata only — used by the develop and export paths. */
  async readMeta(buffer: ArrayBuffer, isRaw: boolean): Promise<DecodedMeta | null> {
    if (!isRaw) return null
    let opened = false
    try {
      const raw = await openRaw(new Uint8Array(buffer), { ...PREVIEW_SETTINGS, halfSize: true })
      opened = true
      return await metaFrom(raw)
    } catch (err) {
      throw classify(err)
    } finally {
      if (opened) await releaseRaw()
    }
  },

  /**
   * Thumbnail for the Library grid, when the catalog has to heal itself after
   * a cache eviction. Import uses {@link ingest} instead.
   */
  async makeThumb(buffer: ArrayBuffer, isRaw: boolean, maxEdge = 512): Promise<Blob | null> {
    try {
      if (!isRaw) return await renderedThumb(buffer, maxEdge, THUMB_QUALITY)
      const raw = await openRaw(new Uint8Array(buffer), { ...PREVIEW_SETTINGS, halfSize: true })
      try {
        const meta = await metaFrom(raw)
        return await thumbFrom(raw, maxEdge, THUMB_QUALITY, meta?.flip ?? 0)
      } finally {
        await releaseRaw()
      }
    } catch {
      return null
    }
  },

  /**
   * Standard preview for the loupe, shown while the linear proxy decodes.
   *
   * A sufficiently large camera preview is the instant standard-tier path.
   * Otherwise `halfSize` caps the demosaic at half the sensor's long edge; the
   * loupe passes `false` once zoom asks for resolution that path cannot provide.
   *
   * This is the tier an HDR original survives intact, because it is the one
   * shown large enough for the range to be worth keeping. Grid thumbnails stay
   * standard: a 512 px tile is not where a gain map earns its bytes.
   */
  makePreview,

  /**
   * The camera's own preview as a linear working image.
   *
   * A modern body embeds a near-full-resolution JPEG — 4416 x 2944 on the
   * X-T50 — and pulling it costs about 150 ms against the seconds a demosaic
   * needs. It is the first thing Develop puts on screen, exactly as Lightroom
   * shows the camera rendering until its own conversion is ready, and it is
   * fully editable because it lands in the same half-float working space.
   *
   * The pixels are camera-rendered, so `fromRaw` is false and the caller must
   * not run the RAW base curve over them a second time.
   */
  async decodeEmbedded(
    buffer: ArrayBuffer,
    isRaw: boolean,
    maxEdge = 2560,
  ): Promise<LinearImage | null> {
    if (!isRaw) return transferLinearImage(await decodeRenderedLinear(buffer, maxEdge))

    let raw: LibRaw | undefined
    try {
      raw = await openRaw(new Uint8Array(buffer), { ...PREVIEW_SETTINGS, halfSize: true })
      const meta = await metaFrom(raw).catch(() => null)
      const image = await embeddedPreviewLinearFrom(raw, maxEdge, meta?.flip ?? 0)
      if (!image) return null
      // The catalog wants the real frame's dimensions: this preview stands in
      // for the photo, it is not a photo of its own. `metaFrom` has already
      // folded the orientation into those numbers.
      const fullWidth = meta?.width || image.fullWidth
      const fullHeight = meta?.height || image.fullHeight
      return transferLinearImage({
        ...image,
        meta,
        fullWidth,
        fullHeight,
        scale: Math.max(image.width, image.height) / Math.max(1, fullWidth, fullHeight),
      })
    } catch (error) {
      console.warn('Embedded RAW preview could not be decoded', error)
      return null
    } finally {
      if (raw) await releaseRaw().catch(() => {})
    }
  },

  /**
   * Linear ProPhoto half-float RGBA, demosaiced at native resolution and then
   * downsampled to `maxEdge`. `quality` changes the interpolation algorithm, not
   * the sensor resolution presented to it.
   *
   * The old fit-view shortcut averaged CFA cells before demosaic. It was quick,
   * but introduced false colour and aliasing: on real 4K+ fixtures chroma
   * variation rose 63% on Bayer and 99% on X-Trans against a full demosaic at
   * the same output size. The embedded camera JPEG remains the fast loading tier;
   * pixels presented as the editable RAW always take the quality path.
   */
  decodeLinear,

  /**
   * One horizontal slice of {@link decodeLinear}, for running a demosaic across
   * the worker pool instead of on one core.
   *
   * This is the fallback for algorithms LibRaw never parallelised — DCB and
   * VNG carry no `#pragma omp` at all — and for contexts that cannot be
   * cross-origin isolated, where SharedArrayBuffer and therefore OpenMP are
   * unavailable. LibRaw has no partial demosaic: it will happily accept a
   * `cropbox` but has to unpack the whole frame first. Slicing the *demosaic*
   * is the only parallelism left: every worker repeats the unpack (roughly 20%
   * of the work) and then demosaics its own 1/N of the frame.
   *
   * The band is reduced to its share of the proxy grid before it comes back, so
   * four bands of a 40MP frame return about 8 MB each rather than 60 MB.
   *
   * `userFlip: 0` is essential. `dcraw_make_mem_image()` normally applies the
   * camera's flip itself; letting it do that per band would rotate each slice
   * independently. Bands are assembled in sensor orientation and rotated once.
   */
  async decodeLinearBand(buffer: ArrayBuffer, req: BandRequest): Promise<BandResult> {
    const { srcWidth, srcHeight, dstWidth, dstHeight, yFrom, yTo } = req
    const yRatio = srcHeight / dstHeight
    // The exact source rows this band's destination rows average over.
    const need0 = Math.floor(yFrom * yRatio)
    const need1 = Math.min(srcHeight, Math.max(need0 + 1, Math.floor(yTo * yRatio)))

    // Keep the CFA phase: a band that starts mid-pattern decodes as if the
    // sensor had a different colour layout.
    const period = req.xtrans ? 6 : 2
    const margin = bandMargin(req.quality)
    const top = Math.max(0, Math.floor((need0 - margin) / period) * period)
    const bottom = Math.min(srcHeight, need1 + margin)

    const cropX = req.rawCrop ? req.rawCrop[0] : 0
    const cropY = req.rawCrop ? req.rawCrop[1] : 0

    let raw: LibRaw | undefined
    try {
      await limitThreads(req.threads)
      raw = await openRaw(new Uint8Array(buffer), {
        ...LINEAR_SETTINGS,
        ...rawNoiseSettings(req.iso),
        ...demosaicSettings(req.xtrans, req.quality),
        userFlip: 0,
        cropbox: [cropX, cropY + top, srcWidth, bottom - top],
      })
      const img = await raw.imageData()
      if (!img?.data?.length) throw new RawError('no-pixels', 'LibRaw returned no pixels')
      if (img.width !== srcWidth || img.height !== bottom - top) {
        throw new RawError(
          'unknown',
          `band ${yFrom}-${yTo} decoded ${img.width}x${img.height}, expected ${srcWidth}x${bottom - top}`,
        )
      }

      const meta = await metaFrom(raw)
      const whiteLevel = workingHeadroom(meta)
      const data = downsampleRowsToHalfRGBA(
        img.data as Uint16Array,
        img.width,
        img.colors,
        srcWidth,
        srcHeight,
        dstWidth,
        dstHeight,
        yFrom,
        yTo,
        top,
        whiteLevel,
      )
      const result: BandResult = {
        data,
        yFrom,
        rows: yTo - yFrom,
        whiteLevel,
        camMul: meta?.camMul ?? null,
        preMul: meta?.preMul ?? null,
        black: meta?.black ?? null,
        maximum: meta?.maximum ?? null,
      }
      return Comlink.transfer(result, [data.buffer as ArrayBuffer])
    } catch (err) {
      throw classify(err)
    } finally {
      if (raw) await releaseRaw()
    }
  },
}

/**
 * Last resort for a RAW LibRaw cannot demosaic: pull the camera's own embedded
 * JPEG. Newly released bodies routinely land here for a few months until
 * LibRaw ships support, and a camera-rendered preview is infinitely better
 * than an empty canvas.
 */
async function embeddedPreviewLinearFrom(
  raw: LibRaw,
  maxEdge: number,
  flip: number,
): Promise<LinearImage | null> {
  const thumb = await raw.thumbnailData()
  if (!thumb?.data?.length || thumb.format !== 'jpeg') return null
  const bmp = await createImageBitmap(embeddedImageBlob(thumb.data as Uint8Array))
  return orientLinear(bitmapToLinear(bmp, maxEdge, false), flip)
}

export type RawWorkerApi = typeof api

Comlink.expose(api)
