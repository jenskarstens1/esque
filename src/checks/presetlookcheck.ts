import { apply3, decodedAsShotTempTint, SRGB_D65_TO_PROPHOTO_D50 } from '../core/color'
import { defaultEdits } from '../core/defaults'
import { floatToHalf, HALF_ONE } from '../core/half'
import { RENDERED_WHITE_POINT, type SourceImage } from '../core/workingImage'
import { applyPreset, BUILTIN_PRESETS } from '../develop/presets'
import { Renderer } from '../gpu/renderer'
import { rawPool } from '../raw/pool'
import { runCheck } from './checkreport'
import type { Edits } from '../core/types'

const looks = BUILTIN_PRESETS.filter((p) => p.group !== 'Tools')
const failures: string[] = []
const ok = (condition: boolean, message: string) => {
  if (!condition) failures.push(message)
}

function chart(isRaw: boolean): SourceImage {
  const width = 256
  const height = 32
  const data = new Uint16Array(width * height * 4)
  const colors: Array<[number, number, number]> = [
    [0.32, 0.19, 0.12], [0.55, 0.36, 0.25], [0.79, 0.58, 0.44], [0.93, 0.75, 0.61],
    [0.16, 0.45, 0.22], [0.18, 0.36, 0.66], [0.7, 0.18, 0.16], [0.7, 0.6, 0.2],
  ]
  const linear = (v: number) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgb: [number, number, number] = y < 16 ? [x / 255, x / 255, x / 255] : colors[Math.floor(x / 32)]
      const working = apply3(SRGB_D65_TO_PROPHOTO_D50, [linear(rgb[0]), linear(rgb[1]), linear(rgb[2])])
      const offset = (y * width + x) * 4
      for (let c = 0; c < 3; c++) data[offset + c] = floatToHalf(working[c])
      data[offset + 3] = HALF_ONE
    }
  }
  return { width, height, data, isRaw, asShot: RENDERED_WHITE_POINT, whiteLevel: 1 }
}

async function pixels(renderer: Renderer, edits: Edits) {
  renderer.renderOffscreen(edits)
  const image = await renderer.readOutput('srgb')
  if (!image) throw new Error('Preset render returned no pixels')
  return image
}

const luma = (image: ImageData, x: number, y: number) => {
  const offset = (y * image.width + x) * 4
  return image.data[offset] * 0.2126 + image.data[offset + 1] * 0.7152 + image.data[offset + 2] * 0.0722
}

async function checkCharts(renderer: Renderer) {
  for (const kind of ['raw', 'rendered'] as const) {
    const source = chart(kind === 'raw')
    renderer.setImage(source)
    const base = defaultEdits(kind, source.asShot)
    // Isolate the look from capture sharpening/NR on this synthetic chart.
    base.detail = defaultEdits('rendered').detail
    const reference = await pixels(renderer, base)
    const signatures: number[][] = []
    for (const preset of looks) {
      const edits = applyPreset(base, preset)
      edits.effects.grainAmount = 0
      const output = await pixels(renderer, edits)
      const ramp = Array.from({ length: 256 }, (_, x) => luma(output, x, 8))
      ok(Math.abs(ramp[128] - luma(reference, 128, 8)) < 32,
        `${kind}/${preset.id}: middle grey moved more than 32/255`)
      ok(ramp[240] > 205, `${kind}/${preset.id}: highlights turned grey (${ramp[240].toFixed(1)})`)
      ok(ramp[16] < 45, `${kind}/${preset.id}: shadows washed out (${ramp[16].toFixed(1)})`)
      for (let x = 2; x < 254; x++) {
        ok(ramp[x] >= ramp[x - 1] - 1.5, `${kind}/${preset.id}: tonal reversal at ${x}`)
      }
      if (edits.basic.treatment === 'bw') {
        const neutral = structuredClone(edits)
        neutral.colorMixer.bw = defaultEdits().colorMixer.bw
        const unmixed = await pixels(renderer, neutral)
        ok(Math.abs(luma(output, 176, 24) - luma(unmixed, 176, 24)) > 2,
          `${kind}/${preset.id}: the B&W mixer does not separate blue`)
      }
      const signature = [32, 64, 128, 192, 224].map((x) => luma(output, x, 8))
      for (let x = 16; x < 256; x += 32) {
        const offset = (24 * output.width + x) * 4
        signature.push(...output.data.slice(offset, offset + 3))
      }
      for (let i = 0; i < signatures.length; i++) {
        const distance = Math.max(...signature.map((v, c) => Math.abs(v - signatures[i][c])))
        ok(distance > 3, `${kind}/${preset.id}: indistinguishable from ${looks[i].id}`)
      }
      signatures.push(signature)
    }
  }
}

function show(image: ImageData, label: string) {
  const figure = document.createElement('figure')
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('No 2D context for preset contact sheet')
  context.putImageData(image, 0, 0)
  const caption = document.createElement('figcaption')
  caption.textContent = label
  figure.append(canvas, caption)
  document.querySelector('main')!.append(figure)
}

function clippedFraction(image: ImageData) {
  let count = 0
  for (let i = 0; i < image.data.length; i += 4) {
    const low = Math.min(image.data[i], image.data[i + 1], image.data[i + 2])
    const high = Math.max(image.data[i], image.data[i + 1], image.data[i + 2])
    if (low >= 254 || high <= 1) count++
  }
  return count / (image.width * image.height)
}

runCheck(async () => {
  const renderer = await Renderer.create(new OffscreenCanvas(1, 1))
  try {
    await checkCharts(renderer)
    const fixture = new URLSearchParams(location.search).get('fixture') ?? '/raw-fixtures/ai-astronaut.png'
    const isRaw = !/\.(png|jpe?g|webp)$/i.test(fixture)
    const response = await fetch(fixture)
    if (!response.ok) throw new Error(`Fixture fetch failed: ${response.status}`)
    const decoded = await rawPool.decodeLinear(await response.arrayBuffer(), isRaw, 512)
    if (!decoded) throw new Error(`Fixture decode failed: ${fixture}`)
    const m = decoded.meta
    const source: SourceImage = {
      ...decoded,
      isRaw: decoded.fromRaw,
      asShot: decoded.fromRaw
        ? decodedAsShotTempTint(m?.camMul ?? null, m?.preMul ?? null, m?.camXyz ?? null)
        : RENDERED_WHITE_POINT,
    }
    renderer.setImage(source)
    const base = defaultEdits(source.isRaw ? 'raw' : 'rendered', source.asShot, m?.iso)
    const reference = await pixels(renderer, base)
    show(reference, 'Unedited reference')
    const baselineClipping = clippedFraction(reference)
    const clipping: Record<string, number> = {}
    for (const preset of looks) {
      const output = await pixels(renderer, applyPreset(base, preset))
      show(output, preset.name)
      clipping[preset.id] = clippedFraction(output)
      ok(clipping[preset.id] < baselineClipping + 0.03,
        `${preset.id}: introduces more than 3% clipped pixels`)
    }
    return { ok: failures.length === 0, failures, fixture, looks: looks.length, baselineClipping, clipping }
  } finally {
    renderer.dispose()
  }
})
