/**
 * The RAW transfer contract: the shipped decoder settings must yield
 * scene-linear pixels.
 *
 * Everything downstream of the decoder — white balance, exposure, the box
 * downsample, the working headroom scale, the renderer's scene-to-display
 * transfer, linear DNG export — multiplies RAW samples as though they were
 * proportional to scene radiance. That holds only if LibRaw is asked for, and
 * actually delivers, a linear output curve.
 *
 * This earns a check of its own because the contract has been broken before and
 * nothing failed when it was. The decoder asked for `gamm: [1, 1]` and never
 * got it: the libraw-wasm binding only copied `gamm` when the array had exactly
 * six elements while its own type declared two, so a two-element request was
 * dropped and every decode came back on dcraw's 0.45/4.5 curve — which the
 * renderer's own transfer then encoded a second time. The picture merely
 * rendered about a stop bright and washed out, shadows lifted 1.37 stops, and
 * the tone and detail defaults had been quietly trimmed around it.
 *
 * Reading the `OUTPUT_GAMMA` constant back would not have caught that, because
 * the constant was right and the binding was wrong. So the assertion runs a real
 * decode through the real {@link LINEAR_SETTINGS} object and measures the
 * pixels that come out.
 *
 * Run through `tools/headless.mjs /checks/gammacheck.html`.
 */
import LibRaw from 'libraw-wasm'
import { LINEAR_SETTINGS } from '../raw/settings'
import { runCheck } from './checkreport'

const params = new URLSearchParams(location.search)
const fixture = params.get('fixture') ?? '/raw-fixtures/canon-5d2.cr2'

/**
 * Decodes through the shipped settings, overriding only the output curve.
 *
 * Sharing one settings object across both decodes is the point: it holds the
 * demosaic, white balance, highlight mode and saturation point identical, so
 * the two planes are the same pixels differing by exactly one variable and can
 * be compared sample by sample rather than as distributions.
 */
async function decode(bytes: Uint8Array<ArrayBuffer>, gamm?: [number, number]) {
  const raw = new LibRaw()
  await raw.open(bytes, {
    ...LINEAR_SETTINGS,
    ...(gamm ? { gamm } : {}),
    // Only to keep the check quick, and applied identically to both sides.
    halfSize: true,
  })
  const img = await raw.imageData()
  if (!img?.data?.length) throw new Error('LibRaw returned no pixels')
  return img.data as Uint16Array
}

runCheck(async () => {
  const failures: string[] = []
  const ok = (condition: boolean, message: string) => {
    if (!condition) failures.push(message)
  }

  const bytes = new Uint8Array(await (await fetch(fixture)).arrayBuffer())

  /*
   * Halving the exponent must square-root the output.
   *
   * Rather than reproduce dcraw's `gamma_curve()` — which solves for its own toe
   * breakpoint, and is exactly the fragile thing to depend on — this uses only
   * the relationship between two decodes. A pure power curve of exponent p
   * gives `out = linear ** p`, so if the shipped settings are linear, decoding
   * again at exponent 0.5 and squaring the result must reproduce them.
   *
   * That one comparison closes both failure modes at once:
   *
   *   - Shipped settings not linear. Were `OUTPUT_GAMMA` to go back to 0.45/4.5,
   *     the shipped plane is Rec.709 of the linear one while the reference is
   *     its square root, and squaring no longer lands near it.
   *   - `gamm` silently ignored, which is the original bug. Both decodes then
   *     come back identical on whatever default LibRaw applies, and squaring a
   *     value reproduces it only at 0 and 1 — so a frame of real pixels fails
   *     wide.
   */
  const shipped = await decode(bytes.slice())
  const root = await decode(bytes.slice(), [0.5, 0])
  ok(shipped.length === root.length, 'the two decodes disagree on size')

  const residuals: number[] = []
  for (let i = 0; i < shipped.length; i++) {
    const s = shipped[i] / 65535
    // The noise floor and the ceiling both compress the difference between the
    // two hypotheses, so neither end can be allowed to carry the assertion.
    if (s <= 0.002 || s >= 0.98) continue
    const r = root[i] / 65535
    residuals.push(Math.abs(r * r - s))
  }
  residuals.sort((a, b) => a - b)
  const median = residuals[Math.floor(residuals.length / 2)] ?? NaN
  const p99 = residuals[Math.floor(residuals.length * 0.99)] ?? NaN

  ok(residuals.length > 10_000, `only ${residuals.length} comparable samples`)
  ok(
    median < 0.002 && p99 < 0.01,
    `squaring the exponent-0.5 decode did not reproduce the shipped decode ` +
      `(median residual ${median}, p99 ${p99}) — the shipped settings are not ` +
      `linear, or 'gamm' is not reaching LibRaw`,
  )

  return {
    pass: failures.length === 0,
    failures,
    fixture,
    samples: residuals.length,
    medianResidual: median,
    p99Residual: p99,
    gamm: LINEAR_SETTINGS.gamm,
  }
})
