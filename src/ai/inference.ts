import * as Comlink from 'comlink'
import type { DownloadProgress } from './modelCache'
import type { SegmentModel, SegmentModelId } from './models'
import type { PrepareSource } from './prepare'
import type { SegmentWorkerApi } from './segmentWorker'

type Backend = Pick<SegmentWorkerApi, 'ready' | 'segment' | 'release'> & { dispose(): void }
type Progress = (progress: DownloadProgress) => void

interface InferenceDependencies {
  createBackend(): Backend
  loadWeights(model: SegmentModel, progress?: Progress): Promise<ArrayBuffer>
}

async function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {}
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  try {
    return await Promise.race([task, stopped])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/** Serialize residency checks, transfers and releases as one transaction. */
export function createInference(io: InferenceDependencies) {
  let backend: Backend | null = null
  let queue: Promise<void> = Promise.resolve()
  let controller = new AbortController()

  function schedule<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = controller.signal
    const task = queue.then(() => {
      signal.throwIfAborted()
      return abortable(work(signal), signal)
    })
    queue = task.then(() => {}, () => {})
    return task
  }

  function segment(
    model: SegmentModel,
    source: PrepareSource,
    stage: (phase: 'loading' | 'running') => void,
    progress?: Progress,
  ) {
    return schedule(async (signal) => {
      const current = backend ??= io.createBackend()
      const ready = await current.ready(model.id)
      signal.throwIfAborted()
      let weights: ArrayBuffer | undefined
      if (!ready) {
        stage('loading')
        const shared = await io.loadWeights(model, progress)
        signal.throwIfAborted()
        // Download callers may share this buffer. Only transfer our own copy.
        weights = shared.slice(0)
      }
      stage('running')
      // Copy pixels only when their inference can start, not while queued.
      const pixels = source.data.slice()
      const transfers: Transferable[] = [pixels.buffer]
      if (weights) transfers.push(weights)
      const result = await current.segment(Comlink.transfer({
        modelId: model.id, weights, pixels,
        width: source.width, height: source.height, isRaw: source.isRaw,
      }, transfers))
      signal.throwIfAborted()
      return result
    })
  }

  function release(modelId: SegmentModelId): Promise<void> {
    return schedule(async () => { await backend?.release(modelId) })
  }

  function shutdown() {
    controller.abort(new DOMException('Detection was stopped. Try again.', 'AbortError'))
    backend?.dispose()
    backend = null
    controller = new AbortController()
    queue = Promise.resolve()
  }

  return { segment, release, shutdown }
}
