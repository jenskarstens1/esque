/**
 * LibRaw orientation codes, in dcraw's bitfield form.
 *
 *   bit 0 (1) — mirror horizontally
 *   bit 1 (2) — mirror vertically
 *   bit 2 (4) — transpose
 *
 * Applied in that order: mirrors first, then the transpose. All eight EXIF
 * orientations map onto this, including the four mirrored ones that a
 * three-case switch silently renders upside down. `-1` means "unknown".
 *
 * Kept free of any libraw-wasm import so the main thread can reason about
 * orientation without pulling the decoder into its bundle.
 */
export const normaliseFlip = (flip: number | null | undefined) =>
  typeof flip === 'number' && flip >= 0 && flip <= 7 ? flip : 0

/** Whether a flip code swaps the image's width and height. */
export const flipTransposes = (flip: number | null | undefined) =>
  (normaliseFlip(flip) & 4) !== 0

/**
 * LibRaw flip code -> canvas transform matrix.
 *
 * `setTransform(a,b,c,d,e,f)` maps (x,y) -> (a·x + c·y + e, b·x + d·y + f).
 */
export function orientationTransform(rawFlip: number, w: number, h: number) {
  const flip = normaliseFlip(rawFlip)
  const mx = flip & 1 ? -1 : 1
  const tx = flip & 1 ? w : 0
  const my = flip & 2 ? -1 : 1
  const ty = flip & 2 ? h : 0

  return flip & 4
    ? { w: h, h: w, transform: [0, mx, my, 0, ty, tx] as const }
    : { w, h, transform: [mx, 0, 0, my, tx, ty] as const }
}

/** Rotates a half-float RGBA buffer to match the camera's orientation flag. */
export function applyOrientationHalf(
  data: Uint16Array,
  w: number,
  h: number,
  rawFlip: number,
): { width: number; height: number; data: Uint16Array } {
  const flip = normaliseFlip(rawFlip)
  if (flip === 0) return { width: w, height: h, data }

  const transpose = (flip & 4) !== 0
  const ow = transpose ? h : w
  const oh = transpose ? w : h
  const out = new Uint16Array(data.length)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Mirrors first, then the transpose — see normaliseFlip.
      const mx = flip & 1 ? w - 1 - x : x
      const my = flip & 2 ? h - 1 - y : y
      const ox = transpose ? my : mx
      const oy = transpose ? mx : my
      const si = (y * w + x) * 4
      const oi = (oy * ow + ox) * 4
      out[oi] = data[si]
      out[oi + 1] = data[si + 1]
      out[oi + 2] = data[si + 2]
      out[oi + 3] = data[si + 3]
    }
  }
  return { width: ow, height: oh, data: out }
}
