/**
 * Pan/zoom cost check.
 *
 * A pan moves the destination rect and nothing else, so the only work it should
 * cost is one output pass. This drives the renderer directly at a realistic
 * proxy size and separates the three costs the viewport used to pay every
 * frame: the edit graph, the histogram readback, and the present.
 *
 * Run through `tools/headless.mjs /checks/perfcheck.html`.
 */
import { Renderer } from '../gpu/renderer'
import { defaultEdits } from '../core/defaults'
import type { SourceImage } from '../gpu/renderer'
import { RENDERED_WHITE_POINT } from '../core/workingImage'
import { runCheck } from './checkreport'

const RENDERED_SOURCE = {
  isRaw: false,
  asShot: RENDERED_WHITE_POINT,
  whiteLevel: 1,
} as const

declare global {
  interface Window {
    __done?: boolean
    __result?: unknown
  }
}

function toHalf(value: number): number {
  const f = new Float32Array(1)
  const i = new Uint32Array(f.buffer)
  f[0] = value
  const x = i[0]
  const sign = (x >>> 16) & 0x8000
  const exp = ((x >>> 23) & 0xff) - 127 + 15
  const mant = x & 0x7fffff
  if (exp <= 0) return sign
  if (exp >= 31) return sign | 0x7c00
  return sign | (exp << 10) | (mant >> 13)
}

function noise(width: number, height: number): SourceImage {
  const data = new Uint16Array(width * height * 4)
  const one = toHalf(1)
  for (let i = 0; i < width * height; i++) {
    const v = toHalf(0.05 + 0.6 * (((i * 2654435761) >>> 8) / 0xffffff))
    data[i * 4] = v
    data[i * 4 + 1] = v
    data[i * 4 + 2] = v
    data[i * 4 + 3] = one
  }
  return { width, height, data, ...RENDERED_SOURCE }
}

/**
 * Median of N timed runs.
 *
 * WebGPU exposes completion of submitted work directly through
 * `queue.onSubmittedWorkDone()`, so the readback hack that the WebGL2
 * version needed to force a real sync point is no longer required.
 */
async function timed(n: number, device: GPUDevice, fn: (i: number) => void | Promise<void>): Promise<number> {
  const samples: number[] = []
  for (let i = 0; i < n; i++) {
    await device.queue.onSubmittedWorkDone()
    const t0 = performance.now()
    await fn(i)
    await device.queue.onSubmittedWorkDone()
    samples.push(performance.now() - t0)
  }
  samples.sort((a, b) => a - b)
  return Math.round(samples[samples.length >> 1] * 100) / 100
}

async function run() {
  const canvas = document.createElement('canvas')
  canvas.width = 1600
  canvas.height = 1000
  document.body.append(canvas)

  const renderer = await Renderer.create(canvas)

  const PROXY = 2560
  renderer.setImage(noise(PROXY, Math.round(PROXY / 1.5)))

  const edits = defaultEdits()
  // A working edit, not the identity: the identity stack short-circuits passes
  // a real photo would be running.
  edits.basic.exposure = 0.4
  edits.basic.contrast = 15
  edits.basic.vibrance = 20
  edits.tone.shShadows = 25
  edits.tone.shHighlights = -30
  edits.detail.sharpenAmount = 40
  edits.detail.luminanceNR = 20
  edits.effects.vignetteAmount = -20

  const rect = { x: -200, y: -120, width: 2400, height: 1600 }
  const opts = { outputSpace: 'srgb' as const }

  // Warm the shader cache and the first mip build.
  renderer.render(edits, { ...opts, rect })
  await renderer.readHistogram('srgb')
  await renderer.ctx.device.queue.onSubmittedWorkDone()

  const N = 12
  const graph = await timed(N, renderer.ctx.device, (i) => {
    renderer.render(edits, { ...opts, rect: { ...rect, x: rect.x + (i % 4) } })
  })
  const graphPlusHist = await timed(N, renderer.ctx.device, async (i) => {
    renderer.render(edits, { ...opts, rect: { ...rect, x: rect.x + (i % 4) } })
    await renderer.readHistogram('srgb')
  })
  const present = await timed(N, renderer.ctx.device, (i) => {
    renderer.render(edits, {
      ...opts,
      rect: { ...rect, x: rect.x + (i % 4) },
      graphKey: 'steady',
    })
  })

  return {
    proxy: `${PROXY}x${Math.round(PROXY / 1.5)}`,
    canvas: `${canvas.width}x${canvas.height}`,
    graphMs: graph,
    graphPlusHistogramMs: graphPlusHist,
    histogramMs: Math.round((graphPlusHist - graph) * 100) / 100,
    presentOnlyMs: present,
    note: 'presentOnlyMs is what a pan frame should cost',
  }
}

runCheck(run)
