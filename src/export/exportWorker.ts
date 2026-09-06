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
import { clearAlphas } from '../ai/alpha'

let previousRender: Promise<void> = Promise.resolve()

function enqueueRender<T>(work: () => Promise<T>): Promise<T> {
  const result = previousRender.then(async () => {
    try {
      return await work()
    } finally {
      clearAlphas()
    }
  })
  // A failed job rejects its own caller without poisoning the next job.
  previousRender = result.then(() => undefined, () => undefined)
  return result
}

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
    return enqueueRender(() => renderExport(input, onProgress))
  },

  async renderThumb(input: ThumbPixelInput): Promise<Blob | null> {
    return enqueueRender(() => renderThumb(input))
  },
}

export type ExportWorkerApi = typeof api

Comlink.expose(api)
