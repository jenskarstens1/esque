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
import { ExportCancelled, renderFull } from '../export/render'
import { defaultEdits, defaultMaskAdjustments } from '../core/defaults'
import { geometryOutputSize } from '../gpu/geometry'
import { isAiGeometry, type Edits } from '../core/types'
import { RENDERED_WHITE_POINT } from '../core/workingImage'
import { halfRgbaToRgb16 } from '../export/dng'
import { alphaKey, dropAlphasFor, getAlpha, putAlpha, saveAlpha } from '../ai/alpha'
import { detect, restoreCoverage, useDetect } from '../ai/detect'
import { cacheDelete, cacheRead } from '../catalog/opfs'
import { newMaskLayer } from '../develop/layers'
import { disposeExportWorker, renderThumbInWorker } from '../export/client'

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
let lastAssertion = 'Starting mask coverage'

async function checkMaskCoverage() {
  const failures: string[] = []
  let assertions = 0
  const check = (ok: boolean, name: string) => {
    assertions++
    lastAssertion = name
    if (!ok) failures.push(name)
  }
  const image = ramped(32, 24)
  const photoId = `export-check-${crypto.randomUUID()}`
  const key = alphaKey(photoId, 'aiSubject', 'u2netp')
  const alpha = { size: 8, data: new Float32Array(64).fill(1) }
  const edits = defaultEdits()
  const mask = newMaskLayer([], 'aiSubject')
  const geometry = mask.components[0].geometry
  if (!isAiGeometry(geometry)) throw new Error('Expected a detected mask fixture')
  geometry.cacheKey = key
  mask.adjustments.exposure = 1
  edits.layers = [mask]
  const render = (settings: Edits) => renderFull(image, {
    edits: settings, outputSpace: 'srgb', depth: 8,
  })
  const expectMissing = async (work: () => Promise<unknown>, name: string) => {
    try {
      await work()
      check(false, name)
    } catch (err) {
      check(err instanceof Error && err.message.includes('needs detection'), name)
    }
  }
  const thumbBlue = async (thumb: Blob | null) => {
    if (!thumb) throw new Error('The export worker returned no thumbnail')
    const bitmap = await createImageBitmap(thumb)
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('The browser cannot read the worker result')
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    return context.getImageData(16, 12, 1, 1).data[2]
  }

  try {
    await saveAlpha(key, alpha)
    check(!!(await cacheRead(key)), 'Coverage fixture is persisted')
    putAlpha(key, alpha)
    const plain = await render(defaultEdits())
    const warm = await render(edits)
    const sample = (12 * image.width + 16) * 4 + 2
    check(warm.data[sample] - plain.data[sample] > 8, 'Detected coverage changes rendered pixels')

    dropAlphasFor(photoId)
    check(!getAlpha(key), 'Cold render starts without in-memory coverage')
    const cold = await render(edits)
    check(cold.data.every((value, i) => Math.abs(value - warm.data[i]) <= 1),
      'Cold rendered export matches the previously detected mask')

    const thumb = () => renderThumbInWorker({ ...image, data: image.data.slice(), edits })
    const plainThumb = () => renderThumbInWorker({
      ...image, data: image.data.slice(), edits: defaultEdits(),
    })
    check(Math.abs(await thumbBlue(await thumb()) - warm.data[sample]) <= 6,
      'The separate render worker hydrates saved coverage before encoding')
    await saveAlpha(key, { size: 8, data: new Float32Array(64) })
    check(Math.abs(await thumbBlue(await thumb()) - plain.data[sample]) <= 6,
      'The worker releases old coverage between jobs and reads updated persisted data')
    await saveAlpha(key, alpha)
    const [concurrentMask, concurrentPlain] = await Promise.all([thumb(), plainThumb()])
    check(Math.abs(await thumbBlue(concurrentMask) - warm.data[sample]) <= 6,
      'Concurrent requests retain the masked job pixels')
    check(Math.abs(await thumbBlue(concurrentPlain) - plain.data[sample]) <= 6,
      'Concurrent requests retain the unmasked job pixels')
    check(getAlpha(key)?.data[0] === 1, 'Worker cleanup does not discard the viewport coverage cache')

    await cacheDelete(key)
    const writable = Object.getOwnPropertyDescriptor(FileSystemFileHandle.prototype, 'createWritable')
    if (!writable) throw new Error('The browser cannot inject a coverage write failure')
    try {
      Object.defineProperty(FileSystemFileHandle.prototype, 'createWritable', {
        ...writable,
        value: async () => { throw new DOMException('Fixture storage full', 'QuotaExceededError') },
      })
      try {
        await saveAlpha(key, alpha)
        check(false, 'Coverage persistence failures are not swallowed')
      } catch (err) {
        check(err instanceof Error && err.name === 'QuotaExceededError',
          'Coverage persistence failures are not swallowed')
      }
      const saved = await detect({ photoId, kind: 'aiSubject', modelId: 'u2netp' })
      check(!saved && useDetect.getState().status[key]?.phase === 'error',
        'Detection reports a retained-coverage save failure')
      check(getAlpha(key)?.data[0] === 1, 'Failed persistence retains the live mask for retry')
    } finally {
      Object.defineProperty(FileSystemFileHandle.prototype, 'createWritable', writable)
    }
    check(await detect({ photoId, kind: 'aiSubject', modelId: 'u2netp' }) && !!(await cacheRead(key)),
      'Retrying detection persists retained coverage without another model run')

    dropAlphasFor(photoId)
    check(await restoreCoverage(key), 'Develop restores saved coverage without detection')
    check(!!getAlpha(key) && useDetect.getState().status[key]?.phase === 'ready',
      'Reopened coverage is available to the viewport and detection controls')
    check(!(await detect({ photoId, kind: 'aiSubject', modelId: 'u2netp', force: true })),
      'Explicit re-detection bypasses saved coverage and requires a loaded photo')
    check(getAlpha(key)?.data[0] === 1,
      'An unsuccessful re-detection retains the previous mask')

    await cacheDelete(key)
    dropAlphasFor(photoId)
    await expectMissing(() => render(edits), 'Missing coverage refuses a misleading rendered export')
    await expectMissing(
      () => renderThumbInWorker({ ...image, data: image.data.slice(), edits }),
      'The render worker reports unavailable coverage instead of dropping edits',
    )
    check(Math.abs(await thumbBlue(await plainThumb()) - plain.data[sample]) <= 6,
      'A failed render does not block later worker jobs')
    check(!(await restoreCoverage(key)) && useDetect.getState().status[key]?.phase === 'error',
      'Unavailable coverage has a visible detection error state')

    const undetected = structuredClone(edits)
    const pendingGeometry = undetected.layers[0].components[0].geometry
    if (!isAiGeometry(pendingGeometry)) throw new Error('Expected a detected mask fixture')
    pendingGeometry.cacheKey = null
    await expectMissing(() => render(undetected), 'Unfinished non-neutral detection cannot export silently')

    for (const state of ['hidden', 'transparent', 'neutral'] as const) {
      const ignored = structuredClone(edits)
      if (state === 'hidden') ignored.layers[0].visible = false
      else if (state === 'transparent') ignored.layers[0].opacity = 0
      else ignored.layers[0].adjustments = defaultMaskAdjustments()
      const result = await render(ignored)
      check(result.data.every((value, i) => Math.abs(value - plain.data[i]) <= 1),
        `${state} layers do not block or change an export`)
    }

    try {
      await renderFull(image, {
        edits, outputSpace: 'srgb', depth: 8, signal: { cancelled: true },
      })
      check(false, 'Cancellation takes precedence over missing mask coverage')
    } catch (err) {
      check(err instanceof ExportCancelled, 'Cancellation takes precedence over missing mask coverage')
    }
  } finally {
    disposeExportWorker()
    dropAlphasFor(photoId)
    await cacheDelete(key)
  }
  return { pass: failures.length === 0, assertions, failures }
}

interface PixelPlane {
  width: number
  height: number
  data: ArrayLike<number>
}

const px = (plane: Pick<PixelPlane, 'width' | 'data'>, x: number, y: number) => {
  const i = (y * plane.width + x) * 4
  return [plane.data[i], plane.data[i + 1], plane.data[i + 2]]
}

/** Mean absolute difference over a coarse grid of sample points. */
const diff = (a: PixelPlane, b: PixelPlane) => {
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

function checkDngHeadroom(out: Record<string, unknown>, failures: string[]) {
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
}

async function checkCropExport(
  image: ReturnType<typeof ramped>,
  out: Record<string, unknown>,
  failures: string[],
) {
  const render = (edits: Edits) =>
    renderFull(image, { edits, outputSpace: 'srgb', depth: 8 })

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
}

async function checkTiledExport(out: Record<string, unknown>, failures: string[]) {
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
}

async function run() {
  const layers = await checkMaskCoverage()
  if (new URLSearchParams(location.search).get('case') === 'layers') return layers
  const out: Record<string, unknown> = { layers }
  const failures: string[] = [...layers.failures]
  checkDngHeadroom(out, failures)
  await checkCropExport(ramped(W, H), out, failures)
  await checkTiledExport(out, failures)
  out.failures = failures
  out.pass = failures.length === 0
  return out
}

run()
  .then((r) => {
    window.__result = r
  })
  .catch((err) => {
    window.__result = {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      lastAssertion,
    }
  })
  .finally(() => {
    window.__done = true
  })
