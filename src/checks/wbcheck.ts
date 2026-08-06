/**
 * Headless check for the white-balance dropper.
 *
 * Two independent things can be wrong here, and only one of them is obvious.
 *
 * **The map has to be the shader.** The dropper measures the *sensor* proxy
 * while the photographer is pointing at the *cropped, straightened, lens
 * corrected* photo, so `outputUvToSourceUv` transcribes the inverse map in
 * `src/gpu/wgsl/geometry.ts`. Nothing about a wrong transcription looks wrong:
 * the dropper still returns a confident white point, just measured off the
 * wrong pixel — and it goes wrong first on the photos hardest to notice it on,
 * the ones that were straightened or turned. So the check renders a small
 * marker through the real GPU graph, finds where the graph put it, asks the
 * CPU map where that point came from, and compares the answer to where the
 * marker actually is. The two implementations are only allowed to agree.
 *
 * **The colour has to invert.** Balancing on a patch has to produce a white
 * point whose gain cancels the patch's cast exactly, for casts in both
 * directions and for a patch that is already neutral. And a patch that cannot
 * answer — black, or clipped — has to refuse rather than return a confident
 * meaningless number.
 *
 * The GPU half needs a real browser:
 *   node tools/browsercheck.mjs /checks/wbcheck.html
 * The CPU half runs anywhere and is reported either way, so
 * `node tools/headless.mjs /checks/wbcheck.html` still says something useful.
 */
import { Renderer } from '../gpu/renderer'
import { defaultEdits } from '../core/defaults'
import { floatToHalf } from '../core/half'
import { TEMP_MAX, whiteBalanceGain } from '../core/color'
import { outputUvToSourceUv, samplePatch, whiteBalanceFromPatch } from '../develop/wbPicker'
import { RENDERED_WHITE_POINT, type SourceImage } from '../core/workingImage'
import type { Edits, Point2 } from '../core/types'
import { runCheck } from './checkreport'

const failures: string[] = []
const notes: Record<string, unknown> = {}
const ok = (cond: boolean, message: string) => {
  if (!cond) failures.push(message)
}

// ---------------------------------------------------------------------------
// A frame with a marker in a known place
// ---------------------------------------------------------------------------

// Deliberately not square, and not a multiple of the other side: an aspect bug
// in either implementation cancels itself out on a square frame.
const W = 200
const H = 140
/** Marker radius in source pixels. Big enough to survive resampling, small enough to be a point. */
const DOT = 3.5

/**
 * A black frame with one bright disc centred on `at`.
 *
 * A disc rather than a square because every case here deforms it — rotation,
 * perspective, distortion — and a disc's centroid survives being deformed
 * symmetrically, where a square's corners would drag it.
 */
function marker(at: Point2): SourceImage {
  const data = new Uint16Array(W * H * 4)
  const one = floatToHalf(1)
  const cx = at.x * W - 0.5
  const cy = at.y * H - 0.5
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      data[i + 3] = one
      if (Math.hypot(x - cx, y - cy) <= DOT) {
        data[i] = one
        data[i + 1] = one
        data[i + 2] = one
      }
    }
  }
  return {
    width: W,
    height: H,
    data,
    isRaw: false,
    asShot: RENDERED_WHITE_POINT,
    whiteLevel: 1,
  }
}

/**
 * Where the brightest thing in a rendered frame is, in output uv.
 *
 * Thresholded at half the peak and weighted by the excess, so the disc's soft
 * resampled edge contributes in proportion rather than dragging the centroid
 * toward whichever side happens to have more of it.
 */
function brightestPoint(
  px: { data: Uint16Array | Uint8ClampedArray; width: number; height: number },
): Point2 | null {
  const full = px.data instanceof Uint16Array ? 65535 : 255
  let peak = 0
  for (let i = 0; i < px.data.length; i += 4) {
    if (px.data[i + 1] > peak) peak = px.data[i + 1]
  }
  if (peak < 0.15 * full) return null
  const cut = peak * 0.5
  let sx = 0
  let sy = 0
  let sw = 0
  for (let y = 0; y < px.height; y++) {
    for (let x = 0; x < px.width; x++) {
      const v = px.data[(y * px.width + x) * 4 + 1]
      if (v <= cut) continue
      const w = v - cut
      sx += (x + 0.5) * w
      sy += (y + 0.5) * w
      sw += w
    }
  }
  if (!sw) return null
  return { x: sx / sw / px.width, y: sy / sw / px.height }
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

type Tweak = (e: Edits) => void

const CASES: { name: string; edits: Tweak; at?: Point2[] }[] = [
  { name: 'identity', edits: () => {}, at: [{ x: 0.5, y: 0.5 }, { x: 0.2, y: 0.25 }, { x: 0.8, y: 0.75 }] },
  {
    name: 'crop',
    edits: (e) => Object.assign(e.crop, { left: 0.2, top: 0.15, right: 0.8, bottom: 0.9 }),
  },
  { name: 'quarterTurns 1', edits: (e) => (e.crop.quarterTurns = 1) },
  { name: 'quarterTurns 2', edits: (e) => (e.crop.quarterTurns = 2) },
  { name: 'quarterTurns 3', edits: (e) => (e.crop.quarterTurns = 3) },
  { name: 'flipH', edits: (e) => (e.crop.flipH = true) },
  { name: 'flipV', edits: (e) => (e.crop.flipV = true) },
  { name: 'straighten', edits: (e) => (e.crop.angle = 12) },
  {
    // The combination is the point: each of these is easy to get right alone
    // and easy to get out of order together.
    name: 'crop + turn + straighten',
    edits: (e) => {
      Object.assign(e.crop, { left: 0.15, top: 0.1, right: 0.85, bottom: 0.95 })
      e.crop.quarterTurns = 1
      e.crop.angle = -7
    },
  },
  {
    name: 'perspective',
    edits: (e) => Object.assign(e.transform, { horizontal: 40, vertical: -30 }),
  },
  {
    name: 'scale + offset',
    edits: (e) => Object.assign(e.transform, { scale: 130, offsetX: 10, offsetY: -8 }),
  },
  { name: 'aspect stretch', edits: (e) => (e.transform.aspect = 30) },
  { name: 'aspect squeeze', edits: (e) => (e.transform.aspect = -25) },
  { name: 'distortion +', edits: (e) => (e.lens.distortion = 25) },
  { name: 'distortion −', edits: (e) => (e.lens.distortion = -20) },
  {
    name: 'everything',
    edits: (e) => {
      Object.assign(e.crop, {
        left: 0.12,
        top: 0.08,
        right: 0.9,
        bottom: 0.94,
        angle: 6,
        quarterTurns: 3,
        flipH: true,
      })
      Object.assign(e.transform, { horizontal: 20, vertical: 15, scale: 112, offsetX: 5, rotate: -4 })
      e.lens.distortion = 12
    },
  },
]

const DEFAULT_AT: Point2[] = [
  { x: 0.5, y: 0.5 },
  { x: 0.36, y: 0.34 },
  { x: 0.66, y: 0.63 },
]

function editsFor(tweak: Tweak): Edits {
  const e = defaultEdits()
  tweak(e)
  return e
}

// ---------------------------------------------------------------------------

runCheck(async () => {
  // --- The map, against the shader -----------------------------------------

  if (navigator.gpu) {
    const renderer = await Renderer.create(new OffscreenCanvas(1, 1))
    const worst: Record<string, number> = {}

    for (const c of CASES) {
      const edits = editsFor(c.edits)
      let caseWorst = 0
      for (const at of c.at ?? DEFAULT_AT) {
        renderer.setImage(marker(at))
        renderer.setFrame(null)
        renderer.renderOffscreen(edits)
        const px = await renderer.readPixels('prophoto', 16, null)
        if (!px) {
          failures.push(`${c.name} @ ${at.x},${at.y}: nothing rendered`)
          continue
        }
        const found = brightestPoint(px)
        if (!found) {
          failures.push(`${c.name} @ ${at.x},${at.y}: marker not visible in the output`)
          continue
        }
        const back = outputUvToSourceUv(edits, W, H, found)
        // Measured in source pixels, because that is the unit the error costs
        // something in: the dropper samples a 5×5 patch, so being a pixel or
        // two out is survivable and being ten out is not.
        const err = Math.hypot((back.x - at.x) * W, (back.y - at.y) * H)
        caseWorst = Math.max(caseWorst, err)
        ok(
          err < 2.5,
          `${c.name} @ ${at.x},${at.y}: CPU map disagrees with the shader by ${err.toFixed(2)}px ` +
            `(shader put it at ${found.x.toFixed(4)},${found.y.toFixed(4)}, ` +
            `map walked back to ${back.x.toFixed(4)},${back.y.toFixed(4)})`,
        )
      }
      worst[c.name] = Math.round(caseWorst * 100) / 100
    }
    notes.worstErrorPx = worst
  } else {
    notes.gpu = 'skipped — no navigator.gpu; run through tools/browsercheck.mjs'
  }

  // --- The map, on its own --------------------------------------------------
  // The identity has to be exactly the identity or every other case above is
  // measuring against the wrong baseline, and floating point is no excuse.
  {
    const e = defaultEdits()
    const p = outputUvToSourceUv(e, W, H, { x: 0.25, y: 0.75 })
    ok(Math.abs(p.x - 0.25) < 1e-9 && Math.abs(p.y - 0.75) < 1e-9, `identity is not exact: ${p.x}, ${p.y}`)
  }
  {
    const e = defaultEdits()
    Object.assign(e.crop, { left: 0.25, top: 0.5, right: 0.75, bottom: 1 })
    const mid = outputUvToSourceUv(e, W, H, { x: 0.5, y: 0.5 })
    ok(
      Math.abs(mid.x - 0.5) < 1e-9 && Math.abs(mid.y - 0.75) < 1e-9,
      `crop centre is not the crop's centre: ${mid.x}, ${mid.y}`,
    )
    const tl = outputUvToSourceUv(e, W, H, { x: 0, y: 0 })
    ok(
      Math.abs(tl.x - 0.25) < 1e-9 && Math.abs(tl.y - 0.5) < 1e-9,
      `crop corner is not the crop's corner: ${tl.x}, ${tl.y}`,
    )
  }

  // --- Sampling -------------------------------------------------------------
  {
    const image = marker({ x: 0.5, y: 0.5 })
    const hit = samplePatch(image, { x: 0.5, y: 0.5 })
    ok(!!hit && hit[1] > 0.9, `the marker's own centre did not sample bright: ${hit?.[1]}`)
    ok(samplePatch(image, { x: 0.1, y: 0.1 })?.[1] === 0, 'empty frame did not sample black')
    ok(samplePatch(image, { x: 1.4, y: 0.5 }) === null, 'a point off the image sampled something')
    ok(samplePatch(image, { x: -0.01, y: 0.5 }) === null, 'a point before the image sampled something')
  }

  // --- The colour -----------------------------------------------------------
  // Balancing on a cast has to produce a gain that cancels it. Gain is
  // normalised on green, so the cast is cancelled when both ratios return to 1.
  {
    const image = marker({ x: 0.5, y: 0.5 })
    // Casts a real neutral surface can plausibly carry. Nothing more extreme,
    // because past a point the illuminant that would explain the patch is
    // outside 2000–50000K and the honest answer is the clamp, checked below.
    const casts: [number, number, number][] = [
      [1, 1, 1],
      [1.3, 1, 0.7],
      [0.75, 1, 1.35],
      [1.6, 1, 0.55],
      [0.7, 1, 1.5],
      [1.1, 1, 1.05],
    ]
    const corrected: Record<string, number[]> = {}
    for (const cast of casts) {
      const patch: [number, number, number] = [cast[0] * 0.4, cast[1] * 0.4, cast[2] * 0.4]
      const wp = whiteBalanceFromPatch(image, patch)
      if (!wp) {
        failures.push(`no white point for cast ${cast.join('/')}`)
        continue
      }
      const gain = whiteBalanceGain(image.asShot, wp)
      const r = (patch[0] * gain[0]) / (patch[1] * gain[1])
      const b = (patch[2] * gain[2]) / (patch[1] * gain[1])
      corrected[cast.join('/')] = [Math.round(r * 1e4) / 1e4, Math.round(b * 1e4) / 1e4]
      ok(
        Math.abs(r - 1) < 0.01 && Math.abs(b - 1) < 0.01,
        `cast ${cast.join('/')} was not cancelled: corrected to ${r.toFixed(3)}/1/${b.toFixed(3)} ` +
          `(temp ${Math.round(wp.temp)}K tint ${wp.tint.toFixed(1)})`,
      )
    }
    notes.corrected = corrected

    // A neutral patch must leave the photograph where the camera put it.
    const same = whiteBalanceFromPatch(image, [0.4, 0.4, 0.4])!
    ok(
      Math.abs(same.temp - image.asShot.temp) / image.asShot.temp < 0.02 &&
        Math.abs(same.tint - image.asShot.tint) < 2,
      `a neutral patch moved the white point to ${Math.round(same.temp)}K / ${same.tint.toFixed(1)}`,
    )

    // The Temp number is the *illuminant's* temperature, not the correction's:
    // a tungsten frame reads 2850K and is then corrected towards blue, which is
    // why `WB_PRESETS.tungsten` is the lowest number on the slider. So a
    // red-heavy patch — lit warm — has to read *low*, and a blue-heavy patch
    // high. Getting this backwards passes every symmetric test above, because
    // cancelling a cast says nothing about which way the label runs.
    const warm = whiteBalanceFromPatch(image, [0.5, 0.4, 0.28])!
    ok(
      warm.temp < image.asShot.temp,
      `a warm-lit patch read as ${Math.round(warm.temp)}K, which is not below the ${image.asShot.temp}K it was shot at`,
    )
    const cool = whiteBalanceFromPatch(image, [0.28, 0.4, 0.5])!
    ok(
      cool.temp > image.asShot.temp,
      `a cool-lit patch read as ${Math.round(cool.temp)}K, which is not above the ${image.asShot.temp}K it was shot at`,
    )

    // Past the end of the scale the answer is the end of the scale. A patch
    // this blue implies an illuminant hotter than any the model represents, and
    // pinning it there is better than wrapping, diverging, or refusing — the
    // photographer still gets most of the correction and can finish by hand.
    const beyond = whiteBalanceFromPatch(image, [0.24, 0.4, 0.68])!
    ok(
      beyond.temp === TEMP_MAX && Number.isFinite(beyond.tint),
      `an out-of-gamut patch settled on ${Math.round(beyond.temp)}K / ${beyond.tint.toFixed(1)} rather than the ${TEMP_MAX}K limit`,
    )

    // Nothing to say is better than something confident and meaningless.
    ok(whiteBalanceFromPatch(image, [0, 0, 0]) === null, 'black returned a white point')
    ok(whiteBalanceFromPatch(image, [1, 1, 1]) === null, 'a blown patch returned a white point')
    ok(whiteBalanceFromPatch(image, [0.3, 1, 0.3]) === null, 'a patch clipped in one channel returned a white point')
  }

  return { ok: failures.length === 0, pass: failures.length === 0, failures, ...notes }
}, { print: true })
