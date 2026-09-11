import Dexie, { type EntityTable } from 'dexie'
import { createRoot } from 'react-dom/client'
import { createModelCache, ModelConsentError, useModelDownloads } from '../ai/modelCache'
import { consentKey, modelDownloadAllowed, setModelConsent, useAiPreferences } from '../ai/preferences'
import { SEGMENT_MODELS, defaultModelFor, formatBytes, modelsFor, type SegmentModel, type SegmentModelId } from '../ai/models'
import { createInference } from '../ai/inference'
import type { SegmentRequest } from '../ai/segmentWorker'
import { inputDimensions, normalizeAlpha, predictionAlpha, prepareInput, prepareModelInput, squareAlpha } from '../ai/prepare'
import { floatToHalf } from '../core/half'
import { detectKey, useDetect } from '../ai/detect'
import { alphaKey, dropAlphasFor, loadAlpha, saveAlpha } from '../ai/alpha'
import { cacheDelete } from '../catalog/opfs'
import { useDevelop } from '../develop/session'
import { newGeometry, newMask } from '../develop/masks'
import { MaskDetection } from '../modules/develop/panels/MaskDetection'
import { runMaskDetection } from '../modules/develop/panels/maskDetectionActions'
import { defaultEdits } from '../core/defaults'
import type { AiMaskGeometry } from '../core/types'
import { createBinaryCache } from '../catalog/cache'
import type { BinaryCacheEntry } from '../catalog/db'
import { SettingsDialog } from '../shell/SettingsDialog'
import { runCheck } from './checkreport'
import '../styles/index.css'

const failures: string[] = []
let assertions = 0
const ok = (value: unknown, message: string) => {
  assertions++
  if (!value) failures.push(message)
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
async function rejected(task: Promise<unknown>, message: string) {
  try {
    await task
    ok(false, message)
    return null
  } catch (cause) {
    ok(true, message)
    return cause
  }
}

const model: SegmentModel = { ...SEGMENT_MODELS.u2netp, bytes: 4096 }

function fixture() {
  const files = new Map<string, File>()
  const allowed = new Set<string>()
  const urls: string[] = []
  let fetcher: typeof fetch = async () => new Response(new Uint8Array(model.bytes))
  let beforeWrite = async () => {}
  let beforeRead = async () => {}
  let writes = 0
  const manager = createModelCache({
    read: async (key) => { await beforeRead(); return files.get(key) ?? null },
    write: async (key, data) => {
      await beforeWrite()
      writes++
      files.set(key, new File([data], key))
    },
    remove: async (key) => { files.delete(key) },
    fetch: (...args) => { urls.push(String(args[0])); return fetcher(...args) },
    allowed: (item) => allowed.has(consentKey(item)),
    revoke: (item) => { allowed.delete(consentKey(item)) },
  })
  return {
    ...manager, files, allowed, urls,
    writes: () => writes,
    fetch: (next: typeof fetch) => { fetcher = next },
    beforeWrite: (next: () => Promise<void>) => { beforeWrite = next },
    beforeRead: (next: () => Promise<void>) => { beforeRead = next },
  }
}

async function cacheChecks() {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(model.bytes))
  model.sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const f = fixture()
  const denied = await rejected(f.loadModelWeights(model), 'Unapproved model must reject')
  ok(denied instanceof ModelConsentError && f.urls.length === 0, 'Consent gates same-origin and remote requests')
  f.allowed.add(consentKey(model))
  await rejected(f.loadModelWeights({ ...model, id: 'u2net-human', bytes: 8192 }), 'Consent is per artifact')
  ok(f.urls.length === 0, 'Permission for Fast never starts a People download')
  const downloaded = await f.loadModelWeights(model)
  ok(downloaded.byteLength === model.bytes && f.urls[0] === model.local, 'Approved download tries local first')
  ok(await f.isModelCached(model), 'Successful download persists')
  f.allowed.clear()
  const requests = f.urls.length
  await f.loadModelWeights(model)
  ok(f.urls.length === requests, 'An installed model works without download consent or network')
  await f.forgetModel(model)
  ok(!(await f.isModelCached(model)) && !f.allowed.size, 'Delete removes weights and revokes permission')
  await rejected(f.loadModelWeights(model), 'Deleted models cannot silently return')
  ok(f.urls.length === requests, 'Delete prevents automatic redownload')

  const fallback = fixture()
  fallback.allowed.add(consentKey(model))
  fallback.fetch(async (url) => String(url) === model.local
    ? new Response('<html>SPA fallback</html>', { headers: { 'content-type': 'text/html' } })
    : new Response(new Uint8Array(model.bytes)))
  await fallback.loadModelWeights(model)
  ok(fallback.urls.join('|') === `${model.local}|${model.remote}`, 'HTML local fallback reaches the disclosed upstream')

  for (const size of [42, model.bytes + 1]) {
    const invalid = fixture()
    invalid.allowed.add(consentKey(model))
    invalid.fetch(async () => new Response(new Uint8Array(size)))
    await rejected(invalid.loadModelWeights(model), 'Truncated or oversized models reject')
    ok(invalid.writes() === 0, 'Invalid downloads never enter the cache')
  }

  const wrongHash = fixture()
  wrongHash.allowed.add(consentKey(model))
  wrongHash.fetch(async () => new Response(new Uint8Array(model.bytes).fill(1)))
  await rejected(wrongHash.loadModelWeights(model), 'Same-size files with the wrong hash reject')
  ok(wrongHash.writes() === 0, 'Unverified artifacts are never installed')
  wrongHash.files.set('models/u2netp.onnx', new File([new Uint8Array(model.bytes).fill(1)], 'u2netp.onnx'))
  wrongHash.allowed.clear()
  const priorRequests = wrongHash.urls.length
  await rejected(wrongHash.loadModelWeights(model), 'Same-size cache corruption still needs consent to repair')
  ok(wrongHash.urls.length === priorRequests, 'Integrity failures never bypass download consent')

  const corrupt = fixture()
  corrupt.files.set('models/u2netp.onnx', new File([new Uint8Array(30)], 'u2netp.onnx'))
  ok(!(await corrupt.isModelCached(model)), 'A truncated cache entry is not downloaded')
  ok((await corrupt.modelCacheInfo(model)).bytes === 30, 'Incomplete cached models remain visible for deletion')
  await rejected(corrupt.loadModelWeights(model), 'Cache repair still requires consent')
  ok(corrupt.urls.length === 0, 'Corruption never bypasses permission')
  corrupt.allowed.add(consentKey(model))
  await corrupt.loadModelWeights(model)
  ok(await corrupt.isModelCached(model), 'Approved repair replaces a truncated artifact')

  const shared = fixture()
  shared.allowed.add(consentKey(model))
  const start = deferred()
  const finish = deferred()
  shared.fetch(async () => { start.resolve(); await finish.promise; return new Response(new Uint8Array(model.bytes)) })
  const a: number[] = []
  const b: number[] = []
  const first = shared.loadModelWeights(model, (p) => a.push(p.loaded))
  await start.promise
  const second = shared.loadModelWeights(model, (p) => b.push(p.loaded))
  await tick()
  finish.resolve()
  await Promise.all([first, second])
  ok(shared.urls.length === 1 && shared.writes() === 1, 'Concurrent callers share one download and write')
  ok(a.at(-1) === model.bytes && b.at(-1) === model.bytes, 'All joined callers receive progress')

  const cancelled = fixture()
  cancelled.allowed.add(consentKey(model))
  const requested = deferred()
  cancelled.fetch(async (_url, init) => {
    requested.resolve()
    await new Promise<void>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })
    })
    return new Response()
  })
  const pending = rejected(cancelled.loadModelWeights(model), 'Cancelled requests reject')
  await requested.promise
  cancelled.allowed.clear()
  cancelled.cancelModelDownload(model)
  await pending
  ok(cancelled.urls.length === 1 && cancelled.writes() === 0, 'Revocation prevents fallback and persistence')
  ok(cancelled.useModelDownloads.getState().status[model.id]?.phase === 'idle', 'Cancellation exits busy state')

  const writing = fixture()
  writing.allowed.add(consentKey(model))
  const writingStarted = deferred()
  const releaseWrite = deferred()
  writing.beforeWrite(async () => { writingStarted.resolve(); await releaseWrite.promise })
  const downloading = rejected(writing.loadModelWeights(model), 'Deletion cancels an active install')
  await writingStarted.promise
  const deleting = writing.forgetModel(model)
  await rejected(writing.loadModelWeights(model), 'No new load can race deletion')
  releaseWrite.resolve()
  await Promise.all([downloading, deleting])
  ok(writing.files.size === 0 && writing.allowed.size === 0, 'A late cache write cannot resurrect a deleted model')
  ok(writing.useModelDownloads.getState().status[model.id]?.phase === 'idle', 'Deletion exits busy state')

  const stale = fixture()
  stale.files.set('models/u2netp.onnx', new File([new Uint8Array(model.bytes)], 'u2netp.onnx'))
  const reading = deferred()
  const releaseRead = deferred()
  stale.beforeRead(async () => { reading.resolve(); await releaseRead.promise })
  const staleLoad = rejected(stale.loadModelWeights(model), 'Old reads cannot use a deleted model')
  await reading.promise
  await stale.forgetModel(model)
  releaseRead.resolve()
  await staleLoad
  ok(stale.urls.length === 0, 'Deletion during cache lookup causes no network')

  const quota = fixture()
  quota.allowed.add(consentKey(model))
  quota.beforeWrite(async () => { throw new DOMException('Full', 'QuotaExceededError') })
  await rejected(quota.loadModelWeights(model), 'Failed model persistence must not claim a successful install')
  ok(quota.useModelDownloads.getState().status[model.id]?.message?.includes('storage'), 'Quota errors name the recovery')
  quota.beforeWrite(async () => {})
  await quota.loadModelWeights(model)
  ok(await quota.isModelCached(model), 'Failed download tasks can be retried')
}

async function previewChecks() {
  class CheckDB extends Dexie {
    cache!: EntityTable<BinaryCacheEntry, 'key'>
    constructor() {
      super(`esque-ai-check-${crypto.randomUUID()}`)
      this.version(1).stores({ cache: 'key, modifiedAt' })
    }
  }
  const database = new CheckDB()
  try {
    const cache = createBinaryCache(database, async () => null)
    for (const key of ['models/test.onnx', 'ai/test/mask', 'preview/test.jpg', 'proxy/test.rgba16f']) {
      await cache.cacheWrite(key, new Uint8Array(16))
    }
    await database.cache.toCollection().modify({ modifiedAt: 1 })
    ok(await cache.cacheEvict(0, 1) === 32, 'Size and age eviction remove only regenerable previews')
    ok(!!(await cache.cacheRead('models/test.onnx')) && !!(await cache.cacheRead('ai/test/mask')),
      'Automatic eviction preserves downloaded models and saved edit coverage even above budget')
    await cache.cacheWrite('preview/test.jpg', new Uint8Array(16))
    await cache.cacheWrite('proxy/test.rgba16f', new Uint8Array(16))
    await cache.cacheClear({ previewsOnly: true })
    ok(!!(await cache.cacheRead('models/test.onnx')) && !!(await cache.cacheRead('ai/test/mask')), 'Clear previews preserves models and coverage')
    ok(!(await cache.cacheRead('preview/test.jpg')) && !(await cache.cacheRead('proxy/test.rgba16f')), 'Clear previews removes preview and proxy tiers')
    await cache.cacheClear()
    ok((await cache.cacheStats()).files === 0, 'Explicit full cache clearing still clears all tiers')
  } finally {
    await database.delete()
  }
}

function inferenceFixture() {
  const weights = new ArrayBuffer(4)
  const source = { width: 2, height: 2, data: new Uint16Array(16), isRaw: false }
  const transfers: Array<{ id: SegmentModelId; weights: number }> = []
  let loads = 0
  let copies = 0
  let builds = 0
  let failLoad = false
  let beforeRun = async () => {}
  const slice = source.data.slice.bind(source.data)
  source.data.slice = (start, end) => { copies++; return slice(start, end) }
  const runner = createInference({
    loadWeights: async () => {
      loads++
      if (failLoad) throw new ModelConsentError('Permission required')
      return weights
    },
    createBackend: () => {
      builds++
      let resident: SegmentModelId | null = null
      return {
        ready: async (id: SegmentModelId) => resident === id,
        segment: async (request: SegmentRequest) => {
          const buffers: Transferable[] = [request.pixels.buffer]
          if (request.weights) buffers.push(request.weights)
          const received = structuredClone(request, { transfer: buffers })
          transfers.push({ id: received.modelId, weights: received.weights?.byteLength ?? 0 })
          if (resident !== received.modelId && !received.weights) throw new Error('Missing cold weights')
          resident = received.modelId
          await beforeRun()
          return { alpha: new Float32Array(4), size: 2, gpu: true, ms: 1 }
        },
        release: async (id: SegmentModelId) => { if (resident === id) resident = null },
        dispose: () => { resident = null },
      }
    },
  })
  return {
    runner, source, transfers, weights,
    loadCount: () => loads, copyCount: () => copies, buildCount: () => builds,
    beforeRun: (next: () => Promise<void>) => { beforeRun = next },
    failLoad: (value: boolean) => { failLoad = value },
  }
}

async function inferenceChecks() {
  const f = inferenceFixture()
  const stages: string[] = []
  const run = (model = SEGMENT_MODELS.modnet) => f.runner.segment(model, f.source, (stage) => stages.push(stage))
  try {
    await run()
    stages.length = 0
    await run()
    ok(f.loadCount() === 1 && f.transfers[1].weights === 0, 'Warm inference does not read, hash or transfer model weights')
    ok(stages.join() === 'running', 'Warm inference never displays a model download')
    ok(f.weights.byteLength === 4 && f.source.data.byteLength === 32, 'Transfers never detach shared weights or the live image')
    await f.runner.release('modnet')
    await run()
    ok(f.loadCount() === 2 && f.transfers[2].weights === 4, 'Released sessions reload weights before detection')
    f.failLoad(true)
    await rejected(run(SEGMENT_MODELS.u2netp), 'A cold model still enforces consent')
    await run()
    ok(f.loadCount() === 3, 'Failed model switches leave the resident model reusable')
    f.failLoad(false)

    const held = deferred()
    f.beforeRun(() => held.promise)
    const first = run()
    await tick()
    const before = f.copyCount()
    const second = run(SEGMENT_MODELS.u2netp)
    const release = f.runner.release('u2netp')
    await tick()
    ok(f.copyCount() === before, 'Queued photos are not copied while another inference runs')
    held.resolve()
    await Promise.all([first, second, release])
    await run(SEGMENT_MODELS.u2netp)
    ok(f.transfers.at(-1)?.weights === 4, 'Model switching and deletion are serialized with residency checks')

    const stopped = deferred()
    f.beforeRun(() => stopped.promise)
    const active = rejected(run(), 'Shutdown settles active inference instead of leaving it hung')
    const queued = rejected(run(), 'Shutdown rejects queued inference')
    await tick()
    f.runner.shutdown()
    await Promise.all([active, queued])
    f.beforeRun(async () => {})
    await run()
    ok(f.buildCount() === 2, 'Detection can restart after shutdown')
    stopped.resolve()
  } finally {
    f.runner.shutdown()
  }
}

async function maskSwitchChecks() {
  const saved = useDevelop.getState()
  const photoId = `mask-switch-${crypto.randomUUID()}`
  const mask = newMask([], 'aiPerson')
  const component = mask.components[0]
  const geometry: AiMaskGeometry = {
    kind: 'aiPerson', model: 'u2net-human', cacheKey: alphaKey(photoId, 'aiPerson', 'u2net-human'), refine: 50,
  }
  component.geometry = geometry
  const original = { ...defaultEdits('rendered'), masks: [mask] }
  const target = { photoId, maskId: mask.id, componentId: component.id, kind: 'aiPerson' as const, modelId: 'modnet' as const }
  const current = () => useDevelop.getState().edits.masks[0].components[0].geometry as AiMaskGeometry
  const reset = () => useDevelop.setState({ photoId, edits: structuredClone(original) })
  let edits = 0
  useDevelop.setState({
    update: (_key, _label, mutate) => {
      const next = structuredClone(useDevelop.getState().edits)
      mutate(next)
      edits++
      useDevelop.setState({ edits: next })
    },
  })
  try {
    reset()
    await runMaskDetection(target, async () => false)
    ok(current().cacheKey === geometry.cacheKey && current().model === 'u2net-human' && current().refine === 50 && edits === 0,
      'A failed replacement changes neither coverage, model, refinement nor history')
    const held = deferred()
    const pending = runMaskDetection(target, async () => { await held.promise; return true })
    await tick()
    ok(current().cacheKey === geometry.cacheKey && current().model === geometry.model,
      'Existing masks remain active throughout replacement detection')
    held.resolve()
    ok(await pending, 'Successful replacement commits')
    ok(current().model === 'modnet' && current().cacheKey === detectKey(target) && current().refine === 0 && edits === 1,
      'Coverage, model and default refinement switch atomically in one history step')

    reset()
    useDevelop.getState().update('', '', (next) => { (next.masks[0].components[0].geometry as AiMaskGeometry).refine = 73 })
    await runMaskDetection(target, async () => true)
    ok(current().refine === 73, 'Replacement preserves custom refinement')

    reset()
    const away = deferred()
    const late = runMaskDetection(target, async () => { await away.promise; return true })
    useDevelop.setState({ photoId: 'another-photo' })
    away.resolve()
    ok(!(await late) && current().model === 'u2net-human', 'A late result cannot edit a different photo')

    reset()
    const changed = deferred()
    const stale = runMaskDetection(target, async () => { await changed.promise; return true })
    useDevelop.getState().update('', '', (next) => { (next.masks[0].components[0].geometry as AiMaskGeometry).cacheKey = 'changed' })
    changed.resolve()
    ok(!(await stale) && current().cacheKey === 'changed', 'A late result cannot overwrite a changed mask')

    reset()
    await runMaskDetection({ ...target, modelId: 'u2net-human' }, async (request) => {
      ok(request.force === true, 'Explicit reruns bypass cached coverage, including retries')
      return false
    })
  } finally {
    useDevelop.setState(saved)
  }
}

function outputChecks() {
  const values = new Float32Array([0, 0.25, 0.5, 1])
  const half = Uint16Array.from(values, floatToHalf)
  const expected = normalizeAlpha(values)
  ok(predictionAlpha(half, 2).every((v, i) => Math.abs(v - expected[i]) < 1e-4), 'FP16 output is decoded numerically')
  const logits = predictionAlpha(new Float32Array([-100, 0, 1, 100]), 2, 'logits')
  ok(logits[0] < 0.001 && logits[1] === 0.5 && Math.abs(logits[2] - 0.731059) < 1e-5 && logits[3] === 1,
    'BiRefNet logits receive sigmoid exactly once, not a contrast stretch')
  ok(predictionAlpha(new Float32Array(4), 2, 'logits').every((value) => value === 0.5),
    'Uncertain flat logits retain their probability')
  ok(detectKey({ photoId: 'test', kind: 'aiSubject', modelId: 'birefnet-lite' }).endsWith('.v2'),
    'New BiRefNet detections cannot reuse old incorrectly normalized coverage')
  ok(detectKey({ photoId: 'test', kind: 'aiSubject', modelId: 'u2netp' }) === 'ai/test/aiSubject.u2netp',
    'Unchanged U2Net coverage keeps its cache identity')
  for (const values of [new Float32Array(3), new Float32Array([0, 1, NaN, 0])]) {
    let failed = false
    try { predictionAlpha(values, 2) } catch { failed = true }
    ok(failed, 'Malformed outputs fail explicitly')
  }
}

async function replacementChecks() {
  const portrait = SEGMENT_MODELS.modnet
  ok(defaultModelFor('aiPerson') === 'modnet', 'New People masks use MODNet')
  ok(defaultModelFor('aiSubject') === 'birefnet-lite-webgpu' && defaultModelFor('aiBackground') === 'birefnet-lite-webgpu',
    'New Subject and Background masks use BiRefNet-lite')
  ok(modelsFor('aiPerson').length === 1 && modelsFor('aiPerson')[0].id === 'modnet',
    'New People masks only offer person-specific inference')
  ok(modelsFor('aiPerson', 'u2net-human').some((item) => item.id === 'u2net-human') &&
    modelsFor('aiPerson', 'birefnet-lite').some((item) => item.id === 'birefnet-lite'),
  'Saved People masks retain both historical model choices')
  const geometry = newGeometry('aiPerson')
  ok('refine' in geometry && geometry.refine === 0, 'New portrait mattes are not contrast-hardened')
  const previous = useAiPreferences.getState()
  try {
    useAiPreferences.setState({ downloads: {
      'u2net-human': consentKey(SEGMENT_MODELS['u2net-human']),
      u2netp: consentKey(SEGMENT_MODELS.u2netp),
      'birefnet-lite': consentKey(SEGMENT_MODELS['birefnet-lite']),
    } })
    ok(!modelDownloadAllowed(portrait) && !modelDownloadAllowed(SEGMENT_MODELS['birefnet-lite-webgpu']),
      'Legacy permission does not authorize either replacement')
  } finally {
    useAiPreferences.setState(previous)
  }
  for (const [width, height, expectedWidth, expectedHeight] of [
    [900, 600, 768, 512], [600, 900, 512, 768], [20000, 200, 1024, 32], [100, 100, 512, 512],
  ]) {
    const dims = inputDimensions({ width, height }, portrait)
    ok(dims.width === expectedWidth && dims.height === expectedHeight,
      `Portrait input ${width}x${height} is aspect-aware, stride-aligned and bounded`)
  }
  const pixels = new Uint16Array(16).fill(floatToHalf(0.21404114))
  for (let i = 3; i < 16; i += 4) pixels[i] = floatToHalf(1)
  const source = { width: 2, height: 2, data: pixels, isRaw: false }
  const input = prepareModelInput(source, { ...portrait, size: 32 })
  ok(input.data.every((value) => Math.abs(value) < 0.005),
    'Rendered middle grey reaches MODNet at zero in [-1,1], without exposure renormalization')
  const legacyInput = prepareInput(source, 320, true)
  ok(prepareModelInput(source, SEGMENT_MODELS.u2netp).data.every((value, index) => value === legacyInput[index]),
    'Legacy input recipes are unchanged')
  const soft = new Float32Array([0.2, 0.4, 0.6, 0.8])
  ok(predictionAlpha(soft, 2, 'alpha').every((value, index) => value === soft[index]),
    'MODNet alpha is neither stretched nor passed through sigmoid')
  ok(predictionAlpha(new Float32Array(4).fill(0.4), 2, 'alpha').every((value) => Math.abs(value - 0.4) < 1e-6),
    'Uniform soft portrait alpha stays uniform and nonzero')
  ok(predictionAlpha(Uint16Array.from(soft, floatToHalf), 2, 'alpha')
    .every((value, index) => Math.abs(value - soft[index]) < 0.001), 'FP16 mattes retain calibrated alpha')
  const rect = squareAlpha(new Float32Array([0.1, 0.2, 0.3, 0.4, 0.6, 0.7, 0.8, 0.9]), 4, 2)
  ok(rect.size === 4 && Math.abs(rect.data[6] - 0.425) < 1e-6 && Math.abs(rect.data[15] - 0.9) < 1e-6,
    'Rectangular mattes keep their normalized position and soft transitions in square storage')
  const photoId = `ai-replacement-check-${crypto.randomUUID()}`
  const key = alphaKey(photoId, 'aiPerson', 'modnet')
  try {
    await saveAlpha(key, rect)
    const restored = await loadAlpha(key)
    ok(restored?.size === 4 && restored.data.every((value, index) => Math.abs(value - rect.data[index]) <= 1 / 255),
      'Portrait alpha survives disk storage without changing the legacy cache format')
  } finally {
    dropAlphasFor(photoId)
    await cacheDelete(key)
  }
}

async function settingsChecks() {
  const current = SEGMENT_MODELS.modnet
  const saved = localStorage.getItem('esque.ai')
  const state = useAiPreferences.getState()
  const downloads = useModelDownloads.getState()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    setModelConsent(current, false)
    root.render(<SettingsDialog open onClose={() => {}} />)
    await new Promise((resolve) => setTimeout(resolve, 100))
    window.dispatchEvent(new CustomEvent('esque:settings', { detail: { pane: 'ai' } }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    ok(document.querySelector('#settings-tab-ai')?.getAttribute('aria-selected') === 'true', 'Develop opens the AI settings tab')
    const checkbox = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]'))
      .find((input) => input.closest('label')?.textContent?.includes(`Allow downloads for ${current.label}`))
    ok(checkbox?.getAttribute('aria-checked') === 'false', 'Settings presents unchecked per-model consent')
    checkbox?.click()
    await tick()
    ok(modelDownloadAllowed(current), 'Settings grants explicit permission')
    ok(localStorage.getItem('esque.ai')?.includes(consentKey(current)), 'Permission is persisted')
    useModelDownloads.setState({
      status: { [current.id]: { phase: 'downloading', progress: 0.37, message: null } },
    })
    await tick()
    const progress = document.querySelector<HTMLElement>(`[role="progressbar"][aria-label="${current.label} model download"]`)
    ok(progress?.getAttribute('aria-valuenow') === '37', 'Model progress exposes its exact percentage')
    ok(progress?.getAttribute('aria-valuetext')?.includes(`of ${formatBytes(current.bytes)}`), 'Model progress names transferred and total bytes')
    ok(progress && getComputedStyle(progress).height === '6px', 'Download track has the shared visible height')
    useModelDownloads.setState({
      status: { [current.id]: { phase: 'saving', progress: 1, message: null } },
    })
    await tick()
    ok(progress?.getAttribute('aria-valuenow') === '100' &&
      progress.getAttribute('aria-valuetext')?.includes('Saving model'),
    'Completed transfers distinguish saving from download progress')
    const write = Storage.prototype.setItem
    setModelConsent(current, false)
    try {
      Storage.prototype.setItem = () => { throw new DOMException('Full', 'QuotaExceededError') }
      let failed = false
      try { setModelConsent(current, true) } catch { failed = true }
      ok(failed && !modelDownloadAllowed(current), 'Failed persistence never grants consent')
    } finally {
      Storage.prototype.setItem = write
    }
  } finally {
    if (saved === null) localStorage.removeItem('esque.ai')
    else localStorage.setItem('esque.ai', saved)
    useAiPreferences.setState(state)
    if (new URLSearchParams(location.search).has('progress')) {
      useModelDownloads.setState({
        status: { [current.id]: { phase: 'downloading', progress: 0.37, message: null } },
      })
    } else {
      useModelDownloads.setState(downloads)
    }
    if (!new URLSearchParams(location.search).has('ui')) {
      root.unmount()
      host.remove()
    }
  }
}

async function legacyCoverageChecks() {
  const develop = useDevelop.getState()
  const detection = useDetect.getState()
  const photoId = `ai-legacy-check-${crypto.randomUUID()}`
  const legacyKey = alphaKey(photoId, 'aiSubject', 'birefnet-lite')
  const geometry: AiMaskGeometry = { kind: 'aiSubject', model: 'birefnet-lite', cacheKey: legacyKey, refine: 50 }
  const mask = newMask([], 'aiSubject')
  const component = { ...mask.components[0], geometry }
  mask.components = [component]
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    let updates = 0
    useDevelop.setState({ photoId, update: () => { updates++ } })
    useDetect.setState({
      status: { [legacyKey]: { phase: 'ready', progress: null, message: null, gpu: true, ms: null } },
    })
    root.render(<MaskDetection mask={mask} component={component} geometry={geometry} />)
    await new Promise((resolve) => setTimeout(resolve, 60))
    ok(host.textContent?.includes('Using the saved result.'), 'Legacy BiRefNet coverage remains available under its original key')
    const refine = host.querySelector('[role="slider"][aria-label="Refine"]')
    ok(!!refine && refine.getAttribute('aria-disabled') !== 'true', 'Legacy mask refinement does not require another model download')
    const picker = host.querySelector<HTMLSelectElement>('select[aria-label="Mask model"]')
    if (!picker) throw new Error('Mask model picker is missing')
    picker.value = 'birefnet-lite-webgpu'
    picker.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    ok(updates === 0 && geometry.cacheKey === legacyKey && picker.value === 'birefnet-lite-webgpu',
      'Choosing a replacement is a preview, not a destructive edit')
    ok(host.textContent?.includes('Your current mask stays visible') && host.textContent.includes('Replace Mask'),
      'The panel clearly names the safe replacement action')
    const nextKey = detectKey({ photoId, kind: 'aiSubject', modelId: 'birefnet-lite-webgpu' })
    useDetect.setState((state) => ({ status: {
      ...state.status, [nextKey]: { phase: 'error', progress: null, message: 'Download unavailable', gpu: true, ms: null },
    } }))
    await tick()
    ok(host.querySelector('[role="alert"]')?.textContent === 'Download unavailable' &&
      refine?.getAttribute('aria-disabled') !== 'true',
    'Replacement failures are announced without disabling refinement of the current mask')
  } finally {
    root.unmount()
    host.remove()
    useDevelop.setState(develop)
    useDetect.setState(detection)
  }
}

runCheck(async () => {
  await cacheChecks()
  await previewChecks()
  await inferenceChecks()
  await maskSwitchChecks()
  outputChecks()
  await replacementChecks()
  await legacyCoverageChecks()
  await settingsChecks()
  return { pass: failures.length === 0, assertions, failures }
})
