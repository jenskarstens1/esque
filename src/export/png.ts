/**
 * PNG writer for 16-bit output.
 *
 * The browser encodes PNG, but only through a canvas, and a canvas is 8 bits per
 * channel. That made `bitDepth: 16` a no-op for PNG — the setting existed, the
 * UI offered it, and the file came out 8-bit regardless. TIFF was the only way
 * to get 16 bits out of a 16-bit editor.
 *
 * Deflate comes from `CompressionStream`, so the only real work here is scanline
 * filtering. Rows are fed through the compressor as they are produced rather
 * than buffered, which keeps peak memory at roughly one copy of the image
 * instead of three — a 45 MP 16-bit RGB frame is 270 MB, so that matters.
 */
import { pngChunk } from './containers'

export interface PngOptions {
  width: number
  height: number
  /** Interleaved RGB, no alpha. 16-bit samples are written big-endian. */
  data: Uint16Array
}

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const CHANNELS = 3
/** Bytes to the same sample in the pixel to the left: 3 channels x 2 bytes. */
const BPP = CHANNELS * 2

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** Sum of absolute signed byte values — libpng's filter selection heuristic. */
function score(row: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < row.length; i++) {
    const v = row[i]
    sum += v < 128 ? v : 256 - v
  }
  return sum
}

/**
 * Emits `[filterType, ...filtered]` for one scanline, choosing whichever of the
 * five filters compresses best by the heuristic above.
 */
function filterRow(
  cur: Uint8Array,
  prev: Uint8Array,
  candidates: Uint8Array[],
  out: Uint8Array,
): void {
  const n = cur.length

  for (let i = 0; i < n; i++) {
    const left = i >= BPP ? cur[i - BPP] : 0
    const up = prev[i]
    const upLeft = i >= BPP ? prev[i - BPP] : 0
    candidates[0][i] = cur[i]
    candidates[1][i] = (cur[i] - left) & 0xff
    candidates[2][i] = (cur[i] - up) & 0xff
    candidates[3][i] = (cur[i] - ((left + up) >> 1)) & 0xff
    candidates[4][i] = (cur[i] - paeth(left, up, upLeft)) & 0xff
  }

  let bestType = 0
  let bestScore = Infinity
  for (let t = 0; t < 5; t++) {
    const s = score(candidates[t])
    if (s < bestScore) {
      bestScore = s
      bestType = t
    }
  }

  out[0] = bestType
  out.set(candidates[bestType], 1)
}

export async function encodePng16(opts: PngOptions): Promise<Uint8Array> {
  const { width, height, data } = opts
  const stride = width * BPP

  const cur = new Uint8Array(stride)
  const prev = new Uint8Array(stride)
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(stride))
  const line = new Uint8Array(stride + 1)

  let y = 0
  const rows = new ReadableStream<BufferSource>({
    pull(controller) {
      if (y >= height) {
        controller.close()
        return
      }
      const base = y * width * CHANNELS
      for (let x = 0; x < width * CHANNELS; x++) {
        const v = data[base + x]
        cur[x * 2] = (v >> 8) & 0xff
        cur[x * 2 + 1] = v & 0xff
      }
      filterRow(cur, prev, candidates, line)
      prev.set(cur)
      // The stream keeps the chunk until the compressor consumes it, so each
      // row has to be handed over as its own copy.
      controller.enqueue(line.slice())
      y++
    },
  })

  const deflated = new Uint8Array(
    await new Response(rows.pipeThrough(new CompressionStream('deflate'))).arrayBuffer(),
  )

  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, width)
  dv.setUint32(4, height)
  ihdr[8] = 16 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  const parts = [
    SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflated),
    pngChunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
