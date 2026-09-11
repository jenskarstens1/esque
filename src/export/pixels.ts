/**
 * Export-time pixel work: resize, output sharpening and watermarking.
 *
 * Resampling happens on the CPU in one pass with a Lanczos-3 kernel. The
 * canvas's own `drawImage` downscale is fast but soft and non-deterministic
 * across platforms, which is exactly what you don't want in an export.
 */
import type { SharpenAmount, SharpenTarget, WatermarkFont, WatermarkSettings } from './types'

export interface Plane {
  width: number
  height: number
  /** Interleaved RGBA. */
  data: Uint8ClampedArray | Uint16Array
}

const maxOf = (data: Plane['data']) => (data instanceof Uint16Array ? 65535 : 255)

const like = (data: Plane['data'], n: number) =>
  data instanceof Uint16Array ? new Uint16Array(n) : new Uint8ClampedArray(n)

// --- resize -----------------------------------------------------------------

const LOBES = 3

function lanczos(x: number) {
  if (x === 0) return 1
  const a = Math.abs(x)
  if (a >= LOBES) return 0
  const px = Math.PI * a
  return (LOBES * Math.sin(px) * Math.sin(px / LOBES)) / (px * px)
}

interface Taps {
  starts: Int32Array
  widths: Int32Array
  weights: Float32Array
  maxWidth: number
}

function buildTaps(srcLen: number, dstLen: number): Taps {
  const scale = dstLen / srcLen
  // Upscaling keeps the kernel at its natural width; downscaling widens it so
  // we average all the source pixels that fall into each output pixel.
  const support = scale < 1 ? LOBES / scale : LOBES
  const maxWidth = Math.ceil(support * 2) + 2

  const starts = new Int32Array(dstLen)
  const widths = new Int32Array(dstLen)
  const weights = new Float32Array(dstLen * maxWidth)

  for (let i = 0; i < dstLen; i++) {
    const center = (i + 0.5) / scale - 0.5
    const from = Math.max(0, Math.ceil(center - support))
    const to = Math.min(srcLen - 1, Math.floor(center + support))
    let sum = 0
    let n = 0
    for (let s = from; s <= to; s++) {
      const w = lanczos(scale < 1 ? (s - center) * scale : s - center)
      weights[i * maxWidth + n] = w
      sum += w
      n++
    }
    if (sum !== 0) {
      for (let k = 0; k < n; k++) weights[i * maxWidth + k] /= sum
    }
    starts[i] = from
    widths[i] = n
  }
  return { starts, widths, weights, maxWidth }
}

/** Separable Lanczos-3 resample. Both passes run in the source's bit depth. */
export function resize(src: Plane, width: number, height: number): Plane {
  if (src.width === width && src.height === height) return src
  const max = maxOf(src.data)

  const hTaps = buildTaps(src.width, width)
  const tmp = new Float32Array(width * src.height * 4)
  for (let y = 0; y < src.height; y++) {
    const rowIn = y * src.width * 4
    const rowOut = y * width * 4
    for (let x = 0; x < width; x++) {
      const start = hTaps.starts[x]
      const n = hTaps.widths[x]
      const wOff = x * hTaps.maxWidth
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let k = 0; k < n; k++) {
        const w = hTaps.weights[wOff + k]
        const s = rowIn + (start + k) * 4
        r += src.data[s] * w
        g += src.data[s + 1] * w
        b += src.data[s + 2] * w
        a += src.data[s + 3] * w
      }
      const o = rowOut + x * 4
      tmp[o] = r
      tmp[o + 1] = g
      tmp[o + 2] = b
      tmp[o + 3] = a
    }
  }

  const vTaps = buildTaps(src.height, height)
  const out = like(src.data, width * height * 4)
  for (let y = 0; y < height; y++) {
    const start = vTaps.starts[y]
    const n = vTaps.widths[y]
    const wOff = y * vTaps.maxWidth
    for (let x = 0; x < width; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let k = 0; k < n; k++) {
        const w = vTaps.weights[wOff + k]
        const s = ((start + k) * width + x) * 4
        r += tmp[s] * w
        g += tmp[s + 1] * w
        b += tmp[s + 2] * w
        a += tmp[s + 3] * w
      }
      const o = (y * width + x) * 4
      out[o] = Math.max(0, Math.min(max, r))
      out[o + 1] = Math.max(0, Math.min(max, g))
      out[o + 2] = Math.max(0, Math.min(max, b))
      out[o + 3] = Math.max(0, Math.min(max, a))
    }
  }
  return { width, height, data: out }
}

// --- output sharpening ------------------------------------------------------

const SHARPEN_STRENGTH: Record<SharpenAmount, number> = { low: 0.5, standard: 0.9, high: 1.5 }
/** Print needs more, because ink spread eats fine detail. */
const TARGET_SCALE: Record<Exclude<SharpenTarget, 'none'>, number> = {
  screen: 1,
  glossy: 1.35,
  matte: 1.7,
}
const TARGET_RADIUS: Record<Exclude<SharpenTarget, 'none'>, number> = {
  screen: 0.7,
  glossy: 1,
  matte: 1.3,
}

/**
 * Unsharp mask on luminance only, so sharpening never introduces colour
 * fringes — the same reason Lightroom's output sharpening is luminance-based.
 */
export function outputSharpen(
  plane: Plane,
  target: SharpenTarget,
  amount: SharpenAmount,
): Plane {
  if (target === 'none') return plane
  const strength = SHARPEN_STRENGTH[amount] * TARGET_SCALE[target]
  const radius = TARGET_RADIUS[target]
  const { width, height, data } = plane
  const max = maxOf(data)

  const luma = new Float32Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const s = i * 4
    luma[i] = (data[s] * 0.2126 + data[s + 1] * 0.7152 + data[s + 2] * 0.0722) / max
  }

  const blurred = gaussian(luma, width, height, radius)
  const out = like(data, data.length)

  for (let i = 0; i < width * height; i++) {
    const detail = luma[i] - blurred[i]
    // Threshold suppresses noise amplification in flat areas.
    const gate = Math.abs(detail) < 0.004 ? 0 : 1
    const delta = detail * strength * gate * max
    const s = i * 4
    out[s] = Math.max(0, Math.min(max, data[s] + delta))
    out[s + 1] = Math.max(0, Math.min(max, data[s + 1] + delta))
    out[s + 2] = Math.max(0, Math.min(max, data[s + 2] + delta))
    out[s + 3] = data[s + 3]
  }
  return { width, height, data: out }
}

/** Separable gaussian on a single float plane. */
function gaussian(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3))
  const kernel = new Float32Array(radius * 2 + 1)
  let sum = 0
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma))
    kernel[i + radius] = v
    sum += v
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum

  const tmp = new Float32Array(src.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let k = -radius; k <= radius; k++) {
        acc += src[y * w + Math.min(w - 1, Math.max(0, x + k))] * kernel[k + radius]
      }
      tmp[y * w + x] = acc
    }
  }
  const out = new Float32Array(src.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let k = -radius; k <= radius; k++) {
        acc += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x] * kernel[k + radius]
      }
      out[y * w + x] = acc
    }
  }
  return out
}

// --- watermark --------------------------------------------------------------

const FONT_STACK: Record<WatermarkFont, string> = {
  sans: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
}

function watermarkPlacement(
  width: number,
  height: number,
  mark: WatermarkSettings,
) {
  const longEdge = Math.max(width, height)
  const fontSize = Math.max(10, (mark.size / 100) * longEdge)
  const inset = (mark.inset / 100) * longEdge
  const font = `500 ${fontSize}px ${FONT_STACK[mark.font] ?? FONT_STACK.sans}`
  const [vertical, horizontal] = mark.position.split('-') as [string, string]
  const baseline: CanvasTextBaseline = vertical === 'top' ? 'top' : 'alphabetic'
  const align: CanvasTextAlign =
    horizontal === 'left' ? 'left' : horizontal === 'right' ? 'right' : 'center'
  const x = horizontal === 'left' ? inset : horizontal === 'right' ? width - inset : width / 2
  const y = vertical === 'top' ? inset : height - inset
  const blur = mark.shadow ? fontSize * 0.18 : 0
  const offsetY = mark.shadow ? fontSize * 0.04 : 0
  return { font, baseline, align, x, y, blur, offsetY }
}

/**
 * Draws the text watermark.
 *
 * Text shaping goes through a canvas because reimplementing it is not sensible,
 * but the canvas is only used to rasterise the glyphs into a small RGBA8 layer
 * covering the text's bounding box. That layer is then composited into the plane
 * at its native bit depth, so 16-bit exports keep both their watermark and their
 * precision — previously they silently lost the watermark entirely.
 *
 * Compositing happens in place. The pipeline discards the input plane on the
 * next assignment, and copying a 45 MP 16-bit frame to avoid that would cost
 * 360 MB for nothing.
 */
export function watermark(plane: Plane, mark: WatermarkSettings): Plane {
  if (!mark.enabled || !mark.text.trim()) return plane

  const { width, height, data } = plane
  const { font, baseline, align, x, y, blur, offsetY } =
    watermarkPlacement(width, height, mark)

  const measure = new OffscreenCanvas(1, 1).getContext('2d')
  if (!measure) return plane
  measure.font = font
  measure.textAlign = align
  measure.textBaseline = baseline
  const m = measure.measureText(mark.text)

  // The shadow spreads past the glyph box, so the layer has to be padded by the
  // blur radius plus its offset or the shadow gets clipped.
  const pad = Math.ceil(blur * 2 + offsetY + 2)
  const x0 = Math.max(0, Math.floor(x - m.actualBoundingBoxLeft - pad))
  const y0 = Math.max(0, Math.floor(y - m.actualBoundingBoxAscent - pad))
  const x1 = Math.min(width, Math.ceil(x + m.actualBoundingBoxRight + pad))
  const y1 = Math.min(height, Math.ceil(y + m.actualBoundingBoxDescent + pad))
  const w = x1 - x0
  const h = y1 - y0
  if (w <= 0 || h <= 0) return plane

  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return plane
  ctx.translate(-x0, -y0)
  ctx.font = font
  ctx.textAlign = align
  ctx.textBaseline = baseline
  ctx.globalAlpha = mark.opacity / 100
  ctx.fillStyle = mark.color === 'white' ? '#fff' : '#000'
  if (mark.shadow) {
    ctx.shadowColor = mark.color === 'white' ? 'rgba(0,0,0,.55)' : 'rgba(255,255,255,.55)'
    ctx.shadowBlur = blur
    ctx.shadowOffsetY = offsetY
  }
  ctx.fillText(mark.text, x, y)

  const layer = ctx.getImageData(0, 0, w, h).data
  const max = maxOf(data)
  // getImageData is unpremultiplied 8-bit, so source-over is a plain lerp once
  // the colour is scaled into the plane's range.
  const scale = max / 255

  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const s = (row * w + col) * 4
      const a = layer[s + 3] / 255
      if (a <= 0) continue
      const d = ((y0 + row) * width + x0 + col) * 4
      for (let c = 0; c < 3; c++) {
        const blended = layer[s + c] * scale * a + data[d + c] * (1 - a)
        // Uint16Array wraps rather than clamping, unlike Uint8ClampedArray.
        data[d + c] = Math.max(0, Math.min(max, Math.round(blended)))
      }
    }
  }
  return plane
}
