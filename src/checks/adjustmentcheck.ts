import { defaultEdits } from '../core/defaults'
import { floatToHalf } from '../core/half'
import type { Edits } from '../core/types'
import { newMaskLayer } from '../develop/layers'
import { Renderer, type SourceImage } from '../gpu/renderer'
import { runCheck } from './checkreport'

function image(width: number, height: number, isRaw = true): SourceImage {
  const data = new Uint16Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const noise = ((i * 2654435761) >>> 8) / 0xffffff
    data[i * 4] = floatToHalf(0.02 + noise * 0.8)
    data[i * 4 + 1] = floatToHalf(0.05 + (i % width) / width)
    data[i * 4 + 2] = floatToHalf(0.1 + noise * 0.3)
    data[i * 4 + 3] = floatToHalf(1 + noise)
  }
  return { width, height, data, isRaw, asShot: { temp: 5500, tint: 0 }, whiteLevel: 1 }
}

async function run() {
  const failures: string[] = []
  let assertions = 0
  const check = (condition: boolean, name: string) => {
    assertions++
    if (!condition) failures.push(name)
  }
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 200
  document.body.append(canvas)
  const renderer = await Renderer.create(canvas)
  const device = renderer.ctx.device
  const gpuErrors: string[] = []
  device.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message))

  // Count real encoded passes, not just elapsed time on a particular GPU.
  let denoisePasses = 0
  const beginPass = GPUCommandEncoder.prototype.beginRenderPass
  GPUCommandEncoder.prototype.beginRenderPass = function (descriptor) {
    const pass = beginPass.call(this, descriptor)
    const setPipeline = pass.setPipeline.bind(pass)
    pass.setPipeline = (pipeline) => {
      if (pipeline.label === 'denoise') denoisePasses++
      setPipeline(pipeline)
    }
    return pass
  }

  let seq = 0
  const render = (edits: Edits) => renderer.render(edits, { graphKey: `edit-${++seq}` })
  const pixels = () => renderer.readPixels('prophoto', 16)
  const exact = async (name: string, edits: Edits) => {
    const cached = await pixels()
    renderer.renderOffscreen(edits)
    const reference = await pixels()
    check(!!cached && !!reference && cached.width === reference.width &&
      cached.height === reference.height &&
      cached.data.every((value, i) => value === reference.data[i]),
    `${name}: cached output must match uncached 16-bit output exactly`)
  }
  try {
    const source = image(192, 128)
    renderer.setImage(source)
    const edits = defaultEdits('raw')
    edits.detail.luminanceNR = 25
    edits.tone.recovery = 'propagate'
    edits.detail.impulseNR = 10
    edits.lens.defringePurpleAmount = 3
    edits.lens.defringeGreenAmount = 2
    render(edits)
    check(denoisePasses === 1, 'The first edit runs capture cleanup')
    await exact('first edit', edits)

    const downstream: [string, (e: Edits) => void][] = [
      ['exposure', (e) => { e.basic.exposure = 0.6 }],
      ['contrast', (e) => { e.basic.contrast = 15 }],
      ['profile', (e) => { e.profile.rolloff = 40 }],
      ['tone', (e) => { e.tone.shShadows = 20 }],
      ['texture', (e) => { e.basic.texture = 12 }],
      ['curve', (e) => { e.curve.rgb = [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }] }],
      ['mixer', (e) => { e.colorMixer.hue.red = 10 }],
      ['grading', (e) => { e.colorGrading.global.saturation = 8 }],
      ['geometry', (e) => { e.crop.right = 0.8; e.crop.angle = 4 }],
      ['lens geometry', (e) => { e.lens.distortion = 10 }],
      ['effects', (e) => { e.effects.grainAmount = 10 }],
      ['mask', (e) => {
        const layer = newMaskLayer([], 'linear')
        layer.adjustments.exposure = 0.5
        e.layers = [layer]
      }],
      ['mask adjustment', (e) => { e.layers[0].adjustments.exposure = 0.8 }],
    ]
    for (const [name, mutate] of downstream) {
      mutate(edits)
      denoisePasses = 0
      render(edits)
      check(denoisePasses === 0, `${name}: unchanged capture stages are skipped`)
      await exact(name, edits)
    }

    // Each consumed upstream field invalidates independently, even when the
    // caller changes the same object in place instead of replacing a section.
    const upstream: [string, (e: Edits) => void][] = [
      ['WB mode', (e) => { e.basic.wbMode = 'custom' }],
      ['temperature', (e) => { e.basic.temp = 6200 }],
      ['tint', (e) => { e.basic.tint = 12 }],
      ['recovery mode', (e) => { e.tone.recovery = 'blend' }],
      ['recovery threshold', (e) => { e.tone.recoveryThreshold = 70 }],
      ...Object.keys(edits.calibration).map((key): [string, (e: Edits) => void] => {
        const field = key as keyof Edits['calibration']
        return [field, (e) => { e.calibration[field] += 1 }]
      }),
      ...Object.keys(edits.detail).map((key): [string, (e: Edits) => void] => {
        const field = key as keyof Edits['detail']
        return [field, (e) => { e.detail[field] += 0.1 }]
      }),
      ...([
        'defringePurpleAmount', 'defringePurpleHueLo', 'defringePurpleHueHi',
        'defringeGreenAmount', 'defringeGreenHueLo', 'defringeGreenHueHi',
      ] as const).map((field): [string, (e: Edits) => void] =>
        [field, (e) => { e.lens[field] += 1 }]),
    ]
    for (const [name, mutate] of upstream) {
      mutate(edits)
      denoisePasses = 0
      render(edits)
      check(denoisePasses === 1, `${name}: capture cache is invalidated`)
      await exact(name, edits)
    }

    const before = defaultEdits('raw')
    before.basic.temp = 4200
    before.basic.wbMode = 'custom'
    const rect = { x: 0, y: 0, width: 160, height: 200 }
    const panes = () => [
      { edits: before, rect, cacheKey: 'before' },
      { edits, rect: { ...rect, x: 160 } },
    ]
    renderer.renderPanes(panes(), { graphKey: `edit-${++seq}` })
    await exact('compare warmup', edits)
    edits.basic.exposure += 0.1
    denoisePasses = 0
    renderer.renderPanes(panes(), { graphKey: `edit-${++seq}` })
    check(denoisePasses === 0, 'The cached before pane does not evict the live capture cache')
    await exact('compare drag', edits)
    renderer.render(edits, { bypass: true })
    render(edits)
    await exact('after bypass', edits)

    for (const next of [image(192, 128, false), image(128, 96)]) {
      renderer.setImage(next)
      denoisePasses = 0
      render(edits)
      check(denoisePasses === 1, 'A new source invalidates capture, including same-size images')
      await exact('source replacement', edits)
    }

    const edge = Number(new URLSearchParams(location.search).get('edge') ?? 2560)
    if (!Number.isInteger(edge) || edge < 256 || edge > 6000) throw new Error('edge must be 256..6000')
    renderer.setImage(image(edge, Math.round(edge * 2 / 3)))
    const benchmarkEdits = defaultEdits('raw')
    const measure = async (cached: boolean) => {
      const samples: number[] = []
      for (let i = 0; i < 18; i++) {
        benchmarkEdits.basic.exposure = i / 30
        const t0 = performance.now()
        if (cached) render(benchmarkEdits)
        else renderer.render(benchmarkEdits)
        await device.queue.onSubmittedWorkDone()
        if (i >= 4) samples.push(performance.now() - t0)
      }
      samples.sort((a, b) => a - b)
      return Number(samples[samples.length >> 1].toFixed(3))
    }
    const uncachedMs = await measure(false)
    const cachedMs = await measure(true)
    check(gpuErrors.length === 0, `GPU validation: ${gpuErrors.join('; ')}`)
    return { ok: !failures.length, assertions, failures, benchmark: {
      width: edge, height: Math.round(edge * 2 / 3), uncachedMs, cachedMs,
      speedup: Number((uncachedMs / cachedMs).toFixed(2)),
    } }
  } finally {
    GPUCommandEncoder.prototype.beginRenderPass = beginPass
    renderer.dispose()
  }
}

runCheck(run, { print: true })
