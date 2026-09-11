/**
 * End-to-end check for the real LibRaw path.
 *
 * The fixture is rawpy's public, valid Canon 5D Mark II CR2. Override it with
 * `?fixture=/path.cr2` to exercise another file served by Vite.
 *
 * Run through `tools/headless.mjs /checks/rawcheck.html`.
 */
import { rawPool } from '../raw/pool'
import {
  decodedAsShotTempTint,
  TEMP_MAX,
  TEMP_MIN,
  TINT_MAX,
  TINT_MIN,
} from '../core/color'
import { RENDERED_WHITE_POINT, type SourceImage } from '../core/workingImage'
import { defaultEdits } from '../core/defaults'
import { applyAuto, autoDevelop } from '../develop/auto'
import { halfToFloat } from '../core/half'
import { Renderer } from '../gpu/renderer'
import { flipTransposes } from '../raw/orientation'
import { runCheck } from './checkreport'

declare global {
  interface Window {
    __result?: unknown
    __done?: boolean
  }
}

const DEFAULT_FIXTURE =
  'https://raw.githubusercontent.com/letmaik/rawpy/main/test/RAW_CANON_5DMARK2_PREPROD.CR2'
const params = new URLSearchParams(location.search)
const fixture = params.get('fixture') ?? DEFAULT_FIXTURE
const requestedEdge = Math.max(64, Math.min(8192, Number(params.get('edge')) || 1024))
const decodeQuality = params.get('quality') === 'full' ? 'full' : 'interactive'
const failures: string[] = []
const ok = (condition: boolean, message: string) => {
  if (!condition) failures.push(message)
}

function sourceOf(linear: NonNullable<Awaited<ReturnType<typeof rawPool.decodeLinear>>>): SourceImage {
  const meta = linear.meta
  return {
    width: linear.width,
    height: linear.height,
    data: linear.data,
    isRaw: linear.fromRaw,
    asShot: decodedAsShotTempTint(
      meta?.camMul ?? null,
      meta?.preMul ?? null,
      meta?.camXyz ?? null,
    ),
    whiteLevel: linear.whiteLevel,
  }
}

function renderedSourceOf(
  linear: NonNullable<Awaited<ReturnType<typeof rawPool.decodeEmbedded>>>,
): SourceImage {
  return {
    width: linear.width,
    height: linear.height,
    data: linear.data,
    isRaw: false,
    asShot: RENDERED_WHITE_POINT,
    whiteLevel: 1,
  }
}

function sourceStats(image: SourceImage) {
  let max = 0
  let aboveOne = 0
  let atCeiling = 0
  let invalid = 0
  const pixels = image.width * image.height
  for (let i = 0; i < pixels; i++) {
    const o = i * 4
    for (let c = 0; c < 3; c++) {
      const value = halfToFloat(image.data[o + c])
      if (!Number.isFinite(value) || value < 0) invalid++
      if (value > max) max = value
      if (value > 1) aboveOne++
      if (value >= image.whiteLevel * 0.995) atCeiling++
    }
  }
  return {
    max,
    aboveOneFraction: aboveOne / (pixels * 3),
    ceilingFraction: atCeiling / (pixels * 3),
    invalid,
  }
}

async function renderedStats(
  image: SourceImage,
  edits: ReturnType<typeof defaultEdits>,
  label: string,
) {
  const renderer = await Renderer.create(new OffscreenCanvas(1, 1))
  try {
    renderer.setImage(image)
    renderer.setFrame(null)
    renderer.renderOffscreen(edits)
    const plane = await renderer.readPixels('srgb', 8, null)
    if (!plane) throw new Error('The GPU returned no pixels')
    const canvas = document.createElement('canvas')
    canvas.width = plane.width
    canvas.height = plane.height
    canvas.title = label
    canvas.style.maxWidth = '48vw'
    canvas.style.height = 'auto'
    canvas.getContext('2d')?.putImageData(
      new ImageData(new Uint8ClampedArray(plane.data), plane.width, plane.height),
      0,
      0,
    )
    document.body.append(canvas)
    const pixels = plane.width * plane.height
    let clipped = 0
    let lumaVariation = 0
    let chromaVariation = 0
    let chromaSamples = 0
    const gradients = new Uint32Array(256)
    let gradientSamples = 0
    const luminance = new Uint8Array(pixels)
    for (let i = 0; i < pixels; i++) {
      const o = i * 4
      if (Math.max(plane.data[o], plane.data[o + 1], plane.data[o + 2]) >= 255) clipped++
      luminance[i] = Math.round(
        0.2126 * plane.data[o] + 0.7152 * plane.data[o + 1] + 0.0722 * plane.data[o + 2],
      )
    }
    for (let y = 0; y < plane.height; y++) {
      for (let x = 0; x < plane.width - 1; x++) {
        const i = y * plane.width + x
        const next = i + 1
        const l = luminance[i]
        const nl = luminance[next]
        gradients[Math.abs(l - nl)]++
        gradientSamples++
        // Flat, non-clipped neighbours isolate the red/blue speckling that a
        // noisy demosaic adds without counting real coloured edges as noise.
        if (l < 8 || l > 245 || Math.abs(l - nl) > 12) continue
        const o = i * 4
        const no = next * 4
        const rg = plane.data[o] - plane.data[o + 1]
        const bg = plane.data[o + 2] - plane.data[o + 1]
        const nrg = plane.data[no] - plane.data[no + 1]
        const nbg = plane.data[no + 2] - plane.data[no + 1]
        lumaVariation += Math.abs(l - nl)
        chromaVariation += (Math.abs(rg - nrg) + Math.abs(bg - nbg)) / 2
        chromaSamples++
      }
    }

    luminance.sort()
    const percentile = (rank: number) => luminance[Math.round((pixels - 1) * rank)] / 255
    const gradientPercentile = (rank: number) => {
      const target = Math.round((gradientSamples - 1) * rank)
      let seen = 0
      for (let value = 0; value < gradients.length; value++) {
        seen += gradients[value]
        if (seen > target) return value
      }
      return 255
    }
    return {
      clipped: clipped / pixels,
      p10: percentile(0.1),
      p50: percentile(0.5),
      p90: percentile(0.9),
      p99: percentile(0.99),
      lumaVariation: lumaVariation / Math.max(chromaSamples, 1),
      chromaVariation: chromaVariation / Math.max(chromaSamples, 1),
      edgeP99: gradientPercentile(0.99),
    }
  } finally {
    renderer.dispose()
  }
}

async function renderedRoundTrip(): Promise<[number, number, number]> {
  const expected: [number, number, number] = [96, 144, 208]
  const canvas = new OffscreenCanvas(8, 8)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = `rgb(${expected.join(' ')})`
  ctx.fillRect(0, 0, 8, 8)
  const encoded = await canvas.convertToBlob({ type: 'image/png' })
  const linear = await rawPool.decodeLinear(await encoded.arrayBuffer(), false, 8)
  if (!linear) throw new Error('Rendered round-trip decode failed')

  const image: SourceImage = {
    width: linear.width,
    height: linear.height,
    data: linear.data,
    isRaw: false,
    asShot: RENDERED_WHITE_POINT,
    whiteLevel: 1,
  }

  const renderer = await Renderer.create(new OffscreenCanvas(1, 1))
  try {
    renderer.setImage(image)
    renderer.renderOffscreen(defaultEdits('rendered', image.asShot))
    const plane = await renderer.readPixels('srgb', 8, null)
    if (!plane) throw new Error('Rendered round-trip render failed')
    const sum: [number, number, number] = [0, 0, 0]
    const pixels = plane.width * plane.height
    for (let i = 0; i < pixels; i++) {
      sum[0] += plane.data[i * 4]
      sum[1] += plane.data[i * 4 + 1]
      sum[2] += plane.data[i * 4 + 2]
    }
    return sum.map((value) => Math.round(value / pixels)) as [number, number, number]
  } finally {
    renderer.dispose()
  }
}

async function blobSize(blob: Blob | null): Promise<[number, number] | null> {
  if (!blob) return null
  const bitmap = await createImageBitmap(blob)
  const size: [number, number] = [bitmap.width, bitmap.height]
  bitmap.close()
  return size
}

async function run() {
  const started = performance.now()
  async function checkDecodePipeline() {
  async function loadPrimaryDecode() {
  const response = await fetch(fixture)
  if (!response.ok) throw new Error(`Fixture download failed: HTTP ${response.status}`)
  const buffer = await response.arrayBuffer()
  const metadataStarted = performance.now()
  const decodedMeta = await rawPool.readMeta(buffer.slice(0), true)
  const metadataMs = performance.now() - metadataStarted
  const iso = decodedMeta?.iso ?? 0

  const linearStarted = performance.now()
  const linearPromise = rawPool
    .decodeLinear(
      buffer.slice(0),
      true,
      requestedEdge,
      iso,
      decodedMeta?.rawCrop,
      decodeQuality,
    )
    .then((result) => ({
      result,
      ms: performance.now() - linearStarted,
    }))
  const embeddedStarted = performance.now()
  const embeddedPromise = rawPool
    .decodeEmbedded(buffer.slice(0), true, requestedEdge)
    .then((result) => ({
      result,
      ms: performance.now() - embeddedStarted,
    }))
  const [linearTimed, embeddedTimed] = await Promise.all([linearPromise, embeddedPromise])
  const full = linearTimed.result
  const embedded = embeddedTimed.result
  if (!full) throw new Error('LibRaw returned no image')

  const image = sourceOf(full)
  const stats = sourceStats(image)
  const meta = full.meta
  return {
    buffer,
    metadataMs,
    decodedMeta,
    iso,
    linearTimed,
    embeddedTimed,
    full,
    embedded,
    image,
    stats,
    meta,
  }
  }
  const {
    buffer,
    metadataMs,
    decodedMeta,
    iso,
    linearTimed,
    embeddedTimed,
    full,
    embedded,
    image,
    stats,
    meta,
  } = await loadPrimaryDecode()

  async function loadRelatedImages() {
  const [renderedRgb, nativePreviewSize, previewSize, generatedPreviewSize, thumbSize, ingest] =
    await Promise.all([
      renderedRoundTrip(),
      rawPool
        .makePreview(buffer.slice(0), true, 0, true, iso, decodedMeta?.rawCrop)
        .then(blobSize),
      rawPool
        .makePreview(buffer.slice(0), true, 640, true, iso, decodedMeta?.rawCrop)
        .then(blobSize),
      rawPool
        .makePreview(buffer.slice(0), true, 640, false, iso, decodedMeta?.rawCrop, false)
        .then(blobSize),
      rawPool.makeThumb(buffer.slice(0), true, 320).then(blobSize),
      rawPool.ingest(buffer.slice(0), true, 160).then(async (result) => ({
        ...result,
        thumbSize: await blobSize(result.thumb),
      })),
    ])
  return { renderedRgb, nativePreviewSize, previewSize, generatedPreviewSize, thumbSize, ingest }
  }
  const {
    renderedRgb,
    nativePreviewSize,
    previewSize,
    generatedPreviewSize,
    thumbSize,
    ingest,
  } = await loadRelatedImages()

  function checkDecodedDimensions() {
  const expectedSize =
    meta?.cameraModel === 'EOS 5D Mark II'
      ? flipTransposes(meta.flip)
        ? [3744, 5616]
        : [5616, 3744]
      : [full.fullWidth, full.fullHeight]

  ok(full.fromRaw, 'full decode fell back to an embedded JPEG')
  ok(full.fullWidth === expectedSize[0] && full.fullHeight === expectedSize[1],
    `unexpected oriented size ${full.fullWidth}x${full.fullHeight}`)
  ok(meta?.width === full.fullWidth && meta?.height === full.fullHeight,
    `metadata size ${meta?.width}x${meta?.height} differs from decoded pixels`)
  ok(
    ingest.meta?.width === full.fullWidth && ingest.meta?.height === full.fullHeight,
    `ingest metadata size ${ingest.meta?.width}x${ingest.meta?.height} differs from decoded pixels`,
  )
  const expectedEdge = Math.min(requestedEdge, Math.max(full.fullWidth, full.fullHeight))
  ok(
    Math.max(full.width, full.height) === expectedEdge,
    `quality decode returned ${full.width}x${full.height} for a ${requestedEdge} request`,
  )
  ok(
    Math.abs(full.scale - full.width / full.fullWidth) < 1e-6,
    `decode scale ${full.scale} does not match its dimensions`,
  )
  }
  checkDecodedDimensions()

  function checkEmbeddedDimensions() {
  // The embedded tier is what Develop paints first, so it has to agree with the
  // real conversion about the shape of the photo — a stand-in that is rotated
  // or a different aspect would make the swap a visible jump.
  ok(!!embedded, 'embedded preview tier produced nothing')
  ok(
    !embedded ||
      (embedded.fullWidth === full.fullWidth && embedded.fullHeight === full.fullHeight),
    `embedded tier reports ${embedded?.fullWidth}x${embedded?.fullHeight}, decode says ${full.fullWidth}x${full.fullHeight}`,
  )
  ok(
    !embedded ||
      ((embedded.width > embedded.height) === (full.width > full.height) && !embedded.fromRaw),
    `embedded tier orientation is ${embedded?.width}x${embedded?.height}`,
  )
  }
  checkEmbeddedDimensions()

  function checkPreviewDimensions() {
  ok(
    !!nativePreviewSize &&
      (nativePreviewSize[0] > nativePreviewSize[1]) === (full.fullWidth > full.fullHeight) &&
      Math.abs(nativePreviewSize[0] / nativePreviewSize[1] - full.fullWidth / full.fullHeight) <
        0.01,
    `native preview size is ${nativePreviewSize?.join('x') ?? 'missing'}`,
  )
  ok(
    !!previewSize &&
      (previewSize[0] > previewSize[1]) === (full.fullWidth > full.fullHeight) &&
      Math.max(...previewSize) === 640,
    `preview orientation/size is ${previewSize?.join('x') ?? 'missing'}`,
  )
  ok(
    !!generatedPreviewSize &&
      (generatedPreviewSize[0] > generatedPreviewSize[1]) ===
        (full.fullWidth > full.fullHeight) &&
      Math.max(...generatedPreviewSize) === 640,
    `generated preview orientation/size is ${generatedPreviewSize?.join('x') ?? 'missing'}`,
  )
  }
  checkPreviewDimensions()

  function checkThumbnailDimensions() {
  ok(
    !!thumbSize &&
      (thumbSize[0] > thumbSize[1]) === (full.fullWidth > full.fullHeight) &&
      Math.max(...thumbSize) === 320,
    `thumbnail orientation/size is ${thumbSize?.join('x') ?? 'missing'}`,
  )
  ok(
    !!ingest.thumbSize &&
      (ingest.thumbSize[0] > ingest.thumbSize[1]) === (full.fullWidth > full.fullHeight) &&
      Math.max(...ingest.thumbSize) === 160,
    `ingest thumbnail orientation/size is ${ingest.thumbSize?.join('x') ?? 'missing'}`,
  )
  }
  checkThumbnailDimensions()

  function checkMetadataAndSamples() {
  ok(
    fixture === DEFAULT_FIXTURE ? meta?.cameraMake === 'Canon' : !!meta?.cameraMake,
    `camera make is ${meta?.cameraMake || 'missing'}`,
  )
  ok(!!meta?.cameraModel, 'camera model is missing')
  ok(decodedMeta?.iso === meta?.iso, 'metadata-only ISO differs from decoded metadata')
  ok((meta?.camMul?.length ?? 0) >= 3, 'camera white balance is missing')
  ok((meta?.camXyz?.length ?? 0) >= 3, 'camera colour matrix is missing')
  ok(image.whiteLevel > 1.05, `RAW ceiling ${image.whiteLevel} did not preserve WB headroom`)
  ok(stats.max <= image.whiteLevel * 1.002,
    `decoded maximum ${stats.max} exceeds ceiling ${image.whiteLevel}`)
  ok(stats.invalid === 0, `${stats.invalid} invalid linear samples`)
  ok(stats.ceilingFraction < 0.05,
    `${(stats.ceilingFraction * 100).toFixed(2)}% of channels are decoder-clipped`)
  ok(
    Math.max(
      Math.abs(renderedRgb[0] - 96),
      Math.abs(renderedRgb[1] - 144),
      Math.abs(renderedRgb[2] - 208),
    ) <= 3,
    `rendered sRGB round-trip produced ${renderedRgb.join(', ')}`,
  )
  }
  checkMetadataAndSamples()
  return {
    buffer,
    metadataMs,
    linearTimed,
    embeddedTimed,
    full,
    embedded,
    image,
    stats,
    meta,
    renderedRgb,
    nativePreviewSize,
    previewSize,
    generatedPreviewSize,
    thumbSize,
    ingest,
  }
  }
  const decoded = await checkDecodePipeline()
  const {
    buffer,
    metadataMs,
    linearTimed,
    embeddedTimed,
    full,
    embedded,
    image,
    stats,
    meta,
    renderedRgb,
    nativePreviewSize,
    previewSize,
    generatedPreviewSize,
    thumbSize,
    ingest,
  } = decoded

  async function checkDefaultAppearance() {
  const defaultAppearance = await renderedStats(
    image,
    defaultEdits('raw', image.asShot, meta?.iso),
    'RAW defaults',
  )
  const cameraJpegAppearance = embedded
    ? await renderedStats(
        renderedSourceOf(embedded),
        defaultEdits('rendered', RENDERED_WHITE_POINT),
        'Camera JPEG',
      )
    : null

  /**
   * The RAW defaults rendered at whatever exposure puts them at the camera
   * JPEG's brightness.
   *
   * Acutance is gradient magnitude, so it scales with the signal it is measured
   * on: identical sharpening on a picture half as bright reports half the
   * figure. LibRaw runs with `noAutoBright`, deliberately leaving exposure to
   * the user, while the camera JPEG has the camera's own auto-brightening baked
   * in — so on a dark frame the two are not comparable as they stand, and
   * comparing them regardless measures the exposure gap rather than the
   * sharpener.
   *
   * That distinction used to be invisible. While the decode was still on
   * dcraw's 0.45/4.5 curve the renderer's own transfer encoded it a second
   * time, lifting the default rendering by about a stop and letting a raw
   * acutance comparison pass for the wrong reason. Removing the double encode
   * is what exposed it.
   */
  async function brightnessMatched(target: number) {
    let lo = 0
    let hi = 4
    let best: Awaited<ReturnType<typeof renderedStats>> | null = null
    let bestExposure = 0
    // Rendered brightness is monotonic in exposure, so bisection converges.
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) / 2
      const trial = defaultEdits('raw', image.asShot, meta?.iso)
      trial.basic.exposure = mid
      const stats = await renderedStats(image, trial, `RAW defaults +${mid.toFixed(2)}EV`)
      if (best === null || Math.abs(stats.p90 - target) < Math.abs(best.p90 - target)) {
        best = stats
        bestExposure = mid
      }
      if (stats.p90 < target) lo = mid
      else hi = mid
    }
    return { stats: best!, exposure: bestExposure }
  }
  const matchedAppearance = cameraJpegAppearance
    ? await brightnessMatched(cameraJpegAppearance.p90)
    : null

  // Each renderedStats call creates its own Renderer, so these are independent
  // and can resolve in parallel without sharing any GPU state.
  const qualityVariants = params.has('variants')
    ? await Promise.all(
        [
          { name: 'Capture 60 / Color NR 35', sharpen: 60, color: 35 },
          { name: 'Capture 65 / Color NR 45', sharpen: 65, color: 45 },
          { name: 'Capture 70 / Color NR 55', sharpen: 70, color: 55 },
        ].map(async ({ name, sharpen, color }) => {
          const variant = defaultEdits('raw', image.asShot, meta?.iso)
          variant.detail.sharpenAmount = sharpen
          variant.detail.colorNR = color
          return {
            name,
            sharpen,
            color,
            appearance: await renderedStats(image, variant, name),
          }
        }),
      )
    : null
  let detailControls: {
    smoothness: { low: Awaited<ReturnType<typeof renderedStats>>; high: Awaited<ReturnType<typeof renderedStats>> }
    contrast: { low: Awaited<ReturnType<typeof renderedStats>>; high: Awaited<ReturnType<typeof renderedStats>> }
  } | null = null
  const edits = defaultEdits('raw', image.asShot)
  edits.detail.sharpenAmount = 0
  edits.detail.luminanceNR = 0
  edits.detail.colorNR = 0
  const renderedBeforeAuto = await renderedStats(image, edits, 'As shot')
  if (fixture === DEFAULT_FIXTURE) {
    /*
     * Whether any pixel actually lands above the white-balance headroom point
     * is a property of the scene, not of the decoder, so it is asserted here
     * against the one frame known to contain such highlights rather than
     * against every fixture. The X-T5 frame is an ISO 125 exposure whose
     * brightest pixel sits at about a third of saturation in linear light and
     * clips nothing at all — it has no headroom to preserve.
     *
     * It used to hold everywhere for the wrong reason: on dcraw's 0.45/4.5
     * curve every value was inflated between 1.8x and 4.5x, which pushed even
     * an unclipped frame past 1.0. The two assertions above are the
     * content-independent half of this guard and still catch a decode that
     * throws the headroom away.
     */
    ok(stats.max > 1, `decoded maximum ${stats.max} discarded RAW headroom`)

    // With every editable detail control disabled this is intentionally the
    // sensor-facing baseline, not a secretly pre-smoothed image. Keep a broad
    // guard against demosaic regressions, then hold the actual default rendering
    // to the stricter thresholds below.
    ok(renderedBeforeAuto.lumaVariation < 4.1,
      `RAW luminance variation is ${renderedBeforeAuto.lumaVariation}`)
    ok(renderedBeforeAuto.chromaVariation < 9,
      `RAW chroma variation is ${renderedBeforeAuto.chromaVariation}`)
    ok(defaultAppearance.lumaVariation < 4.1,
      `default luminance variation is ${defaultAppearance.lumaVariation}`)
    ok(defaultAppearance.chromaVariation < 5.6,
      `default chroma variation is ${defaultAppearance.chromaVariation}`)
    ok(
      defaultAppearance.chromaVariation < renderedBeforeAuto.chromaVariation * 0.68,
      'default colour noise reduction did not materially clean the sensor baseline',
    )
    ok(
      defaultAppearance.edgeP99 >= renderedBeforeAuto.edgeP99 * 0.8,
      `default detail processing reduced strong edges from ${renderedBeforeAuto.edgeP99} to ${defaultAppearance.edgeP99}`,
    )
    ok(!!cameraJpegAppearance, 'camera JPEG comparison is unavailable')
    ok(
      !cameraJpegAppearance ||
        defaultAppearance.chromaVariation <= cameraJpegAppearance.chromaVariation * 1.05,
      `RAW chroma variation ${defaultAppearance.chromaVariation} exceeds camera JPEG ${cameraJpegAppearance?.chromaVariation}`,
    )
    ok(
      !matchedAppearance ||
        !cameraJpegAppearance ||
        matchedAppearance.stats.edgeP99 >= cameraJpegAppearance.edgeP99 * 0.95,
      `RAW edge acutance ${matchedAppearance?.stats.edgeP99} at +${matchedAppearance?.exposure.toFixed(2)}EV ` +
        `trails camera JPEG ${cameraJpegAppearance?.edgeP99} at matched brightness ` +
        `(${matchedAppearance?.stats.p90} vs ${cameraJpegAppearance?.p90})`,
    )

    const lowSmoothness = defaultEdits('raw', image.asShot)
    lowSmoothness.detail.sharpenAmount = 0
    lowSmoothness.detail.luminanceNR = 0
    lowSmoothness.detail.colorNR = 50
    lowSmoothness.detail.colorNRSmoothness = 0
    const highSmoothness = structuredClone(lowSmoothness)
    highSmoothness.detail.colorNRSmoothness = 100

    const lowContrast = defaultEdits('raw', image.asShot)
    lowContrast.detail.sharpenAmount = 0
    lowContrast.detail.colorNR = 0
    lowContrast.detail.luminanceNR = 60
    lowContrast.detail.luminanceNRContrast = 0
    const highContrast = structuredClone(lowContrast)
    highContrast.detail.luminanceNRContrast = 100

    detailControls = {
      smoothness: {
        low: await renderedStats(image, lowSmoothness, 'Colour smoothness 0'),
        high: await renderedStats(image, highSmoothness, 'Colour smoothness 100'),
      },
      contrast: {
        low: await renderedStats(image, lowContrast, 'Luminance contrast 0'),
        high: await renderedStats(image, highContrast, 'Luminance contrast 100'),
      },
    }
    ok(
      detailControls.smoothness.high.chromaVariation <
        detailControls.smoothness.low.chromaVariation * 0.99,
      'colour noise smoothness does not affect the rendered result',
    )
    ok(
      detailControls.contrast.high.lumaVariation >
        detailControls.contrast.low.lumaVariation * 1.25,
      'luminance noise contrast does not restore local contrast',
    )
  }
  return {
    defaultAppearance,
    cameraJpegAppearance,
    matchedAppearance,
    qualityVariants,
    detailControls,
    edits,
    renderedBeforeAuto,
  }
  }
  const appearance = await checkDefaultAppearance()
  const {
    defaultAppearance,
    cameraJpegAppearance,
    matchedAppearance,
    qualityVariants,
    detailControls,
    edits,
    renderedBeforeAuto,
  } = appearance

  async function checkAutoDevelop() {
  const auto = autoDevelop(image, edits)
  applyAuto(edits, auto)
  const autoAgain = autoDevelop(image, edits)

  ok(
    !auto.wb ||
      (auto.wb.temp >= TEMP_MIN &&
        auto.wb.temp <= TEMP_MAX &&
        auto.wb.tint >= TINT_MIN &&
        auto.wb.tint <= TINT_MAX),
    `Auto white balance is ${JSON.stringify(auto.wb)}`,
  )
  ok(Number.isFinite(auto.tone.exposure) && Math.abs(auto.tone.exposure) <= 3,
    `Auto exposure is ${auto.tone.exposure}`)
  ok(auto.tone.highlights >= -60 && auto.tone.highlights <= 0,
    `Auto highlights are ${auto.tone.highlights}`)
  ok(auto.tone.whites >= -45 && auto.tone.whites <= 45,
    `Auto whites are ${auto.tone.whites}`)
  ok(auto.tone.blacks >= -45 && auto.tone.blacks <= 45,
    `Auto blacks are ${auto.tone.blacks}`)
  ok(auto.vibrance >= -12 && auto.vibrance <= 25,
    `Auto vibrance is ${auto.vibrance}`)
  ok(JSON.stringify(autoAgain) === JSON.stringify(auto), 'Auto is not idempotent on the real RAW')

  const renderedAfterAuto = await renderedStats(image, edits, 'Auto')
  ok(renderedAfterAuto.clipped < 0.08,
    `Auto left ${(renderedAfterAuto.clipped * 100).toFixed(2)}% of rendered pixels clipped`)
  ok(
    renderedAfterAuto.clipped <= renderedBeforeAuto.clipped + 0.02,
    `Auto increased clipping from ${renderedBeforeAuto.clipped} to ${renderedAfterAuto.clipped}`,
  )
  ok(
    renderedAfterAuto.p50 > 0.16 && renderedAfterAuto.p50 < 0.72,
    `Auto mid-tone landed at ${renderedAfterAuto.p50}`,
  )
  return { auto, renderedAfterAuto }
  }
  const { auto, renderedAfterAuto } = await checkAutoDevelop()

  return {
    pass: failures.length === 0,
    failures,
    fixture,
    bytes: buffer.byteLength,
    ms: Math.round(performance.now() - started),
    timings: {
      metadata: Math.round(metadataMs),
      linear: Math.round(linearTimed.ms),
      embedded: Math.round(embeddedTimed.ms),
    },
    dimensions: {
      requestedEdge,
      decoded: [full.width, full.height],
      oriented: [full.fullWidth, full.fullHeight],
      nativePreview: nativePreviewSize,
      preview: previewSize,
      generatedPreview: generatedPreviewSize,
      thumbnail: thumbSize,
      ingestThumbnail: ingest.thumbSize,
      flip: meta?.flip,
    },
    camera: `${meta?.cameraMake} ${meta?.cameraModel}`.trim(),
    iso: meta?.iso,
    asShot: image.asShot,
    whiteLevel: image.whiteLevel,
    source: stats,
    renderedRgb,
    defaultAppearance,
    cameraJpegAppearance,
    matchedAppearance,
    qualityVariants,
    proxyQuality: 'native demosaic',
    decodeQuality,
    detailControls,
    auto,
    renderedBeforeAuto,
    renderedAfterAuto,
  }
}

runCheck(async () => {
  try {
    return await run()
  } finally {
    // The pool holds decoder workers; a failed run must still let them go.
    rawPool.dispose()
  }
})
