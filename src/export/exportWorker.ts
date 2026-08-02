/**
 * Export/render worker.
 *
 * Owns a WebGPU device on an OffscreenCanvas and runs the entire pixel
 * pipeline — full-resolution render, resample, sharpen, watermark, encode — so
 * the main thread never blocks on a 45 MP export. Grid thumbnails ride along
 * here too, because they run the same graph and would otherwise stall the UI on
 * every slider release.
 */
import * as Comlink from 'comlink'
import {
  beginJob,
  cancelJob,
  renderExport,
  renderThumb,
  type ExportPixelInput,
  type ExportPixelResult,
  type PipelineStage,
  type ThumbPixelInput,
} from './pipeline'
import { detectFormats } from './formats'

const api = {
  async detectFormats(): Promise<string[]> {
    return [...(await detectFormats())]
  },

  beginJob,
  cancelJob,

  async renderExport(
    input: ExportPixelInput,
    onProgress?: (stage: PipelineStage, fraction: number) => void,
  ): Promise<ExportPixelResult> {
    return renderExport(input, onProgress)
  },

  async renderThumb(input: ThumbPixelInput): Promise<Blob | null> {
    return renderThumb(input)
  },
}

export type ExportWorkerApi = typeof api

Comlink.expose(api)
