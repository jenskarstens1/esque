import {
  COLOR_BANDS,
  EDITS_VERSION,
  type BandValues,
  type DetailEdits,
  type Edits,
  type EditSection,
  type LayerTransform,
  type MaskAdjustments,
} from './types'
import type { WhitePoint } from './color'
import { RENDERED_WHITE_POINT } from './workingImage'

const zeroBands = (): BandValues =>
  Object.fromEntries(COLOR_BANDS.map((b) => [b, 0])) as BandValues

/**
 * Which kind of file the defaults are for.
 *
 * A RAW is scene-linear and undemosaiced, so it arrives soft and needs a
 * capture-sharpening baseline plus modest luminance and colour noise reduction
 * before you have anything worth judging. A JPEG or TIFF has already been
 * through the camera's (or another editor's) sharpener and denoiser, so the
 * same baseline would be a second pass over the same pixels: haloed edges and
 * smeared detail that the user never asked for. Rendered files therefore start
 * all four controls at zero.
 */
export type FileKind = 'raw' | 'rendered'

export const editsKind = (isRaw: boolean): FileKind => (isRaw ? 'raw' : 'rendered')

function isoValue(iso: number, values: number[], fallback: number): number {
  if (!Number.isFinite(iso) || iso <= 0) return fallback
  const stop = Math.max(0, Math.min(values.length - 1, Math.log2(Math.max(100, iso) / 100)))
  const lo = Math.floor(stop)
  const hi = Math.min(values.length - 1, lo + 1)
  return Math.round(values[lo] + (values[hi] - values[lo]) * (stop - lo))
}

/**
 * Sensor noise rises by roughly one stop whenever ISO doubles, and these curves
 * follow it — but gently, because a default that hides noise also hides the
 * photograph.
 *
 * Low-ISO defaults are calibrated against paired camera JPEGs at the same output
 * size. The old 45/25 sharpening/colour baseline left every tested RAW visibly
 * behind its JPEG: edge acutance was 30 vs 34 on Canon 5D IV, 48 vs 54 on Nikon
 * D800, and 76 vs 89 on Fujifilm X-T50. It also left almost twice the residual
 * chroma texture on the X-Trans frame. A 70/55 baseline lands at 34/55/88 while
 * matching or beating the JPEG's chroma cleanliness on all three.
 *
 * The curves are set against the camera's own JPEG, measuring detail and noise
 * separately — detail as gradient energy in the most structured fifth of the
 * frame, noise as median local deviation in the flattest fifth, since a single
 * gradient figure cannot tell texture from grain and will happily reward simply
 * switching denoising off.
 *
 * At ISO 6400 the earlier calibration puts the camera at noise 3.1 / detail 7.1. Luminance noise
 * reduction of 70 lands at 2.8 / 7.2 — the camera's cleanliness with slightly
 * more surviving texture — where the old value of 90 gave 2.0 / 6.3, cleaner
 * than the camera but visibly softer. Sharpening holds near its baseline rather
 * than collapsing, masking keeps grain out of flat areas, and colour noise
 * reduction stays strong because it costs almost no detail.
 */
export function rawDetailDefaults(iso = 0): DetailEdits {
  return {
    sharpenAmount: isoValue(iso, [70, 70, 70, 55, 45, 35, 30], 60),
    sharpenRadius: 1,
    sharpenDetail: 25,
    sharpenMasking: isoValue(iso, [0, 0, 5, 10, 20, 30, 40], 10),
    luminanceNR: isoValue(iso, [0, 0, 5, 15, 40, 60, 70], 0),
    luminanceNRDetail: isoValue(iso, [60, 60, 60, 60, 55, 50, 50], 50),
    // Restore coherent residual texture after the stronger high-ISO filter.
    // Keeping this near zero at low ISO avoids manufacturing grain where the
    // first pass has almost nothing to remove.
    luminanceNRContrast: isoValue(iso, [0, 0, 0, 5, 15, 25, 30], 0),
    colorNR: isoValue(iso, [55, 55, 55, 55, 55, 55, 60], 55),
    colorNRDetail: 50,
    colorNRSmoothness: isoValue(iso, [50, 50, 50, 55, 65, 80, 85], 50),
    impulseNR: 0,
  }
}

export const defaultEdits = (
  kind: FileKind = 'raw',
  asShot: WhitePoint = kind === 'raw'
    ? { temp: 5500, tint: 0 }
    : RENDERED_WHITE_POINT,
  iso = 0,
): Edits => {
  const rawDetail = rawDetailDefaults(kind === 'raw' ? iso : 0)
  return {
  version: EDITS_VERSION,
  profile: 'standard',

  basic: {
    wbMode: 'asShot',
    temp: asShot.temp,
    tint: asShot.tint,
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    texture: 0,
    clarity: 0,
    dehaze: 0,
    vibrance: 0,
    saturation: 0,
    treatment: 'color',
    avoidColorShift: true,
    protectSkin: true,
  },

  tone: {
    recovery: 'off',
    recoveryThreshold: 100,
    shHighlights: 0,
    shShadows: 0,
    shRadius: 40,
    shTonalWidth: 70,
    drcAmount: 0,
    drcDetail: 50,
    detailFinest: 0,
    detailFine: 0,
    detailCoarse: 0,
    detailCoarsest: 0,
    detailThreshold: 20,
  },

  curve: {
    mode: 'parametric',
    rgbMode: 'standard',
    parametric: {
      highlights: 0,
      lights: 0,
      darks: 0,
      shadows: 0,
      shadowSplit: 0.25,
      midtoneSplit: 0.5,
      highlightSplit: 0.75,
    },
    rgb: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
    red: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
    green: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
    blue: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
  },

  colorMixer: {
    hue: zeroBands(),
    saturation: zeroBands(),
    luminance: zeroBands(),
    bw: zeroBands(),
  },

  colorGrading: {
    shadows: { hue: 0, saturation: 0, luminance: 0 },
    midtones: { hue: 0, saturation: 0, luminance: 0 },
    highlights: { hue: 0, saturation: 0, luminance: 0 },
    global: { hue: 0, saturation: 0, luminance: 0 },
    blending: 50,
    balance: 0,
  },

  detail: {
    ...rawDetail,
    // Rendered files have already been sharpened and denoised in-camera.
    sharpenAmount: kind === 'raw' ? rawDetail.sharpenAmount : 0,
    sharpenMasking: kind === 'raw' ? rawDetail.sharpenMasking : 0,
    luminanceNR: kind === 'raw' ? rawDetail.luminanceNR : 0,
    colorNR: kind === 'raw' ? rawDetail.colorNR : 0,
  },

  lens: {
    enableProfile: false,
    distortion: 0,
    vignetting: 0,
    caRed: 0,
    caBlue: 0,
    defringePurpleAmount: 0,
    defringePurpleHueLo: 30,
    defringePurpleHueHi: 70,
    defringeGreenAmount: 0,
    defringeGreenHueLo: 40,
    defringeGreenHueHi: 60,
  },

  transform: {
    vertical: 0,
    horizontal: 0,
    rotate: 0,
    aspect: 0,
    scale: 100,
    offsetX: 0,
    offsetY: 0,
  },

  crop: {
    left: 0,
    top: 0,
    right: 1,
    bottom: 1,
    angle: 0,
    aspect: 'free',
    aspectLocked: false,
    quarterTurns: 0,
    flipH: false,
    flipV: false,
  },

  effects: {
    vignetteAmount: 0,
    vignetteMidpoint: 50,
    vignetteRoundness: 0,
    vignetteFeather: 50,
    vignetteHighlights: 0,
    grainAmount: 0,
    grainSize: 25,
    grainRoughness: 50,
  },

  calibration: {
    shadowTint: 0,
    redHue: 0,
    redSaturation: 0,
    greenHue: 0,
    greenSaturation: 0,
    blueHue: 0,
    blueSaturation: 0,
  },

  layers: [],
  spots: [],
  redEye: [],
  }
}

/** A layer sitting exactly where it was placed. */
export const defaultLayerTransform = (): LayerTransform => ({
  offsetX: 0,
  offsetY: 0,
  scale: 100,
  rotate: 0,
  flipH: false,
  flipV: false,
})

export const defaultMaskAdjustments = (): MaskAdjustments => ({
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  texture: 0,
  clarity: 0,
  dehaze: 0,
  temp: 0,
  tint: 0,
  saturation: 0,
  hue: 0,
  hueStrength: 0,
  colorize: 0,
  sharpness: 0,
  noise: 0,
  moire: 0,
  defringe: 0,
  curve: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
})

export const SECTION_LABELS: Record<EditSection, string> = {
  profile: 'Profile',
  basic: 'Basic',
  tone: 'Tone Mapping',
  curve: 'Tone Curve',
  colorMixer: 'Color Mixer',
  colorGrading: 'Color Grading',
  detail: 'Detail',
  lens: 'Lens Corrections',
  transform: 'Transform',
  crop: 'Crop',
  effects: 'Effects',
  calibration: 'Calibration',
  layers: 'Masking',
  spots: 'Spot Removal',
  redEye: 'Red Eye',
}

export const ALL_SECTIONS = Object.keys(SECTION_LABELS) as EditSection[]

/** Deep clone that is safe for the plain-data Edits tree. */
export const cloneEdits = (e: Edits): Edits => structuredClone(e)

/**
 * Resets a single section back to its default while leaving the rest intact.
 * Used by per-panel reset and by paste-with-subset.
 */
export function resetSection(edits: Edits, section: EditSection, kind: FileKind = 'raw'): Edits {
  const fresh = defaultEdits(kind)
  return { ...cloneEdits(edits), [section]: fresh[section] } as Edits
}

/** True when the photo has no develop adjustments at all. */
export function isPristine(edits: Edits, kind: FileKind = 'raw'): boolean {
  const base = defaultEdits(kind)
  const strip = (e: Edits) => {
    const { version: _v, ...rest } = e
    return JSON.stringify(rest)
  }
  return strip(edits) === strip(base)
}

// ---------------------------------------------------------------------------
// Field paths
//
// Presets, copy/paste and sync used to work a whole section at a time, which
// meant "give me this look" also meant "and throw away my white balance, my
// capture sharpening and my noise reduction". Addressing individual fields by
// a dotted path lets a preset carry exactly what it declares and nothing else.
// ---------------------------------------------------------------------------

/**
 * Leaves are numbers, strings, booleans — and arrays, which are treated as
 * single values. A tone curve or a mask list only makes sense whole; merging
 * one curve's third point into another's is not a coherent operation.
 */
const isLeaf = (v: unknown): boolean =>
  v === null || typeof v !== 'object' || Array.isArray(v)

/** Every addressable field under `value`, as dotted paths. */
export function leafPaths(value: unknown, prefix = ''): string[] {
  if (isLeaf(value)) return prefix ? [prefix] : []
  const out: string[] = []
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out.push(...leafPaths(v, prefix ? `${prefix}.${k}` : k))
  }
  return out
}

export function getPath(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key]
    return undefined
  }, root)
}

/**
 * Writes `value` at `path`, creating nothing: a path that doesn't exist in the
 * target is skipped rather than invented, so a preset written by a newer build
 * can't graft a bogus branch onto an older edit tree.
 */
export function setPath(root: unknown, path: string, value: unknown): boolean {
  const keys = path.split('.')
  let node = root as Record<string, unknown> | undefined
  for (let i = 0; i < keys.length - 1; i++) {
    const next = node?.[keys[i]]
    if (!next || typeof next !== 'object' || Array.isArray(next)) return false
    node = next as Record<string, unknown>
  }
  const last = keys[keys.length - 1]
  if (!node || !(last in node)) return false
  node[last] = value
  return true
}

const sameValue = (a: unknown, b: unknown): boolean =>
  a === b || (Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b))

/** The leaf paths where `next` differs from `base` — how a preset learns its own scope. */
export function changedPaths(base: unknown, next: unknown, prefix = ''): string[] {
  return leafPaths(base, prefix).filter((p) => !sameValue(getPath(base, p), getPath(next, p)))
}

/** The section a dotted path belongs to. */
export const sectionOfPath = (path: string) => path.split('.')[0] as EditSection
