/**
 * Worker-side pixel pipeline.
 *
 * Everything here runs off the main thread: the full-resolution render, Lanczos
 * resampling, output sharpening, watermarking, container encoding, and grid
 * thumbnails. It deliberately knows nothing about Dexie, file handles or output
 * naming — the orchestrator on the main thread owns all of that and hands down
 * plain structured-cloneable data plus the pixels themselves, transferred rather
 * than copied.
 *
 * The stage order matches Lightroom's: render → resize → output sharpening →
 * watermark → encode → metadata. Sharpening after resize is the important one;
 * sharpening before would be scaled away.
 */
import { renderFull } from './render'
import { Renderer } from '../gpu/renderer'
import { outputSharpen, resize, watermark, type Plane } from './pixels'
import { encodeTiff, rgbaToRgb } from './tiff'
import { encodeDng, halfRgbaToRgb16 } from './dng'
import {
  iccApp2Segments,
  jpegWithSegments,
  pngWithMetadata,
  xmpApp1Segment,
} from './containers'
import { buildExifApp1, metadataIfdEntries, type ExifInput } from './exif'
import { buildXmp } from './metadata'
import { iccProfile } from './icc'
import { encodeJpeg } from './jpeg'
import { encodePng16 } from './png'
import { encodeToLimit } from './limit'
import { targetSize } from './naming'
import { floatToHalf, halfToFloat } from '../core/half'
import { THUMB_EDGE, type ExportSettings } from './types'
import type { Edits, Photo } from '../core/types'
import type { WhitePoint } from '../core/color'
import type { SourceImage } from '../core/workingImage'

export const SOFTWARE = 'esque'

export type PipelineStage = 'rendering' | 'resizing' | 'encoding'

/** What the size limiter actually achieved, so the UI can stop guessing. */
export interface SizeLimitReport {
  requestedKb: number
  actualKb: number
  /** Quality the delivered file was encoded at. */
  quality: number
  /** Encodes performed. The old bisection search could reach seven. */
  probes: number
  /** False when the ceiling could not be met at any usable quality. */
  met: boolean
}

export interface LinearPixels {
  width: number
  height: number
  /** Interleaved RGBA half-float bit patterns at full resolution. */
  data: Uint16Array
  /**
   * False when the pixels came from a camera-rendered preview, in which case a
   * tone curve is already baked in and the RAW base curve must not run again.
   */
  fromRaw: boolean
  whiteLevel: number
}

export interface ExportPixelInput {
  photo: Photo
  settings: ExportSettings
  /**
   * Resolved develop settings. Passed explicitly rather than read off `photo`
   * so the worker never has to fall back to `defaultEdits()` — the orchestrator
   * already knows the answer and the defaults module stays out of the worker.
   */
  edits: Edits
  linear: LinearPixels
  asShot: WhitePoint
  /** Prebuilt sidecar XMP for the DNG path; the orchestrator owns that string. */
  dngXmp?: string
}

export interface ExportPixelResult {
  blob: Blob
  width: number
  height: number
  /** Present only when `limitSize` was on. */
  limit?: SizeLimitReport
}

export interface ThumbPixelInput extends SourceImage {
  edits: Edits
  /**
   * Long edge to render at. Defaults to a grid thumbnail; the Library's
   * preview and 1:1 tiers pass their own, since they render the same graph at
   * the size the viewer is about to show.
   */
  edge?: number
  /** JPEG quality. A larger render is worth more bits than a thumbnail. */
  quality?: number
}

/**
 * Set by the orchestrator between jobs. Export runs one photo at a time, so a
 * single module-level flag is all the cancellation state this needs.
 */
const signal = { cancelled: false }

export function beginJob() {
  signal.cancelled = false
}

export function cancelJob() {
  signal.cancelled = true
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function renderExport(
  input: ExportPixelInput,
  onProgress?: (stage: PipelineStage, fraction: number) => void,
): Promise<ExportPixelResult> {
  const { photo, settings, linear } = input

  if (settings.format === 'dng') {
    onProgress?.('encoding', 0)
    const blob = encodeDng({
      width: linear.width,
      height: linear.height,
      data: halfRgbaToRgb16(
        linear.data,
        linear.width * linear.height,
        linear.whiteLevel,
      ),
      uniqueCameraModel:
        [photo.meta.cameraMake, photo.meta.cameraModel].filter(Boolean).join(' ').trim() ||
        'esque linear',
      resolution: settings.resolution,
      resolutionUnit: settings.resolutionUnit,
      software: SOFTWARE,
      baselineExposure: Math.log2(linear.whiteLevel),
      metadata: metadataIfdEntries(
        exifInput(photo, settings, linear.width, linear.height, true),
      ),
      // A negative keeps its develop settings as metadata, exactly the way
      // Camera Raw stores them beside a raw file.
      xmp: input.dngXmp,
    })
    onProgress?.('encoding', 1)
    return { blob, width: linear.width, height: linear.height }
  }

  // PNG carries 16 bits too, and used to have its bitDepth setting ignored.
  const depth =
    settings.format === 'tiff' || settings.format === 'png' ? settings.bitDepth : 8

  let plane = await renderFull(
    {
      width: linear.width,
      height: linear.height,
      data: linear.data,
      isRaw: photo.isRaw && linear.fromRaw,
      asShot: input.asShot,
      whiteLevel: linear.whiteLevel,
    },
    {
      edits: input.edits,
      outputSpace: settings.colorSpace,
      depth,
      onProgress: (f) => onProgress?.('rendering', f),
      signal,
    },
  )

  onProgress?.('resizing', 0)
  const target = targetSize(plane.width, plane.height, settings)
  if (target.width !== plane.width || target.height !== plane.height) {
    plane = resize(plane, target.width, target.height)
  }
  plane = outputSharpen(plane, settings.sharpenTarget, settings.sharpenAmount)
  plane = watermark(plane, settings.watermark)
  onProgress?.('resizing', 1)

  onProgress?.('encoding', 0)
  const icc = iccProfile(settings.colorSpace)
  const { blob, limit } = await encode(plane, photo, settings, icc, depth)
  onProgress?.('encoding', 1)

  return { blob, width: plane.width, height: plane.height, limit }
}

function exifInput(
  photo: Photo,
  settings: ExportSettings,
  width: number,
  height: number,
  srgb: boolean,
): ExifInput {
  return {
    photo,
    width,
    height,
    policy: settings.metadata,
    removeLocation: settings.removeLocation,
    srgb,
    resolution: settings.resolution,
    resolutionUnit: settings.resolutionUnit,
    software: SOFTWARE,
  }
}

/**
 * Encodes to the requested quality and, when a size ceiling is set, converges on
 * it with {@link encodeToLimit}. The pixels are already rendered, resized and
 * sharpened by this point, so re-encoding is the only cost of a second probe.
 */
async function encodeLimited(
  encodeAt: (quality: number) => Promise<Uint8Array>,
  settings: ExportSettings,
  overhead: number,
): Promise<{ bytes: Uint8Array; limit?: SizeLimitReport }> {
  if (!settings.limitSize) {
    return { bytes: await encodeAt(settings.quality) }
  }

  const ceiling = Math.max(1024, settings.limitSizeKb * 1024 - overhead)
  const result = await encodeToLimit(encodeAt, settings.quality, ceiling)
  return {
    bytes: result.bytes,
    limit: {
      requestedKb: settings.limitSizeKb,
      actualKb: Math.round((result.bytes.length + overhead) / 1024),
      quality: result.quality,
      probes: result.probes,
      met: result.met,
    },
  }
}

async function encode(
  plane: Plane,
  photo: Photo,
  settings: ExportSettings,
  icc: Uint8Array,
  depth: 8 | 16,
): Promise<{ blob: Blob; limit?: SizeLimitReport }> {
  const { width, height } = plane
  const xmp = buildXmp(photo, settings, SOFTWARE)

  if (settings.format === 'tiff') {
    const blob = await encodeTiff({
      width,
      height,
      depth,
      data: rgbaToRgb(plane.data, width * height),
      icc,
      compress: settings.compress,
      resolution: settings.resolution,
      resolutionUnit: settings.resolutionUnit,
      software: SOFTWARE,
      metadata: metadataIfdEntries(
        exifInput(photo, settings, width, height, settings.colorSpace === 'srgb'),
      ),
      xmp: xmp ?? undefined,
    })
    return { blob }
  }

  if (settings.format === 'png') {
    // 16-bit has to bypass the canvas, which is an 8-bit surface and would
    // quietly halve the precision the setting was asked for.
    const raw =
      depth === 16
        ? await encodePng16({
            width,
            height,
            data: rgbaToRgb(plane.data, width * height) as Uint16Array,
          })
        : new Uint8Array(await (await canvasOf(plane).convertToBlob()).arrayBuffer())
    const out = await pngWithMetadata(raw, icc, settings.resolution, xmp)
    return { blob: new Blob([out as BlobPart], { type: 'image/png' }) }
  }

  if (settings.format === 'jpeg') {
    const segments: Uint8Array[] = []
    const exif = buildExifApp1(
      exifInput(photo, settings, width, height, settings.colorSpace === 'srgb'),
    )
    if (exif) segments.push(exif)
    if (xmp) {
      const seg = xmpApp1Segment(xmp)
      if (seg) segments.push(seg)
    }
    if (icc) segments.push(...iccApp2Segments(icc))
    const overhead = segments.reduce((n, s) => n + s.length, 0)

    const { bytes, limit } = await encodeLimited(
      (quality) =>
        encodeJpeg(plane, {
          quality,
          progressive: settings.jpegProgressive,
          subsampling: settings.jpegSubsampling,
          // Trellis roughly doubles encode time, which is only worth paying
          // when every byte counts because a ceiling is in play.
          trellis: settings.limitSize,
        }),
      settings,
      overhead,
    )
    return {
      blob: new Blob([jpegWithSegments(bytes, segments) as BlobPart], { type: 'image/jpeg' }),
      limit,
    }
  }

  // WebP: no wasm encoder here, and the browser's is competent. It writes a bare
  // VP8L/VP8 stream with no profile chunk, so WebP is only offered for sRGB
  // where the absent profile is the correct assumption.
  const canvas = canvasOf(plane)
  const { bytes, limit } = await encodeLimited(
    async (quality) =>
      new Uint8Array(
        await (
          await canvas.convertToBlob({ type: 'image/webp', quality: quality / 100 })
        ).arrayBuffer(),
      ),
    settings,
    0,
  )
  return { blob: new Blob([bytes as BlobPart], { type: 'image/webp' }), limit }
}

/** 8-bit plane onto a canvas, for the encoders the browser still owns. */
function canvasOf(plane: Plane): OffscreenCanvas {
  const canvas = new OffscreenCanvas(plane.width, plane.height)
  const ctx = canvas.getContext('2d')!
  ctx.putImageData(
    new ImageData(plane.data as Uint8ClampedArray<ArrayBuffer>, plane.width, plane.height),
    0,
    0,
  )
  return canvas
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

/**
 * Grid thumbnails are rendered back to back — a "sync settings to 50 photos"
 * would otherwise pay for 50 fresh GPU devices. They are tiny, so one
 * long-lived renderer costs almost nothing to keep around.
 *
 * The *promise* is what gets cached, not the renderer. Acquiring a WebGPU
 * device is asynchronous, so two thumbnails starting in the same tick would
 * both see a null field and both build one; holding the in-flight promise makes
 * the second await the first.
 */
let thumbRenderer: Promise<Renderer> | null = null

/** Matches the quality the RAW worker writes import thumbnails at. */
const THUMB_QUALITY = 0.82

function reusableRenderer(): Promise<Renderer> {
  thumbRenderer ??= Renderer.create(new OffscreenCanvas(1, 1))
  return thumbRenderer
}

export async function renderThumb(input: ThumbPixelInput): Promise<Blob | null> {
  const src = downscale(input)
  try {
    const plane = await renderFull(src, {
      edits: input.edits,
      outputSpace: 'srgb',
      depth: 8,
      renderer: await reusableRenderer(),
    })
    const canvas = new OffscreenCanvas(plane.width, plane.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.putImageData(
      new ImageData(plane.data as Uint8ClampedArray<ArrayBuffer>, plane.width, plane.height),
      0,
      0,
    )
    return await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: input.quality ?? THUMB_QUALITY,
    })
  } catch (err) {
    // A lost context poisons the cached renderer, so drop it and let the next
    // thumbnail build a fresh one rather than failing forever.
    void thumbRenderer?.then((r) => r.dispose())
    thumbRenderer = null
    throw err
  }
}

/**
 * Box-filter down to the target size *before* rendering.
 *
 * Rendering at proxy size and then shrinking would be ~25x the shader work for
 * an identical result at 512px, and vignette/grain are framed to the render
 * size so they'd come out at the wrong scale anyway.
 */
function downscale(src: ThumbPixelInput): ThumbPixelInput {
  const edge = src.edge ?? THUMB_EDGE
  const long = Math.max(src.width, src.height)
  if (long <= edge) return src

  const scale = edge / long
  const w = Math.max(1, Math.round(src.width * scale))
  const h = Math.max(1, Math.round(src.height * scale))
  const out = new Uint16Array(w * h * 4)
  const sx = src.width / w
  const sy = src.height / h

  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy)
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((y + 1) * sy)))
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx)
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((x + 1) * sx)))
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * src.width + x0) * 4
        for (let xx = x0; xx < x1; xx++, i += 4) {
          r += halfToFloat(src.data[i])
          g += halfToFloat(src.data[i + 1])
          b += halfToFloat(src.data[i + 2])
          n++
        }
      }
      const o = (y * w + x) * 4
      out[o] = floatToHalf(r / n)
      out[o + 1] = floatToHalf(g / n)
      out[o + 2] = floatToHalf(b / n)
      out[o + 3] = 0x3c00 // 1.0
    }
  }

  return { ...src, width: w, height: h, data: out }
}

