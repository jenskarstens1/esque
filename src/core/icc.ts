/**
 * ICC profile reader, for files that arrive already colour-managed.
 *
 * esque's own 16-bit exports carry a profile — a ProPhoto TIFF is written with
 * a gamma 1.8 curve and ProPhoto colorants — and so does anything that came out
 * of Lightroom, Capture One or Photoshop. Reading a deep file back while
 * assuming sRGB is not a rounding error: a linear 0.25 written as ProPhoto and
 * read as sRGB comes back as 0.181, three quarters of a stop dark and the wrong
 * hue in anything saturated. Round-tripping your own export has to be exact.
 *
 * The scope is the matrix/shaper profile, which is what every RGB working space
 * in practice is: three colorant tags and three tone curves. A LUT-based
 * profile (a printer or a camera characterisation) is refused rather than
 * approximated — the caller then falls back to assuming sRGB, which is what it
 * would have done anyway.
 *
 * The colorant tags are, by specification, already adapted to the D50 profile
 * connection space, so no chromatic adaptation is applied here. The `chad` tag
 * records the adaptation that was performed, and re-applying it would move the
 * white a second time.
 */
import type { Mat3 } from './color'

export interface SourceProfile {
  /** Source RGB → XYZ under the D50 profile connection space white. */
  toXyzD50: Mat3
  /**
   * Encoded device value in [0,1] → linear, per channel.
   *
   * Three curves rather than one because a matrix/shaper profile is entitled
   * to give each channel its own, and several real ones do. Applying red's to
   * all three would decode such a file to the wrong colour while reporting
   * success.
   */
  toLinear: [(v: number) => number, (v: number) => number, (v: number) => number]
}

const sig = (b: Uint8Array, o: number) =>
  String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3])

const u32 = (b: Uint8Array, o: number) =>
  ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0

const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1]

/** ICC's fixed-point number: a signed 15.16, big-endian. */
const s15f16 = (b: Uint8Array, o: number) => (u32(b, o) | 0) / 65536

/** The identity, for a profile whose curve says "already linear". */
const LINEAR = (v: number) => v

function profileTags(bytes: Uint8Array): Map<string, Uint8Array> | null {
  if (bytes.length < 132 || sig(bytes, 16) !== 'RGB ') return null
  const pcs = sig(bytes, 20)
  if (pcs !== 'XYZ ' && pcs !== 'Lab ') return null

  const count = u32(bytes, 128)
  if (!count || count > 128 || 132 + count * 12 > bytes.length) return null

  const tags = new Map<string, Uint8Array>()
  for (let index = 0; index < count; index++) {
    const entry = 132 + index * 12
    const offset = u32(bytes, entry + 4)
    const size = u32(bytes, entry + 8)
    if (offset + size > bytes.length || size < 8) continue
    tags.set(sig(bytes, entry), bytes.subarray(offset, offset + size))
  }
  return tags
}

function profileMatrix(tags: Map<string, Uint8Array>): Mat3 | null {
  const red = colorant(tags.get('rXYZ'))
  const green = colorant(tags.get('gXYZ'))
  const blue = colorant(tags.get('bXYZ'))
  if (!red || !green || !blue) return null

  const matrix: Mat3 = [
    red[0], green[0], blue[0],
    red[1], green[1], blue[1],
    red[2], green[2], blue[2],
  ]
  const determinant = det3(matrix)
  return isFinite(determinant) && Math.abs(determinant) >= 1e-9 ? matrix : null
}

function profileCurves(
  tags: Map<string, Uint8Array>,
): SourceProfile['toLinear'] | null {
  const grey = curve(tags.get('kTRC'))
  const red = curve(tags.get('rTRC')) ?? grey
  const green = curve(tags.get('gTRC')) ?? grey
  const blue = curve(tags.get('bTRC')) ?? grey
  return red && green && blue ? [red, green, blue] : null
}

/**
 * Reads a matrix/shaper profile, or returns null for anything else.
 *
 * Null is not an error: it means "this profile cannot be honoured exactly", and
 * the caller has a documented fallback.
 */
export function parseIccProfile(bytes: Uint8Array): SourceProfile | null {
  const tags = profileTags(bytes)
  if (!tags) return null
  const toXyzD50 = profileMatrix(tags)
  const toLinear = profileCurves(tags)
  if (!toXyzD50 || !toLinear) return null
  return { toXyzD50, toLinear }
}

function det3(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  )
}

/** An 'XYZ ' tag: a type signature, four reserved bytes, then one XYZ triple. */
function colorant(tag: Uint8Array | undefined): [number, number, number] | null {
  if (!tag || tag.length < 20 || sig(tag, 0) !== 'XYZ ') return null
  return [s15f16(tag, 8), s15f16(tag, 12), s15f16(tag, 16)]
}

/** A 'curv' or 'para' tone reproduction curve, as a decoding function. */
function curve(tag: Uint8Array | undefined): ((v: number) => number) | null {
  if (!tag || tag.length < 12) return null
  const type = sig(tag, 0)
  if (type === 'curv') return curvType(tag)
  if (type === 'para') return paraType(tag)
  return null
}

function curvType(tag: Uint8Array): ((v: number) => number) | null {
  const n = u32(tag, 8)
  // Zero entries is the spec's way of writing the identity.
  if (n === 0) return LINEAR
  // One entry is a pure power curve, stored as u8Fixed8.
  if (n === 1) {
    if (tag.length < 14) return null
    const gamma = u16(tag, 12) / 256
    if (!(gamma > 0)) return null
    return (v) => (v <= 0 ? 0 : Math.pow(v, gamma))
  }
  if (tag.length < 12 + n * 2) return null
  // A sampled curve, interpolated. Written by anything whose transfer has a
  // linear toe — sRGB and Rec. 709 both do — which no power curve can express.
  const table = new Float32Array(n)
  for (let i = 0; i < n; i++) table[i] = u16(tag, 12 + i * 2) / 65535
  return (v) => {
    if (v <= 0) return table[0]
    if (v >= 1) return table[n - 1]
    const x = v * (n - 1)
    const i = Math.floor(x)
    const f = x - i
    return table[i] + (table[Math.min(n - 1, i + 1)] - table[i]) * f
  }
}

/** Parametric curve types 0–4 from ICC.1:2010, table 65. */
function paraType(tag: Uint8Array): ((v: number) => number) | null {
  const fn = u16(tag, 8)
  const need = [1, 3, 4, 5, 7][fn]
  if (need === undefined || tag.length < 12 + need * 4) return null
  const p: number[] = []
  for (let i = 0; i < need; i++) p.push(s15f16(tag, 12 + i * 4))
  const [g, a, b, c, d, e, f] = p

  if (fn === 0) return (v) => (v <= 0 ? 0 : Math.pow(v, g))
  if (fn === 1) {
    if (a === 0) return null
    return (v) => (v >= -b / a ? Math.pow(a * v + b, g) : 0)
  }
  if (fn === 2) {
    if (a === 0) return null
    return (v) => (v >= -b / a ? Math.pow(a * v + b, g) + c : c)
  }
  // Type 3 is the sRGB shape: a power segment above the join and a straight
  // line below it, which is exactly what the toe exists for.
  if (fn === 3) return (v) => (v >= d ? Math.pow(a * v + b, g) : c * v)
  return (v) => (v >= d ? Math.pow(a * v + b, g) + e : c * v + f)
}

/**
 * Builds a profile from PNG's own colour chunks.
 *
 * A PNG may describe itself with `gAMA` and `cHRM` instead of carrying an ICC
 * profile, and those are cheap to honour once the ICC path exists.
 */
export function profileFromChromaticities(
  gamma: number | null,
  chrm: { wx: number; wy: number; rx: number; ry: number; gx: number; gy: number; bx: number; by: number } | null,
  srgbPrimaries: Mat3,
): SourceProfile | null {
  if (gamma === null && !chrm) return null
  const toXyz = chrm ? primariesToXyzD50(chrm) : srgbPrimaries
  if (!toXyz) return null
  // `gAMA` stores the *encoding* exponent, so decoding is its reciprocal.
  const exp = gamma && gamma > 0 ? 1 / gamma : null
  // PNG has one gamma for the whole image, so all three channels share it.
  const f = exp === null ? LINEAR : (v: number) => (v <= 0 ? 0 : Math.pow(v, exp))
  return { toXyzD50: toXyz, toLinear: [f, f, f] }
}

const BRADFORD: Mat3 = [
  0.8951, 0.2664, -0.1614,
  -0.7502, 1.7135, 0.0367,
  0.0389, -0.0685, 1.0296,
]

const D50_XYZ: [number, number, number] = [0.9642, 1, 0.8249]

/** Chromaticities to an RGB → XYZ matrix, Bradford-adapted to the D50 PCS. */
function primariesToXyzD50(c: {
  wx: number; wy: number; rx: number; ry: number
  gx: number; gy: number; bx: number; by: number
}): Mat3 | null {
  const xyz = (x: number, y: number): [number, number, number] =>
    y === 0 ? [0, 0, 0] : [x / y, 1, (1 - x - y) / y]
  const R = xyz(c.rx, c.ry)
  const G = xyz(c.gx, c.gy)
  const B = xyz(c.bx, c.by)
  const W = xyz(c.wx, c.wy)
  const base: Mat3 = [R[0], G[0], B[0], R[1], G[1], B[1], R[2], G[2], B[2]]
  const inv = inverse3(base)
  if (!inv) return null
  const s = apply(inv, W)
  const scaled: Mat3 = [
    R[0] * s[0], G[0] * s[1], B[0] * s[2],
    R[1] * s[0], G[1] * s[1], B[1] * s[2],
    R[2] * s[0], G[2] * s[1], B[2] * s[2],
  ]
  const adapt = bradford(W, D50_XYZ)
  return adapt ? multiply(adapt, scaled) : null
}

function bradford(from: [number, number, number], to: [number, number, number]): Mat3 | null {
  const src = apply(BRADFORD, from)
  const dst = apply(BRADFORD, to)
  if (!src[0] || !src[1] || !src[2]) return null
  const scale: Mat3 = [dst[0] / src[0], 0, 0, 0, dst[1] / src[1], 0, 0, 0, dst[2] / src[2]]
  const inv = inverse3(BRADFORD)
  return inv ? multiply(multiply(inv, scale), BRADFORD) : null
}

function apply(m: Mat3, v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ]
}

function multiply(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
    }
  }
  return out as Mat3
}

function inverse3(m: Mat3): Mat3 | null {
  const d = det3(m)
  if (!isFinite(d) || Math.abs(d) < 1e-12) return null
  return [
    (m[4] * m[8] - m[5] * m[7]) / d,
    (m[2] * m[7] - m[1] * m[8]) / d,
    (m[1] * m[5] - m[2] * m[4]) / d,
    (m[5] * m[6] - m[3] * m[8]) / d,
    (m[0] * m[8] - m[2] * m[6]) / d,
    (m[2] * m[3] - m[0] * m[5]) / d,
    (m[3] * m[7] - m[4] * m[6]) / d,
    (m[1] * m[6] - m[0] * m[7]) / d,
    (m[0] * m[4] - m[1] * m[3]) / d,
  ]
}
