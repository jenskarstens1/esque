/**
 * File-size-limited encoding.
 *
 * The old search bisected quality blindly: up to seven full-resolution encodes,
 * no use of what each probe revealed, and if even the floor quality overshot it
 * returned the oversized file with no indication that the limit had been missed.
 *
 * JPEG size against quality is smooth and monotonic, and `log(size)` is close to
 * linear in quality over the range anyone exports at. That makes it a root-find
 * rather than a search: two points fit the slope, and the third probe is usually
 * within a few percent of the ceiling. A bracket is maintained alongside the
 * model so a badly-behaved image degrades to bisection instead of diverging.
 *
 * The goal is not merely to fit under the ceiling — that is trivial — but to use
 * as much of it as possible, since every unused byte is quality thrown away.
 */

export interface SizeLimitResult {
  bytes: Uint8Array
  /** Quality the returned bytes were encoded at. */
  quality: number
  /** Number of encodes performed, including the first. */
  probes: number
  /** False when even {@link MIN_QUALITY} could not fit the ceiling. */
  met: boolean
}

/** Below this JPEG stops being a photograph, so the search refuses to go lower. */
const MIN_QUALITY = 20

/**
 * One initial encode plus at most five corrections.
 *
 * The budget matters because each probe is a full-size encode, so it trades
 * time against how much of the size budget ends up used. Measured on a 1.76 MP
 * frame, a cap of four left 58% of a 120 kB ceiling unspent — quality thrown
 * away for no reason — while six reaches 97% in five probes. The worst case is
 * still no worse than the blind bisection this replaced, which always ran
 * seven, and the common case where the requested quality already fits costs a
 * single encode.
 */
const MAX_PROBES = 6

/**
 * Stop once a probe uses at least this much of the budget. Anything above it is
 * within a couple of quality points of optimal and not worth another full-size
 * encode; anything below leaves visible quality unspent.
 */
const CLOSE_ENOUGH = 0.92

/**
 * Predictions aim slightly under the ceiling. A probe that lands just over is
 * wasted — it only narrows the bracket — whereas one that lands just under is
 * immediately usable as the answer, so it is worth biasing toward fitting.
 */
const SAFETY = 0.97

/**
 * Seed slope for `d(ln size)/d(quality)`, from the usual behaviour of halving
 * file size for every ~14 quality points. Only used for the second probe, before
 * there is enough data to measure the real slope.
 */
const SEED_SLOPE = 0.05

interface Probe {
  quality: number
  size: number
}

/**
 * Predicts the quality that lands on `target`, from the two probes closest to
 * it. Falls back to bisection whenever the fit is degenerate or out of bracket.
 */
function nextQuality(probes: Probe[], target: number, lo: number, hi: number): number {
  const mid = Math.round((lo + hi) / 2)
  if (!probes.length) return mid

  const sorted = [...probes].sort(
    (a, b) => Math.abs(Math.log(a.size / target)) - Math.abs(Math.log(b.size / target)),
  )
  const anchor = sorted[0]

  let slope = SEED_SLOPE
  const other = sorted.find((p) => p.quality !== anchor.quality && p.size > 0)
  if (other && anchor.size > 0) {
    const fitted =
      (Math.log(anchor.size) - Math.log(other.size)) / (anchor.quality - other.quality)
    // A non-positive slope means the encoder didn't behave monotonically here;
    // trusting it would send the prediction the wrong way.
    if (Number.isFinite(fitted) && fitted > 0.005) slope = fitted
  }

  const predicted = Math.round(anchor.quality + Math.log(target / anchor.size) / slope)
  if (!Number.isFinite(predicted) || predicted <= lo || predicted >= hi) return mid
  return predicted
}

/**
 * Encodes at `requested` quality and, if the result exceeds `ceiling` bytes,
 * walks quality down until it fits.
 *
 * `encode` must be pure with respect to quality — it is called several times
 * with the same pixels, so any resize or sharpening has to have happened first.
 */
export async function encodeToLimit(
  encode: (quality: number) => Promise<Uint8Array>,
  requested: number,
  ceiling: number,
): Promise<SizeLimitResult> {
  const start = Math.max(MIN_QUALITY, Math.min(100, Math.round(requested)))
  let probes = 1
  const firstBytes = await encode(start)
  if (firstBytes.length <= ceiling) {
    return { bytes: firstBytes, quality: start, probes, met: true }
  }

  const history: Probe[] = [{ quality: start, size: firstBytes.length }]
  let lo = MIN_QUALITY - 1
  let hi = start

  // Largest result that fits, and the smallest seen overall as a fallback for
  // images that cannot be squeezed under the ceiling at any usable quality.
  let best: { bytes: Uint8Array; quality: number } | null = null
  let smallest = { bytes: firstBytes, quality: start }

  while (probes < MAX_PROBES && hi - lo > 1) {
    const q = nextQuality(history, ceiling * SAFETY, lo, hi)
    if (q <= lo || q >= hi) break

    const bytes = await encode(q)
    probes++
    history.push({ quality: q, size: bytes.length })
    if (bytes.length < smallest.bytes.length) smallest = { bytes, quality: q }

    if (bytes.length <= ceiling) {
      if (!best || bytes.length > best.bytes.length) best = { bytes, quality: q }
      lo = q
      if (bytes.length >= ceiling * CLOSE_ENOUGH) break
    } else {
      hi = q
    }
  }

  if (best) return { bytes: best.bytes, quality: best.quality, probes, met: true }

  // Nothing fit, and the search may have run out of budget before reaching the
  // floor. One last encode there is worth it: it is the only quality that can
  // still turn a miss into a hit, and otherwise gives the caller the smallest
  // file the encoder is willing to produce.
  if (lo < MIN_QUALITY && history.every((p) => p.quality !== MIN_QUALITY)) {
    const bytes = await encode(MIN_QUALITY)
    probes++
    if (bytes.length <= ceiling) {
      return { bytes, quality: MIN_QUALITY, probes, met: true }
    }
    if (bytes.length < smallest.bytes.length) smallest = { bytes, quality: MIN_QUALITY }
  }

  return { bytes: smallest.bytes, quality: smallest.quality, probes, met: false }
}
