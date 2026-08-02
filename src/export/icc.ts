/**
 * Minimal ICC v2 matrix-shaper profile generator.
 *
 * Exporting Display P3 or ProPhoto pixels without a profile is worse than not
 * offering the option at all — every viewer would treat them as sRGB and show
 * wrong colour. Real profiles are a few hundred bytes when you only need the
 * matrix-shaper tags, so we build them here rather than shipping binaries.
 *
 * Tags written: desc, wtpt, cprt, rXYZ/gXYZ/bXYZ, rTRC/gTRC/bTRC (+ chad).
 * That is the complete required set for an RGB display profile.
 */
import type { OutputSpace } from '../gpu/colorspace'

// --- primitives -------------------------------------------------------------

const s15f16 = (v: number) => Math.round(v * 65536)

class Writer {
  private buf: number[] = []
  u8(v: number) {
    this.buf.push(v & 0xff)
    return this
  }
  u16(v: number) {
    return this.u8(v >> 8).u8(v)
  }
  u32(v: number) {
    return this.u16((v >>> 16) & 0xffff).u16(v & 0xffff)
  }
  i32(v: number) {
    return this.u32(v >>> 0)
  }
  ascii(s: string) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i))
    return this
  }
  pad(n: number) {
    while (n-- > 0) this.u8(0)
    return this
  }
  align4() {
    while (this.buf.length % 4) this.u8(0)
    return this
  }
  get length() {
    return this.buf.length
  }
  bytes() {
    return new Uint8Array(this.buf)
  }
}

// --- colour science ---------------------------------------------------------

type XY = [number, number]

interface SpaceSpec {
  name: string
  red: XY
  green: XY
  blue: XY
  white: XY
  /**
   * The transfer function the output shader actually writes, which is what the
   * profile has to describe — not whatever the standard nominally specifies.
   * A number is a pure power curve; 'srgb' is the piecewise curve, which gets
   * sampled because a power curve is visibly wrong in the deep shadows.
   */
  trc: number | 'srgb'
}

const D65: XY = [0.3127, 0.329]
const D50: XY = [0.3457, 0.3585]

const SPACES: Record<OutputSpace, SpaceSpec> = {
  srgb: {
    name: 'sRGB',
    red: [0.64, 0.33],
    green: [0.3, 0.6],
    blue: [0.15, 0.06],
    white: D65,
    trc: 'srgb',
  },
  'display-p3': {
    name: 'Display P3',
    red: [0.68, 0.32],
    green: [0.265, 0.69],
    blue: [0.15, 0.06],
    white: D65,
    trc: 'srgb',
  },
  'adobe-rgb': {
    name: 'Adobe RGB (1998)',
    red: [0.64, 0.33],
    green: [0.21, 0.71],
    blue: [0.15, 0.06],
    white: D65,
    trc: 2.19921875,
  },
  prophoto: {
    name: 'ProPhoto RGB',
    red: [0.7347, 0.2653],
    green: [0.1596, 0.8404],
    blue: [0.0366, 0.0001],
    white: D50,
    trc: 1.8,
  },
  rec2020: {
    name: 'Rec. 2020',
    red: [0.708, 0.292],
    green: [0.17, 0.797],
    blue: [0.131, 0.046],
    white: D65,
    trc: 'srgb',
  },
}

const xyToXYZ = ([x, y]: XY): [number, number, number] => [x / y, 1, (1 - x - y) / y]

function invert3(m: number[][]): number[][] {
  const [[a, b, c], [d, e, f], [g, h, i]] = m
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ]
}

const mul3 = (m: number[][], v: number[]) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2])
const mulM = (a: number[][], b: number[][]) =>
  a.map((r) => b[0].map((_, j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]))

/** RGB -> XYZ for the profile's own white point. */
function rgbToXYZ(spec: SpaceSpec): number[][] {
  const R = xyToXYZ(spec.red)
  const G = xyToXYZ(spec.green)
  const B = xyToXYZ(spec.blue)
  const W = xyToXYZ(spec.white)
  const S = mul3(invert3([
    [R[0], G[0], B[0]],
    [R[1], G[1], B[1]],
    [R[2], G[2], B[2]],
  ]), W)
  return [
    [R[0] * S[0], G[0] * S[1], B[0] * S[2]],
    [R[1] * S[0], G[1] * S[1], B[1] * S[2]],
    [R[2] * S[0], G[2] * S[1], B[2] * S[2]],
  ]
}

const BRADFORD = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
]

/** Bradford adaptation matrix, since ICC PCS is always D50. */
function chromaticAdaptation(from: XY, to: XY): number[][] {
  const src = mul3(BRADFORD, xyToXYZ(from))
  const dst = mul3(BRADFORD, xyToXYZ(to))
  const scale = [
    [dst[0] / src[0], 0, 0],
    [0, dst[1] / src[1], 0],
    [0, 0, dst[2] / src[2]],
  ]
  return mulM(mulM(invert3(BRADFORD), scale), BRADFORD)
}

// --- profile ----------------------------------------------------------------

interface Tag {
  sig: string
  data: Uint8Array
}

function textTag(text: string): Uint8Array {
  // 'desc' in ICC v2 is a multi-part descriptor; only the ASCII part matters
  // to every real-world consumer, so the Unicode and script parts stay empty.
  const w = new Writer()
  w.ascii('desc').u32(0)
  w.u32(text.length + 1).ascii(text).u8(0)
  w.u32(0).u32(0) // unicode language code + count
  w.u16(0).u8(0) // script code + count
  w.pad(67)
  return w.bytes()
}

function copyrightTag(text: string): Uint8Array {
  const w = new Writer()
  w.ascii('text').u32(0).ascii(text).u8(0)
  return w.bytes()
}

function xyzTag(v: number[]): Uint8Array {
  const w = new Writer()
  w.ascii('XYZ ').u32(0)
  for (const c of v) w.i32(s15f16(c))
  return w.bytes()
}

/** Device value -> linear, i.e. the decoding direction a matrix-shaper wants. */
const srgbToLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4

function curveTag(trc: number | 'srgb'): Uint8Array {
  const w = new Writer()
  w.ascii('curv').u32(0)
  if (typeof trc === 'number') {
    // One u8Fixed8 entry is the compact "pure power curve" form.
    return w.u32(1).u16(Math.round(trc * 256)).bytes()
  }
  // 1024 samples put the quantisation error below a 16-bit LSB everywhere,
  // including the linear toe that a power curve gets badly wrong near black.
  const n = 1024
  w.u32(n)
  for (let i = 0; i < n; i++) {
    w.u16(Math.round(srgbToLinear(i / (n - 1)) * 65535))
  }
  return w.bytes()
}

function s15Fixed16Array(m: number[][]): Uint8Array {
  const w = new Writer()
  w.ascii('sf32').u32(0)
  for (const row of m) for (const v of row) w.i32(s15f16(v))
  return w.bytes()
}

const cache = new Map<OutputSpace, Uint8Array>()

/** Builds (and memoises) an ICC v2 profile for one of our output spaces. */
export function iccProfile(space: OutputSpace): Uint8Array {
  const hit = cache.get(space)
  if (hit) return hit

  const spec = SPACES[space]
  const toXYZ = rgbToXYZ(spec)
  const adapt = chromaticAdaptation(spec.white, D50)
  const m = mulM(adapt, toXYZ)

  const tags: Tag[] = [
    { sig: 'desc', data: textTag(`esque ${spec.name}`) },
    { sig: 'wtpt', data: xyzTag(xyToXYZ(D50)) },
    { sig: 'cprt', data: copyrightTag('Public Domain') },
    { sig: 'chad', data: s15Fixed16Array(adapt) },
    { sig: 'rXYZ', data: xyzTag([m[0][0], m[1][0], m[2][0]]) },
    { sig: 'gXYZ', data: xyzTag([m[0][1], m[1][1], m[2][1]]) },
    { sig: 'bXYZ', data: xyzTag([m[0][2], m[1][2], m[2][2]]) },
    { sig: 'rTRC', data: curveTag(spec.trc) },
  ]
  // The three TRCs are identical, so they share one tag element — standard
  // practice and what every shipping profile does.
  tags.push({ sig: 'gTRC', data: tags[7].data })
  tags.push({ sig: 'bTRC', data: tags[7].data })

  const headerSize = 128
  const tableSize = 4 + tags.length * 12
  const offsets: number[] = []
  let cursor = headerSize + tableSize
  const seen = new Map<Uint8Array, number>()
  const blocks: Uint8Array[] = []
  for (const tag of tags) {
    const shared = seen.get(tag.data)
    if (shared !== undefined) {
      offsets.push(shared)
      continue
    }
    offsets.push(cursor)
    seen.set(tag.data, cursor)
    blocks.push(tag.data)
    cursor += tag.data.length + ((4 - (tag.data.length % 4)) % 4)
  }
  const total = cursor

  const h = new Writer()
  h.u32(total)
  h.ascii('esqe') // preferred CMM
  h.u32(0x02400000) // version 2.4
  h.ascii('mntr').ascii('RGB ').ascii('XYZ ')
  const now = new Date()
  h.u16(now.getUTCFullYear()).u16(now.getUTCMonth() + 1).u16(now.getUTCDate())
  h.u16(now.getUTCHours()).u16(now.getUTCMinutes()).u16(now.getUTCSeconds())
  h.ascii('acsp')
  h.u32(0) // platform
  h.u32(0) // flags
  h.u32(0).u32(0) // device manufacturer + model
  h.u32(0).u32(0) // device attributes
  h.u32(0) // rendering intent: perceptual
  const pcs = xyToXYZ(D50)
  h.i32(s15f16(pcs[0])).i32(s15f16(pcs[1])).i32(s15f16(pcs[2]))
  h.u32(0) // profile creator
  h.pad(headerSize - h.length)

  const out = new Uint8Array(total)
  out.set(h.bytes(), 0)

  const t = new Writer()
  t.u32(tags.length)
  tags.forEach((tag, i) => {
    t.ascii(tag.sig).u32(offsets[i]).u32(tag.data.length)
  })
  out.set(t.bytes(), headerSize)

  let at = headerSize + tableSize
  for (const block of blocks) {
    out.set(block, at)
    at += block.length + ((4 - (block.length % 4)) % 4)
  }

  cache.set(space, out)
  return out
}
