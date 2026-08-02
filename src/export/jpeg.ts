/**
 * JPEG encoding via mozjpeg (wasm).
 *
 * `canvas.convertToBlob()` gives one knob — quality — and no say over anything
 * that actually determines JPEG size: no progressive scans, no chroma
 * subsampling choice, no trellis quantisation, no optimal Huffman tables. At
 * matched visual quality mozjpeg lands 15-25% smaller, which matters twice over
 * here because the file-size limiter pays for its savings in re-encodes.
 *
 * The module and its ~60 kB (gzipped) of wasm load on first use inside the
 * export worker, so nothing reaches the main thread and nothing downloads until
 * someone actually exports a JPEG.
 */
import type { Plane } from './pixels'
import type { Subsampling } from './types'

export type { Subsampling }

export interface JpegOptions {
  /** 0..100. */
  quality: number
  progressive: boolean
  subsampling: Subsampling
  /**
   * Rate-distortion optimised coefficients. Buys a few percent for roughly 2x
   * the encode time, so it is off unless the export is chasing a size ceiling.
   */
  trellis: boolean
}

type Encoder = (data: ImageData, options: Record<string, unknown>) => Promise<ArrayBuffer>

let encoder: Promise<Encoder> | null = null

async function load(): Promise<Encoder> {
  encoder ??= import('@jsquash/jpeg/encode').then((m) => m.default as unknown as Encoder)
  return encoder
}

/** Warms the wasm module so the first real encode doesn't pay for compilation. */
export function preloadJpeg(): void {
  void load().catch(() => {})
}

/**
 * mozjpeg's `chroma_subsample` is the luma sampling factor, so 1 is 4:4:4 and 2
 * is 4:2:0. `auto` lets mozjpeg decide, which means 4:4:4 above roughly q90.
 */
function subsampleOptions(mode: Subsampling): Record<string, unknown> {
  if (mode === 'auto') return { auto_subsample: true }
  return { auto_subsample: false, chroma_subsample: mode === '4:4:4' ? 1 : 2 }
}

export async function encodeJpeg(plane: Plane, opts: JpegOptions): Promise<Uint8Array> {
  if (plane.data instanceof Uint16Array) {
    throw new Error('JPEG is an 8-bit format; the plane should have been rendered at depth 8')
  }
  const encode = await load()
  const buffer = await encode(
    {
      data: plane.data as unknown as Uint8ClampedArray,
      width: plane.width,
      height: plane.height,
    } as ImageData,
    {
      quality: Math.max(1, Math.min(100, Math.round(opts.quality))),
      baseline: !opts.progressive,
      progressive: opts.progressive,
      optimize_coding: true,
      trellis_multipass: opts.trellis,
      trellis_opt_zero: opts.trellis,
      trellis_opt_table: opts.trellis,
      ...subsampleOptions(opts.subsampling),
    },
  )
  return new Uint8Array(buffer)
}
