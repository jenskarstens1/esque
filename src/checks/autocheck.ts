/**
 * Headless check for Auto.
 *
 * Two things are being guarded.
 *
 * **The model is the shader.** `toneModel` reproduces scene preparation and
 * display rendering on the CPU so auto can solve instead of guessing; the moment the two disagree
 * every number auto produces is quietly wrong. So the same pixels go through
 * the real GPU graph and through the model, and the two are compared code value
 * by code value.
 *
 * **Auto has to improve the photograph.** Synthetic scenes with known problems
 * — three stops under, a blown sky, haze, a night frame, a tungsten cast, a red
 * wall — are auto-developed, rendered for real, and measured. The assertions are
 * comparative rather than absolute: auto is not allowed to move the mid-tone
 * further from where it belongs, blow highlights that were not blown, or crush
 * blacks that were not crushed. RAW is checked alongside rendered throughout,
 * because it is the case with a base curve, a shoulder and a camera white
 * balance in play.
 *
 * Run through `tools/headless.mjs /checks/autocheck.html`.
 */
import { Renderer, type SourceImage } from '../gpu/renderer'
import { defaultEdits } from '../core/defaults'
import { autoDevelop, autoTone, autoWhiteBalance, applyAuto } from '../develop/auto'
import { basicParams, basicPixel, encode1, luma, type Vec3 } from '../develop/toneModel'
import { asShotTempTint, whiteBalanceGain } from '../gpu/colorspace'
import type { Edits } from '../core/types'
import { RENDERED_WHITE_POINT } from '../core/workingImage'
import { runCheck } from './checkreport'
import { profileEdits } from '../core/profiles'

declare global {
  interface Window {
    __result?: unknown
    __done?: boolean
  }
}

const failures: string[] = []
const out: Record<string, unknown> = {}
const ok = (cond: boolean, message: string) => {
  if (!cond) failures.push(message)
}

// ---------------------------------------------------------------------------
// Synthetic scenes
// ---------------------------------------------------------------------------

const W = 128
const H = 96
const N = W * H

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

/** A real camera's ColorMatrix (XYZ → camera), so the as-shot fit has something honest to invert. */
const CAM_XYZ = [
  [0.6722, -0.0635, -0.0963],
  [-0.4287, 1.246, 0.2028],
  [-0.0908, 0.2162, 0.5668],
]
/** Multipliers of a daylight frame — the as-shot white the proxy is already balanced to. */
const CAM_MUL = [2.05, 1.0, 1.55]
const CAM_AS_SHOT = asShotTempTint(CAM_MUL, CAM_XYZ)

interface SceneSpec {
  /** Median luminance of the scene, in linear light. Middle grey is 0.18. */
  median: number
  /** Spread of the log-normal luminance distribution, in stops (one sigma). */
  stops: number
  /** Fraction of the frame pushed past the sensor's white level. */
  blown?: number
  /** Fraction of the frame sitting at true black. */
  crushed?: number
  /** How colourful the frame is, 0..1. */
  sat?: number
  /** A cast baked into every pixel, as a linear RGB multiplier. */
  cast?: Vec3
  /** Fraction of the frame that is a known neutral surface. */
  neutralPatch?: number
  isRaw?: boolean
  /** Linear ceiling reported by the decoder; RAW can preserve values above 1. */
  whiteLevel?: number
}

/** Which pixels are the known neutral surface, shared by the scene and the measurement. */
function isNeutral(i: number, fraction: number): boolean {
  if (fraction <= 0) return false
  return i % Math.max(2, Math.round(1 / fraction)) === 0
}

/** Winitzki's approximation — good to ~2e-3, which is far finer than a histogram bucket. */
function erfinv(x: number): number {
  const a = 0.147
  const ln = Math.log(1 - x * x)
  const t = 2 / (Math.PI * a) + ln / 2
  return Math.sign(x) * Math.sqrt(Math.sqrt(t * t - ln / a) - t)
}

/**
 * Builds a frame with a known luminance distribution.
 *
 * Luminance is log-normal: a real photograph's histogram is roughly Gaussian in
 * stops around its mid-tone, and a log-*uniform* ramp is not — it has as much
 * area in the deepest shadow as in the mid-tone, which makes every percentile
 * auto looks at unrepresentative and quietly mistunes every target.
 *
 * The values are scattered over the frame by a coprime stride so luminance does
 * not correlate with position: auto weights the middle of the frame more
 * heavily, and a spatial ramp would turn that into a systematic offset that has
 * nothing to do with the algorithm.
 */
function scene(spec: SceneSpec): SourceImage {
  const { median, stops, blown = 0, crushed = 0, sat = 0.35, cast, neutralPatch = 0 } = spec
  const whiteLevel = spec.whiteLevel ?? 1
  const data = new Uint16Array(N * 4)

  for (let i = 0; i < N; i++) {
    const rank = (i * 7919) % N
    const t = (rank + 0.5) / N
    const z = Math.SQRT2 * erfinv(2 * Math.min(0.9995, Math.max(0.0005, t)) - 1)
    let l = median * Math.pow(2, stops * z)
    if (t > 1 - blown) l = whiteLevel * 1.4
    if (t < crushed) l = 0

    let c: Vec3
    if (isNeutral(i, neutralPatch)) {
      // Neutral surfaces spread over the mid-tones and over the frame: the
      // evidence auto WB is supposed to find. Scattered rather than banded,
      // because auto weights the centre of the frame and a band at the top edge
      // would be measuring the centre bias instead of the estimator.
      const nl = 0.05 + 0.3 * (((i * 2237) % 97) / 97)
      c = [nl, nl, nl]
    } else {
      const hue = ((i * 4409) % N) / N
      const wheel: Vec3 = [
        0.5 + 0.5 * Math.cos(2 * Math.PI * hue),
        0.5 + 0.5 * Math.cos(2 * Math.PI * (hue - 1 / 3)),
        0.5 + 0.5 * Math.cos(2 * Math.PI * (hue - 2 / 3)),
      ]
      const mixed: Vec3 = [
        1 - sat + sat * wheel[0],
        1 - sat + sat * wheel[1],
        1 - sat + sat * wheel[2],
      ]
      const k = l / Math.max(1e-6, luma(mixed[0], mixed[1], mixed[2]))
      c = [mixed[0] * k, mixed[1] * k, mixed[2] * k]
    }

    if (cast) {
      c = [c[0] * cast[0], c[1] * cast[1], c[2] * cast[2]]
    }

    const o = i * 4
    // The sensor's white level is the ceiling; nothing survives above it.
    data[o] = toHalf(Math.min(c[0], whiteLevel))
    data[o + 1] = toHalf(Math.min(c[1], whiteLevel))
    data[o + 2] = toHalf(Math.min(c[2], whiteLevel))
    data[o + 3] = toHalf(1)
  }

  return {
    width: W,
    height: H,
    data,
    isRaw: spec.isRaw ?? false,
    asShot: spec.isRaw ? CAM_AS_SHOT : RENDERED_WHITE_POINT,
    whiteLevel,
  }
}

// ---------------------------------------------------------------------------
// Measuring a real render
// ---------------------------------------------------------------------------

// Sharing one device across all checks avoids races from concurrent creation;
// caching the promise (not the resolved value) means concurrent callers wait
// on the same resolution rather than each starting their own device request.
let rendererPromise: Promise<Renderer> | null = null
const getRenderer = () => (rendererPromise ??= Renderer.create(new OffscreenCanvas(1, 1)))

/** Renders through the whole graph and returns tone-space luminance and saturation. */
async function renderTone(image: SourceImage, edits: Edits): Promise<{ lum: Float64Array; sat: Float64Array }> {
  const renderer = await getRenderer()
  renderer.setImage(image)
  renderer.setFrame(null)
  renderer.renderOffscreen(edits)
  const px = (await renderer.readPixels('prophoto', 16, null))!
  const lum = new Float64Array(px.width * px.height)
  const sat = new Float64Array(px.width * px.height)
  for (let i = 0; i < lum.length; i++) {
    const o = i * 4
    // ProPhoto output is gamma 1.8; tone space is the sRGB transfer.
    const r = encode1(Math.pow(px.data[o] / 65535, 1.8))
    const g = encode1(Math.pow(px.data[o + 1] / 65535, 1.8))
    const b = encode1(Math.pow(px.data[o + 2] / 65535, 1.8))
    lum[i] = luma(r, g, b)
    const max = Math.max(r, g, b)
    sat[i] = max > 1e-4 ? (max - Math.min(r, g, b)) / max : 0
  }
  return { lum, sat }
}

function percentile(sorted: Float64Array, p: number): number {
  const i = Math.max(0, Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1))))
  return sorted[i]
}

interface Stats {
  p001: number
  p10: number
  p25: number
  p50: number
  p75: number
  p90: number
  p999: number
  blown: number
  crushed: number
  /** Mean saturation over the mid-tones — what auto's vibrance is judged on. */
  sat: number
}

function statsOf(frame: { lum: Float64Array; sat: Float64Array }): Stats {
  const { lum, sat } = frame
  const sorted = Float64Array.from(lum).sort()
  let blown = 0
  let crushed = 0
  let satSum = 0
  let satN = 0
  for (let i = 0; i < lum.length; i++) {
    const v = lum[i]
    if (v >= 0.995) blown++
    if (v <= 0.004) crushed++
    if (v > 0.12 && v < 0.88) {
      satSum += sat[i]
      satN++
    }
  }
  return {
    p001: round(percentile(sorted, 0.001)),
    p10: round(percentile(sorted, 0.1)),
    p25: round(percentile(sorted, 0.25)),
    p50: round(percentile(sorted, 0.5)),
    p75: round(percentile(sorted, 0.75)),
    p90: round(percentile(sorted, 0.9)),
    p999: round(percentile(sorted, 0.999)),
    blown: round(blown / lum.length),
    crushed: round(crushed / lum.length),
    sat: round(satN > 0 ? satSum / satN : 0),
  }
}

const round = (v: number) => Math.round(v * 1000) / 1000

// ---------------------------------------------------------------------------
// 1. The model has to be the shader
// ---------------------------------------------------------------------------

async function checkModel() {
  const cases: Array<{ name: string; isRaw: boolean; edits: () => Edits }> = [
    {
      name: 'rendered/neutral',
      isRaw: false,
      edits: () => defaultEdits('rendered'),
    },
    {
      name: 'raw/standard',
      isRaw: true,
      edits: () => {
        const e = defaultEdits('rendered')
        e.profile = profileEdits('standard')
        return e
      },
    },
    {
      name: 'raw/vivid+tone',
      isRaw: true,
      edits: () => {
        const e = defaultEdits('rendered')
        e.profile = profileEdits('vivid')
        e.basic.exposure = 0.8
        e.basic.contrast = 25
        e.basic.highlights = -60
        e.basic.shadows = 45
        e.basic.whites = 30
        e.basic.blacks = -25
        e.basic.vibrance = 30
        e.basic.saturation = -10
        return e
      },
    },
    {
      name: 'raw/wb+calibration',
      isRaw: true,
      edits: () => {
        const e = defaultEdits('rendered')
        e.profile = profileEdits('portrait')
        e.basic.wbMode = 'custom'
        e.basic.temp = 3200
        e.basic.tint = -18
        e.basic.exposure = -0.6
        e.calibration.shadowTint = 20
        e.calibration.redHue = 15
        e.calibration.blueSaturation = -20
        e.basic.avoidColorShift = true
        e.basic.protectSkin = true
        return e
      },
    },
  ]

  const image = scene({ median: 0.12, stops: 2.6, sat: 0.5 })
  const rawImage = { ...image, isRaw: true, asShot: CAM_AS_SHOT }
  const renderer = await getRenderer()

  for (const c of cases) {
    const src = c.isRaw ? rawImage : image
    const edits = c.edits()
    renderer.setImage(src)
    renderer.setFrame(null)
    renderer.renderOffscreen(edits)
    const px = (await renderer.readPixels('prophoto', 16, null))!

    const p = basicParams(edits, src)
    const model: Vec3 = [0, 0, 0]
    const source: Vec3 = [0, 0, 0]
    let worst = 0
    let worstAt = -1
    for (let i = 0; i < N; i++) {
      const o = i * 4
      source[0] = halfOf(src.data[o])
      source[1] = halfOf(src.data[o + 1])
      source[2] = halfOf(src.data[o + 2])
      basicPixel(source, p, model)
      for (let ch = 0; ch < 3; ch++) {
        // The model works in tone space; the readback is ProPhoto gamma 1.8.
        const want = Math.pow(decode(model[ch]), 1 / 1.8) * 65535
        const got = px.data[o + ch]
        const d = Math.abs(want - got)
        if (d > worst) {
          worst = d
          worstAt = i
        }
      }
    }
    out[`model:${c.name}`] = { worst: Math.round(worst), at: worstAt }
    // 16-bit readback plus half-float source: a couple of hundred code values
    // is quantisation. A disagreement in the maths lands in the thousands.
    ok(worst < 400, `model ${c.name}: worst ${Math.round(worst)} code values at px ${worstAt}`)
  }
}

/**
 * Recovery thresholds are fractions of the RAW decoder ceiling, not display
 * code values. Values below that ceiling must survive Clip unchanged, while
 * Blend must not neutralise a channel that is still well below saturation.
 */
async function checkRecoveryCeiling() {
  const renderer = await getRenderer()
  const patch = (rgb: Vec3): SourceImage => {
    const width = 8
    const height = 8
    const data = new Uint16Array(width * height * 4)
    for (let i = 0; i < width * height; i++) {
      const o = i * 4
      data[o] = toHalf(rgb[0])
      data[o + 1] = toHalf(rgb[1])
      data[o + 2] = toHalf(rgb[2])
      data[o + 3] = toHalf(1)
    }
    return {
      width,
      height,
      data,
      isRaw: true,
      asShot: CAM_AS_SHOT,
      whiteLevel: 2.4,
    }
  }

  const edits = defaultEdits('rendered', CAM_AS_SHOT)
  edits.profile = profileEdits('neutral')
  const render = async (
    image: SourceImage,
    recovery: Edits['tone']['recovery'],
    configure?: (value: Edits) => void,
  ) => {
    const e = structuredClone(edits)
    e.tone.recovery = recovery
    e.tone.recoveryThreshold = 90
    configure?.(e)
    renderer.setImage(image)
    renderer.setFrame(null)
    renderer.renderOffscreen(e)
    return (await renderer.readPixels('prophoto', 16, null))!.data
  }

  const below = patch([1.6, 1.6, 1.6])
  const off = await render(below, 'off')
  const clipped = await render(below, 'clip')
  let worst = 0
  for (let i = 0; i < off.length; i++) worst = Math.max(worst, Math.abs(off[i] - clipped[i]))
  out['recovery:ceiling'] = { belowCeilingDiff: worst }
  ok(worst <= 2, `recovery ceiling: Clip changed a below-ceiling value by ${worst}`)

  const captureCases: Array<[string, (value: Edits) => void]> = [
    ['impulse', (e) => { e.detail.impulseNR = 100 }],
    ['denoise', (e) => {
      e.detail.luminanceNR = 70
      e.detail.colorNR = 60
    }],
    ['sharpen', (e) => { e.detail.sharpenAmount = 100 }],
    ['defringe', (e) => { e.lens.defringePurpleAmount = 20 }],
  ]
  const captureDiffs: Record<string, number> = {}
  for (const [name, configure] of captureCases) {
    const processed = await render(below, 'off', configure)
    let diff = 0
    for (let i = 0; i < off.length; i++) diff = Math.max(diff, Math.abs(off[i] - processed[i]))
    captureDiffs[name] = diff
    // Extra RGBA16F round trips can move a 16-bit output by a few dozen codes.
    // A hidden clamp from 1.6 to 1.0 moves it by thousands.
    ok(diff <= 64, `capture ${name}: changed uniform RAW headroom by ${diff}`)
  }
  out['capture:headroom'] = captureDiffs

  const colored = await render(patch([2.4, 2.3, 1.2]), 'blend')
  const blueToRed = colored[2] / Math.max(colored[0], 1)
  ;(out['recovery:ceiling'] as Record<string, number>).blueToRed = round(blueToRed)
  ok(
    blueToRed < 0.8,
    `recovery ceiling: Blend neutralised an unclipped blue channel (${round(blueToRed)})`,
  )
}

const halfOf = (bits: number): number => {
  const s = bits & 0x8000 ? -1 : 1
  const e = (bits & 0x7c00) >> 10
  const f = bits & 0x03ff
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024)
  if (e === 0x1f) return f ? NaN : s * Infinity
  return s * Math.pow(2, e - 15) * (1 + f / 1024)
}

const decode = (x: number) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4))

// ---------------------------------------------------------------------------
// 2. Auto has to improve the photograph
// ---------------------------------------------------------------------------

const IDEAL_MID = 0.46

interface Case {
  name: string
  image: SourceImage
  /** Expected direction of travel, as a sanity check on the solve. */
  expect?: (r: ReturnType<typeof autoDevelop>, before: Stats, after: Stats) => string | null
}

function baseEdits(image: SourceImage): Edits {
  const e = defaultEdits(image.isRaw ? 'raw' : 'rendered', image.asShot)
  // Capture sharpening and NR are irrelevant here and only add noise to the
  // measurement; the tone graph is what is being checked.
  e.detail.sharpenAmount = 0
  e.detail.luminanceNR = 0
  e.detail.colorNR = 0
  e.profile = profileEdits('standard')
  return e
}

async function checkScenes() {
  const cases: Case[] = []
  for (const isRaw of [false, true]) {
    const tag = isRaw ? 'raw' : 'rendered'
    cases.push(
      {
        name: `${tag}/underexposed`,
        image: scene({ median: 0.009, stops: 1.5, sat: 0.3, isRaw }),
        expect: (r) => (r.tone.exposure > 1.5 ? null : `exposure ${r.tone.exposure} should lift`),
      },
      {
        name: `${tag}/overexposed`,
        image: scene({ median: 0.55, stops: 1.4, blown: 0.06, sat: 0.3, isRaw }),
        expect: (r) =>
          r.tone.exposure < 0.5 && r.tone.highlights < 0
            ? null
            : `exposure ${r.tone.exposure} / highlights ${r.tone.highlights} on a blown frame`,
      },
      {
        name: `${tag}/flat`,
        image: scene({ median: 0.15, stops: 0.35, sat: 0.12, isRaw }),
        expect: (r) =>
          r.tone.contrast > 10 && r.vibrance > 0
            ? null
            : `contrast ${r.tone.contrast} / vibrance ${r.vibrance} on a flat frame`,
      },
      {
        name: `${tag}/contrasty`,
        image: scene({ median: 0.18, stops: 3.2, sat: 0.3, isRaw }),
        expect: (r) =>
          r.tone.contrast <= 0
            ? null
            : `contrast +${r.tone.contrast} on a frame that already has too much`,
      },
      {
        name: `${tag}/night`,
        image: scene({ median: 0.012, stops: 1.9, crushed: 0.45, sat: 0.35, isRaw }),
        expect: (r) =>
          r.tone.blacks === 0 ? null : `blacks ${r.tone.blacks} on a frame that is already black`,
      },
      {
        name: `${tag}/wellExposed`,
        image: scene({ median: 0.16, stops: 1.7, sat: 0.35, isRaw }),
        expect: (r) =>
          Math.abs(r.tone.exposure) < 0.5 && Math.abs(r.tone.contrast) < 25
            ? null
            : `exposure ${r.tone.exposure} / contrast ${r.tone.contrast} on a good frame`,
      },
    )
    if (isRaw) {
      cases.push({
        name: 'raw/headroom',
        image: scene({
          median: 0.2,
          stops: 2.2,
          sat: 0.3,
          isRaw: true,
          whiteLevel: 2.4,
        }),
        expect: (r) =>
          Math.abs(r.tone.exposure) < 0.75 && r.tone.highlights > -40
            ? null
            : `discarded RAW headroom: exposure ${r.tone.exposure}, highlights ${r.tone.highlights}`,
      })
    }
  }

  for (const c of cases) {
    const before = baseEdits(c.image)
    const beforeStats = statsOf(await renderTone(c.image, before))

    const result = autoDevelop(c.image, before)
    const after = structuredClone(before)
    applyAuto(after, result)
    const afterStats = statsOf(await renderTone(c.image, after))

    out[`scene:${c.name}`] = {
      wb: result.wb,
      ...result.tone,
      vibrance: result.vibrance,
      before: beforeStats,
      after: afterStats,
    }

    const gotBetter =
      Math.abs(afterStats.p50 - IDEAL_MID) <= Math.abs(beforeStats.p50 - IDEAL_MID) + 0.02
    ok(gotBetter, `${c.name}: mid-tone ${beforeStats.p50} → ${afterStats.p50}, no better`)

    ok(
      afterStats.blown <= beforeStats.blown + 0.02,
      `${c.name}: blew highlights, ${beforeStats.blown} → ${afterStats.blown}`,
    )
    ok(
      afterStats.crushed <= beforeStats.crushed + 0.03,
      `${c.name}: crushed shadows, ${beforeStats.crushed} → ${afterStats.crushed}`,
    )
    ok(
      afterStats.p50 > 0.16 && afterStats.p50 < 0.72,
      `${c.name}: mid-tone landed at ${afterStats.p50}`,
    )

    const problem = c.expect?.(result, beforeStats, afterStats)
    ok(!problem, `${c.name}: ${problem}`)

    // Auto reads the file, not the panel: running it on its own output has to
    // produce the same answer, or the button would walk the photo somewhere new
    // on every press.
    const again = autoDevelop(c.image, after)
    ok(
      again.tone.exposure === result.tone.exposure &&
        again.tone.contrast === result.tone.contrast &&
        again.tone.whites === result.tone.whites &&
        again.tone.blacks === result.tone.blacks,
      `${c.name}: not idempotent, ${JSON.stringify(result.tone)} then ${JSON.stringify(again.tone)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// 3. White balance
// ---------------------------------------------------------------------------

/** How far a patch is from neutral once the estimate is applied, as a ratio. */
function neutralityError(
  image: SourceImage,
  wb: { temp: number; tint: number },
  patchFraction: number,
): number {
  const gain = whiteBalanceGain(image.asShot, wb)
  let r = 0
  let g = 0
  let b = 0
  for (let i = 0; i < N; i++) {
    if (!isNeutral(i, patchFraction)) continue
    const o = i * 4
    r += halfOf(image.data[o]) * gain[0]
    g += halfOf(image.data[o + 1]) * gain[1]
    b += halfOf(image.data[o + 2]) * gain[2]
  }
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return max > 0 ? (max - min) / max : 0
}

function checkWhiteBalance() {
  const casts: Array<{ name: string; cast: Vec3 }> = [
    { name: 'tungsten', cast: [1.45, 1, 0.55] },
    { name: 'shade', cast: [0.82, 1, 1.35] },
    { name: 'green', cast: [0.9, 1.12, 0.92] },
    { name: 'none', cast: [1, 1, 1] },
  ]

  for (const isRaw of [false, true]) {
    for (const c of casts) {
      const image = scene({
        median: 0.15,
        stops: 1.6,
        sat: 0.3,
        cast: c.cast,
        neutralPatch: 0.12,
        isRaw,
      })
      const edits = baseEdits(image)
      const before = neutralityError(image, image.asShot, 0.12)
      const wb = autoWhiteBalance(image, edits)
      ok(!!wb, `wb ${isRaw ? 'raw' : 'rendered'}/${c.name}: no estimate`)
      if (!wb) continue

      const after = neutralityError(image, wb, 0.12)
      out[`wb:${isRaw ? 'raw' : 'rendered'}/${c.name}`] = {
        ...wb,
        asShot: image.asShot,
        before: round(before),
        after: round(after),
      }
      ok(
        after < 0.02,
        `wb ${isRaw ? 'raw' : 'rendered'}/${c.name}: neutral patch still off by ${round(after)}`,
      )
      ok(
        after <= before + 1e-3,
        `wb ${isRaw ? 'raw' : 'rendered'}/${c.name}: made the cast worse`,
      )

      // Re-estimating on a corrected frame must not wander: the second answer
      // is what the user sees if they press Auto twice.
      const corrected: Edits = {
        ...edits,
        basic: { ...edits.basic, wbMode: 'auto', temp: wb.temp, tint: wb.tint },
      }
      const second = autoWhiteBalance(image, corrected)
      ok(!!second, `wb ${c.name}: second pass returned nothing`)
      if (second) {
        const drift = Math.abs(second.temp - wb.temp) / wb.temp
        ok(
          drift < 0.05,
          `wb ${isRaw ? 'raw' : 'rendered'}/${c.name}: drifted ${wb.temp}K → ${second.temp}K`,
        )
      }
    }
  }

  // A frame dominated by one saturated colour is the classic grey-world
  // failure: a red wall is not evidence of a red light.
  const wall = scene({ median: 0.12, stops: 1, sat: 0, cast: [1, 1, 1], neutralPatch: 0.08, isRaw: true })
  for (let i = 0; i < N; i++) {
    if (isNeutral(i, 0.08)) continue
    const o = i * 4
    const l = halfOf(wall.data[o + 1])
    wall.data[o] = toHalf(Math.min(1, l * 2.6))
    wall.data[o + 1] = toHalf(l * 0.75)
    wall.data[o + 2] = toHalf(l * 0.5)
  }
  const wallWb = autoWhiteBalance(wall, baseEdits(wall))
  ok(!!wallWb, 'wb redWall: no estimate')
  if (wallWb) {
    const err = neutralityError(wall, wallWb, 0.08)
    out['wb:redWall'] = { ...wallWb, patchError: round(err) }
    ok(err < 0.08, `wb redWall: the wall dragged the balance, patch off by ${round(err)}`)
  }
}

// ---------------------------------------------------------------------------
// 4. Degenerate input
// ---------------------------------------------------------------------------

function checkDegenerate() {
  const black: SourceImage = {
    width: 16,
    height: 16,
    data: new Uint16Array(16 * 16 * 4),
    isRaw: true,
    asShot: CAM_AS_SHOT,
    whiteLevel: 1,
  }
  const e = baseEdits(black)
  const tone = autoTone(black, e)
  ok(
    Object.values(tone).every((v) => Number.isFinite(v)),
    `black frame produced ${JSON.stringify(tone)}`,
  )
  ok(autoWhiteBalance(black, e) === null, 'black frame produced a white balance')

  const white = { ...black, data: new Uint16Array(16 * 16 * 4).fill(toHalf(1)) }
  const whiteTone = autoTone(white, e)
  ok(
    Object.values(whiteTone).every((v) => Number.isFinite(v)),
    `white frame produced ${JSON.stringify(whiteTone)}`,
  )
  out.degenerate = { black: tone, white: whiteTone }
}

// ---------------------------------------------------------------------------

const started = performance.now()

runCheck(async () => {
  // A throw is recorded as a failure rather than rethrown: the checks that did
  // run still carry their measurements, and those are what say where it broke.
  try {
    await checkModel()
    await checkRecoveryCeiling()
    await checkScenes()
    checkWhiteBalance()
    checkDegenerate()
  } catch (err) {
    failures.push(`threw: ${(err as Error).message}\n${(err as Error).stack}`)
  }

  return {
    pass: failures.length === 0,
    failures,
    ms: Math.round(performance.now() - started),
    ...out,
  }
})
