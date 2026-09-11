/**
 * The segmentation models esque can run, and whether this browser can run them.
 *
 * Nothing here ships in the bundle. A model is a few megabytes at best and a
 * hundred at worst, which is not something to post to every visitor who opens
 * the Library — so weights are fetched on first use, cached in OPFS beside the
 * proxies, and reused from disk after that. The catalogue below is the whole
 * contract: sizes, licences and download weight are stated up front so the UI
 * can tell the user what a mask is about to cost before it costs it.
 *
 * MODNet supplies portrait alpha; BiRefNet-lite supplies general subject
 * segmentation. U²-Net artifacts remain addressable for older saved edits,
 * but are no longer offered when creating new masks.
 *
 * Licensing is a hard constraint rather than a footnote. esque is AGPL, so a
 * model whose weights forbid commercial use cannot ship as a default however
 * good it looks — which is why RMBG-1.4, the obvious quality pick, is absent.
 */

export const SEGMENT_MODEL_IDS = ['u2netp', 'u2net-human', 'birefnet-lite', 'modnet', 'birefnet-lite-webgpu'] as const
export type SegmentModelId = typeof SEGMENT_MODEL_IDS[number]

/** The mask kinds that are answered by a segmentation model. */
export type AiMaskKind = 'aiSubject' | 'aiBackground' | 'aiPerson'

export interface SegmentModel {
  id: SegmentModelId
  label: string
  /** One line for the picker, describing the trade rather than the network. */
  note: string
  /** Square edge for ImageNet models; target short edge for MODNet. */
  size: number
  preprocessing: 'imagenet' | 'modnet'
  /** Download weight, for the confirmation the user sees. */
  bytes: number
  /** SHA-256 of the complete, standalone ONNX artifact. */
  sha256: string
  license: string
  licenseNote?: string
  legacy?: boolean
  output: 'saliency' | 'logits' | 'alpha'
  /** Increment when preprocessing or output semantics change. */
  coverageVersion: number
  /**
   * Same-origin copy, if the deployment vendored one with
   * `tools/fetch-models.sh`. Tried first so a self-hosted esque never reaches
   * off-origin at all.
   */
  local: string
  /** Upstream release, used when the deployment did not vendor the weights. */
  remote: string
  /**
   * U²-Net normalises the input by its own maximum before the ImageNet mean
   * and standard deviation, which is what its training code did. BiRefNet does
   * not, and applying it anyway measurably shifts the prediction.
   */
  divideByMax: boolean
}

export const MODEL_MEAN: readonly [number, number, number] = [0.485, 0.456, 0.406]
export const MODEL_STD: readonly [number, number, number] = [0.229, 0.224, 0.225]

export const SEGMENT_MODELS: Record<SegmentModelId, SegmentModel> = {
  u2netp: {
    id: 'u2netp',
    label: 'Fast (legacy)',
    legacy: true,
    note: 'Older subject model, retained for existing masks.',
    size: 320,
    preprocessing: 'imagenet',
    bytes: 4_574_861,
    sha256: '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8',
    license: 'Apache-2.0',
    output: 'saliency',
    coverageVersion: 1,
    local: '/models/u2netp.onnx',
    remote: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
    divideByMax: true,
  },
  'u2net-human': {
    id: 'u2net-human',
    label: 'People (legacy)',
    legacy: true,
    note: 'Older people model, retained for existing masks.',
    size: 320,
    preprocessing: 'imagenet',
    bytes: 175_997_641,
    sha256: '01eb6a29a5c4d8edb30b56adad9bb3a2a0535338e480724a213e0acfd2d1c73c',
    license: 'Apache-2.0',
    licenseNote: 'Upstream code licence; separate human-checkpoint terms have not been independently verified.',
    output: 'saliency',
    coverageVersion: 1,
    local: '/models/u2net-human.onnx',
    remote: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx',
    divideByMax: true,
  },
  'birefnet-lite': {
    id: 'birefnet-lite',
    label: 'BiRefNet-lite (legacy)',
    legacy: true,
    note: 'Older export. Saved masks remain usable; prefer the new export for detection.',
    size: 1024,
    preprocessing: 'imagenet',
    bytes: 114_538_221,
    sha256: 'd39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402',
    license: 'MIT',
    output: 'logits',
    coverageVersion: 2,
    local: '/models/birefnet-lite.onnx',
    remote: 'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/de15b22ba131738a16dff04aab8bdf8dc32e3ac1/onnx/model_fp16.onnx',
    divideByMax: false,
  },
  modnet: {
    id: 'modnet',
    label: 'MODNet',
    note: 'Portrait matting with soft hair edges. Best for prominent people.',
    size: 512,
    preprocessing: 'modnet',
    bytes: 12_984_781,
    sha256: '25f165da9bfd30830a575f1f0490f1acd995975cb349bc02f3d79332e1fe5cf6',
    license: 'Apache-2.0',
    output: 'alpha',
    coverageVersion: 1,
    local: '/models/modnet.onnx',
    remote: 'https://huggingface.co/Xenova/modnet/resolve/fa2fa546052fba4c08921230a26cc69a333fca12/onnx/model_fp16.onnx',
    divideByMax: false,
  },
  'birefnet-lite-webgpu': {
    id: 'birefnet-lite-webgpu',
    label: 'BiRefNet-lite',
    note: 'Subject and background masks at 1024px. WebGPU-optimized export; larger download.',
    size: 1024,
    preprocessing: 'imagenet',
    bytes: 123_224_205,
    sha256: '348c075771a9f6631d6ac991a1ac613d33910390cf943afa752f3a73c36fca03',
    license: 'MIT',
    output: 'logits',
    coverageVersion: 1,
    local: '/models/birefnet-lite-webgpu.onnx',
    remote: 'https://huggingface.co/runes/birefnet-lite-webgpu/resolve/d553b221039609f1ab170e3c2e651b59f363c98a/birefnet_lite_webgpu_fp16.onnx',
    divideByMax: false,
  },
}

/** All artifacts, including legacy ones whose consent and storage remain manageable. */
export const SEGMENT_MODEL_LIST: SegmentModel[] = [
  SEGMENT_MODELS.modnet, SEGMENT_MODELS['birefnet-lite-webgpu'],
  SEGMENT_MODELS.u2netp, SEGMENT_MODELS['u2net-human'], SEGMENT_MODELS['birefnet-lite'],
]

export function modelsFor(kind: AiMaskKind, savedModel?: string): SegmentModel[] {
  const models = [kind === 'aiPerson' ? SEGMENT_MODELS.modnet : SEGMENT_MODELS['birefnet-lite-webgpu']]
  const legacy = SEGMENT_MODEL_LIST.find((model) => model.id === savedModel)
  if (legacy && !models.includes(legacy)) {
    models.push(legacy)
  }
  return models
}

export function defaultModelFor(kind: AiMaskKind): SegmentModelId {
  return modelsFor(kind)[0].id
}

export function defaultRefineFor(modelId: string | undefined): number {
  return modelId === 'modnet' ? 0 : 50
}

/** "4.4 MB" — for a sentence about a download, not a storage report. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  const mb = bytes / (1024 * 1024)
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/**
 * The ONNX Runtime WASM binary, transferred once before any model can run.
 *
 * This is the compressed size, because that is what the user waits for. It is
 * stated in the UI alongside the model size and deserves to be: at roughly 6 MB
 * the runtime outweighs the small model, so quoting only "4.4 MB" for the first
 * detection would understate the wait by more than double. It is not counted
 * once anything is cached, since by then the browser has it.
 */
export const RUNTIME_BYTES = 5_953_961

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

export interface AiSupport {
  ok: boolean
  /** Why not, or what is degraded — phrased for a tooltip on the control. */
  reason: string | null
  /** False when inference falls back to WASM, which is far slower. */
  gpu: boolean
}

let cached: AiSupport | null = null
let probe: Promise<AiSupport> | null = null

/**
 * Whether AI masks can run here, and how well.
 *
 * WebGPU is already a hard requirement for the renderer, so a browser that
 * reaches Develop at all clears the bar — but the adapter is requested again
 * rather than assumed, because a machine can expose `navigator.gpu` and still
 * fail to hand one out, and learning that when the user clicks "Subject" is
 * worse than learning it when the menu is built.
 *
 * A missing adapter is not fatal: ORT falls back to WASM, which runs the small
 * model in a few seconds rather than a few hundred milliseconds. Slow but
 * honest, so it is reported as a caveat instead of a refusal.
 */
export async function aiSupport(): Promise<AiSupport> {
  if (cached) return cached
  if (!probe) {
    probe = (async (): Promise<AiSupport> => {
      if (typeof navigator === 'undefined' || typeof indexedDB === 'undefined' ||
          typeof WebAssembly === 'undefined') {
        return {
          ok: false,
          reason: 'AI masks need WebAssembly and browser storage.',
          gpu: false,
        }
      }
      if (!navigator.gpu) {
        return { ok: false, reason: 'AI masks need WebGPU. Try Chrome or Edge.', gpu: false }
      }
      try {
        const adapter = await navigator.gpu.requestAdapter()
        if (adapter) return { ok: true, reason: null, gpu: true }
        return {
          ok: true,
          reason: 'No GPU adapter available, so detection runs on the CPU and takes a few seconds.',
          gpu: false,
        }
      } catch {
        return {
          ok: true,
          reason: 'The GPU refused a device, so detection runs on the CPU and takes a few seconds.',
          gpu: false,
        }
      }
    })()
  }
  cached = await probe
  return cached
}

/**
 * Synchronous answer, for callers that cannot await one.
 *
 * Menus are built synchronously each time they open, so they have no way to
 * wait for the probe — and a menu that has never triggered it would disable the
 * detected kinds forever, with a browser that supports them perfectly well.
 * Asking here starts the probe so the next open is right, which for a
 * `requestAdapter` call is a few milliseconds away.
 */
export function aiSupportNow(): AiSupport | null {
  if (!cached) void aiSupport()
  return cached
}
