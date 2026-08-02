/**
 * What this browser and display can do with extended dynamic range.
 *
 * Two independent mechanisms carry HDR here, and they ship on different
 * schedules, so each is probed separately rather than folded into one flag:
 *
 *   `dynamic-range-limit`  a CSS property, inherited, that decides whether an
 *                          HDR source — a phone's gain-map JPEG, an HDR AVIF —
 *                          is shown at full range or tone mapped to SDR. This is
 *                          what covers every `<img>` in the app.
 *   HDR canvas             a WebGPU surface configured with
 *                          `toneMapping: { mode: 'extended' }`, which is the
 *                          only way a canvas can put a value above display
 *                          white on screen. This covers the Develop viewport.
 *
 * The property's initial value is `no-limit`, so "HDR off" is an active choice
 * the app has to write down, not the absence of one.
 */

export interface HdrCapability {
  /** `dynamic-range-limit` is understood, so image surfaces can be held to SDR. */
  css: boolean
  /**
   * A canvas can present values above display white.
   *
   * This tracks WebGPU, because extended-range presentation is core WebGPU
   * rather than an experiment: a surface configured with
   * `toneMapping: { mode: 'extended' }` works unflagged in both Chromium and
   * Safari. The WebGL2 route it replaced never could — Safari ships neither
   * `configureHighDynamicRange` nor `drawingBufferStorage`, not even behind a
   * flag, which is what forced the pipeline onto WebGPU in the first place.
   *
   * `navigator.gpu` is the whole test. There is deliberately no attempt to
   * probe the tone mapping mode itself: unknown dictionary members are ignored
   * rather than rejected, so configuring cannot report whether it took, and the
   * only real proof is a pixel above 1.0 on a display with headroom. The
   * renderer reports what it actually got through `hdrPresenting`, so the UI
   * still tells the truth if a browser turns out not to honour it.
   */
  canvas: boolean
}

let cached: HdrCapability | null = null

export function hdrCapability(): HdrCapability {
  if (cached) return cached
  cached =
    typeof window === 'undefined'
      ? { css: false, canvas: false }
      : {
          css: typeof CSS !== 'undefined' && CSS.supports('dynamic-range-limit', 'no-limit'),
          canvas: typeof navigator !== 'undefined' && !!navigator.gpu,
        }
  return cached
}

/** True when this build can show HDR anywhere at all. */
export const hdrSupported = () => {
  const c = hdrCapability()
  return c.css || c.canvas
}

/**
 * How far HDR viewing reaches in this browser.
 *
 * The two mechanisms ship on different schedules, so a browser may show photos
 * in full range while keeping the Develop canvas in SDR. That split is worth
 * saying out loud: a toggle that visibly changes the grid and does nothing to
 * the viewport reads as a bug otherwise. Now that the canvas runs on WebGPU the
 * usual answer is `everything`, but the distinction still holds for anything
 * without WebGPU.
 */
export type HdrReach = 'none' | 'images' | 'everything'

export function hdrReach(): HdrReach {
  const c = hdrCapability()
  if (c.canvas) return 'everything'
  return c.css ? 'images' : 'none'
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const HIGH_RANGE = '(dynamic-range: high)'

/** Whether the display the window is on reports extended range *right now*. */
export function displayIsHdr(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(HIGH_RANGE).matches
}

/**
 * Calls back whenever the answer changes — dragging the window to a second
 * monitor, or macOS pulling headroom away when the battery gets low.
 */
export function watchDisplayHdr(onChange: (high: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const mq = window.matchMedia(HIGH_RANGE)
  const handler = () => onChange(mq.matches)
  mq.addEventListener('change', handler)
  return () => mq.removeEventListener('change', handler)
}

// ---------------------------------------------------------------------------
// Headroom
// ---------------------------------------------------------------------------

/**
 * Nothing on the platform reports how much headroom a display actually has, so
 * the amount is a preference rather than a measurement. Two stops is the range
 * a typical laptop panel holds above SDR white with the backlight up, and it is
 * where Lightroom's own HDR preview lands by default.
 */
export const HEADROOM_STOPS_DEFAULT = 2
export const HEADROOM_STOPS_MIN = 0
export const HEADROOM_STOPS_MAX = 4

/** Stops above display white -> the linear multiple the output pass expands to. */
export const headroomFromStops = (stops: number) =>
  Math.pow(2, Math.min(HEADROOM_STOPS_MAX, Math.max(HEADROOM_STOPS_MIN, stops)))

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/**
 * Writes the viewing limit onto the document element.
 *
 * `dynamic-range-limit` inherits, so one declaration at the root reaches every
 * thumbnail, the filmstrip, the loupe, the Develop canvas and anything a portal
 * puts outside the React tree. Setting it per-surface would mean finding every
 * one of them again the next time somebody adds a view.
 */
export function applyDynamicRangeLimit(on: boolean) {
  if (typeof document === 'undefined' || !hdrCapability().css) return
  document.documentElement.style.setProperty(
    'dynamic-range-limit',
    on ? 'no-limit' : 'standard',
  )
}
