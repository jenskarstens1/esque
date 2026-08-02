import { useEffect, useState } from 'react'

export interface HistogramData {
  r: Uint32Array
  g: Uint32Array
  b: Uint32Array
  l: Uint32Array
  max: number
  clipShadow: number
  clipHighlight: number
}

export const BINS = 256

/** Computes a histogram from an image URL by sampling a downscaled copy. */
export function useHistogram(url: string | null): HistogramData | null {
  const [data, setData] = useState<HistogramData | null>(null)

  useEffect(() => {
    if (!url) {
      setData(null)
      return
    }
    let alive = true
    ;(async () => {
      try {
        const res = await fetch(url)
        const bitmap = await createImageBitmap(await res.blob())
        // 320px on the long edge is plenty: the shape converges long before this.
        const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height))
        const w = Math.max(1, Math.round(bitmap.width * scale))
        const h = Math.max(1, Math.round(bitmap.height * scale))
        const canvas = new OffscreenCanvas(w, h)
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!
        ctx.drawImage(bitmap, 0, 0, w, h)
        bitmap.close()
        const px = ctx.getImageData(0, 0, w, h).data

        const r = new Uint32Array(BINS)
        const g = new Uint32Array(BINS)
        const b = new Uint32Array(BINS)
        const l = new Uint32Array(BINS)
        let clipShadow = 0
        let clipHighlight = 0

        for (let i = 0; i < px.length; i += 4) {
          const R = px[i]
          const G = px[i + 1]
          const B = px[i + 2]
          r[R]++
          g[G]++
          b[B]++
          l[(R * 77 + G * 151 + B * 28) >> 8]++
          if (R <= 1 && G <= 1 && B <= 1) clipShadow++
          if (R >= 254 && G >= 254 && B >= 254) clipHighlight++
        }

        // Ignore the extremes when scaling: a big black border shouldn't flatten
        // everything else into the baseline.
        let max = 0
        for (let i = 1; i < BINS - 1; i++) {
          max = Math.max(max, r[i], g[i], b[i], l[i])
        }
        const total = px.length / 4
        if (alive)
          setData({
            r,
            g,
            b,
            l,
            max: max || 1,
            clipShadow: clipShadow / total,
            clipHighlight: clipHighlight / total,
          })
      } catch {
        if (alive) setData(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [url])

  return data
}
