/**
 * The decoder's output contract.
 *
 * These live outside `rawWorker.ts` because that module calls
 * `Comlink.expose()` at import time and can only be loaded as a worker, which
 * puts the one thing most worth testing — the settings the decoder actually
 * ships with — out of reach of a check page. `gammacheck` imports this module
 * and decodes with these exact objects.
 */
import type { LibRawSettings } from 'libraw-wasm'

/**
 * Transfer curve LibRaw encodes its 16-bit output with: none. `[1, 1]` is
 * dcraw's "give me scene-linear" idiom, and it is stated deliberately rather
 * than inherited.
 *
 * This is load-bearing, not cosmetic. Every stage downstream — white balance,
 * exposure, the decoder's box downsample, the working headroom scale, the
 * renderer's whole graph, and linear DNG export — multiplies these samples as
 * if they were proportional to scene radiance. On dcraw's default 0.45/4.5
 * curve they are not, and the discrepancy is a curve rather than a constant:
 * measured against the fixtures, encoded/linear runs about 1.8x in the
 * highlights to 4.5x in the shadows, so it cannot be absorbed by a baseline
 * exposure and has to be removed at the source.
 *
 * There is history here worth keeping. The decoder used to ask for `[1, 1]` and
 * silently never got it, because the libraw-wasm binding only copied `gamm`
 * when the array had exactly six elements while its own type declared two. The
 * vendored build fixes that binding (see tools/build-libraw.sh), so the request
 * is now honoured — which is why the value has to be chosen on purpose, and why
 * it is verified rather than asserted. `gammacheck` decodes a fixture through
 * {@link LINEAR_SETTINGS} and again with the exponent halved, then checks that
 * squaring the second reproduces the first; that can hold only if `gamm`
 * reaches LibRaw *and* these settings are linear. It is the guard against this
 * regressing silently a second time.
 *
 * Saved edits are deliberately *not* migrated across this change. The
 * correction is a curve rather than a constant — about 1.37 stops in deep
 * shadow, 0.60 at mid grey, 0.02 in the highlights — so no compensating
 * exposure can restore the old appearance, and one fitted at the midtones would
 * leave shadows 0.77 stops dark while pushing highlights 0.6 stops bright,
 * which is worse for many pictures than leaving them alone. Existing edits
 * therefore render on the corrected pipeline as-is. Cached *pixels* are a
 * separate matter and are invalidated: see the proxy cache version in
 * `develop/proxyCache.ts`.
 */
export const OUTPUT_GAMMA: [number, number] = [1, 1]

/**
 * Produces **scene-linear ProPhoto RGB, 16-bit** ({@link OUTPUT_GAMMA}).
 * Reconstruction, scene preparation, and capture cleanup then retain that
 * headroom until the renderer's explicit scene-to-display stage.
 *
 *   outputColor 4 : ProPhoto primaries (very wide, holds saturated reds/greens)
 *   noAutoBright  : never let LibRaw guess an exposure; that's the user's job
 *   useCameraWb   : start from the camera's as-shot WB, then offset from there
 *   highlight 1   : reserve WB headroom instead of clipping it before the GPU
 *   adjustMaximumThr 0 : keep the camera's declared saturation point
 *
 * That last one matters for reproducibility. LibRaw's default 0.75 lets
 * `adjust_maximum()` pull the white point down to the brightest sample actually
 * present, which is a property of the pixels handed to it — so a cropped or
 * banded decode of the same file lands on a different white point than the
 * whole frame, and the cached proxy stops matching a fresh decode. Pinning the
 * threshold to 0 costs a fraction of a stop of highlight brightness that the
 * half-float working space carries losslessly anyway, and is what makes a
 * banded decode bit-identical to the frame it replaces.
 */
export const LINEAR_SETTINGS: LibRawSettings = {
  outputColor: 4,
  outputBps: 16,
  gamm: OUTPUT_GAMMA,
  noAutoBright: true,
  useCameraWb: true,
  useCameraMatrix: 1,
  highlight: 1,
  adjustMaximumThr: 0,
  outputTiff: false,
}
