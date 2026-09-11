import { create } from 'zustand'
import { cacheDelete, cacheRead, cacheWrite, modelKey } from '../catalog/opfs'
import { SEGMENT_MODELS, type SegmentModel, type SegmentModelId } from './models'
import { modelDownloadAllowed, setModelConsent, useAiPreferences } from './preferences'

export interface DownloadProgress {
  loaded: number
  total: number
}

export class ModelFetchError extends Error {}
export class ModelConsentError extends Error {}

export interface ModelDownload {
  phase: 'idle' | 'downloading' | 'saving' | 'ready' | 'removing' | 'error'
  progress: number
  message: string | null
}

interface ModelDownloads {
  status: Partial<Record<SegmentModelId, ModelDownload>>
  revision: number
}

interface DownloadTask {
  controller: AbortController
  promise: Promise<ArrayBuffer>
  listeners: Set<(progress: DownloadProgress) => void>
}

interface ModelCacheDependencies {
  read: typeof cacheRead
  write: (key: string, data: ArrayBuffer) => Promise<void>
  remove: typeof cacheDelete
  fetch: typeof fetch
  allowed: (model: SegmentModel) => boolean
  revoke: (model: SegmentModel) => void
}

async function matchesArtifact(model: SegmentModel, buffer: ArrayBuffer): Promise<boolean> {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return hex === model.sha256
}

/** Injectable I/O keeps consent and cancellation checks out of the user's cache. */
export function createModelCache(io: ModelCacheDependencies) {
  const useModelDownloads = create<ModelDownloads>(() => ({ status: {}, revision: 0 }))
  const inflight = new Map<SegmentModelId, DownloadTask>()
  const removing = new Map<SegmentModelId, Promise<void>>()
  const generations = new Map<SegmentModelId, number>()

  function report(model: SegmentModel, phase: ModelDownload['phase'], progress = 0, message: string | null = null) {
    useModelDownloads.setState((s) => ({
      status: { ...s.status, [model.id]: { phase, progress, message } },
      revision: s.revision + (phase === 'ready' || phase === 'idle' || phase === 'error' ? 1 : 0),
    }))
  }

  function requireConsent(model: SegmentModel) {
    if (!io.allowed(model)) {
      throw new ModelConsentError(`Allow downloads for ${model.label} in Settings > AI models first.`)
    }
  }

  function cancelModelDownload(model: SegmentModel): void {
    inflight.get(model.id)?.controller.abort()
  }

  async function modelCacheInfo(model: SegmentModel) {
    const file = await io.read(modelKey(model.id))
    return { cached: file?.size === model.bytes, bytes: file?.size ?? 0 }
  }

  async function isModelCached(model: SegmentModel): Promise<boolean> {
    return (await modelCacheInfo(model)).cached
  }

  function forgetModel(model: SegmentModel): Promise<void> {
    const existing = removing.get(model.id)
    if (existing) return existing
    io.revoke(model)
    cancelModelDownload(model)
    generations.set(model.id, (generations.get(model.id) ?? 0) + 1)
    const pending = inflight.get(model.id)
    report(model, 'removing')
    const task = (async () => {
      // Wait for an OPFS write already in progress before removing its result.
      if (pending) await Promise.allSettled([pending.promise])
      await io.remove(modelKey(model.id))
      report(model, 'idle')
    })().catch((error: unknown) => {
      report(model, 'error', 0, error instanceof Error ? error.message : 'Could not delete the model.')
      throw error
    }).finally(() => removing.delete(model.id))
    removing.set(model.id, task)
    return task
  }

  async function download(model: SegmentModel, onProgress: (progress: DownloadProgress) => void, signal: AbortSignal) {
    let lastError: unknown
    for (const url of [model.local, model.remote]) {
      signal.throwIfAborted()
      requireConsent(model)
      try {
        const response = await io.fetch(url, { signal, mode: 'cors', credentials: 'same-origin' })
        const type = response.headers.get('content-type') ?? ''
        if (!response.ok || type.includes('text/html')) {
          await response.body?.cancel()
          throw new ModelFetchError(`${url} responded ${response.status}${type.includes('text/html') ? ' with HTML' : ''}.`)
        }
        const buffer = await drain(response, model, onProgress, signal)
        if (!(await matchesArtifact(model, buffer))) {
          throw new ModelFetchError(`${model.label} failed its integrity check. The file does not match the approved model.`)
        }
        return buffer
      } catch (error) {
        if (signal.aborted) throw error
        lastError = error
      }
    }
    throw new ModelFetchError(
      `Could not download ${model.label}. ${lastError instanceof Error ? lastError.message : 'No source responded.'}`,
    )
  }

  /** Only a cache miss can reach the network, and every source requires consent. */
  async function loadModelWeights(model: SegmentModel, onProgress?: (progress: DownloadProgress) => void): Promise<ArrayBuffer> {
    const generation = generations.get(model.id) ?? 0
    const available = () => {
      if (removing.has(model.id) || generation !== (generations.get(model.id) ?? 0)) {
        throw new Error('This model was deleted or is being deleted. Allow its download in Settings to use it again.')
      }
    }
    available()
    const key = modelKey(model.id)
    const hit = await io.read(key)
    available()
    if (hit?.size === model.bytes) {
      const buffer = await hit.arrayBuffer()
      available()
      if (await matchesArtifact(model, buffer)) {
        available()
        onProgress?.({ loaded: hit.size, total: hit.size })
        return buffer
      }
      available()
    }
    requireConsent(model)

    let task = inflight.get(model.id)
    if (!task) {
      const controller = new AbortController()
      const listeners = new Set<(progress: DownloadProgress) => void>()
      const promise = (async () => {
        report(model, 'downloading')
        if (hit) await io.remove(key)
        const buffer = await download(model, (progress) => {
          report(model, 'downloading', progress.loaded / progress.total)
          for (const listener of listeners) listener(progress)
        }, controller.signal)
        controller.signal.throwIfAborted()
        requireConsent(model)
        report(model, 'saving', 1)
        await io.write(key, buffer)
        if (controller.signal.aborted || !io.allowed(model)) {
          await io.remove(key)
          controller.signal.throwIfAborted()
          requireConsent(model)
        }
        report(model, 'ready', 1)
        return buffer
      })().catch((error: unknown) => {
        // Deletion owns its status until the pending write has been removed.
        if (!removing.has(model.id)) {
          report(model, controller.signal.aborted ? 'idle' : 'error', 0,
            controller.signal.aborted ? 'Download cancelled.' :
              error instanceof Error && error.name === 'QuotaExceededError'
                ? 'Not enough browser storage. Free space in Settings > Cache and retry.'
                : error instanceof Error ? error.message : 'Model download failed.')
        }
        throw error
      }).finally(() => inflight.delete(model.id))
      task = { controller, listeners, promise }
      inflight.set(model.id, task)
    }
    if (onProgress) task.listeners.add(onProgress)
    try {
      return await task.promise
    } finally {
      if (onProgress) task.listeners.delete(onProgress)
    }
  }

  return { useModelDownloads, loadModelWeights, modelCacheInfo, isModelCached, cancelModelDownload, forgetModel }
}

async function drain(
  response: Response,
  model: SegmentModel,
  onProgress: (progress: DownloadProgress) => void,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  // A fixed buffer bounds memory and rejects truncated/oversized artifacts.
  const out = new Uint8Array(model.bytes)
  const reader = response.body?.getReader()
  if (!reader) {
    const buffer = await response.arrayBuffer()
    signal.throwIfAborted()
    if (buffer.byteLength !== model.bytes) throw new ModelFetchError('Unexpected model size.')
    return buffer
  }
  let loaded = 0
  let complete = false
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      if (loaded + value.byteLength > out.length) throw new ModelFetchError('Model exceeds its advertised size.')
      out.set(value, loaded)
      loaded += value.byteLength
      onProgress({ loaded, total: model.bytes })
    }
    if (loaded !== model.bytes) throw new ModelFetchError(`Incomplete model: received ${loaded} of ${model.bytes} bytes.`)
    complete = true
    return out.buffer
  } finally {
    try {
      if (!complete) await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}

export const { useModelDownloads, loadModelWeights, modelCacheInfo, isModelCached, cancelModelDownload, forgetModel } =
  createModelCache({
    read: cacheRead,
    write: cacheWrite,
    remove: cacheDelete,
    fetch: (...args) => fetch(...args),
    allowed: modelDownloadAllowed,
    revoke: (model) => setModelConsent(model, false),
  })

// Revocation also covers requests made by the Develop panel and other tabs.
useAiPreferences.subscribe(() => {
  for (const model of Object.values(SEGMENT_MODELS)) {
    if (!modelDownloadAllowed(model)) cancelModelDownload(model)
  }
})
