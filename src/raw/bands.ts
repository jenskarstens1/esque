/**
 * Splitting a demosaic across the worker pool.
 *
 * The vendored libraw-wasm is compiled with OpenMP, but LibRaw only annotated
 * some of its demosaics: AHD and three-pass Markesteijn carry `#pragma omp`,
 * while DCB and VNG have none at all. Cross-origin isolation can also be
 * missing, in which case SharedArrayBuffer — and with it every wasm thread —
 * is unavailable. Both gaps are covered the same way: hand every worker the
 * same file and a different horizontal band, pay the unpack N times, and split
 * the interpolation, which is roughly 75% of a RAW decode.
 *
 * LibRaw has no region-of-interest decode, so this is the only lever: `cropbox`
 * still unpacks the whole frame and only then demosaics the requested window.
 *
 * Kept free of any libraw-wasm import so the pool can plan bands on the main
 * thread without pulling the decoder into its bundle.
 */

import type { RawCrop, RawDecodeQuality } from './decoded'

/** X-Trans sensors report this CFA pattern id. */
export const XTRANS_FILTERS = 9

/**
 * Sensor rows decoded either side of a band and then thrown away.
 *
 * A demosaic reads a neighbourhood, so the outermost rows of a cropped decode
 * differ from the same rows of a whole-frame decode. How far in that difference
 * reaches depends on the algorithm: AHD and VNG are single-pass and converge
 * within a handful of rows, while the full Bayer tier runs DCB with three
 * refinement iterations plus false-colour enhancement, each of which widens the
 * neighbourhood again.
 *
 * Measured on 30–40MP Canon and Nikon frames against a whole-frame reference:
 * 24 rows leaves AHD and VNG bit-exact but still lets 98 of 13.1M samples drift
 * on DCB, all of them on a band join. 64 closes it to a hard floor — on a 36MP
 * Nikon split twelve ways, 7 samples in 145M sit one half-float ULP off, always
 * in the same clipped-highlight column, and 128 rows does not move that number
 * while costing 16% more. It is a saturation boundary rather than a
 * neighbourhood that has not converged, so 64 is where the margin stops paying.
 */
export const bandMargin = (quality: RawDecodeQuality) => (quality === 'full' ? 64 : 24)

/** Below this the margins cost more than the split saves. */
const MIN_BAND_ROWS = 96

/**
 * Whether a whole-frame demosaic can be replaced by parallel band decodes.
 *
 * Bands must be *identical* to the frame they replace, not merely similar —
 * anything else shows up as a horizontal join. AHD, DCB, and VNG all converge
 * within {@link bandMargin}. Three-pass Markesteijn never does: its passes are
 * phase-locked to the buffer they were handed, and re-aligning band origins to
 * its internal 106-pixel tile stride does not restore exactness. The X-Trans
 * full tier therefore stays whole-frame, where its own `#pragma omp` — one of
 * only two demosaics LibRaw annotated, alongside AHD — carries it instead.
 */
export const canBandDecode = (xtrans: boolean, quality: RawDecodeQuality) =>
  !xtrans || quality === 'interactive'

/**
 * Whether this tier's demosaic carries `#pragma omp`, and so already spreads
 * itself across the machine without being split.
 *
 * Only two of LibRaw's interpolators are annotated: AHD, which the Bayer
 * working tier uses, and three-pass Markesteijn, which the X-Trans full tier
 * uses. The other two — DCB for Bayer at 1:1 and export, VNG for X-Trans while
 * working — run on one core no matter how many are free, so bands are their
 * only route to the rest of the machine and are worth cutting much finer.
 */
export const hasThreadedDemosaic = (xtrans: boolean, quality: RawDecodeQuality) =>
  xtrans ? quality === 'full' : quality === 'interactive'

/**
 * Contiguous destination row ranges, one per worker.
 *
 * The split is on the *destination* grid rather than the sensor so that every
 * output row belongs to exactly one band, which is what lets bands be reduced
 * independently and still tile without a seam.
 */
export function bandRanges(dstHeight: number, workers: number): [number, number][] {
  const count = Math.min(workers, Math.max(1, Math.floor(dstHeight / MIN_BAND_ROWS)))
  if (count < 2) return [[0, dstHeight]]
  const ranges: [number, number][] = []
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * dstHeight) / count)
    const to = Math.floor(((i + 1) * dstHeight) / count)
    if (to > from) ranges.push([from, to])
  }
  return ranges
}

/** One horizontal slice of a proxy, decoded independently of its neighbours. */
export interface BandRequest {
  iso: number
  quality: RawDecodeQuality
  xtrans: boolean
  /** Camera crop, in LibRaw's unrotated visible frame. */
  rawCrop: RawCrop | null
  /** Unrotated visible frame the destination grid is derived from. */
  srcWidth: number
  srcHeight: number
  /** Unrotated destination grid, shared by every band. */
  dstWidth: number
  dstHeight: number
  /** Destination rows this band owns. */
  yFrom: number
  yTo: number
  /** OpenMP team size for this band, so bands do not oversubscribe each other. */
  threads?: number
}

export interface BandResult {
  /** RGBA half-float, `dstWidth` by `yTo - yFrom`. */
  data: Uint16Array
  yFrom: number
  rows: number
  whiteLevel: number
  /** Colour data as normalised by the `scale_colors()` run that made `data`. */
  camMul: number[] | null
  preMul: number[] | null
  black: number | null
  maximum: number | null
}
