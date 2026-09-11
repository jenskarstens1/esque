/**
 * Segmentation worker.
 *
 * Inference is a second or two of solid compute even on the GPU, because the
 * upload, the graph and the readback all have to happen before anything can be
 * drawn. Doing that on the main thread would freeze the viewport mid-edit, so
 * it lives out here and the result crosses back as a transferred buffer.
 *
 * The most recently used session is cached. Building one costs the weights being parsed
 * and the graph compiled — a large chunk of the total for the small model — and
 * a user masking a shoot will run the same network on photo after photo, so
 * paying it once is most of what makes the second mask feel instant.
 *
 * Input and output names are read off the session rather than hardcoded. The
 * families name their tensors quite differently (`input.1` and a numbered
 * output on U²-Net, `input`/`output` on MODNet), and a registry
 * that had to carry them would break the moment someone pointed it at a model
 * that was re-exported. These graphs take one input and their first output is
 * the one that matters, which is a far more stable thing to rely on.
 */
import * as Comlink from 'comlink'
import * as ort from 'onnxruntime-web/webgpu'
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import { prepareModelInput, predictionAlpha, squareAlpha, type PrepareSource } from './prepare'
import { SEGMENT_MODELS, type SegmentModelId } from './models'

export interface SegmentRequest {
  modelId: SegmentModelId
  /** Omitted when the caller has established that this model is resident. */
  weights?: ArrayBuffer
  width: number
  height: number
  isRaw?: boolean
  /** RGBA half-float, scene-linear ProPhoto. */
  pixels: Uint16Array
}

export interface SegmentResult {
  /** `size` × `size` coverage in 0..1. */
  alpha: Float32Array
  size: number
  /** Whether the run actually used the GPU, for the status line. */
  gpu: boolean
  ms: number
}

interface Cached {
  session: ort.InferenceSession
  gpu: boolean
}

const sessions = new Map<string, Promise<Cached>>()

// Comlink calls can overlap. Serialize GPU work and model release, retaining
// only one compiled model rather than accumulating hundreds of MB per tier.
let queue: Promise<void> = Promise.resolve()
function serial<T>(run: () => Promise<T>): Promise<T> {
  const task = queue.then(run)
  queue = task.then(() => {}, () => {})
  return task
}

async function releaseSession(modelId: string): Promise<void> {
  const cached = sessions.get(modelId)
  if (!cached) return
  const { session } = await cached
  await session.release()
  sessions.delete(modelId)
}

/**
 * ORT's WASM binary, resolved through the bundler.
 *
 * The default is a jsDelivr URL built from the package version, which would
 * mean a local-first editor quietly fetching its runtime from a CDN — and
 * failing outright offline. Vite rewrites this to a hashed asset in `dist`, so
 * everything the worker needs is served from the same origin as the app.
 *
 * The `webgpu` entry point is the "bundle" variant, which inlines the loader
 * glue, so only the binary itself is external. It is also the smallest build
 * carrying both backends this worker asks for: 24 MB against the 27 MB of the
 * default entry point, which additionally drags in WebNN.
 */
ort.env.wasm.wasmPaths = { wasm: wasmUrl }
ort.env.wasm.numThreads = globalThis.crossOriginIsolated
  ? Math.max(1, Math.min(4, navigator.hardwareConcurrency ?? 2)) : 1
ort.env.logLevel = 'error'

async function build(weights: ArrayBuffer): Promise<Cached> {
  const bytes = new Uint8Array(weights)

  // WebGPU first, WASM second. The fallback is not hypothetical — a converted
  // graph can contain one operator the WebGPU backend has not implemented, and
  // the whole session fails to build rather than degrading to CPU for that
  // node. Catching it here means an unusual model is slow instead of broken.
  try {
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['webgpu'],
      graphOptimizationLevel: 'all',
    })
    return { session, gpu: true }
  } catch {
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    })
    return { session, gpu: false }
  }
}

const api = {
  ready(modelId: SegmentModelId): Promise<boolean> {
    return serial(async () => sessions.has(modelId))
  },

  segment(req: SegmentRequest): Promise<SegmentResult> {
    return serial(async () => {
      const started = performance.now()

      let cached = sessions.get(req.modelId)
      if (!cached) {
        if (!req.weights?.byteLength) throw new Error('The model is not loaded. Retry detection with its weights.')
        for (const id of sessions.keys()) await releaseSession(id)
        cached = build(req.weights)
        sessions.set(req.modelId, cached)
      }
      let resolved: Cached
      try {
        resolved = await cached
      } catch (err) {
        // Failed builds must not prevent a later retry.
        sessions.delete(req.modelId)
        throw err
      }
      const { session, gpu } = resolved

      const source: PrepareSource = {
        width: req.width,
        height: req.height,
        data: req.pixels,
        isRaw: req.isRaw,
      }
      const model = SEGMENT_MODELS[req.modelId]
      const tensor = prepareModelInput(source, model)

      const inputName = session.inputNames[0]
      const input = new ort.Tensor('float32', tensor.data, [1, 3, tensor.height, tensor.width])
      let outputs: ort.InferenceSession.ReturnType | undefined
      try {
        // U²-Net's auxiliary heads are separate outputs, not extra alpha planes.
        outputs = await session.run({ [inputName]: input }, [session.outputNames[0]])
        const first = outputs[session.outputNames[0]]
        if (first.dims.length !== 4 || first.dims[0] !== 1 || first.dims[1] !== 1 ||
            first.dims[2] !== tensor.height || first.dims[3] !== tensor.width) {
          throw new Error('The model returned an unsupported mask shape.')
        }
        const data = first.data
        if (!(first.type === 'float32' && data instanceof Float32Array) &&
            !(first.type === 'float16' && data instanceof Uint16Array)) {
          throw new Error(`Unsupported mask tensor type: ${first.type}.`)
        }
        const prediction = predictionAlpha(data, tensor.width, model.output, tensor.height)
        const { data: alpha, size } = squareAlpha(prediction, tensor.width, tensor.height)
        return Comlink.transfer(
          { alpha, size, gpu, ms: performance.now() - started },
          [alpha.buffer],
        )
      } finally {
        input.dispose()
        if (outputs) for (const output of Object.values(outputs)) output.dispose()
      }
    })
  },

  /** Frees a session's GPU memory when the user switches tiers. */
  release(modelId: string): Promise<void> {
    return serial(() => releaseSession(modelId))
  },
}

export type SegmentWorkerApi = typeof api

Comlink.expose(api)
