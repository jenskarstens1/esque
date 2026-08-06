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
 * Two tiers, because "subject mask" means different things at different points
 * in an edit. `u2netp` is 4.4 MB and lands in well under a second — the right
 * default for dialling in a look. `birefnet-lite` is 114 MB and resolves hair
 * and foliage properly, which matters when the mask is the point. The user
 * picks; neither is downloaded until they do.
 *
 * Licensing is a hard constraint rather than a footnote. esque is AGPL, so a
 * model whose weights forbid commercial use cannot ship as a default however
 * good it looks — which is why RMBG-1.4, the obvious quality pick, is absent.
 */

export type SegmentModelId = 'u2netp' | 'u2net-human' | 'birefnet-lite'

/** The mask kinds that are answered by a segmentation model. */
export type AiMaskKind = 'aiSubject' | 'aiBackground' | 'aiPerson'

export interface SegmentModel {
  id: SegmentModelId
  label: string
  /** One line for the picker, describing the trade rather than the network. */
  note: string
  /** Square edge the network was trained at. Input is stretched to it. */
  size: number
  /** Download weight, for the confirmation the user sees. */
  bytes: number
  license: string
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
    label: 'Fast',
    note: 'Quick and small. Good on clear subjects.',
    size: 320,
    bytes: 4_574_861,
    license: 'Apache-2.0',
    local: '/models/u2netp.onnx',
    remote: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
    divideByMax: true,
  },
  'u2net-human': {
    id: 'u2net-human',
    label: 'People',
    note: 'Trained on people specifically.',
    size: 320,
    bytes: 175_997_641,
    license: 'Apache-2.0',
    local: '/models/u2net_human_seg.onnx',
    remote: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx',
    divideByMax: true,
  },
  'birefnet-lite': {
    id: 'birefnet-lite',
    label: 'Thorough',
    note: 'Resolves hair and foliage. Large download, slower.',
    size: 1024,
    bytes: 114_538_221,
    license: 'MIT',
    local: '/models/birefnet-lite.onnx',
    remote: 'https://huggingface.co/onnx-community/BiRefNet_lite/resolve/main/onnx/model_fp16.onnx',
    divideByMax: false,
  },
}

/** The tiers offered for a given mask kind, best default first. */
export const SEGMENT_MODEL_LIST: SegmentModel[] = Object.values(SEGMENT_MODELS)

export function modelsFor(kind: AiMaskKind): SegmentModel[] {
  if (kind === 'aiPerson') {
    return [SEGMENT_MODELS['u2net-human'], SEGMENT_MODELS['birefnet-lite']]
  }
  return [SEGMENT_MODELS.u2netp, SEGMENT_MODELS['birefnet-lite']]
}

export function defaultModelFor(kind: AiMaskKind): SegmentModelId {
  return modelsFor(kind)[0].id
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
      if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
        return {
          ok: false,
          reason: 'This browser has no origin private file system to cache the model in.',
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
