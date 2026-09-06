/**
 * Turning a working-space proxy into something a segmentation network expects.
 *
 * These models were trained on ordinary photographs: 8-bit sRGB, gamma
 * encoded, exposed the way a camera or a phone would have exposed them. What
 * esque has instead is scene-linear ProPhoto half-float straight off the
 * demosaic, which is a different picture in three separate ways. Hand that to
 * U²-Net unconverted and it sees a dim, green-cast, low-contrast frame and
 * returns a correspondingly vague mask — the failure looks like a bad model
 * rather than a bad input, which is what makes it worth spelling out here.
 *
 * So three conversions happen, in order:
 *
 * 1. **Scale.** A box average down to the network's square. Averaging rather
 *    than sampling matters more than it looks: a 40 MP frame reduced to 320 px
 *    by nearest-neighbour aliases fine detail into noise, and hair and foliage
 *    are exactly where the mask is judged.
 *
 * 2. **Exposure.** RAW files are not normalised — a frame exposed to protect
 *    highlights can sit two stops below the working white with nothing near
 *    1.0. Rather than trusting the file, a high percentile of the luminance is
 *    measured and mapped to white, so an underexposed frame and a bright one
 *    reach the network looking equally like photographs. This is the single
 *    change that most affects whether detection works on real RAWs.
 *
 * 3. **Colour.** ProPhoto D50 linear to sRGB D65, then the sRGB transfer
 *    function, because that is the encoding the training data was in.
 *
 * The result is stretched to a square rather than letterboxed, which is what
 * these networks' own preprocessing does. It distorts the aspect, but it is the
 * distortion they were trained under, and the mask comes back in the same
 * normalised coordinates it went out in — so the stretch cancels exactly when
 * the alpha is sampled over the source.
 */
import { PROPHOTO_D50_TO_SRGB_D65 } from '../core/color'
import { halfToFloat } from '../core/half'
import { MODEL_MEAN, MODEL_STD } from './models'

/** The pixels the preparation needs; a `SourceImage` satisfies it. */
export interface PrepareSource {
  width: number
  height: number
  /** RGBA half-float bit patterns, scene-linear ProPhoto D50. */
  data: Uint16Array
}

/**
 * Every half-float bit pattern, decoded once.
 *
 * A 24 MP proxy is 72 million channel reads. `halfToFloat` is cheap but not
 * free, and a 128 KB table turns each one into an array index — which takes the
 * downsample from something you notice to something you do not.
 */
let decodeTable: Float32Array | null = null

function halfTable(): Float32Array {
  if (decodeTable) return decodeTable
  const t = new Float32Array(65536)
  for (let i = 0; i < 65536; i++) {
    const v = halfToFloat(i)
    // NaN and infinities come off clipped sensors; clamping here keeps them
    // from poisoning an entire box average further down.
    t[i] = Number.isFinite(v) ? v : 0
  }
  decodeTable = t
  return t
}

/** Linear sRGB component to the sRGB transfer function. */
function encodeSrgb(v: number): number {
  if (v <= 0) return 0
  if (v >= 1) return 1
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

/**
 * Resamples the proxy to `size` × `size` of linear sRGB.
 *
 * Two paths, because the proxy is not always the larger of the two. A 320 px
 * network gets a box average, walking the source once and accumulating into the
 * cell each pixel falls in, so cost tracks the proxy rather than the square. A
 * 1024 px network asking for more pixels than the proxy has gets bilinear
 * interpolation instead: scattering upward would leave most destination cells
 * with nothing written to them, and those cells read back as black — a grid of
 * holes through the tensor, which the network reads as structure that isn't
 * there.
 */
function reduceToSquare(src: PrepareSource, size: number): Float32Array {
  const { width, height, data } = src
  const table = halfTable()
  const m = PROPHOTO_D50_TO_SRGB_D65
  const out = new Float32Array(size * size * 3)

  // Written into by both paths, to keep the matrix in one place.
  const toSrgb = (r: number, g: number, b: number, o: number, w = 1) => {
    out[o] += (m[0] * r + m[1] * g + m[2] * b) * w
    out[o + 1] += (m[3] * r + m[4] * g + m[5] * b) * w
    out[o + 2] += (m[6] * r + m[7] * g + m[8] * b) * w
  }

  if (width < size || height < size) {
    const xScale = width / size
    const yScale = height / size
    for (let dy = 0; dy < size; dy++) {
      // Sample at cell centres, so the resample does not drift half a pixel.
      const sy = Math.min(height - 1, Math.max(0, (dy + 0.5) * yScale - 0.5))
      const y0 = Math.floor(sy)
      const y1 = Math.min(height - 1, y0 + 1)
      const fy = sy - y0
      for (let dx = 0; dx < size; dx++) {
        const sx = Math.min(width - 1, Math.max(0, (dx + 0.5) * xScale - 0.5))
        const x0 = Math.floor(sx)
        const x1 = Math.min(width - 1, x0 + 1)
        const fx = sx - x0
        const o = (dy * size + dx) * 3
        const corners = [
          [x0, y0, (1 - fx) * (1 - fy)],
          [x1, y0, fx * (1 - fy)],
          [x0, y1, (1 - fx) * fy],
          [x1, y1, fx * fy],
        ]
        for (const [cx, cy, w] of corners) {
          if (w <= 0) continue
          const i = (cy * width + cx) * 4
          toSrgb(table[data[i]], table[data[i + 1]], table[data[i + 2]], o, w)
        }
      }
    }
    return out
  }

  const count = new Float64Array(size * size)

  // Precomputed column bucket, so the inner loop is not doing a divide per pixel.
  const colBucket = new Int32Array(width)
  for (let x = 0; x < width; x++) {
    colBucket[x] = Math.min(size - 1, Math.floor((x * size) / width))
  }

  for (let y = 0; y < height; y++) {
    const row = Math.min(size - 1, Math.floor((y * size) / height))
    const rowBase = row * size
    let i = y * width * 4
    for (let x = 0; x < width; x++, i += 4) {
      // ProPhoto D50 → sRGB D65 while still linear. Out-of-gamut colours go
      // negative here; they are clamped after the exposure scale so the
      // percentile still sees the real distribution.
      const cell = rowBase + colBucket[x]
      toSrgb(table[data[i]], table[data[i + 1]], table[data[i + 2]], cell * 3)
      count[cell] += 1
    }
  }

  for (let c = 0; c < size * size; c++) {
    const n = count[c] || 1
    const o = c * 3
    out[o] /= n
    out[o + 1] /= n
    out[o + 2] /= n
  }
  return out
}

/**
 * The scale that puts the frame's highlights at white.
 *
 * A high percentile rather than the maximum, so one clipped specular or a hot
 * pixel does not decide the exposure for the whole frame. The result is
 * clamped to a sane range in both directions: a photograph that is genuinely
 * dark — a night shot, a low-key portrait — should still read as dark, and
 * scaling it to a mid-grey average would tell the network something false
 * about the scene.
 */
function whiteScale(rgb: Float32Array): number {
  const n = rgb.length / 3
  const luma = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * 3
    luma[i] = 0.2126 * rgb[o] + 0.7152 * rgb[o + 1] + 0.0722 * rgb[o + 2]
  }
  const sorted = luma.slice().sort()
  const peak = sorted[Math.min(n - 1, Math.floor(n * 0.995))]
  if (!(peak > 1e-6)) return 1
  return Math.min(Math.max(1 / peak, 0.25), 16)
}

/**
 * A prepared NCHW float32 tensor, ready to hand to the session.
 *
 * `divideByMax` reproduces U²-Net's own preprocessing, which normalises the
 * image by its maximum before the ImageNet statistics. BiRefNet was trained
 * without it. Getting this wrong does not throw — it just quietly returns a
 * worse mask — so it travels with the model in the registry rather than being
 * decided here.
 */
export function prepareInput(
  src: PrepareSource,
  size: number,
  divideByMax: boolean,
): Float32Array {
  const rgb = reduceToSquare(src, size)
  const scale = whiteScale(rgb)

  const n = size * size
  const encoded = new Float32Array(n * 3)
  let max = 0
  for (let i = 0; i < n * 3; i++) {
    const v = encodeSrgb(rgb[i] * scale)
    encoded[i] = v
    if (v > max) max = v
  }

  const norm = divideByMax && max > 1e-6 ? 1 / max : 1

  // NCHW: the whole red plane, then green, then blue.
  const tensor = new Float32Array(3 * n)
  for (let c = 0; c < 3; c++) {
    const mean = MODEL_MEAN[c]
    const std = MODEL_STD[c]
    const plane = c * n
    for (let i = 0; i < n; i++) {
      tensor[plane + i] = (encoded[i * 3 + c] * norm - mean) / std
    }
  }
  return tensor
}

/**
 * Rescales a raw prediction to a usable 0..1 alpha.
 *
 * Both families emit an unbounded saliency map rather than a probability, so
 * the reference implementations stretch min to max before using it — without
 * that a confident mask and a hesitant one come back at different overall
 * strengths and the same Refine setting means two different things. A flat
 * prediction, which is what an empty frame produces, is returned as zero
 * instead of being stretched into noise.
 */
export function normalizeAlpha(pred: Float32Array): Float32Array {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < pred.length; i++) {
    const v = pred[i]
    if (!Number.isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  const out = new Float32Array(pred.length)
  const span = max - min
  if (!(span > 1e-6)) return out
  for (let i = 0; i < pred.length; i++) {
    const v = Number.isFinite(pred[i]) ? pred[i] : min
    out[i] = (v - min) / span
  }
  return out
}
