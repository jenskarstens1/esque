/**
 * End-to-end check for detected masks.
 *
 * The interesting failures in this feature are all silent ones, which is why
 * this exists rather than a unit test of the pieces.
 *
 * **The runtime has to load from our own origin.** ORT's default `wasmPaths` is
 * a jsDelivr URL built from the package version. Overriding it is one line, and
 * getting that line wrong does not throw at import time — it throws deep inside
 * the first `InferenceSession.create`, or worse, quietly works in development
 * on a machine with a warm CDN cache. So the first thing checked is that a
 * session builds at all.
 *
 * **Preprocessing is where the mask is won or lost.** The proxy is scene-linear
 * ProPhoto at whatever exposure the RAW happened to sit at; U²-Net was trained
 * on ordinary sRGB JPEGs. Hand it the former unconverted and it does not fail,
 * it just returns a vague grey blob. There is no assertion that catches "vague"
 * except running the network on a frame whose answer is known, so the scene
 * here is a hard-edged bright disc on a dark ground and the check is that the
 * middle of the disc comes back high, the corners come back low, and the gap
 * between them is wide.
 *
 * **The alpha has to survive the trip into framed space.** Coverage is computed
 * on the unframed sensor grid and consumed by a mask shader working in cropped,
 * straightened coordinates. `framedAlpha` replays the geometry pass to bridge
 * them; if it is wrong the mask is offset or mirrored, which looks like a bad
 * model rather than a bad transform. So the last stage renders a real mask
 * through the real renderer and checks the coverage landed where the disc is.
 *
 * Run with `node tools/headless.mjs 'http://localhost:PORT/checks/segcheck.html?download'`.
 * `?download` explicitly permits this diagnostic to install the Fast model.
 * Unlike most of the GPU checks this one does work under puppeteer, which
 * reports a WebGPU adapter here; `tools/browsercheck.mjs` drives it in a real
 * browser if that ever stops being true.
 */
import { Renderer } from '../gpu/renderer'
import { defaultEdits } from '../core/defaults'
import { RENDERED_WHITE_POINT, type SourceImage } from '../core/workingImage'
import { floatToHalf } from '../core/half'
import { prepareInput, normalizeAlpha } from '../ai/prepare'
import { bitmapToLinear } from '../raw/rendered'
import { loadModelWeights } from '../ai/modelCache'
import { createInference } from '../ai/inference'
import { modelDownloadAllowed, setModelConsent } from '../ai/preferences'
import { SEGMENT_MODELS, aiSupport, MODEL_MEAN, type SegmentModel } from '../ai/models'
import { putAlpha, alphaKey, dropAlphasFor, loadAlpha, saveAlpha } from '../ai/alpha'
import { cacheDelete } from '../catalog/opfs'
import { newMask } from '../develop/masks'
import { runCheck } from './checkreport'
import type { Edits } from '../core/types'
import * as Comlink from 'comlink'
import type { SegmentWorkerApi } from '../ai/segmentWorker'

const failures: string[] = []
const out: Record<string, unknown> = {}

function ok(cond: boolean, msg: string) {
  if (!cond) failures.push(msg)
}

const W = 640
const H = 480
/**
 * Where the subject sits, in normalised source coordinates.
 *
 * Off-centre on purpose. A disc in the middle of the frame is radially
 * symmetric about every transform this check is trying to test — rotate it,
 * crop it symmetrically, or forget to transform it at all, and the coverage
 * lands in the same place either way. Displaced, its position becomes evidence.
 */
const CX = 0.35
const CY = 0.4
const R = 0.24

/**
 * A bright disc on a dark ground, in scene-linear ProPhoto.
 *
 * Deliberately not a photograph. The point is not to prove U²-Net is good — it
 * is to prove the plumbing feeds it something it can read, and for that the
 * answer has to be unambiguous enough that a wrong colour space or a missing
 * transfer function shows up as a number rather than as a judgement call.
 *
 * The exposure is low on purpose: 0.18 mid-grey scaled down to a sixth of it,
 * the way a highlight-protected RAW actually sits. If the robust exposure
 * normalisation in `prepareInput` were removed, this frame would reach the
 * network as near-black and the mask would collapse — which is exactly the
 * regression worth catching.
 */
function disc(): SourceImage {
  const data = new Uint16Array(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W
      const v = (y + 0.5) / H
      const dx = (u - CX) * (W / H)
      const dy = v - CY
      const inside = Math.hypot(dx, dy) < R
      // Warm bright subject, mid-tone cool ground — separable by luma and by
      // hue, so the check does not depend on which cue the network happens to
      // use. The ground is deliberately not black: against black, a mask that
      // leaked everywhere would still read as zero in the render and the leak
      // assertion would pass without testing anything.
      const rgb = inside ? [0.052, 0.043, 0.028] : [0.011, 0.013, 0.02]
      const o = (y * W + x) * 4
      data[o] = floatToHalf(rgb[0])
      data[o + 1] = floatToHalf(rgb[1])
      data[o + 2] = floatToHalf(rgb[2])
      data[o + 3] = floatToHalf(1)
    }
  }
  return {
    width: W,
    height: H,
    data,
    isRaw: true,
    asShot: RENDERED_WHITE_POINT,
    whiteLevel: 1,
  }
}

/** Mean of a square patch of a size×size alpha plane, in normalised coords. */
function patch(a: Float32Array, size: number, cx: number, cy: number, r: number): number {
  let sum = 0
  let n = 0
  const x0 = Math.max(0, Math.floor((cx - r) * size))
  const x1 = Math.min(size - 1, Math.ceil((cx + r) * size))
  const y0 = Math.max(0, Math.floor((cy - r) * size))
  const y1 = Math.min(size - 1, Math.ceil((cy + r) * size))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      sum += a[y * size + x]
      n++
    }
  }
  return n ? sum / n : 0
}

// ---------------------------------------------------------------------------

/** Capability probe agrees with the browser we are actually in. */
async function checkSupport() {
  const support = await aiSupport()
  out.support = support
  ok(support.ok, `aiSupport refused this browser: ${support.reason}`)
  ok(support.gpu, 'no GPU adapter — the rest of this check will be slow but valid')
}

/** Preprocessing produces a tensor in the range the network was trained for. */
function checkPrepare() {
  const src = disc()
  const size = 320
  const t = prepareInput({ width: W, height: H, data: src.data }, size, true)

  ok(t.length === 3 * size * size, `tensor is ${t.length}, expected ${3 * size * size}`)
  ok(
    t.every((v) => Number.isFinite(v)),
    'tensor contains non-finite values',
  )

  // With divide-by-max and ImageNet normalisation, the brightest pixel of the
  // red plane lands near (1 - mean) / std. Far below that means the exposure
  // normalisation or the transfer function is missing.
  let max = -Infinity
  let min = Infinity
  for (let i = 0; i < size * size; i++) {
    if (t[i] > max) max = t[i]
    if (t[i] < min) min = t[i]
  }
  out.prepare = { min: +min.toFixed(3), max: +max.toFixed(3), mean0: MODEL_MEAN[0] }
  ok(max > 1.5, `red plane peaks at ${max.toFixed(2)}; the subject never reached white`)
  ok(min < 0, `red plane floor is ${min.toFixed(2)}; the ground never reached black`)
  ok(max - min > 2, `contrast after preprocessing is only ${(max - min).toFixed(2)}`)
}

/**
 * The whole inference path: local wasm, local weights, a mask that is right.
 */
async function checkSegment(): Promise<Float32Array> {
  const model = SEGMENT_MODELS.u2netp
  const started = performance.now()
  const weights = await diagnosticWeights(model)
  out.weights = { bytes: weights.byteLength, ms: Math.round(performance.now() - started) }
  ok(weights.byteLength > 1_000_000, `weights are only ${weights.byteLength} bytes`)

  const worker = new Worker(new URL('../ai/segmentWorker.ts', import.meta.url), {
    type: 'module',
  })
  const api = Comlink.wrap<SegmentWorkerApi>(worker)
  const src = disc()

  const res = await api.segment({
    modelId: model.id,
    weights,
    width: W,
    height: H,
    pixels: src.data,
  })

  out.segment = { ms: Math.round(res.ms), gpu: res.gpu, size: res.size }

  const a = res.alpha
  ok(a.length === model.size * model.size, `alpha is ${a.length}, expected square`)
  ok(
    a.every((v) => v >= 0 && v <= 1),
    'alpha escaped 0..1 after normalisation',
  )

  const subject = patch(a, res.size, CX, CY, R * 0.4)
  const corner = (patch(a, res.size, 0.06, 0.06, 0.05) + patch(a, res.size, 0.94, 0.94, 0.05)) / 2
  out.coverage = { subject: +subject.toFixed(3), corner: +corner.toFixed(3) }

  ok(subject > 0.7, `subject centre came back at ${subject.toFixed(2)}, expected > 0.7`)
  ok(corner < 0.3, `background corners came back at ${corner.toFixed(2)}, expected < 0.3`)
  ok(
    subject - corner > 0.5,
    `separation is only ${(subject - corner).toFixed(2)} — the mask is vague`,
  )

  worker.terminate()
  return a
}

async function diagnosticWeights(model: SegmentModel): Promise<ArrayBuffer> {
  // This diagnostic's explicit opt-in is separate from normal detection.
  const temporaryConsent = !modelDownloadAllowed(model) && new URLSearchParams(location.search).has('download')
  if (temporaryConsent) setModelConsent(model, true)
  try {
    return await loadModelWeights(model)
  } finally {
    if (temporaryConsent) setModelConsent(model, false)
  }
}

/** NASA's public-domain astronaut portrait; fixture acquisition is documented in README. */
async function checkPortrait(model: SegmentModel) {
  const response = await fetch('/raw-fixtures/ai-astronaut.png')
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) {
    throw new Error('Install the NASA portrait fixture described in README before running this check.')
  }
  const blob = await response.blob()
  const weights = await diagnosticWeights(model)
  ok(weights.byteLength === model.bytes, 'Replacement artifact has the pinned byte count')
  // Consent was restored above. An installed replacement must work offline.
  const fetcher = window.fetch
  try {
    window.fetch = async () => { throw new Error('Unexpected network request for cached model') }
    const cached = await loadModelWeights(model)
    ok(cached.byteLength === weights.byteLength, 'Replacement weights reload offline')
  } finally {
    window.fetch = fetcher
  }
  const worker = new Worker(new URL('../ai/segmentWorker.ts', import.meta.url), {
    type: 'module',
  })
  const api = Comlink.wrap<SegmentWorkerApi>(worker)
  let weightLoads = 0
  const inference = createInference({
    loadWeights: async () => { weightLoads++; return weights },
    createBackend: () => ({
      ready: (id) => api.ready(id),
      segment: (request) => api.segment(request),
      release: (id) => api.release(id),
      dispose: () => worker.terminate(),
    }),
  })
  const runs = []
  try {
    for (const [left, width, height] of [[0, 512, 512], [64, 384, 512], [0, 512, 384]]) {
      const source = bitmapToLinear(await createImageBitmap(blob, left, 0, width, height), 1024, false)
      const result = await inference.segment(model, { ...source, isRaw: false }, () => {})
      ok(source.data.byteLength === width * height * 8, 'Inference transfers do not detach the source photo')
      const { alpha, size } = result
      const face = patch(alpha, size, (0.43 * 512 - left) / width, 0.23 * 512 / height, 0.025)
      const background = patch(alpha, size, 0.96, 0.04, 0.02)
      const soft = alpha.filter((value) => value > 0.05 && value < 0.95).length
      ok(alpha.length === size * size && alpha.every((value) => Number.isFinite(value) && value >= 0 && value <= 1),
        `${model.id} ${width}x${height}: finite normalized square coverage`)
      ok(face > 0.8 && background < 0.2, `${model.id} ${width}x${height}: face/background ${face}/${background}`)
      ok(soft > 100, `${model.id} ${width}x${height}: soft edge coverage survives`)
      runs.push({ width, height, size, face, background, soft, gpu: result.gpu, ms: Math.round(result.ms) })
      if (width === 384) {
        await checkPortraitRender({
          width, height, data: source.data, isRaw: false, asShot: RENDERED_WHITE_POINT, whiteLevel: 1,
        }, { data: alpha, size }, model)
      }
    }
    ok(weightLoads === 1 && await api.ready(model.id), 'Three real detections initialize and transfer weights only once')
    await inference.release(model.id)
    ok(!(await api.ready(model.id)), 'Releasing an installed model clears worker residency')
  } finally {
    inference.shutdown()
    out.portrait = { model: model.id, weightLoads, runs }
  }
}

async function checkPortraitRender(source: SourceImage, alpha: { data: Float32Array; size: number }, model: SegmentModel) {
  const photoId = `portrait-check-${crypto.randomUUID()}`
  const kind = model.id === 'modnet' ? 'aiPerson' : 'aiSubject'
  const key = alphaKey(photoId, kind, model.id)
  const renderer = await Renderer.create(new OffscreenCanvas(1, 1))
  try {
    await saveAlpha(key, alpha)
    const restored = await loadAlpha(key)
    if (!restored) throw new Error('Portrait coverage was not persisted.')
    ok(restored.data.every((value, index) => Math.abs(value - alpha.data[index]) <= 1 / 255),
      'Actual portrait predictions survive byte-coverage storage')
    renderer.setImage(source)
    renderer.setFrame(null)
    const base = defaultEdits('rendered')
    const mask = newMask([], kind)
    const geometry = mask.components[0].geometry
    if (!('cacheKey' in geometry)) throw new Error('Expected detected geometry')
    geometry.cacheKey = key
    mask.adjustments.exposure = 3
    const u = (0.43 * 512 - 64) / source.width
    const v = 0.23
    for (const cropped of [false, true]) {
      const crop = cropped ? { left: 0.1, top: 0.05, right: 0.99, bottom: 0.9 } : base.crop
      const edits = { ...base, crop: { ...base.crop, ...crop } }
      renderer.renderOffscreen(edits)
      const plain = await renderer.readPixels('prophoto', 16, null)
      renderer.renderOffscreen({ ...edits, masks: [mask] })
      const lit = await renderer.readPixels('prophoto', 16, null)
      if (!lit || !plain) throw new Error('Portrait mask rendering returned no pixels.')
      const changeAt = (x: number, y: number) => {
        const px = Math.floor((x - crop.left) / (crop.right - crop.left) * lit.width)
        const py = Math.floor((y - crop.top) / (crop.bottom - crop.top) * lit.height)
        const index = (py * lit.width + px) * 4
        return lit.data[index] - plain.data[index]
      }
      ok(changeAt(u, v) > 1000, `${model.id}: saved matte covers the face${cropped ? ' after cropping' : ''}`)
      ok(Math.abs(changeAt(0.96, 0.06)) < 100,
        `${model.id}: saved matte leaves the background unchanged${cropped ? ' after cropping' : ''}`)
    }
  } finally {
    renderer.dispose()
    dropAlphasFor(photoId)
    await cacheDelete(key)
  }
}

/** A flat prediction must not be stretched into noise. */
function checkFlat() {
  const flat = normalizeAlpha(new Float32Array(64).fill(0.4))
  ok(
    flat.every((v) => v === 0),
    'a flat prediction should normalise to zeros, not to full coverage',
  )
}

/**
 * The alpha reaches the mask shader in the right place, cropped or not.
 *
 * Coverage is computed on the unframed sensor grid; the mask shader works in
 * cropped, straightened coordinates. `framedAlpha` bridges them by replaying
 * the geometry pass over the coverage texture. If that is wrong the mask is
 * displaced, which in a viewport looks like a bad model rather than a bad
 * transform — so this measures where the mask actually landed rather than
 * whether it landed at all, and does it twice: once undisturbed, and once
 * through a crop that moves the subject somewhere a passthrough would not put
 * it.
 */
async function checkRender(alpha: Float32Array) {
  const renderer = await Renderer.create(new OffscreenCanvas(1, 1))
  renderer.setImage(disc())
  renderer.setFrame(null)

  const cacheKey = alphaKey('segcheck', 'aiSubject', 'u2netp')
  putAlpha(cacheKey, { size: Math.round(Math.sqrt(alpha.length)), data: alpha })

  const withMask = (base: Edits): Edits => {
    const mask = newMask([], 'aiSubject')
    const geom = mask.components[0].geometry as { cacheKey: string | null; refine: number }
    geom.cacheKey = cacheKey
    geom.refine = 50
    mask.adjustments.exposure = 3
    return { ...base, masks: [mask] }
  }

  /** Where the mask put its weight, and how much of it there was. */
  const centroid = async (base: Edits) => {
    renderer.renderOffscreen(withMask(base))
    const lit = (await renderer.readPixels('prophoto', 16, null))!
    renderer.renderOffscreen(base)
    const plain = (await renderer.readPixels('prophoto', 16, null))!

    let sum = 0
    let sx = 0
    let sy = 0
    let peak = 0
    for (let y = 0; y < lit.height; y++) {
      for (let x = 0; x < lit.width; x++) {
        const o = (y * lit.width + x) * 4
        // The mask is the only difference between the two renders, so what it
        // covers is exactly where they disagree.
        const d = Math.max(0, lit.data[o] - plain.data[o])
        if (d > peak) peak = d
        sum += d
        sx += d * ((x + 0.5) / lit.width)
        sy += d * ((y + 0.5) / lit.height)
      }
    }
    return { u: sum ? sx / sum : -1, v: sum ? sy / sum : -1, peak, sum }
  }

  const base = defaultEdits('raw')
  const plainAt = await centroid(base)
  out.uncropped = { u: +plainAt.u.toFixed(3), v: +plainAt.v.toFixed(3), peak: plainAt.peak }

  ok(plainAt.peak > 500, `the mask barely lifted anything (peak +${plainAt.peak})`)
  ok(
    Math.hypot(plainAt.u - CX, plainAt.v - CY) < 0.06,
    `mask centred at (${plainAt.u.toFixed(2)}, ${plainAt.v.toFixed(2)}), subject is at (${CX}, ${CY})`,
  )

  // An asymmetric crop, so the subject moves somewhere the untransformed alpha
  // would not have put it.
  const crop = { left: 0.2, top: 0.15, right: 0.85, bottom: 0.9 }
  const cropped: Edits = { ...base, crop: { ...base.crop, ...crop } }
  const wantU = (CX - crop.left) / (crop.right - crop.left)
  const wantV = (CY - crop.top) / (crop.bottom - crop.top)

  const cropAt = await centroid(cropped)
  out.cropped = {
    u: +cropAt.u.toFixed(3),
    v: +cropAt.v.toFixed(3),
    wantU: +wantU.toFixed(3),
    wantV: +wantV.toFixed(3),
  }

  ok(cropAt.peak > 500, `no mask survived the crop (peak +${cropAt.peak})`)
  ok(
    Math.hypot(cropAt.u - wantU, cropAt.v - wantV) < 0.07,
    `cropped mask centred at (${cropAt.u.toFixed(2)}, ${cropAt.v.toFixed(2)}), expected (${wantU.toFixed(2)}, ${wantV.toFixed(2)}) — coverage is not tracking the frame`,
  )

  renderer.dispose()
}

// ---------------------------------------------------------------------------

const started = performance.now()

runCheck(async () => {
  try {
    await checkSupport()
    checkPrepare()
    checkFlat()
    const model = new URLSearchParams(location.search).get('model')
    if (model === 'modnet' || model === 'birefnet-lite' || model === 'birefnet-lite-webgpu') {
      await checkPortrait(SEGMENT_MODELS[model])
    } else {
      if (model && model !== 'u2netp') throw new Error(`Unknown diagnostic model: ${model}`)
      const alpha = await checkSegment()
      await checkRender(alpha)
    }
  } catch (err) {
    failures.push(`threw: ${(err as Error).message}\n${(err as Error).stack}`)
  }

  return {
    pass: failures.length === 0,
    failures,
    ms: Math.round(performance.now() - started),
    ...out,
  }
})
