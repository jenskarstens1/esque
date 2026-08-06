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
import {
  SEGMENT_MODELS,
  aiSupport,
  type AiMaskKind,
  type SegmentModelId,
} from './models'
import type { SegmentWorkerApi } from './segmentWorker'
import { peekProxy } from '../develop/proxy'

export type DetectPhase = 'idle' | 'downloading' | 'running' | 'ready' | 'error'

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

let worker: Worker | null = null
let remote: Comlink.Remote<SegmentWorkerApi> | null = null

function api(): Comlink.Remote<SegmentWorkerApi> {
  if (!remote) {
    worker = new Worker(new URL('./segmentWorker.ts', import.meta.url), { type: 'module' })
    remote = Comlink.wrap<SegmentWorkerApi>(worker)
  }
  return remote
}

/** Drops the worker entirely, which is the only reliable way to free the session. */
export function shutdownDetect(): void {
  worker?.terminate()
  worker = null
  remote = null
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const running = new Map<string, Promise<boolean>>()

export interface DetectRequest {
  photoId: string
  kind: AiMaskKind
  modelId: SegmentModelId
}

export function detectKey(req: DetectRequest): string {
  return alphaKey(req.photoId, req.kind, req.modelId)
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
    const cached = await loadAlpha(key)
    if (cached) {
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

    setStatus(key, { phase: 'downloading', progress: 0, message: null, gpu: support.gpu })
    const weights = await loadModelWeights(model, ({ loaded, total }) => {
      setStatus(key, { phase: 'downloading', progress: total > 0 ? loaded / total : 0 })
    })

    setStatus(key, { phase: 'running', progress: null })

    // The proxy's buffer is copied rather than transferred: it is the live
    // texture source for the viewport, and handing it to the worker would
    // detach it out from under the next render.
    const pixels = proxy.data.slice()
    const result = await api().segment(
      Comlink.transfer(
        {
          modelId: model.id,
          size: model.size,
          divideByMax: model.divideByMax,
          weights,
          width: proxy.width,
          height: proxy.height,
          pixels,
        },
        [pixels.buffer],
      ),
    )

    const alpha = { size: result.size, data: result.alpha }
    putAlpha(key, alpha)
    void saveAlpha(key, alpha)

    setStatus(key, {
      phase: 'ready',
      progress: null,
      message: null,
      gpu: result.gpu,
      ms: Math.round(result.ms),
    })
    useDetect.setState((s) => ({ revision: s.revision + 1 }))
    return true
  } catch (err) {
    setStatus(key, {
      phase: 'error',
      progress: null,
      message: err instanceof Error ? err.message : 'Detection failed.',
    })
    return false
  }
}
