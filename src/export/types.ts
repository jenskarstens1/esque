import type { OutputSpace } from '../gpu/colorspace'

/** Formats we can actually produce in the browser today. */
export type ExportFormat = 'jpeg' | 'png' | 'webp' | 'tiff' | 'dng' | 'original'

/**
 * JPEG chroma subsampling. `auto` lets mozjpeg pick, which means full chroma
 * above roughly quality 90 and 4:2:0 below it.
 */
export type Subsampling = 'auto' | '4:4:4' | '4:2:0'

export type ResizeMode =
  | 'none'
  | 'longEdge'
  | 'shortEdge'
  | 'width'
  | 'height'
  | 'fit'
  | 'megapixels'
  | 'percent'

export type SharpenTarget = 'none' | 'screen' | 'matte' | 'glossy'
export type SharpenAmount = 'low' | 'standard' | 'high'

export type MetadataPolicy =
  | 'all'
  | 'noCamera'
  | 'copyrightContact'
  | 'copyrightOnly'
  | 'none'

export type ResolutionUnit = 'inch' | 'cm'
export type ExtensionCase = 'lower' | 'upper'

export type WatermarkFont = 'sans' | 'serif' | 'mono'

export interface WatermarkSettings {
  enabled: boolean
  text: string
  /** 0..100 */
  opacity: number
  /** Percent of the image's long edge. */
  size: number
  position:
    | 'top-left'
    | 'top-center'
    | 'top-right'
    | 'bottom-left'
    | 'bottom-center'
    | 'bottom-right'
  /** Margin from the edge, percent of the long edge. */
  inset: number
  color: 'white' | 'black'
  shadow: boolean
  font: WatermarkFont
}

export interface ExportSettings {
  format: ExportFormat
  /** 0..100, JPEG and WebP only. */
  quality: number
  /** Multi-scan JPEG. Smaller for photos, and renders progressively on the web. */
  jpegProgressive: boolean
  /** Chroma resolution. 4:4:4 keeps saturated edges crisp at a size cost. */
  jpegSubsampling: Subsampling
  /** 8 or 16; TIFF and PNG only. */
  bitDepth: 8 | 16
  colorSpace: OutputSpace
  /** Compress TIFFs with Deflate. */
  compress: boolean
  /** Re-encode at a lower quality until the file fits. JPEG and WebP only. */
  limitSize: boolean
  /** Ceiling in kilobytes for {@link limitSize}. */
  limitSizeKb: number

  resizeMode: ResizeMode
  resizeWidth: number
  resizeHeight: number
  resizeLongEdge: number
  resizeShortEdge: number
  megapixels: number
  /** 1..400, used by `resizeMode: 'percent'`. */
  resizePercent: number
  /** Never scale a small image up to reach the target. */
  dontEnlarge: boolean
  /** Written into the file's metadata; it does not change pixel dimensions. */
  resolution: number
  resolutionUnit: ResolutionUnit

  sharpenTarget: SharpenTarget
  sharpenAmount: SharpenAmount

  metadata: MetadataPolicy
  /** Strip GPS even when other metadata is kept. */
  removeLocation: boolean
  /** Strip the people/face fields, the way Lightroom's export does. */
  removePersonInfo: boolean
  /** Copy the catalog's keywords into the exported file. */
  writeKeywords: boolean
  /** Write an `.xmp` sidecar next to each exported file. */
  writeSidecar: boolean

  watermark: WatermarkSettings

  /** Supports {name} {seq} {date} {camera} {lens} {iso} {custom} tokens. */
  filenameTemplate: string
  /** Value substituted for the {custom} token. */
  customText: string
  startNumber: number
  extensionCase: ExtensionCase
  /** Subfolder created inside the chosen destination, '' for none. */
  subfolder: string
  overwrite: 'skip' | 'overwrite' | 'rename'
}

export interface ExportPreset {
  id: string
  name: string
  builtIn: boolean
  settings: ExportSettings
}

export type JobState = 'queued' | 'running' | 'prepared' | 'done' | 'failed' | 'skipped' | 'cancelled'

export interface ExportJob {
  id: string
  photoId: string
  filename: string
  state: JobState
  /** 0..1 within this job. */
  progress: number
  outputName: string | null
  bytes: number
  error: string | null
  /**
   * Set when a size limit was asked for but could not be met even at the
   * encoder's floor quality. The file is still written — it is the smallest one
   * obtainable — but the user needs to know the ceiling was missed.
   */
  overLimit?: { requestedKb: number; quality: number } | null
}

export const DEFAULT_WATERMARK: WatermarkSettings = {
  enabled: false,
  text: '',
  opacity: 70,
  size: 3.2,
  position: 'bottom-right',
  inset: 2.5,
  color: 'white',
  shadow: true,
  font: 'sans',
}

export const DEFAULT_EXPORT: ExportSettings = {
  format: 'jpeg',
  quality: 85,
  jpegProgressive: true,
  jpegSubsampling: 'auto',
  bitDepth: 8,
  colorSpace: 'srgb',
  compress: true,
  limitSize: false,
  limitSizeKb: 2000,

  resizeMode: 'none',
  resizeWidth: 2048,
  resizeHeight: 2048,
  resizeLongEdge: 2048,
  resizeShortEdge: 1365,
  megapixels: 8,
  resizePercent: 50,
  dontEnlarge: true,
  resolution: 300,
  resolutionUnit: 'inch',

  sharpenTarget: 'none',
  sharpenAmount: 'standard',

  metadata: 'all',
  removeLocation: false,
  removePersonInfo: false,
  writeKeywords: true,
  writeSidecar: false,

  watermark: DEFAULT_WATERMARK,

  filenameTemplate: '{name}',
  customText: '',
  startNumber: 1,
  extensionCase: 'lower',
  subfolder: '',
  overwrite: 'rename',
}

export const FORMAT_LABELS: Record<ExportFormat, string> = {
  jpeg: 'JPEG',
  png: 'PNG',
  webp: 'WebP',
  tiff: 'TIFF',
  dng: 'DNG (linear raw)',
  original: 'Original file',
}

/**
 * Long edge of a grid thumbnail. Shared because the main thread decides which
 * proxy to hand over and the worker does the actual downscale — they have to
 * agree or the grid ends up with thumbnails at two different sizes.
 */
export const THUMB_EDGE = 512

export const EXTENSIONS: Record<Exclude<ExportFormat, 'original'>, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  tiff: 'tif',
  dng: 'dng',
}

/** Formats that can carry more than 8 bits per channel. */
export const SUPPORTS_16_BIT = new Set<ExportFormat>(['tiff', 'png'])
export const SUPPORTS_QUALITY = new Set<ExportFormat>(['jpeg', 'webp'])
/**
 * Formats that pass the photo through rather than rendering it: the original
 * bytes, or a demosaiced negative with no develop settings baked in. Neither
 * has a meaningful output colour space, resize or watermark to choose.
 */
export const NEGATIVE_FORMATS = new Set<ExportFormat>(['original', 'dng'])

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const preset = (
  id: string,
  name: string,
  settings: Partial<ExportSettings>,
): ExportPreset => ({
  id,
  name,
  builtIn: true,
  settings: { ...DEFAULT_EXPORT, ...settings },
})

/** Lightroom ships roughly this set, and for roughly these reasons. */
export const BUILT_IN_PRESETS: ExportPreset[] = [
  preset('builtin-web', 'JPEG for web', {
    format: 'jpeg',
    quality: 80,
    colorSpace: 'srgb',
    resizeMode: 'longEdge',
    resizeLongEdge: 2048,
    sharpenTarget: 'screen',
    sharpenAmount: 'standard',
    metadata: 'copyrightContact',
  }),
  preset('builtin-email', 'JPEG for email', {
    format: 'jpeg',
    quality: 70,
    colorSpace: 'srgb',
    resizeMode: 'longEdge',
    resizeLongEdge: 1200,
    limitSize: true,
    limitSizeKb: 900,
    sharpenTarget: 'screen',
    metadata: 'copyrightOnly',
  }),
  preset('builtin-full', 'Full-quality JPEG', {
    format: 'jpeg',
    quality: 96,
    colorSpace: 'srgb',
  }),
  preset('builtin-print', 'TIFF for print', {
    format: 'tiff',
    bitDepth: 16,
    colorSpace: 'adobe-rgb',
    resolution: 300,
    sharpenTarget: 'glossy',
  }),
  preset('builtin-dng', 'Linear DNG negative', { format: 'dng' }),
  preset('builtin-original', 'Original files', {
    format: 'original',
    writeSidecar: true,
  }),
]

/** Fills in whatever a stored preset or an older settings blob is missing. */
export function normaliseSettings(value: unknown): ExportSettings {
  const raw = (value ?? {}) as Partial<ExportSettings>
  return {
    ...DEFAULT_EXPORT,
    ...raw,
    watermark: { ...DEFAULT_WATERMARK, ...(raw.watermark ?? {}) },
  }
}
