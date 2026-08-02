import type { CurvePoint, ParametricCurve } from '../core/types'

export const LUT_SIZE = 256

/**
 * Monotone cubic (Fritsch–Carlson) interpolation through the control points.
 * Natural cubic splines overshoot on steep curves and produce visible tone
 * reversals; monotone cubic can't.
 */
export function splineLut(points: CurvePoint[], size = LUT_SIZE): Float32Array {
  const out = new Float32Array(size)
  const pts = [...points].sort((a, b) => a.x - b.x)

  if (pts.length < 2) {
    for (let i = 0; i < size; i++) out[i] = i / (size - 1)
    return out
  }

  const n = pts.length
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)

  const dx: number[] = []
  const slope: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const h = Math.max(1e-6, xs[i + 1] - xs[i])
    dx.push(h)
    slope.push((ys[i + 1] - ys[i]) / h)
  }

  // Tangents: average of neighbouring slopes, zeroed at local extrema.
  const m = new Array<number>(n)
  m[0] = slope[0]
  m[n - 1] = slope[n - 2]
  for (let i = 1; i < n - 1; i++) {
    m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2
  }
  // Fritsch–Carlson limiter keeps the interpolant monotone.
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0
      m[i + 1] = 0
      continue
    }
    const a = m[i] / slope[i]
    const b = m[i + 1] / slope[i]
    const s = a * a + b * b
    if (s > 9) {
      const t = 3 / Math.sqrt(s)
      m[i] = t * a * slope[i]
      m[i + 1] = t * b * slope[i]
    }
  }

  let seg = 0
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1)
    if (x <= xs[0]) {
      out[i] = ys[0]
      continue
    }
    if (x >= xs[n - 1]) {
      out[i] = ys[n - 1]
      continue
    }
    while (seg < n - 2 && x > xs[seg + 1]) seg++
    const h = dx[seg]
    const t = (x - xs[seg]) / h
    const t2 = t * t
    const t3 = t2 * t
    const h00 = 2 * t3 - 3 * t2 + 1
    const h10 = t3 - 2 * t2 + t
    const h01 = -2 * t3 + 3 * t2
    const h11 = t3 - t2
    out[i] = h00 * ys[seg] + h10 * h * m[seg] + h01 * ys[seg + 1] + h11 * h * m[seg + 1]
  }

  for (let i = 0; i < size; i++) out[i] = Math.min(1, Math.max(0, out[i]))
  return out
}

/** Smooth hump centred on a region, falling to zero at its neighbours. */
function hump(x: number, lo: number, hi: number): number {
  if (x <= lo || x >= hi) return 0
  const t = (x - lo) / (hi - lo)
  return Math.sin(Math.PI * t) ** 2
}

/**
 * The parametric curve: four region sliders bounded by three split points,
 * exactly like Lightroom's. Output is guaranteed monotone.
 */
export function parametricLut(p: ParametricCurve, size = LUT_SIZE): Float32Array {
  const out = new Float32Array(size)
  const s0 = Math.max(0.02, Math.min(0.48, p.shadowSplit))
  const s1 = Math.max(s0 + 0.04, Math.min(0.96, p.midtoneSplit))
  const s2 = Math.max(s1 + 0.04, Math.min(0.98, p.highlightSplit))

  const k = 0.28
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1)
    let y = x
    y += (p.shadows / 100) * k * hump(x, -s0, s1 - (s1 - s0) * 0.5)
    y += (p.darks / 100) * k * hump(x, 0, s1 + (s2 - s1) * 0.35)
    y += (p.lights / 100) * k * hump(x, s0 * 0.5, s2 + (1 - s2) * 0.65)
    y += (p.highlights / 100) * k * hump(x, s1 + (s2 - s1) * 0.5, 2 - s2)
    out[i] = Math.min(1, Math.max(0, y))
  }

  // Enforce monotonicity — overlapping humps at extreme settings can invert.
  for (let i = 1; i < size; i++) out[i] = Math.max(out[i], out[i - 1])
  return out
}

export const isIdentityPoints = (pts: CurvePoint[]) =>
  pts.length === 2 &&
  pts[0].x === 0 &&
  pts[0].y === 0 &&
  pts[1].x === 1 &&
  pts[1].y === 1

export const isIdentityParametric = (p: ParametricCurve) =>
  p.highlights === 0 && p.lights === 0 && p.darks === 0 && p.shadows === 0

/** Samples a LUT with linear interpolation — used for the curve editor UI. */
export function sampleLut(lut: Float32Array, x: number): number {
  const t = Math.max(0, Math.min(1, x)) * (lut.length - 1)
  const i = Math.floor(t)
  const f = t - i
  return lut[i] * (1 - f) + lut[Math.min(lut.length - 1, i + 1)] * f
}

/** Composes b(a(x)) so the parametric and point curves stack into one LUT. */
export function composeLut(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = sampleLut(b, a[i])
  return out
}
