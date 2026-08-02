/**
 * What a decode produces, whatever produced it.
 *
 * Both decode paths — LibRaw for RAW, the browser for everything it already
 * understands — hand back the same shape, because the pipeline downstream
 * genuinely does not care which one ran. Keeping that vocabulary here rather
 * than in either decoder is what lets the two stay unaware of each other.
 */

/**
 * Demosaic settings for the two RAW tiers.
 *
 * LibRaw maps `userQual` onto a different algorithm per sensor layout:
 *
 *   quality 3, Bayer    -> AHD
 *   quality 1, X-Trans  -> VNG
 *   quality 4, Bayer    -> DCB with extra correction passes and colour enhance
 *   quality 3, X-Trans  -> three-pass Markesteijn interpolation
 *
 * Interactive proxies use the first pair. They still demosaic the native sensor
 * before reducing it, which preserves the false-colour fix, but avoid spending
 * seconds on refinements that disappear in a 2560-pixel working proxy. Native
 * detail and export use the second pair.
 */
export type RawDecodeQuality = 'interactive' | 'full'

/** Camera previews are the fast path up to the standard Library preview tier. */
export const EMBEDDED_PREVIEW_EDGE = 2048

export interface LinearImage {
  width: number
  height: number
  /** RGBA half-float bit patterns, ready for gl.HALF_FLOAT upload. */
  data: Uint16Array
  /** Scale relative to the full-resolution image, 1 = full res. */
  scale: number
  fullWidth: number
  fullHeight: number
  /**
   * False when the pixels came from the camera's embedded JPEG rather than a
   * demosaic, so the pipeline knows not to apply the RAW base curve on top of
   * a rendering the camera already baked.
   */
  fromRaw: boolean
  /** Metadata from the same LibRaw handle that produced `data`. */
  meta: DecodedMeta | null
  /** Working value represented by a saturated decoder channel. */
  whiteLevel: number
}

export interface DecodedMeta {
  /** Camera-recommended, already-oriented display dimensions. */
  width: number
  height: number
  /**
   * LibRaw's visible frame before any crop or orientation — the space `cropbox`
   * and every row index it returns live in. Splitting a frame into bands needs
   * it, because guessing it back out of the oriented size is exactly the mistake
   * that produced the old double-orientation bug.
   */
  frameWidth: number
  frameHeight: number
  flip: number
  cameraMake: string
  cameraModel: string
  lens: string
  iso: number
  shutter: number
  aperture: number
  focalLength: number
  captureTime: number | null
  artist: string
  gps: { lat: number; lon: number; alt: number } | null
  camMul: number[] | null
  /** Actual WB multipliers used by LibRaw, normalised during processing. */
  preMul: number[] | null
  camXyz: number[][] | null
  black: number | null
  maximum: number | null
  thumbWidth: number
  thumbHeight: number
  /** CFA pattern id. 9 means X-Trans, which needs a different demosaic. */
  filters: number
  /** Crop relative to LibRaw's visible frame, applied before orientation. */
  rawCrop: RawCrop | null
}

export type RawCrop = [number, number, number, number]

/**
 * Everything import needs from one pass over the file.
 *
 * `failure` is the kind rather than a message so the main thread can render it
 * with the same wording it uses everywhere else.
 */
export interface IngestResult {
  meta: DecodedMeta | null
  thumb: Blob | null
  failure: RawFailure | null
}

/**
 * Why a file could not be read.
 *
 * Silently returning null taught the UI nothing, so decode failures now carry a
 * reason the Library and Develop modules can actually show someone.
 */
export type RawFailure =
  | 'unsupported'
  | 'corrupt'
  | 'out-of-memory'
  | 'no-pixels'
  | 'unknown'

export class RawError extends Error {
  readonly kind: RawFailure
  constructor(kind: RawFailure, message: string) {
    super(message)
    // Comlink only preserves name/message/stack across the worker boundary, so
    // the failure kind rides along in the name to survive the trip.
    this.name = `RawError:${kind}`
    this.kind = kind
  }
}

/** Turns whatever LibRaw threw into something we can explain to a person. */
export function classify(err: unknown): RawError {
  if (err instanceof RawError) return err
  const msg = err instanceof Error ? err.message : String(err ?? 'unknown error')
  const low = msg.toLowerCase()
  if (low.includes('unsupported') || low.includes('file format') || low.includes('not supported')) {
    return new RawError('unsupported', msg)
  }
  if (low.includes('memory') || low.includes('allocation') || low.includes('alloc')) {
    return new RawError('out-of-memory', msg)
  }
  if (low.includes('corrupt') || low.includes('io error') || low.includes('unexpected end')) {
    return new RawError('corrupt', msg)
  }
  return new RawError('unknown', msg)
}
