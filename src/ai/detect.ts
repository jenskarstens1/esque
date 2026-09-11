/**
 * Driving detection, and telling the user what it is doing.
 *
 * A subject mask can take a hundred milliseconds or it can take a hundred
 * megabytes and half a minute, and the difference is not something the user
 * can be expected to guess. So every stage is a state here — probing, waiting
 * on a download with real progress, running, ready, failed — and the panel
 * renders all of them rather than a spinner that means five different things.
 *
 * Detection is keyed by photo, kind and model, which is also the OPFS key the
 * mask's `cacheKey` holds. Asking twice for the same combination joins the
 * first run instead of starting a second, so dragging Refine while a detection
 * is in flight does not queue up a backlog of identical inferences.
 */
import * as Comlink from 'comlink'
import { create } from 'zustand'
import { alphaKey, loadAlpha, putAlpha, saveAlpha } from './alpha'
import { loadModelWeights } from './modelCache'
import { createInference } from './inference'
import {
  SEGMENT_MODELS,
  aiSupport,
  type AiMaskKind,
  type SegmentModelId,
} from './models'
import type { SegmentWorkerApi } from './segmentWorker'
import { peekProxy } from '../develop/proxy'
import { cacheHas } from '../catalog/opfs'

export type DetectPhase = 'idle' | 'queued' | 'downloading' | 'running' | 'ready' | 'error'

export const isDetectionBusy = (phase: DetectPhase) =>
  phase === 'queued' || phase === 'downloading' || phase === 'running'

export interface DetectStatus {
  phase: DetectPhase
  /** 0..1 while downloading; null otherwise. */
  progress: number | null
  message: string | null
  /** False when the run fell back to the CPU. */
  gpu: boolean
  ms: number | null
}

const IDLE: DetectStatus = { phase: 'idle', progress: null, message: null, gpu: true, ms: null }

interface DetectState {
  status: Record<string, DetectStatus>
  /** Bumped whenever coverage lands, so the viewport knows to rebuild. */
  revision: number
}

export const useDetect = create<DetectState>(() => ({ status: {}, revision: 0 }))

function setStatus(key: string, patch: Partial<DetectStatus>) {
  useDetect.setState((s) => ({
    status: { ...s.status, [key]: { ...(s.status[key] ?? IDLE), ...patch } },
  }))
}

export function detectStatus(key: string | null): DetectStatus {
  if (!key) return IDLE
  return useDetect.getState().status[key] ?? IDLE
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

const inference = createInference({
  loadWeights: loadModelWeights,
  createBackend: () => {
    const worker = new Worker(new URL('./segmentWorker.ts', import.meta.url), { type: 'module' })
    const remote = Comlink.wrap<SegmentWorkerApi>(worker)
    return {
      ready: (id) => remote.ready(id),
      segment: (request) => remote.segment(request),
      release: (id) => remote.release(id),
      dispose: () => worker.terminate(),
    }
  },
})

/** Drops the worker entirely, which is the only reliable way to free the session. */
export function shutdownDetect(): void {
  inference.shutdown()
}

/** Release a deleted model after any inference already using it finishes. */
export async function releaseDetectionModel(modelId: SegmentModelId): Promise<void> {
  await inference.release(modelId)
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const running = new Map<string, Promise<boolean>>()

export interface DetectRequest {
  photoId: string
  kind: AiMaskKind
  modelId: SegmentModelId
  /** Explicit re-detection must not just return the previous coverage. */
  force?: boolean
}

export function detectKey(req: DetectRequest): string {
  const key = alphaKey(req.photoId, req.kind, req.modelId)
  const version = SEGMENT_MODELS[req.modelId].coverageVersion
  return version > 1 ? `${key}.v${version}` : key
}

/** Restores saved coverage without downloading a model or changing any edits. */
export async function restoreCoverage(key: string): Promise<boolean> {
  const existing = running.get(key)
  if (existing) return existing
  try {
    const cached = await loadAlpha(key)
    const detection = running.get(key)
    if (detection) return detection
    if (cached) {
      setStatus(key, { phase: 'ready', progress: null, message: null, ms: null })
      return true
    }
    setStatus(key, {
      phase: 'error',
      progress: null,
      message: 'Saved coverage is unavailable. Run detection again; your mask adjustments are unchanged.',
    })
  } catch (err) {
    setStatus(key, {
      phase: 'error',
      progress: null,
      message: err instanceof Error ? err.message : String(err),
    })
  }
  return false
}

/**
 * Produces coverage for one photo, or reports why it could not.
 *
 * Resolves `true` when coverage is available under the request's key, whether
 * that took a download and an inference or just an OPFS read. Errors are
 * folded into the store rather than thrown: every caller is a click handler or
 * an effect, and none of them has anywhere useful to put an exception.
 */
export function detect(req: DetectRequest): Promise<boolean> {
  const key = detectKey(req)
  const existing = running.get(key)
  if (existing) return existing

  const task = run(req, key).finally(() => running.delete(key))
  running.set(key, task)
  return task
}

async function run(req: DetectRequest, key: string): Promise<boolean> {
  const model = SEGMENT_MODELS[req.modelId]

  try {
    // A cached result skips the model entirely — no download, no session, no
    // inference. This is the path a reopened photo takes.
    const cached = req.force ? null : await loadAlpha(key)
    if (cached) {
      // A previous write may have failed while the live coverage stayed in RAM.
      if (detectStatus(key).phase === 'error' || !(await cacheHas(key))) {
        await saveAlpha(key, cached)
      }
      setStatus(key, { phase: 'ready', progress: null, message: null, ms: null })
      useDetect.setState((s) => ({ revision: s.revision + 1 }))
      return true
    }

    const support = await aiSupport()
    if (!support.ok) {
      setStatus(key, { phase: 'error', progress: null, message: support.reason })
      return false
    }

    // The proxy is the only copy of the pixels that is already decoded and in
    // memory. Detection deliberately does not force one to be loaded: it is a
    // response to a click in Develop, where the photo on screen is by
    // definition the photo whose proxy is resident.
    const proxy = peekProxy(req.photoId)
    if (!proxy) {
      setStatus(key, {
        phase: 'error',
        progress: null,
        message: 'The photo is still loading. Try again in a moment.',
      })
      return false
    }

    setStatus(key, { phase: 'queued', progress: null, message: null, gpu: support.gpu })
    const result = await inference.segment(
      model, proxy,
      (stage) => setStatus(key, { phase: stage === 'loading' ? 'downloading' : 'running', progress: null }),
      ({ loaded, total }) => setStatus(key, { progress: total > 0 ? loaded / total : 0 }),
    )

    const alpha = { size: result.size, data: result.alpha }
    await saveAlpha(key, alpha)
    putAlpha(key, alpha)
    useDetect.setState((s) => ({ revision: s.revision + 1 }))

    setStatus(key, {
      phase: 'ready',
      progress: null,
      message: null,
      gpu: result.gpu,
      ms: Math.round(result.ms),
    })
    return true
  } catch (err) {
    setStatus(key, {
      phase: 'error',
      progress: null,
      message: err instanceof Error && err.name === 'QuotaExceededError'
        ? 'Browser storage is full. Free some cache space in Settings, then retry detection.'
        : err instanceof Error ? err.message : 'Detection failed.',
    })
    return false
  }
}
