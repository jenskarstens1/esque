/**
 * A CPU mirror of the scene-input and scene-to-display passes.
 *
 * Auto tone can only be as good as its model of what the sliders actually do.
 * The old one worked in linear stops with constants fitted by eye, which meant
 * it was blind to the profile's base curve, the highlight shoulder, white
 * balance and the shape of the region masks — the same numbers landed
 * differently on every profile, and nothing guaranteed the result hit the
 * histogram anywhere in particular.
 *
 * So `SCENE_INPUT_FS` and `RENDER_FS` are reproduced here, arithmetic for
 * arithmetic. With the render available as a plain function, auto stops
 * guessing and starts *solving*: pick a target in tone space, bisect the slider
 * that moves it. `autocheck` renders the same pixels through the real shader
 * and fails if the two ever drift apart.
 *
 * Everything here operates on linear ProPhoto RGB and returns tone space
 * (ProPhoto primaries, sRGB transfer) — the space the histogram is drawn in and
 * the one every tonal control acts in.
 */
import {
  calibrationMatrix,
  whiteBalanceGain,
  type Mat3,
  type WhitePoint,
} from '../core/color'
import { profileRender } from '../core/profiles'
import { clamp01 } from '../lib/math'
import type { Edits } from '../core/types'

export type Vec3 = [number, number, number]

/** ProPhoto luminance weights — the Y row of the D50 primaries, as in COMMON. */
export const LUMA: Vec3 = [0.2880402, 0.7118741, 0.0000857]

export const luma = (r: number, g: number, b: number): number =>
  LUMA[0] * r + LUMA[1] * g + LUMA[2] * b

const EPS = 1e-6


// --- Transfer ---------------------------------------------------------------

export function encode1(x: number): number {
  x = x > 0 ? x : 0
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055
}

export function decode1(x: number): number {
  x = x > 0 ? x : 0
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
}

// --- Tone primitives --------------------------------------------------------

export function shoulder1(x: number, knee: number): number {
  if (x <= knee) return x
  const range = Math.max(1 - knee, EPS)
  return knee + range * (1 - Math.exp(-(x - knee) / range))
}

export function baseCurve(x: number, k: number): number {
  x = clamp01(x)
  // Subtracted, to match `baseCurve` in the shader: added, this is an inverted
  // S that flattens the picture instead of adding the profile's contrast.
  return x - k * Math.sin(2 * Math.PI * x) * (0.5 - Math.abs(x - 0.5)) * 0.5
}

export function contrastCurve(x: number, c: number): number {
  x = clamp01(x)
  if (Math.abs(c) < 1e-5) return x
  const s =
    c > 0
      ? x * x * (3 - 2 * x)
      : 0.5 - Math.sin(Math.asin(Math.max(-1, Math.min(1, 1 - 2 * x))) / 3)
  const t = Math.min(Math.abs(c), 1)
  return x + (s - x) * t
}

export const region = (x: number, center: number, width: number): number => {
  const t = (x - center) / width
  return Math.exp(-t * t)
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

// --- HSV, ported from the GLSL in COMMON ------------------------------------
//
// The shader's branchless mix/step formulation does not agree with a textbook
// HSV at the seams — its hue is folded rather than wrapped — so the arithmetic
// is transcribed rather than reimplemented. Anything else and the model drifts
// from the render exactly where colour is most saturated.

function rgb2hsv(r: number, g: number, b: number): Vec3 {
  // p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g))
  const swap = g >= b
  const p0 = swap ? g : b
  const p1 = swap ? b : g
  const p2 = swap ? 0 : -1
  const p3 = swap ? -1 / 3 : 2 / 3

  // q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r))
  const take = r >= p0
  const q0 = take ? r : p0
  const q1 = p1
  const q2 = take ? p2 : p3
  const q3 = take ? p0 : r

  const d = q0 - Math.min(q3, q1)
  return [Math.abs(q2 + (q3 - q1) / (6 * d + EPS)), d / (q0 + EPS), q0]
}

function hsv2rgb(h: number, s: number, v: number): Vec3 {
  const f = (n: number) => {
    const x = h + n
    const p = Math.abs((x - Math.floor(x)) * 6 - 3)
    return v * (1 + s * (clamp01(p - 1) - 1))
  }
  return [f(1), f(2 / 3), f(1 / 3)]
}

// --- Parameters -------------------------------------------------------------

/**
 * Every uniform the scene-input and display-rendering passes read, resolved from the edit state. Splitting
 * this out is what lets the solver hold the scene fixed and vary one slider.
 */
export interface BasicParams {
  wbGain: Vec3
  calibration: Mat3
  /** -1..1, the Calibration panel's shadow tint. */
  shadowTint: number
  /** Stops. */
  exposure: number
  /** All -1..1, i.e. the slider divided by 100. */
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
  vibrance: number
  saturation: number
  protectSkin: boolean
  avoidColorShift: boolean
  /** Profile stage — zeroed out for rendered files, which carry a look already. */
  profileCurve: number
  profileSat: number
  shoulder: number
}

/** What scene preparation and display rendering need to know about the file. */
export interface SourceInfo {
  isRaw: boolean
  asShot: WhitePoint
}

/**
 * Resolves both passes' uniforms exactly as `Renderer.runGraph` does, so a
 * model run and a real render see the same numbers.
 */
export function basicParams(edits: Edits, source: SourceInfo): BasicParams {
  const b = edits.basic
  const wbGain: Vec3 =
    b.wbMode === 'asShot'
      ? [1, 1, 1]
      : whiteBalanceGain(source.asShot, { temp: b.temp, tint: b.tint })

  const isRaw = source.isRaw
  const profile = profileRender(edits.profile, isRaw)

  return {
    wbGain,
    calibration: calibrationMatrix(edits.calibration),
    shadowTint: edits.calibration.shadowTint / 100,
    exposure: b.exposure,
    contrast: b.contrast / 100,
    highlights: b.highlights / 100,
    shadows: b.shadows / 100,
    whites: b.whites / 100,
    blacks: b.blacks / 100,
    vibrance: b.vibrance / 100,
    saturation: b.saturation / 100,
    protectSkin: b.protectSkin,
    avoidColorShift: b.avoidColorShift,
    profileCurve: profile.curve,
    profileSat: profile.saturation,
    shoulder: profile.shoulder,
  }
}

// --- The pass itself --------------------------------------------------------

/**
 * White balance, calibration and shadow tint — everything upstream of the tone
 * sliders. The solver runs this once per sample and then only re-runs the part
 * that its slider can change.
 */
export function basicInput(rgb: Vec3, p: BasicParams, out: Vec3 = [0, 0, 0]): Vec3 {
  const r = rgb[0] * p.wbGain[0]
  const g = rgb[1] * p.wbGain[1]
  const b = rgb[2] * p.wbGain[2]

  const m = p.calibration
  const cr = Math.max(m[0] * r + m[1] * g + m[2] * b, 0)
  let cg = Math.max(m[3] * r + m[4] * g + m[5] * b, 0)
  const cb = Math.max(m[6] * r + m[7] * g + m[8] * b, 0)

  if (Math.abs(p.shadowTint) > 1e-4) {
    const w = Math.exp(-luma(cr, cg, cb) * 7)
    cg *= 1 - p.shadowTint * 0.14 * w
  }

  out[0] = cr
  out[1] = cg
  out[2] = cb
  return out
}

/**
 * The display-rendering chain, from exposure through saturation. Input is
 * scene-linear ProPhoto as `basicInput` leaves it; output is tone space.
 */
export function basicTone(lin: Vec3, p: BasicParams, out: Vec3 = [0, 0, 0]): Vec3 {
  const gain = Math.pow(2, p.exposure)
  let r = Math.max(lin[0] * gain, 0)
  let g = Math.max(lin[1] * gain, 0)
  let b = Math.max(lin[2] * gain, 0)

  const peak = Math.max(r, g, b)
  if (peak > p.shoulder) {
    const scale = shoulder1(peak, p.shoulder) / Math.max(peak, EPS)
    r *= scale
    g *= scale
    b *= scale
  }

  r = encode1(r)
  g = encode1(g)
  b = encode1(b)

  if (p.profileCurve > 1e-4) {
    r = baseCurve(r, p.profileCurve)
    g = baseCurve(g, p.profileCurve)
    b = baseCurve(b, p.profileCurve)
  }

  const L = clamp01(luma(r, g, b))
  let dL = 0
  dL += p.shadows * 0.3 * region(L, 0.26, 0.24) * smoothstep(0, 0.1, L)
  dL += p.highlights * 0.3 * region(L, 0.74, 0.22) * (1 - smoothstep(0.94, 1, L))
  dL += p.blacks * 0.2 * Math.pow(Math.max(0, 1 - L / 0.42), 2)
  dL += p.whites * 0.2 * Math.pow(Math.max(0, (L - 0.55) / 0.45), 1.6)

  const L2 = clamp01(L + dL)
  const ratio = L2 / Math.max(L, EPS)
  r *= ratio
  g *= ratio
  b *= ratio

  r = contrastCurve(r, p.contrast)
  g = contrastCurve(g, p.contrast)
  b = contrastCurve(b, p.contrast)

  if (
    Math.abs(p.saturation) > 1e-4 ||
    Math.abs(p.vibrance) > 1e-4 ||
    Math.abs(p.profileSat) > 1e-4
  ) {
    const Lsat = luma(r, g, b)
    const hsv = rgb2hsv(clamp01(r), clamp01(g), clamp01(b))
    let s = hsv[1]

    s *= 1 + p.profileSat

    let skin = 1 - 0.55 * Math.exp(-Math.pow((hsv[0] - 0.055) / 0.055, 2))
    if (!p.protectSkin) skin = 1
    const head = Math.pow(Math.max(0, 1 - s), 1.5)
    s *= 1 + p.vibrance * head * skin * 0.95

    s *= p.saturation >= 0 ? 1 + p.saturation * 1.35 : 1 + p.saturation
    const rgb = hsv2rgb(hsv[0], clamp01(s), hsv[2])
    r = rgb[0]
    g = rgb[1]
    b = rgb[2]

    if (p.avoidColorShift) {
      const k = Lsat / Math.max(luma(r, g, b), EPS)
      r = clamp01(r * k)
      g = clamp01(g * k)
      b = clamp01(b * k)
    }
  }

  out[0] = clamp01(r)
  out[1] = clamp01(g)
  out[2] = clamp01(b)
  return out
}

/** Both halves, for callers that just want the answer. */
export function basicPixel(rgb: Vec3, p: BasicParams, out: Vec3 = [0, 0, 0]): Vec3 {
  return basicTone(basicInput(rgb, p, out), p, out)
}

/** Tone-space luminance of one pixel — the value every auto target is written in. */
export function toneLuma(lin: Vec3, p: BasicParams): number {
  const t = basicTone(lin, p, scratch)
  return luma(t[0], t[1], t[2])
}

const scratch: Vec3 = [0, 0, 0]


/** Tone space → the linear ProPhoto the output pass receives. */
export const toneToLinear = (t: Vec3): Vec3 => [decode1(t[0]), decode1(t[1]), decode1(t[2])]
