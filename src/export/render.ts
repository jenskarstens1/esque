/**
 * Full-resolution render for export.
 *
 * The interactive path edits a 2560px proxy; export has to run the identical
 * shader graph over every real pixel. A 40 MP RGBA16F frame is 321 MB and the
 * graph needs three of them, so above a threshold the image is rendered in
 * horizontal tiles instead.
 *
 * Tiling is exact rather than approximate: every pass in the colour graph is
 * either per-pixel or has a bounded radius (blur, denoise, sharpen), so a tile
 * rendered with a halo of HALO pixels and then cropped back is bit-identical
 * to the same region of a single-shot render.
 *
 * Two stages are genuinely global and cannot be tiled. Geometry moves pixels
 * across the whole frame — a rotation's output row reads from everywhere — and
 * the post-crop vignette is defined on the cropped result, so it has to come
 * after. Both run once over an accumulator the tiles are blitted into, which
 * `Renderer.beginComposite` owns.
 */
import { Renderer } from '../gpu/renderer'
import type { SourceImage } from '../core/workingImage'
import { geometryOutputSize, isIdentityFraming, splitAtGeometry } from '../gpu/geometry'
import type { OutputSpace } from '../gpu/colorspace'
import { isAiGeometry, type Edits } from '../core/types'
import { loadAlpha } from '../ai/alpha'
import { isNeutralMask } from '../develop/masks'
import type { Plane } from './pixels'

/**
 * Widest support in the graph: the coarse clarity blur runs at 1/8 scale with
 * sigma ~2.4 over three taps, so its footprint is ~58px at full resolution.
 * 128 is comfortably past that and keeps tiles aligned to a sane boundary.
 */
const HALO = 128

/** Above this many pixels a single-shot render risks exhausting GPU memory. */
const TILE_THRESHOLD = 24_000_000

/** Target pixels per tile, chosen so source + ping-pong stay near 400 MB. */
const TILE_PIXELS = 12_000_000

export type FullRenderInput = SourceImage

export interface FullRenderOptions {
  edits: Edits
  outputSpace: OutputSpace
  depth: 8 | 16
  onProgress?: (fraction: number) => void
  signal?: { cancelled: boolean }
  /**
   * Reuse an existing renderer instead of creating one. Callers that render
   * many small images back to back — grid thumbnails — would otherwise pay for
   * a fresh GPU device every time. Ownership stays with the caller: a
   * renderer passed in here is never disposed.
   */
  renderer?: Renderer
}

class Cancelled extends Error {
  constructor() {
    super('Export cancelled')
  }
}

/**
 * Renders `image` at full resolution and returns display-referred pixels.
 *
 * Unless the caller supplies one, the renderer is created and destroyed here:
 * export work is short-lived and a device holds on to every texture the graph
 * allocated, so keeping one open for a background queue would starve the
 * viewport of VRAM.
 */
export async function renderFull(
  image: FullRenderInput,
  opts: FullRenderOptions,
): Promise<Plane> {
  check(opts.signal)
  for (const mask of opts.edits.masks) {
    if (!mask.visible || mask.opacity === 0 || isNeutralMask(mask)) continue
    for (const { geometry } of mask.components) {
      if (!isAiGeometry(geometry)) continue
      check(opts.signal)
      if (!geometry.cacheKey || !(await loadAlpha(geometry.cacheKey))) {
        throw new Error(`"${mask.name}" needs detection. Open Masking and run detection again before exporting.`)
      }
    }
  }
  check(opts.signal)
  const { width, height, depth } = { ...image, depth: opts.depth }
  const total = width * height
  /** Assembly buffer for the tiled path; a 60 MP one is 480 MB, so it waits. */
  let out: Uint16Array | Uint8ClampedArray | null = null

  const owned = !opts.renderer
  const renderer = opts.renderer ?? (await Renderer.create(new OffscreenCanvas(1, 1)))
  const framed = geometryOutputSize(width, height, opts.edits)

  try {
    if (total <= TILE_THRESHOLD) {
      check(opts.signal)
      renderer.setImage(image)
      renderer.setFrame(null)
      renderer.renderOffscreen(opts.edits)
      const px = await renderer.readPixels(opts.outputSpace, depth, null)
      if (!px) throw new Error('The GPU returned no pixels.')
      opts.onProgress?.(1)
      return { width: framed.width, height: framed.height, data: px.data }
    }

    const { local, framing } = splitAtGeometry(opts.edits)
    // With nothing global to do, the tiles can be read back one at a time and
    // the accumulator skipped entirely — the cheapest path stays the cheapest.
    const direct = isIdentityFraming(opts.edits)
    if (!direct) renderer.beginComposite(width, height)

    const tileHeight = Math.max(256, Math.floor(TILE_PIXELS / width))
    const tiles = Math.ceil(height / tileHeight)

    for (let i = 0; i < tiles; i++) {
      check(opts.signal)
      const y0 = i * tileHeight
      const y1 = Math.min(height, y0 + tileHeight)

      const top = Math.max(0, y0 - HALO)
      const bottom = Math.min(height, y1 + HALO)
      const sliceHeight = bottom - top

      const slice = new Uint16Array(width * sliceHeight * 4)
      slice.set(image.data.subarray(top * width * 4, bottom * width * 4))

      renderer.setImage({ ...image, width, height: sliceHeight, data: slice })
      renderer.setFrame({ width, height, x: 0, y: top })

      if (direct) {
        out ??= depth === 16 ? new Uint16Array(total * 4) : new Uint8ClampedArray(total * 4)
        renderer.renderOffscreen(opts.edits)
        const px = await renderer.readPixels(opts.outputSpace, depth, {
          x: 0,
          y: y0 - top,
          width,
          height: y1 - y0,
        })
        if (!px) throw new Error('The GPU returned no pixels.')
        ;(out as Uint16Array).set(px.data as never, y0 * width * 4)
      } else {
        renderer.compositeTile(local, { y: y0 - top, height: y1 - y0 }, y0)
      }

      opts.onProgress?.(((i + 1) / tiles) * (direct ? 1 : 0.9))

      // Let the event loop breathe so a cancel or a repaint can get through.
      await new Promise((r) => setTimeout(r, 0))
    }

    if (direct) return { width, height, data: out! }

    check(opts.signal)
    renderer.finishComposite(framing)
    const px = await renderer.readPixels(opts.outputSpace, depth, null)
    if (!px) throw new Error('The GPU returned no pixels.')
    opts.onProgress?.(1)
    return { width: framed.width, height: framed.height, data: px.data }
  } finally {
    if (owned) renderer.dispose()
  }
}

function check(signal?: { cancelled: boolean }) {
  if (signal?.cancelled) throw new Cancelled()
}

export { Cancelled as ExportCancelled, HALO as EXPORT_HALO, TILE_THRESHOLD }
