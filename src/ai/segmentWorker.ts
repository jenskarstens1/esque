/**
 * Segmentation worker.
 *
 * Inference is a second or two of solid compute even on the GPU, because the
 * upload, the graph and the readback all have to happen before anything can be
 * drawn. Doing that on the main thread would freeze the viewport mid-edit, so
 * it lives out here and the result crosses back as a transferred buffer.
 *
 * Sessions are cached by model id. Building one costs the weights being parsed
 * and the graph compiled — a large chunk of the total for the small model — and
 * a user masking a shoot will run the same network on photo after photo, so
 * paying it once is most of what makes the second mask feel instant.
 *
 * Input and output names are read off the session rather than hardcoded. The
 * two families name their tensors quite differently (`input.1` and a numbered
 * output on U²-Net, generated names on the converted BiRefNet), and a registry
 * that had to carry them would break the moment someone pointed it at a model
 * that was re-exported. Both graphs take one input and their first output is
 * the one that matters, which is a far more stable thing to rely on.
 */
import * as Comlink from 'comlink'
import * as ort from 'onnxruntime-web/webgpu'
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import { prepareInput, normalizeAlpha, type PrepareSource } from './prepare'

export interface SegmentRequest {
  modelId: string
  /** The network's square edge. */
  size: number
  divideByMax: boolean
  /** The weights. Passed in because the worker has no OPFS bookkeeping. */
  weights: ArrayBuffer
  width: number
  height: number
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
ort.env.wasm.numThreads = Math.max(1, Math.min(4, navigator.hardwareConcurrency ?? 2))
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
  async segment(req: SegmentRequest): Promise<SegmentResult> {
    const started = performance.now()

    let cached = sessions.get(req.modelId)
    if (!cached) {
      cached = build(req.weights)
      sessions.set(req.modelId, cached)
    }
    let resolved: Cached
    try {
      resolved = await cached
    } catch (err) {
      // A failed build must not be cached, or every later attempt reuses the
      // rejected promise and the user can never retry.
      sessions.delete(req.modelId)
      throw err
    }
    const { session, gpu } = resolved

    const source: PrepareSource = {
      width: req.width,
      height: req.height,
      data: req.pixels,
    }
    const tensor = prepareInput(source, req.size, req.divideByMax)

    const inputName = session.inputNames[0]
    const feeds: Record<string, ort.Tensor> = {
      [inputName]: new ort.Tensor('float32', tensor, [1, 3, req.size, req.size]),
    }

    const outputs = await session.run(feeds)
    const first = outputs[session.outputNames[0]]
    const data = first.data as Float32Array

    // The graph emits 1×1×S×S; anything beyond the first plane is a
    // side-supervision head, which is only useful during training.
    const plane = req.size * req.size
    const pred = data.length > plane ? data.subarray(0, plane) : data
    const alpha = normalizeAlpha(pred as Float32Array)

    return Comlink.transfer(
      { alpha, size: req.size, gpu, ms: performance.now() - started },
      [alpha.buffer],
    )
  },

  /** Frees a session's GPU memory when the user switches tiers. */
  async release(modelId: string): Promise<void> {
    const cached = sessions.get(modelId)
    sessions.delete(modelId)
    if (!cached) return
    try {
      const { session } = await cached
      await session.release()
    } catch {
      /* already gone */
    }
  },
}

export type SegmentWorkerApi = typeof api

Comlink.expose(api)
