/**
 * Auto — the one-click develop.
 *
 * `autoDevelop` is the general case: white balance, the six tone controls and
 * vibrance, decided together in that order because each one changes what the
 * next one is looking at. `autoWhiteBalance` and `autoTone` are the same
 * machinery exposed on their own for the WB dropdown and the Tone panel's Auto.
 *
 * Two ideas do all the work here.
 *
 * **The tone controls are solved, not guessed.** `toneModel` is an exact CPU
 * copy of scene preparation plus display rendering, so auto can ask "what does
 * the histogram do if whites is 37?" and get the real answer — profile base
 * curve, highlight shoulder, white balance, calibration and region masks
 * included. Each slider is then
 * bisected until an agreed percentile of the image lands on an agreed value in
 * tone space, and the whole set is iterated because the controls overlap. The
 * old code fitted constants against linear-light stops instead, which quietly
 * meant something different on every profile.
 *
 * **White balance is a correction, not an absolute.** The proxy is decoded with
 * the camera's own multipliers applied, so its pixels are already balanced to
 * the as-shot illuminant. The estimate therefore measures how far the image
 * still is from neutral and composes that with the as-shot white point — the
 * previous version read the average colour as an absolute chromaticity, which
 * is only correct for a photo shot under ProPhoto's D50.
 *
 * Everything reads the decoded linear proxy rather than the rendered output, so
 * auto is independent of what the user has already dialled in and lands on the
 * same answer for a given file every time.
 */
import { whitePointForGain } from '../core/color'
import { halfToFloat } from '../core/half'
import {
  basicInput,
  basicParams,
  basicTone,
  luma,
  smoothstep,
  toneLuma,
  type BasicParams,
  type Vec3,
} from './toneModel'
import { sourcePeak } from '../core/workingImage'
import type { SourceImage } from '../core/workingImage'
import type { CropEdits, Edits } from '../core/types'

export type Tone = Pick<
  Edits['basic'],
  'exposure' | 'contrast' | 'highlights' | 'shadows' | 'whites' | 'blacks'
>

export interface AutoResult {
  /** Null when the frame holds no usable evidence of the illuminant. */
  wb: { temp: number; tint: number } | null
  tone: Tone
  vibrance: number
}

const NEUTRAL_TONE: Tone = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/**
 * A grid of pixels from the frame, with weights.
 *
 * The grid is two-dimensional on purpose: stepping through the buffer linearly
 * aliases against the row width and can land every sample in the same few
 * columns. Weights lean towards the middle of the frame, because that is where
 * the subject usually is and a bright sky along the top edge should not decide
 * the exposure on its own.
 */
interface Samples {
  /** Linear ProPhoto triples, as decoded — white balanced to as-shot. */
  rgb: Float32Array
  weight: Float32Array
  count: number
}

const SAMPLE_TARGET = 40000
/** How much less an edge pixel counts than a central one. */
const EDGE_WEIGHT = 0.35

/** The crop rect in source pixels. Straightening is ignored — a few degrees
 *  cannot move the statistics of a whole frame anywhere interesting. */
function cropRect(crop: CropEdits | undefined, width: number, height: number) {
  const full = { x0: 0, y0: 0, x1: width, y1: height }
  if (!crop) return full
  const x0 = Math.max(0, Math.floor(Math.min(crop.left, crop.right) * width))
  const x1 = Math.min(width, Math.ceil(Math.max(crop.left, crop.right) * width))
  const y0 = Math.max(0, Math.floor(Math.min(crop.top, crop.bottom) * height))
  const y1 = Math.min(height, Math.ceil(Math.max(crop.top, crop.bottom) * height))
  // A crop this small is either degenerate or still being dragged.
  if (x1 - x0 < 16 || y1 - y0 < 16) return full
  return { x0, y0, x1, y1 }
}

function sampleImage(image: SourceImage, crop?: CropEdits, target = SAMPLE_TARGET): Samples {
  const { data, width, height } = image
  const { x0, y0, x1, y1 } = cropRect(crop, width, height)
  const cols = x1 - x0
  const rows = y1 - y0
  const step = Math.max(1, Math.floor(Math.sqrt((cols * rows) / target)))

  const nx = Math.ceil(cols / step)
  const ny = Math.ceil(rows / step)
  const rgb = new Float32Array(nx * ny * 3)
  const weight = new Float32Array(nx * ny)
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const hw = Math.max(1, cols / 2)
  const hh = Math.max(1, rows / 2)

  let n = 0
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const o = (y * width + x) * 4
      const r = halfToFloat(data[o])
      const g = halfToFloat(data[o + 1])
      const b = halfToFloat(data[o + 2])
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) continue

      const dx = (x - cx) / hw
      const dy = (y - cy) / hh
      const k = n * 3
      rgb[k] = r > 0 ? r : 0
      rgb[k + 1] = g > 0 ? g : 0
      rgb[k + 2] = b > 0 ? b : 0
      weight[n] = EDGE_WEIGHT + (1 - EDGE_WEIGHT) * Math.exp(-1.2 * (dx * dx + dy * dy))
      n++
    }
  }
  return { rgb, weight, count: n }
}

// ---------------------------------------------------------------------------
// Auto white balance
// ---------------------------------------------------------------------------

/** Anything with a channel this close to the source ceiling has lost its colour. */
const WB_CLIP_FRACTION = 0.98
/** Iterations of the reweighted grey-point search. */
const WB_PASSES = 6
/** Under-relaxation, so a strong cast converges instead of ringing. */
const WB_RELAX = 0.9
/** Hard limit on the correction, ±1.2 stops per channel. */
const WB_LIMIT = Math.log(2.3)
/** A sample this close to neutral, once corrected, counts as evidence of the illuminant. */
const WB_NEUTRAL_SAT = 0.12
/** Below this much neutral evidence there is no estimate; above the second, full strength. */
const WB_EVIDENCE_LO = 0.01
const WB_EVIDENCE_HI = 0.06

/**
 * Estimates the illuminant and returns it as temp/tint.
 *
 * The scene is assumed to average to grey, but only over the pixels that could
 * plausibly be grey: the weights fall away with saturation, with distance from
 * the mid-tones, and — separately — with how saturated the pixel was *before*
 * any correction. That last term is what stops the search from walking off:
 * neutralise a red wall far enough and it starts to look like evidence of a red
 * light, so a pixel that arrived deeply saturated is never allowed to become
 * the argument for the balance that made it grey.
 *
 * The vote itself is a weighted **median** of the per-pixel colour ratios
 * rather than a mean, which a single dominant colour can no longer drag around.
 * Since a gain is a constant offset in log space, the ordering never changes —
 * so the samples are sorted once and each pass is a linear walk.
 */
export function autoWhiteBalance(
  image: SourceImage,
  edits?: Edits,
): { temp: number; tint: number } | null {
  const s = sampleImage(image, edits?.crop)
  if (!s.count) return null

  // Usable samples, in log-ratio form.
  const lr = new Float64Array(s.count)
  const lb = new Float64Array(s.count)
  const base = new Float64Array(s.count)
  const sat0 = new Float64Array(s.count)
  const lum = new Float64Array(s.count)
  let m = 0

  for (let i = 0; i < s.count; i++) {
    const k = i * 3
    const r = s.rgb[k]
    const g = s.rgb[k + 1]
    const b = s.rgb[k + 2]
    if (!(r > 1e-5) || !(g > 1e-5) || !(b > 1e-5)) continue
    if (sourcePeak(image, r, g, b) >= WB_CLIP_FRACTION) continue
    const l = luma(r, g, b)
    if (l < 0.004 || l > 0.85) continue

    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    lr[m] = Math.log(r / g)
    lb[m] = Math.log(b / g)
    lum[m] = l
    sat0[m] = (max - min) / max
    base[m] = s.weight[i]
    m++
  }
  // Too little to go on — a black frame, or one blown from corner to corner.
  if (m < 64) return null

  const order = (values: Float64Array) => {
    const idx = new Uint32Array(m)
    for (let i = 0; i < m; i++) idx[i] = i
    return idx.sort((a, b) => values[a] - values[b])
  }
  const byR = order(lr)
  const byB = order(lb)

  const weights = new Float64Array(m)
  const sat = new Float64Array(m)
  let ur = 0
  let ub = 0

  for (let pass = 0; pass < WB_PASSES; pass++) {
    const gr = Math.exp(ur)
    const gb = Math.exp(ub)
    let total = 0
    for (let i = 0; i < m; i++) {
      // Saturation of the sample as currently corrected.
      const r = Math.exp(lr[i]) * gr
      const b = Math.exp(lb[i]) * gb
      const max = Math.max(r, 1, b)
      const min = Math.min(r, 1, b)
      const s2 = (max - min) / max
      sat[i] = s2
      const l = lum[i] * (luma(r, 1, b) / luma(1, 1, 1))
      const w =
        base[i] *
        Math.exp(-s2 * s2 * 12) *
        Math.exp(-sat0[i] * sat0[i] * 3) *
        Math.exp(-Math.pow(Math.log(Math.max(l, 1e-6) / 0.18), 2) * 0.4)
      weights[i] = w
      total += w
    }
    if (!(total > 1e-9)) return null

    const mr = weightedMedian(byR, lr, weights, total) + ur
    const mb = weightedMedian(byB, lb, weights, total) + ub
    ur -= mr * WB_RELAX
    ub -= mb * WB_RELAX
    ur = Math.max(-WB_LIMIT, Math.min(WB_LIMIT, ur))
    ub = Math.max(-WB_LIMIT, Math.min(WB_LIMIT, ub))
    if (Math.abs(mr) < 1e-4 && Math.abs(mb) < 1e-4) break
  }

  // How much of the frame actually came out neutral. Grey-world assumes the
  // scene averages to grey, and on a frame with no near-neutral surface at all
  // — a sunset, a forest, a close-up of one painted object — that assumption
  // has nothing behind it and the estimate is a guess dressed as a measurement.
  // The camera's own as-shot balance is the better answer in that case, so the
  // correction is faded out as the evidence disappears rather than applied at
  // full strength on the strength of a coincidence.
  let evidence = 0
  let baseTotal = 0
  for (let i = 0; i < m; i++) {
    baseTotal += base[i]
    if (sat[i] < WB_NEUTRAL_SAT) evidence += base[i]
  }
  const confidence = smoothstep(WB_EVIDENCE_LO, WB_EVIDENCE_HI, baseTotal > 0 ? evidence / baseTotal : 0)
  if (confidence <= 0) return null
  ur *= confidence
  ub *= confidence

  // The gain that would neutralise the frame, expressed as the white point it
  // implies: the renderer's gain is asShotWhite / targetWhite, normalised on
  // green, so the target white is the as-shot white divided through by it.
  return whitePointForGain(image.asShot, Math.exp(ur), Math.exp(ub))
}

/** Value at half the weight, walking a pre-sorted index. */
function weightedMedian(
  order: Uint32Array,
  values: Float64Array,
  weights: Float64Array,
  total: number,
): number {
  const want = total / 2
  let acc = 0
  for (let i = 0; i < order.length; i++) {
    acc += weights[order[i]]
    if (acc >= want) return values[order[i]]
  }
  return values[order[order.length - 1]]
}

// ---------------------------------------------------------------------------
// Auto tone
// ---------------------------------------------------------------------------

/*
 * Targets, all in tone space — the sRGB-encoded working space the histogram is
 * drawn in, where 0.43 is middle grey.
 *
 * Every one of them is a *window*, not a point, and this is the single most
 * important thing about the way auto behaves. A target expressed as a number
 * says "every photograph should look like this", and an auto built that way
 * moves all six sliders on every image — the frame that was already right gets
 * mangled just as hard as the one that was three stops under. Expressed as a
 * window it says "this is the range a photograph is allowed to live in", a
 * slider engages only when the frame is genuinely outside it, and when it does
 * engage it aims for the near edge rather than the middle. On a competent
 * exposure auto now returns zeros, which is the correct answer.
 *
 * `PULL` is the fraction of the remaining distance that is actually taken, so
 * even a real correction stops short of the ideal: a night scene stays night
 * and a high-key portrait stays high-key.
 */

/** The mid-tone may sit anywhere in here without exposure being touched. */
const MID_WINDOW = [0.34, 0.56] as const
const MID_PULL = 0.8
/** Below this the brightest real detail is dull enough to be worth lifting. */
const WHITE_FLOOR = 0.86
const WHITE_TARGET = 0.95
const WHITE_PULL = 0.7
/** Above this the darkest real detail is milky enough to be worth deepening. */
const BLACK_CEIL = 0.1
const BLACK_TARGET = 0.045
const BLACK_PULL = 0.7
/** Ceiling for the top of the image before highlights starts recovering. */
const HIGH_CEIL = 0.96
const HIGH_TARGET = 0.92
const HIGH_PULL = 0.75
/** Floor for the bottom before shadows starts opening. */
const LOW_FLOOR = 0.05
const LOW_TARGET = 0.085
const LOW_PULL = 0.65
/**
 * Distance from the first quartile to the third, which is what contrast is
 * solved against.
 *
 * Deliberately the quartiles and not the tails: whites and blacks have already
 * pinned the ends of the histogram by the time contrast is decided, so
 * measuring out there would have contrast fighting them for the same pixels
 * and reporting the tug of war as an image property.
 */
const SPREAD_WINDOW = [0.26, 0.42] as const
const SPREAD_PULL = 0.6
/** Below this the exposure move is noise from the solve, not a correction. */
const EXPOSURE_DEADBAND = 0.06
/** Exposure may not push the top of the image past this. */
const CLIP_GUARD = 0.99
const CLIP_BUDGET = 0.015

/*
 * Where the usable range ends, in linear light.
 *
 * A RAW arrives clipped at the sensor's white level with nothing above it and,
 * often, true zero below: the top two percent of a blown sky is one flat value
 * and the shadows of a night frame are the black point exactly. Stretching a
 * flat plateau towards white does nothing you can see, and dragging true black
 * up to a target grey is worse than nothing — so the endpoints are measured at
 * the highest and lowest ranks that still hold *detail*, not at fixed ones.
 */
const CLIP_FRACTION = 0.995
const FLOOR_LINEAR = 3e-4
/** Candidate ranks for the white point, brightest first. */
const WHITE_RANKS = [0.998, 0.995, 0.99, 0.98, 0.96, 0.93, 0.9]
/** Candidate ranks for the black point, darkest first. */
const BLACK_RANKS = [0.002, 0.005, 0.012, 0.025, 0.05]
/** Clipped area beyond this fraction earns highlight recovery on its own. */
const CLIP_TOLERANCE = 0.005
const CLIP_RECOVERY = 260
const CLIP_RECOVERY_MAX = 0.4

/**
 * How far auto is allowed to move each control.
 *
 * Narrower than the sliders themselves. These are the bounds of a *plausible*
 * automatic correction, not of the control: an auto that returns -80 highlights
 * has stopped making a judgement and started reporting that it ran out of
 * range, and the result on screen is a photograph nobody would have made.
 */
const LIMITS = {
  exposure: [-3, 3],
  contrast: [-0.25, 0.35],
  highlights: [-0.6, 0],
  shadows: [0, 0.6],
  whites: [-0.45, 0.45],
  blacks: [-0.45, 0.45],
} as const

/**
 * The smallest move, in tone space, that makes a control worth using.
 *
 * Sliders overlap and each one only has authority over part of the range —
 * highlights does almost nothing to a pixel already at 0.99, whites does
 * nothing at all below 0.55. Without this a solve that cannot reach its target
 * walks to the limit and reports a number that looks like a decision, so the
 * panel shows -60 for a control that changed nothing.
 */
const AUTHORITY = 0.012

/** Fixed measurement points. The endpoints are chosen per image instead. */
const RANK = {
  low: 0.08,
  q1: 0.25,
  mid: 0.5,
  q3: 0.75,
  high: 0.9,
  bright: 0.95,
  /** Replaced per image by the clip budget; see `CLIP_BUDGET`. */
  clip: 0.985,
} as const

type AnchorKey = keyof typeof RANK | 'black' | 'white'

/**
 * Solves the six tone controls for one image.
 *
 * `edits` supplies the render the answer has to be right for: white balance,
 * camera profile, calibration and crop. The tone controls themselves are
 * ignored — auto always starts from zero, so pressing it twice is idempotent.
 */
export function autoTone(image: SourceImage, edits: Edits): Tone {
  const scene = sceneFor(image, edits)
  if (!scene) return { ...NEUTRAL_TONE }
  return solveTone(scene)
}

interface Scene {
  params: BasicParams
  /** Representative linear pixels at each measured rank. */
  anchors: Record<AnchorKey, Vec3>
  /** False when the top or bottom of the range holds no recoverable detail. */
  hasWhite: boolean
  hasBlack: boolean
  /** Weighted fraction of the frame with at least one channel at the ceiling. */
  clippedFraction: number
  /** Post-white-balance linear samples, for the presence estimate. */
  linear: Float32Array
  weight: Float32Array
  count: number
}

function sceneFor(image: SourceImage, edits: Edits): Scene | null {
  const s = sampleImage(image, edits.crop)
  if (s.count < 32) return null

  // Auto decides the tone controls from scratch every time; anything already on
  // them would otherwise be measured as part of the scene.
  const flat: Edits = {
    ...edits,
    basic: { ...edits.basic, ...NEUTRAL_TONE },
  }
  const params = basicParams(flat, image)

  const linear = new Float32Array(s.count * 3)
  const lum = new Float64Array(s.count)
  const sourceClipped = new Uint8Array(s.count)
  const px: Vec3 = [0, 0, 0]
  let clipped = 0
  let total = 0
  for (let i = 0; i < s.count; i++) {
    const k = i * 3
    px[0] = s.rgb[k]
    px[1] = s.rgb[k + 1]
    px[2] = s.rgb[k + 2]
    sourceClipped[i] = sourcePeak(image, px[0], px[1], px[2]) >= CLIP_FRACTION ? 1 : 0
    basicInput(px, params, px)
    linear[k] = px[0]
    linear[k + 1] = px[1]
    linear[k + 2] = px[2]
    lum[i] = luma(px[0], px[1], px[2])
    total += s.weight[i]
    // Per channel, because a blue sky loses blue long before it looks bright.
    if (sourceClipped[i]) clipped += s.weight[i]
  }
  if (!(total > 0)) return null

  const order = new Uint32Array(s.count)
  for (let i = 0; i < s.count; i++) order[i] = i
  order.sort((a, b) => lum[a] - lum[b])

  const cum = new Float64Array(s.count)
  let acc = 0
  for (let i = 0; i < s.count; i++) {
    acc += s.weight[order[i]]
    cum[i] = acc
  }

  /** Weighted mean of the pixels whose rank falls inside a window. */
  const anchor = (rank: number, halfWidth: number): Vec3 => {
    const lo = Math.max(0, rank - halfWidth) * acc
    const hi = Math.min(1, rank + halfWidth) * acc
    let r = 0
    let g = 0
    let b = 0
    let w = 0
    for (let i = 0; i < s.count; i++) {
      if (cum[i] < lo) continue
      const j = order[i] * 3
      const wi = s.weight[order[i]]
      r += linear[j] * wi
      g += linear[j + 1] * wi
      b += linear[j + 2] * wi
      w += wi
      if (cum[i] >= hi) break
    }
    if (!(w > 0)) return [0, 0, 0]
    return [r / w, g / w, b / w]
  }

  const clippedShare = (rank: number, halfWidth: number): number => {
    const lo = Math.max(0, rank - halfWidth) * acc
    const hi = Math.min(1, rank + halfWidth) * acc
    let clippedWeight = 0
    let weight = 0
    for (let i = 0; i < s.count; i++) {
      if (cum[i] < lo) continue
      const sample = order[i]
      const wi = s.weight[sample]
      if (sourceClipped[sample]) clippedWeight += wi
      weight += wi
      if (cum[i] >= hi) break
    }
    return weight > 0 ? clippedWeight / weight : 1
  }

  // Walk in from each end until the anchor holds something other than the
  // clipping point or the black point.
  let white: Vec3 = [0, 0, 0]
  let hasWhite = false
  for (const rank of WHITE_RANKS) {
    white = anchor(rank, 0.002)
    if (clippedShare(rank, 0.002) < 0.25) {
      hasWhite = true
      break
    }
  }
  let black: Vec3 = [0, 0, 0]
  let hasBlack = false
  for (const rank of BLACK_RANKS) {
    // A wide window here: the darkest samples of a RAW are as much sensor noise
    // as they are picture, and averaging is the cheapest way to not chase it.
    black = anchor(rank, 0.006)
    if (luma(black[0], black[1], black[2]) > FLOOR_LINEAR) {
      hasBlack = true
      break
    }
  }

  // The mid anchor is deliberately broad: a single percentile of a bimodal
  // frame lands in the gap between the two modes and means nothing.
  const clippedFraction = clipped / total
  const guardRank = Math.max(0.6, Math.min(RANK.clip, 1 - CLIP_BUDGET - clippedFraction))

  // Narrow windows on purpose. An anchor is a weighted mean of linear light, so
  // a wide one on a high-contrast frame is dragged upwards by its own bright
  // end and reports a mid-tone the image does not have.
  const anchors: Record<AnchorKey, Vec3> = {
    black,
    low: anchor(RANK.low, 0.02),
    q1: anchor(RANK.q1, 0.03),
    mid: anchor(RANK.mid, 0.05),
    q3: anchor(RANK.q3, 0.03),
    high: anchor(RANK.high, 0.02),
    // Clip-aware, like the exposure guard: highlights cannot recover a pixel
    // that has already lost its detail, so pointing the measurement at the
    // blown part of a frame only ever produces a slider that darkens the
    // mid-tones and calls it recovery.
    bright: anchor(Math.max(0.75, Math.min(RANK.bright, 1 - clippedFraction - 0.02)), 0.015),
    clip: anchor(guardRank, 0.004),
    white,
  }

  return {
    params,
    anchors,
    hasWhite,
    hasBlack,
    clippedFraction,
    linear,
    weight: s.weight,
    count: s.count,
  }
}

/**
 * Bisects one slider until the measurement hits its target.
 *
 * Returns 0 when the control has no authority over that measurement — whites
 * cannot move a pixel that sits below where whites starts, and reporting 70
 * because the solve ran out of range would be a lie on the slider.
 */
function solve(f: (x: number) => number, lo: number, hi: number, target: number): number {
  const flo = f(lo)
  const fhi = f(hi)
  if (Math.abs(fhi - flo) < AUTHORITY) return 0
  const rising = fhi > flo
  if (rising ? target <= flo : target >= flo) return lo
  if (rising ? target >= fhi : target <= fhi) return hi

  let a = lo
  let b = hi
  for (let i = 0; i < 24; i++) {
    const mid = (a + b) / 2
    if (rising === f(mid) < target) a = mid
    else b = mid
  }
  return (a + b) / 2
}

/**
 * A control only engages when the measurement has left its window, and then it
 * aims for `target` rather than the middle of the window — so a correction is
 * always a step back inside the range, never a march to an ideal.
 */
function windowTarget(
  value: number,
  lo: number,
  hi: number,
  target: number,
  pull: number,
): number | null {
  if (value >= lo && value <= hi) return null
  return value + (target - value) * pull
}

function solveTone(scene: Scene): Tone {
  const p: BasicParams = { ...scene.params, ...zeroed() }
  const a = scene.anchors
  const at = (key: AnchorKey) => toneLuma(a[key], p)

  // Every target is fixed here, from the frame as the profile renders it with
  // all six controls at zero. Re-deriving them inside the loop would have each
  // pass chasing the previous pass's work, which is how a solve that looks
  // convergent ends up parked against its limits.
  const mid0 = at('mid')
  const spread0 = at('q3') - at('q1')

  // Exposure is also the stabiliser. When the mid-tone is already where it
  // belongs the target is the mid-tone itself rather than nothing at all, so
  // that whatever highlight recovery and contrast do to the middle of the
  // histogram gets handed back — otherwise a frame that needed only its
  // highlights pulled down comes out a quarter of a stop darker for no reason
  // anybody asked for.
  const midTarget =
    windowTarget(
      mid0,
      MID_WINDOW[0],
      MID_WINDOW[1],
      mid0 < MID_WINDOW[0] ? MID_WINDOW[0] + 0.06 : MID_WINDOW[1] - 0.08,
      MID_PULL,
    ) ?? mid0
  const brightTarget = windowTarget(at('bright'), 0, HIGH_CEIL, HIGH_TARGET, HIGH_PULL)
  const lowTarget = windowTarget(at('low'), LOW_FLOOR, Infinity, LOW_TARGET, LOW_PULL)
  // One-directional on purpose: whites lifts a dull top, it does not push an
  // already bright one further, and blacks deepens a milky bottom rather than
  // lifting a black point the photographer chose.
  const whiteTarget = windowTarget(at('white'), WHITE_FLOOR, Infinity, WHITE_TARGET, WHITE_PULL)
  const blackTarget = windowTarget(at('black'), 0, BLACK_CEIL, BLACK_TARGET, BLACK_PULL)
  const spreadTarget = windowTarget(
    spread0,
    SPREAD_WINDOW[0],
    SPREAD_WINDOW[1],
    spread0 < SPREAD_WINDOW[0] ? SPREAD_WINDOW[0] + 0.03 : SPREAD_WINDOW[1] - 0.03,
    SPREAD_PULL,
  )

  // Blown area is its own argument for recovery: the anchors sit below it by
  // construction, so without this a frame with a white sky reads as well
  // exposed right up to the moment you look at the sky.
  const blownFloor =
    scene.clippedFraction > CLIP_TOLERANCE
      ? -Math.min(
          CLIP_RECOVERY_MAX,
          (scene.clippedFraction - CLIP_TOLERANCE) * (CLIP_RECOVERY / 100),
        )
      : 0

  for (let pass = 0; pass < 3; pass++) {
    p.exposure = solveExposure(p, at, midTarget)

    const recovered =
      brightTarget === null
        ? 0
        : solve(
            (v) => ((p.highlights = v), at('bright')),
            LIMITS.highlights[0],
            LIMITS.highlights[1],
            brightTarget,
          )
    p.highlights = Math.min(recovered, blownFloor)

    p.shadows =
      lowTarget === null
        ? 0
        : solve((v) => ((p.shadows = v), at('low')), LIMITS.shadows[0], LIMITS.shadows[1], lowTarget)

    p.whites =
      scene.hasWhite && whiteTarget !== null
        ? solve(
            (v) => ((p.whites = v), at('white')),
            LIMITS.whites[0],
            LIMITS.whites[1],
            whiteTarget,
          )
        : 0

    p.blacks =
      scene.hasBlack && blackTarget !== null
        ? solve(
            (v) => ((p.blacks = v), at('black')),
            LIMITS.blacks[0],
            LIMITS.blacks[1],
            blackTarget,
          )
        : 0

    p.contrast =
      spreadTarget === null
        ? 0
        : solve(
            (v) => ((p.contrast = v), at('q3') - at('q1')),
            LIMITS.contrast[0],
            LIMITS.contrast[1],
            spreadTarget,
          )
  }

  // The guard was applied while the other five controls were still moving, so
  // it is checked once more against the set that actually ships.
  if (p.exposure > 0 && at('clip') > CLIP_GUARD) {
    p.exposure = solve((v) => ((p.exposure = v), at('clip')), 0, p.exposure, CLIP_GUARD)
  }

  return {
    exposure: Math.abs(p.exposure) < EXPOSURE_DEADBAND ? 0 : round(p.exposure, 2),
    contrast: round(p.contrast * 100, 0),
    highlights: round(p.highlights * 100, 0),
    shadows: round(p.shadows * 100, 0),
    whites: round(p.whites * 100, 0),
    blacks: round(p.blacks * 100, 0),
  }
}

/**
 * Exposure lands the mid-tone anchor on its target, then gives way at the top:
 * brightening a frame until its highlights blow is the one auto-exposure
 * mistake that cannot be undone further down the panel. A frame that arrived
 * clipped is exempt — a scene with a light source in it would otherwise never
 * be allowed to brighten at all.
 */
function solveExposure(
  p: BasicParams,
  at: (key: AnchorKey) => number,
  midTarget: number,
): number {
  const wanted = solve(
    (v) => ((p.exposure = v), at('mid')),
    LIMITS.exposure[0],
    LIMITS.exposure[1],
    midTarget,
  )
  if (wanted <= 0) {
    p.exposure = wanted
    return wanted
  }

  p.exposure = 0
  // Everything within the clip budget is already at the ceiling with nothing on
  // the sliders: there is no headroom left to spend, so the mid-tone target
  // does not get to spend it.
  let capped = 0
  if (at('clip') < CLIP_GUARD) {
    const ceiling = solve((v) => ((p.exposure = v), at('clip')), 0, LIMITS.exposure[1], CLIP_GUARD)
    capped = ceiling > 0 ? Math.min(wanted, ceiling) : wanted
  }
  p.exposure = capped
  return capped
}

const zeroed = () => ({
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
})

function round(v: number, decimals: number): number {
  const k = Math.pow(10, decimals)
  return Math.round(v * k) / k
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

/**
 * The band of mean tone-space saturation a rendered photograph is expected to
 * sit in, measured the same way the render is: HSV saturation over the
 * mid-tones only, because the near-black and near-white ends of a frame carry
 * no colour to average and would only dilute the number.
 *
 * A window again rather than a target — an image that is already colourful
 * enough gets nothing, which is most of them.
 */
const SAT_WINDOW = [0.13, 0.25] as const
/** Vibrance points per unit of saturation shortfall. */
const SAT_GAIN = 190
const VIBRANCE_LIMIT = { lo: -12, hi: 25 }

/**
 * Vibrance from how colourful the frame renders once the tone is settled.
 *
 * Only the mid-tones are measured: shadows have no colour to speak of and
 * near-white pixels have had theirs squeezed out by the shoulder, so including
 * either would read as "dull" on a photograph that is nothing of the sort.
 */
function autoVibrance(scene: Scene, tone: Tone): number {
  const p: BasicParams = {
    ...scene.params,
    exposure: tone.exposure,
    contrast: tone.contrast / 100,
    highlights: tone.highlights / 100,
    shadows: tone.shadows / 100,
    whites: tone.whites / 100,
    blacks: tone.blacks / 100,
    // Auto decides these two, so it has to measure the frame without them —
    // the profile's own saturation trim stays, because that is the rendering.
    vibrance: 0,
    saturation: 0,
  }

  const px: Vec3 = [0, 0, 0]
  const out: Vec3 = [0, 0, 0]
  let sum = 0
  let weight = 0
  // Every fourth sample: saturation is a bulk statistic and this is the one
  // measurement that has to run the whole chain per pixel.
  for (let i = 0; i < scene.count; i += 4) {
    const k = i * 3
    px[0] = scene.linear[k]
    px[1] = scene.linear[k + 1]
    px[2] = scene.linear[k + 2]
    const t = basicTone(px, p, out)
    const l = luma(t[0], t[1], t[2])
    if (l < 0.12 || l > 0.88) continue
    const max = Math.max(t[0], t[1], t[2])
    const min = Math.min(t[0], t[1], t[2])
    if (!(max > 1e-4)) continue
    const w = scene.weight[i]
    sum += ((max - min) / max) * w
    weight += w
  }
  if (!(weight > 0)) return 0

  const mean = sum / weight
  if (mean >= SAT_WINDOW[0] && mean <= SAT_WINDOW[1]) return 0
  const edge = mean < SAT_WINDOW[0] ? SAT_WINDOW[0] : SAT_WINDOW[1]
  const v = (edge - mean) * SAT_GAIN
  return Math.round(Math.max(VIBRANCE_LIMIT.lo, Math.min(VIBRANCE_LIMIT.hi, v)))
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

/**
 * The general Auto: white balance first, because it changes every channel and
 * therefore the luminance the tone solve is aiming at; then tone; then
 * vibrance, judged on the result of both.
 */
export function autoDevelop(image: SourceImage, edits: Edits): AutoResult {
  const wb = autoWhiteBalance(image, edits)
  const balanced: Edits = wb
    ? { ...edits, basic: { ...edits.basic, wbMode: 'auto', temp: wb.temp, tint: wb.tint } }
    : edits

  const scene = sceneFor(image, balanced)
  if (!scene) return { wb, tone: { ...NEUTRAL_TONE }, vibrance: 0 }

  const tone = solveTone(scene)
  return { wb, tone, vibrance: autoVibrance(scene, tone) }
}

/** Writes an auto result into an edit draft. Safe to call inside an immer producer. */
export function applyAuto(e: Edits, result: AutoResult) {
  if (result.wb) {
    e.basic.wbMode = 'auto'
    e.basic.temp = result.wb.temp
    e.basic.tint = result.wb.tint
  }
  e.basic.exposure = result.tone.exposure
  e.basic.contrast = result.tone.contrast
  e.basic.highlights = result.tone.highlights
  e.basic.shadows = result.tone.shadows
  e.basic.whites = result.tone.whites
  e.basic.blacks = result.tone.blacks
  e.basic.vibrance = result.vibrance
}
