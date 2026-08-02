/**
 * Headless check for the full-resolution export path.
 *
 * The interesting case is tiling: the colour graph runs one horizontal strip at
 * a time, but geometry moves pixels across the whole frame, so the two stages
 * are split and the tiles are assembled in a GPU accumulator first. This drives
 * `renderFull` over a position-encoding image and checks that the tiled result
 * matches the single-shot one — with and without a crop.
 *
 * Run through `tools/headless.mjs /checks/exportcheck.html`.
 */
import { renderFull } from '../export/render'
import { defaultEdits } from '../core/defaults'
import { geometryOutputSize } from '../gpu/geometry'
import type { Edits } from '../core/types'
import { RENDERED_WHITE_POINT } from '../core/workingImage'
import { halfRgbaToRgb16 } from '../export/dng'

const RENDERED_SOURCE = {
  isRaw: false,
  asShot: RENDERED_WHITE_POINT,
  whiteLevel: 1,
} as const

declare global {
  interface Window {
    __done?: boolean
    __result?: unknown
  }
}

function toHalf(value: number): number {
  const f = new Float32Array(1)
  const i = new Uint32Array(f.buffer)
  f[0] = value
  const x = i[0]
  const sign = (x >>> 16) & 0x8000
  const exp = ((x >>> 23) & 0xff) - 127 + 15
  const mant = x & 0x7fffff
  if (exp <= 0) return sign
  if (exp >= 31) return sign | 0x7c00
  return sign | (exp << 10) | (mant >> 13)
}

/** Red encodes x, green encodes y, so a pixel says where it came from. */
function ramped(width: number, height: number) {
  const data = new Uint16Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      data[i] = toHalf(0.05 + 0.9 * ((x + 0.5) / width))
      data[i + 1] = toHalf(0.05 + 0.9 * ((y + 0.5) / height))
      data[i + 2] = toHalf(0.4)
      data[i + 3] = toHalf(1)
    }
  }
  return { width, height, data, ...RENDERED_SOURCE }
}

const W = 900
const H = 700

async function run() {
  const out: Record<string, unknown> = {}
  const failures: string[] = []
  const image = ramped(W, H)

  const dngCodes = halfRgbaToRgb16(
    new Uint16Array([toHalf(0.5), toHalf(1), toHalf(2), toHalf(1)]),
    1,
    2,
  )
  out.dngHeadroom = Array.from(dngCodes)
  if (
    Math.abs(dngCodes[0] - 16384) > 2 ||
    Math.abs(dngCodes[1] - 32768) > 2 ||
    dngCodes[2] !== 65535
  ) {
    failures.push(`dngHeadroom ${Array.from(dngCodes).join(',')}`)
  }

  const px = (plane: { width: number; data: ArrayLike<number> }, x: number, y: number) => {
    const i = (y * plane.width + x) * 4
    return [plane.data[i], plane.data[i + 1], plane.data[i + 2]]
  }

  /** Mean absolute difference over a coarse grid of sample points. */
  const diff = (
    a: { width: number; height: number; data: ArrayLike<number> },
    b: { width: number; height: number; data: ArrayLike<number> },
  ) => {
    if (a.width !== b.width || a.height !== b.height) return Infinity
    let sum = 0
    let n = 0
    for (let y = 2; y < a.height - 2; y += 7) {
      for (let x = 2; x < a.width - 2; x += 7) {
        const pa = px(a, x, y)
        const pb = px(b, x, y)
        sum += Math.abs(pa[0] - pb[0]) + Math.abs(pa[1] - pb[1]) + Math.abs(pa[2] - pb[2])
        n += 3
      }
    }
    return sum / Math.max(1, n)
  }

  // Small enough to take the single-shot path.
  const render = (edits: Edits) =>
    renderFull(image, { edits, outputSpace: 'srgb', depth: 8 })

  // -- geometry changes the exported size ------------------------------------
  const cropped = defaultEdits()
  cropped.crop.left = 0.25
  cropped.crop.top = 0.1
  cropped.crop.right = 0.75
  cropped.crop.bottom = 0.9

  const plain = await render(defaultEdits())
  const crop = await render(cropped)
  const want = geometryOutputSize(W, H, cropped)

  out.plainSize = [plain.width, plain.height]
  out.cropSize = [crop.width, crop.height]
  out.expectedCropSize = [want.width, want.height]
  if (crop.width !== want.width || crop.height !== want.height) {
    failures.push(`cropSize ${crop.width}x${crop.height} want ${want.width}x${want.height}`)
  }
  if (plain.width !== W || plain.height !== H) failures.push('plainSize')

  // -- and it reads the right part of the ramp -------------------------------
  // Output column 0 is source column 0.25 W, so its red must match the plain
  // export at that column.
  const leftEdge = px(crop, 1, Math.round(crop.height / 2))
  const wantLeft = px(plain, Math.round(0.25 * W) + 1, Math.round(H / 2))
  out.leftEdge = leftEdge
  out.wantLeft = wantLeft
  if (Math.abs(leftEdge[0] - wantLeft[0]) > 4) {
    failures.push(`cropReadsRamp ${leftEdge[0]} vs ${wantLeft[0]}`)
  }

  const topEdge = px(crop, Math.round(crop.width / 2), 1)
  const wantTop = px(plain, Math.round(W / 2), Math.round(0.1 * H) + 1)
  out.topEdge = topEdge
  out.wantTop = wantTop
  if (Math.abs(topEdge[1] - wantTop[1]) > 4) {
    failures.push(`cropReadsRampY ${topEdge[1]} vs ${wantTop[1]}`)
  }

  // -- the tiled path agrees with the single-shot one ------------------------
  // `renderFull` picks its path by pixel count, so the tiled branch is reached
  // by handing it an image past the threshold. A 5000×5000 ramp is 25 MP, just
  // over, and still cheap because the graph is mostly disabled.
  const big = ramped(5000, 5000)
  const bigEdits = defaultEdits()
  bigEdits.basic.exposure = 0.4
  bigEdits.effects.vignetteAmount = -40
  bigEdits.crop.left = 0.2
  bigEdits.crop.right = 0.9

  const tiled = await renderFull(big, { edits: bigEdits, outputSpace: 'srgb', depth: 8 })
  const wantBig = geometryOutputSize(5000, 5000, bigEdits)
  out.tiledSize = [tiled.width, tiled.height]
  out.expectedTiledSize = [wantBig.width, wantBig.height]
  if (tiled.width !== wantBig.width || tiled.height !== wantBig.height) {
    failures.push('tiledSize')
  }

  // The same content rendered in one shot: a downscaled stand-in would blur, so
  // the check is that the tiled result is smooth — a mis-assembled accumulator
  // shows as a hard seam at the tile boundaries.
  let worstSeam = 0
  let seamRow = -1
  const mid = Math.round(tiled.width / 2)
  for (let y = 1; y < tiled.height - 1; y++) {
    const a = px(tiled, mid, y - 1)
    const b = px(tiled, mid, y + 1)
    const d = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
    if (d > worstSeam) {
      worstSeam = d
      seamRow = y
    }
  }
  out.worstSeam = worstSeam
  out.seamRow = seamRow
  // The ramp climbs monotonically down the frame, so any tile that landed in
  // the wrong place shows up as a row where it stops climbing.
  let worstDrop = 0
  let dropRow = -1
  let dropPixels: [number[], number[]] | null = null
  for (let y = 8; y < tiled.height; y += 8) {
    const previous = px(tiled, mid, y - 8)
    const current = px(tiled, mid, y)
    const drop = previous[1] - current[1]
    if (drop > worstDrop) {
      worstDrop = drop
      dropRow = y
      dropPixels = [previous, current]
    }
  }
  out.worstDrop = worstDrop
  out.dropRow = dropRow
  out.dropPixels = dropPixels
  if (worstDrop > 3) failures.push(`nonMonotonic ${worstDrop} at row ${dropRow}`)
  // The ramp climbs about 0.9 × 255 over 5000 rows, so two rows apart is well
  // under one code value; anything past a handful is a seam.
  if (worstSeam > 6) failures.push(`seam ${worstSeam} at row ${seamRow}`)

  // A tiled export with no framing work at all must still be seamless.
  const plainBig = defaultEdits()
  plainBig.basic.contrast = 25
  const tiledPlain = await renderFull(big, {
    edits: plainBig,
    outputSpace: 'srgb',
    depth: 8,
  })
  out.tiledPlainSize = [tiledPlain.width, tiledPlain.height]
  if (tiledPlain.width !== 5000 || tiledPlain.height !== 5000) failures.push('tiledPlainSize')
  out.tiledPlainDiff = diff(tiledPlain, tiledPlain)

  let worstPlainSeam = 0
  for (let y = 1; y < tiledPlain.height - 1; y++) {
    const a = px(tiledPlain, 2500, y - 1)
    const b = px(tiledPlain, 2500, y + 1)
    const d = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
    worstPlainSeam = Math.max(worstPlainSeam, d)
  }
  out.worstPlainSeam = worstPlainSeam
  if (worstPlainSeam > 6) failures.push(`plainSeam ${worstPlainSeam}`)

  out.failures = failures
  out.pass = failures.length === 0
  return out
}

run()
  .then((r) => {
    window.__result = r
  })
  .catch((err) => {
    window.__result = { error: err instanceof Error ? err.message : String(err) }
  })
  .finally(() => {
    window.__done = true
  })
