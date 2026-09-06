/**
 * Main-thread handle for the export/render worker.
 *
 * One worker serves both exports and grid thumbnails. Keeping a single instance
 * means one GPU device rather than two, and it naturally serialises the two
 * workloads — which is what we want, since both want the GPU and a lot of
 * memory. The worker queues render calls, so an export in flight simply delays
 * a thumbnail refresh instead of fighting it for VRAM.
 */
import * as Comlink from 'comlink'
import type { ExportWorkerApi } from './exportWorker'
import type {
  ExportPixelInput,
  ExportPixelResult,
  PipelineStage,
  ThumbPixelInput,
} from './pipeline'

let worker: Worker | null = null
let api: Comlink.Remote<ExportWorkerApi> | null = null

function remote(): Comlink.Remote<ExportWorkerApi> {
  if (!api) {
    worker = new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' })
    api = Comlink.wrap<ExportWorkerApi>(worker)
  }
  return api
}

/**
 * Hands the pixels over without copying them. The caller's `data` is detached
 * afterwards, which is exactly right for export (the buffer came straight from
 * the decoder and has no other owner) but means thumbnail callers must pass a
 * copy of anything still living in the proxy cache.
 */
export async function renderExportInWorker(
  input: ExportPixelInput,
  onProgress?: (stage: PipelineStage, fraction: number) => void,
): Promise<ExportPixelResult> {
  const buffer = input.linear.data.buffer as ArrayBuffer
  return remote().renderExport(
    Comlink.transfer(input, [buffer]),
    onProgress ? Comlink.proxy(onProgress) : undefined,
  )
}

export async function renderThumbInWorker(input: ThumbPixelInput): Promise<Blob | null> {
  const buffer = input.data.buffer as ArrayBuffer
  return remote().renderThumb(Comlink.transfer(input, [buffer]))
}

export const beginExportJob = () => remote().beginJob()
export const cancelExportJob = () => remote().cancelJob()

/** Format probing lives here too so the dialog never spins up the encoders. */
export async function detectFormatsInWorker(): Promise<Set<string>> {
  return new Set(await remote().detectFormats())
}

export function disposeExportWorker() {
  worker?.terminate()
  worker = null
  api = null
}
