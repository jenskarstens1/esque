/**
 * IEEE 754 half-float codec.
 *
 * Half precision is the currency of the whole pipeline: the RAW worker hands
 * over linear ProPhoto as half-floats, `rgba16float` textures store them, and
 * readback returns them. Nothing along that path converts on your behalf —
 * `queue.writeTexture` copies bits verbatim and `Float16Array` is not yet
 * everywhere — so both directions live here, once, and every stage rounds the
 * same way. A value that survives the trip through the GPU has to survive the
 * trip through the CPU tone model as well, or auto-tone and the render
 * disagree about the picture they are looking at.
 */

// Single-threaded JS makes one shared reinterpretation buffer safe.
const bitsF32 = new Float32Array(1)
const bitsI32 = new Int32Array(bitsF32.buffer)

/**
 * float32 → half-float bit pattern, rounding to nearest.
 *
 * Subnormals and the rounding carry are handled rather than flushed, because
 * the LUTs uploaded through this land on values near zero often enough that
 * truncating them shows up as a step in the shadows.
 */
export function floatToHalf(val: number): number {
  bitsF32[0] = val
  const x = bitsI32[0]
  let bits = (x >> 16) & 0x8000
  let m = (x >> 12) & 0x07ff
  const e = (x >> 23) & 0xff
  if (e < 103) return bits
  if (e > 142) {
    bits |= 0x7c00
    bits |= (e === 255 ? 0 : 1) && x & 0x007fffff
    return bits
  }
  if (e < 113) {
    m |= 0x0800
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1)
    return bits
  }
  bits |= ((e - 112) << 10) | (m >> 1)
  bits += m & 1
  return bits
}

// Scale factor per normal exponent, so decoding costs a table lookup instead of
// a Math.pow — this runs once per channel per pixel when auto-tone builds its
// histogram. Index 0 is subnormal and 31 is inf/NaN; both are handled below.
const EXP_SCALE = new Float32Array(32)
for (let i = 1; i < 31; i++) EXP_SCALE[i] = Math.pow(2, i - 15)

/** Half-float bit pattern → float32. */
export function halfToFloat(bits: number): number {
  const s = bits & 0x8000 ? -1 : 1
  const e = (bits >> 10) & 0x1f
  const m = bits & 0x3ff
  if (e === 31) return m ? NaN : s * Infinity
  if (e === 0) return s * m * 5.960464477539063e-8 // subnormal: m * 2^-24
  return s * (1 + m * 9.765625e-4) * EXP_SCALE[e]
}

/** The half-float bit pattern for 1.0, the working space's reference white. */
export const HALF_ONE = 0x3c00
