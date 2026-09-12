/**
 * The esque data model.
 *
 * `Edits` is the single source of truth for a photo's appearance. It is pure
 * data: serialisable, diffable, snapshot-able for history, copy/paste-able
 * between photos, and convertible to and from Lightroom's XMP `crs:` namespace.
 * The renderer is a pure function of (decoded image, Edits).
 */

// ---------------------------------------------------------------------------
// White balance
// ---------------------------------------------------------------------------

export type WhiteBalanceMode =
  | 'asShot'
  | 'auto'
  | 'daylight'
  | 'cloudy'
  | 'shade'
  | 'tungsten'
  | 'fluorescent'
  | 'flash'
  | 'custom'

export interface BasicEdits {
  wbMode: WhiteBalanceMode
  /** Correlated colour temperature in Kelvin. */
  temp: number
  /** Green–magenta bias, -150..150. */
  tint: number

  /** Stops of linear exposure, -5..+5. */
  exposure: number
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number

  texture: number
  clarity: number
  dehaze: number
  vibrance: number
  saturation: number

  /** Colour or black & white rendering. */
  treatment: Treatment
  /** Vibrance holds saturated colours back from clipping. */
  avoidColorShift: boolean
  /** Vibrance leaves skin hues where they are. */
  protectSkin: boolean
}

export type Treatment = 'color' | 'bw'

// ---------------------------------------------------------------------------
// Tone (RawTherapee's exposure / tone-mapping engine)
// ---------------------------------------------------------------------------

/**
 * How blown highlights are rebuilt.
 * - `clip`      leave them clipped
 * - `blend`     roll the clipped channels toward neutral, killing magenta skies
 * - `propagate` borrow the surrounding hue and paint it back in
 */
export type HighlightRecovery = 'off' | 'clip' | 'blend' | 'propagate'

export interface ToneEdits {
  recovery: HighlightRecovery
  /** Level at which reconstruction starts, 0..100 of the clipping point. */
  recoveryThreshold: number

  /** Shadows/Highlights — local, radius-based recovery. */
  shHighlights: number
  shShadows: number
  /** Blur radius the local mean is measured over, 1..100. */
  shRadius: number
  /** How far up/down the range each control reaches, 10..100. */
  shTonalWidth: number

  /** Dynamic range compression: pulls the local mean toward the midtones. */
  drcAmount: number
  /** How much fine detail survives the compression, 0..100. */
  drcDetail: number

  /**
   * Contrast by detail levels — four octaves from finest to coarsest,
   * -100..100 each.
   */
  detailFinest: number
  detailFine: number
  detailCoarse: number
  detailCoarsest: number
  /** Noise floor the detail bands ignore, 0..100. */
  detailThreshold: number
}

// ---------------------------------------------------------------------------
// Tone curve
// ---------------------------------------------------------------------------

/** A control point in normalised 0..1 curve space. */
export interface CurvePoint {
  x: number
  y: number
}

export type CurveChannel = 'rgb' | 'red' | 'green' | 'blue'

export interface ParametricCurve {
  highlights: number
  lights: number
  darks: number
  shadows: number
  /** Region split points, 0..1. */
  shadowSplit: number
  midtoneSplit: number
  highlightSplit: number
}

/**
 * How the composite RGB curve is applied. RawTherapee's curve modes: the same
 * curve shape lands very differently depending on what it is applied to.
 */
export type CurveMode =
  | 'standard'
  | 'weighted'
  | 'filmLike'
  | 'saturationAndValue'
  | 'luminance'
  | 'perceptual'

export interface ToneCurveEdits {
  mode: 'parametric' | 'point'
  /** What the composite curve acts on. */
  rgbMode: CurveMode
  parametric: ParametricCurve
  rgb: CurvePoint[]
  red: CurvePoint[]
  green: CurvePoint[]
  blue: CurvePoint[]
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

export const COLOR_BANDS = [
  'red',
  'orange',
  'yellow',
  'green',
  'aqua',
  'blue',
  'purple',
  'magenta',
] as const

export type ColorBand = (typeof COLOR_BANDS)[number]

export type BandValues = Record<ColorBand, number>

export interface ColorMixerEdits {
  hue: BandValues
  saturation: BandValues
  luminance: BandValues
  /** Black & white channel mixer — how much each hue contributes to grey. */
  bw: BandValues
}

export interface GradeWheel {
  /** Degrees, 0..360. */
  hue: number
  /** 0..100. */
  saturation: number
  /** -100..100. */
  luminance: number
}

export interface ColorGradingEdits {
  shadows: GradeWheel
  midtones: GradeWheel
  highlights: GradeWheel
  global: GradeWheel
  /** How much the three ranges overlap, 0..100. */
  blending: number
  /** Pushes the shadow/highlight split, -100..100. */
  balance: number
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export interface DetailEdits {
  sharpenAmount: number
  sharpenRadius: number
  sharpenDetail: number
  /** Edge mask that keeps sharpening off flat areas like skin and sky. */
  sharpenMasking: number

  luminanceNR: number
  luminanceNRDetail: number
  luminanceNRContrast: number
  colorNR: number
  colorNRDetail: number
  colorNRSmoothness: number

  /** Impulse (salt-and-pepper / hot pixel) noise reduction, 0..100. */
  impulseNR: number
}

// ---------------------------------------------------------------------------
// Optics & geometry
// ---------------------------------------------------------------------------

export interface LensEdits {
  /**
   * Round-trips `crs:LensProfileEnable` so a sidecar written by another editor
   * survives an import/export cycle. esque ships no lens profile database, so
   * nothing reads it and no control exposes it — the sliders below are manual
   * corrections and always apply. Wire this up if profiles ever land.
   */
  enableProfile: boolean
  distortion: number
  vignetting: number
  /** Chromatic aberration, per-channel scale correction. */
  caRed: number
  caBlue: number
  defringePurpleAmount: number
  defringePurpleHueLo: number
  defringePurpleHueHi: number
  defringeGreenAmount: number
  defringeGreenHueLo: number
  defringeGreenHueHi: number
}

export interface TransformEdits {
  /** Degrees of perspective correction. */
  vertical: number
  horizontal: number
  rotate: number
  aspect: number
  scale: number
  offsetX: number
  offsetY: number
}

export type CropAspect =
  | 'free'
  | 'original'
  | '1x1'
  | '4x5'
  | '5x7'
  | '2x3'
  | '4x3'
  | '16x9'
  | '3x1'
  | '65x24'

export interface CropEdits {
  /** Normalised crop rect within the straightened frame. */
  left: number
  top: number
  right: number
  bottom: number
  /** Straighten angle in degrees, -45..45. */
  angle: number
  aspect: CropAspect
  aspectLocked: boolean
  /** Quarter-turns applied by the user, 0..3. */
  quarterTurns: number
  flipH: boolean
  flipV: boolean
}

// ---------------------------------------------------------------------------
// Effects & calibration
// ---------------------------------------------------------------------------

export interface EffectsEdits {
  vignetteAmount: number
  vignetteMidpoint: number
  vignetteRoundness: number
  vignetteFeather: number
  vignetteHighlights: number

  grainAmount: number
  grainSize: number
  grainRoughness: number
}

export interface CalibrationEdits {
  shadowTint: number
  redHue: number
  redSaturation: number
  greenHue: number
  greenSaturation: number
  blueHue: number
  blueSaturation: number
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

export type MaskComponentKind =
  | 'linear'
  | 'radial'
  | 'brush'
  | 'colorRange'
  | 'luminanceRange'
  | 'aiSubject'
  | 'aiSky'
  | 'aiBackground'
  | 'aiPerson'
  | 'aiObjects'

export type MaskBlend = 'add' | 'subtract' | 'intersect'

/** Normalised image-space point, 0..1 on both axes. */
export interface Point2 {
  x: number
  y: number
}

export interface LinearGradientGeometry {
  start: Point2
  end: Point2
}

export interface RadialGradientGeometry {
  center: Point2
  radiusX: number
  radiusY: number
  /** Radians. */
  rotation: number
  /** 0..100, how soft the edge is. */
  feather: number
}

export interface BrushDab {
  x: number
  y: number
  radius: number
  /** 0..1, accumulated paint strength. */
  flow: number
  erase: boolean
}

export interface BrushGeometry {
  dabs: BrushDab[]
  feather: number
  /** Restricts paint to pixels similar to the one under the cursor. */
  autoMask: boolean
}

export interface ColorRangeGeometry {
  /** Sampled colours in linear working space. */
  samples: Array<{ r: number; g: number; b: number }>
  /** 0..100 tolerance around the samples. */
  refine: number
}

export interface LuminanceRangeGeometry {
  /** Four stops describing the ramp: blackPoint, shadowFade, highlightFade, whitePoint. */
  range: [number, number, number, number]
  smoothness: number
}

export interface AiGeometry {
  /** OPFS key for the cached model output. */
  cacheKey: string | null
  /**
   * Which tier produced `cacheKey` — see `ai/models`.
   *
   * Kept alongside the key rather than parsed back out of it, because the two
   * answer different questions: the key says where the coverage is, this says
   * what the user asked for. Re-detecting after a crop, or on a photo whose
   * cache was evicted, has to reach for the same model they chose the first
   * time and not silently drop to the default.
   */
  model?: string
  /** For aiObjects: the user's box/brush hint. */
  hint?: { x: number; y: number; w: number; h: number }
  /** Guided-filter edge refinement radius. */
  refine: number
}

export type MaskGeometry =
  | ({ kind: 'linear' } & LinearGradientGeometry)
  | ({ kind: 'radial' } & RadialGradientGeometry)
  | ({ kind: 'brush' } & BrushGeometry)
  | ({ kind: 'colorRange' } & ColorRangeGeometry)
  | ({ kind: 'luminanceRange' } & LuminanceRangeGeometry)
  | ({ kind: 'aiSubject' | 'aiSky' | 'aiBackground' | 'aiPerson' | 'aiObjects' } & AiGeometry)

/** The kinds whose coverage comes from a model rather than from a shape. */
export const AI_MASK_KINDS = [
  'aiSubject',
  'aiSky',
  'aiBackground',
  'aiPerson',
  'aiObjects',
] as const

export type AiMaskGeometry = Extract<MaskGeometry, { kind: (typeof AI_MASK_KINDS)[number] }>

export function isAiGeometry(g: MaskGeometry): g is AiMaskGeometry {
  return (AI_MASK_KINDS as readonly string[]).includes(g.kind)
}

export interface MaskComponent {
  id: string
  blend: MaskBlend
  invert: boolean
  geometry: MaskGeometry
}

/** Local adjustments available inside a mask. Mirrors Lightroom's local set. */
export interface MaskAdjustments {
  exposure: number
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
  texture: number
  clarity: number
  dehaze: number
  temp: number
  tint: number
  saturation: number
  /** Colour overlay, applied like Lightroom's local Color swatch. */
  hue: number
  hueStrength: number
  colorize: number
  sharpness: number
  noise: number
  moire: number
  defringe: number
  /** Local curve, point mode only. */
  curve: CurvePoint[]
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/**
 * How a layer's own pixels combine with the picture beneath it.
 *
 * The separable modes are the Photoshop set, evaluated per channel in tone
 * space — the same space the tone controls work in, which is where these
 * formulas were defined and the only place `overlay` and `softLight` pivot
 * around a mid grey the eye agrees with. The four non-separable modes at the
 * end swap components of HSY between backdrop and layer instead.
 */
export type LayerBlend =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'colorDodge'
  | 'colorBurn'
  | 'hardLight'
  | 'softLight'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity'

/**
 * Where a layer's pixels come from, before its own adjustments run.
 *
 * `adjust` is the classic local adjustment: the layer's pixels *are* the
 * picture below it, so an exposure lift on a masked layer does what a Lightroom
 * mask has always done. `fill` and `image` bring pixels that were not in the
 * photograph, which is what makes a blend mode worth having.
 */
export type LayerContent =
  | { kind: 'adjust' }
  /** Solid colour, sRGB 0..1. */
  | { kind: 'fill'; color: [number, number, number] }
  /** Pixels imported from a file; `source` is the OPFS key they were cached under. */
  | { kind: 'image'; source: string; width: number; height: number }

/**
 * Placement of a layer's own pixels and its mask over the frame.
 *
 * The picture below is never moved — only what the layer brings. On an
 * adjustment layer there are no pixels to move, so this repositions the mask,
 * which is how a detected subject mask can be nudged back into register after
 * a crop.
 */
export interface LayerTransform {
  /** Percent of frame width/height, -100..100. */
  offsetX: number
  offsetY: number
  /** Percent, 100 = as placed. */
  scale: number
  /** Degrees, clockwise. */
  rotate: number
  flipH: boolean
  flipV: boolean
}

export interface Layer {
  id: string
  name: string
  visible: boolean
  /** The mask is inverted before it is used. */
  inverted: boolean
  /** 0..1 global multiplier for the whole layer. */
  opacity: number
  blend: LayerBlend
  /**
   * The layer's mask.
   *
   * An empty stack covers the whole frame — a fill layer with no mask is a flat
   * wash, which is what it should be. Components fold in order exactly as they
   * always have.
   */
  components: MaskComponent[]
  content: LayerContent
  adjustments: MaskAdjustments
  transform: LayerTransform
  /**
   * Confines this layer to the coverage of the layer below.
   *
   * A run of clipped layers all clip to the nearest unclipped layer under them,
   * as in Photoshop: three clipped layers over a cut-out subject stay on that
   * subject without any of them owning a copy of the mask.
   */
  clipped: boolean
  /**
   * Children, for a group. `null` on a leaf — that is what makes it a leaf.
   *
   * A group's mask, opacity and transform fold into every child. Its
   * `content` and `adjustments` are unused.
   */
  children: Layer[] | null
  /**
   * Group only: render the children against a copy of the backdrop and
   * composite that result with the group's blend mode, rather than letting each
   * child blend straight onto the picture (Photoshop's "Pass Through").
   */
  isolate: boolean
}

// ---------------------------------------------------------------------------
// Retouching
// ---------------------------------------------------------------------------

export interface SpotEdit {
  id: string
  mode: 'heal' | 'clone'
  target: Point2
  source: Point2
  /** Normalised to image width. */
  radius: number
  feather: number
  opacity: number
}

export interface RedEyeEdit {
  id: string
  kind: 'human' | 'pet'
  center: Point2
  radius: number
  darken: number
}

// ---------------------------------------------------------------------------
// The whole edit stack
// ---------------------------------------------------------------------------

export const EDITS_VERSION = 4

/**
 * The base rendering a RAW is mapped through — see `core/profiles.ts`.
 *
 * `name` is a starting point rather than a mode: it picks the three values, and
 * moving any of them by hand flips it to `custom`, exactly as a nudged Temp
 * turns a white balance preset into Custom. The values are what actually
 * renders, so the dropdown can never mean something the sliders do not show.
 */
export interface ProfileEdits {
  /** Id of the named base these values came from, or `custom` once edited. */
  name: string
  /** How far below scene white the highlight roll-off starts, 0..40. */
  rolloff: number
  /** Strength of the filmic S applied in tone space, 0..100. */
  contrast: number
  /** Saturation trim baked into the base rendering, -100..100. */
  saturation: number
}

export interface Edits {
  version: number
  /** Camera profile / rendering intent — see `core/profiles.ts`. */
  profile: ProfileEdits
  basic: BasicEdits
  tone: ToneEdits
  curve: ToneCurveEdits
  colorMixer: ColorMixerEdits
  colorGrading: ColorGradingEdits
  detail: DetailEdits
  lens: LensEdits
  transform: TransformEdits
  crop: CropEdits
  effects: EffectsEdits
  calibration: CalibrationEdits
  layers: Layer[]
  spots: SpotEdit[]
  redEye: RedEyeEdit[]
}

/**
 * Panel identifiers, used for per-panel reset, copy/paste and sync.
 *
 * `profile` is in here even though it is a bare string: on a RAW the camera
 * profile is the base rendering everything else sits on, so a preset or a sync
 * that can't carry it can't reproduce the look it promises.
 */
export type EditSection = keyof Omit<Edits, 'version'>

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export type ColorLabel = 'none' | 'red' | 'yellow' | 'green' | 'blue' | 'purple'
export type PickFlag = 'unflagged' | 'pick' | 'reject'

export interface PhotoMetadata {
  cameraMake: string
  cameraModel: string
  lens: string
  iso: number
  shutter: number
  aperture: number
  focalLength: number
  captureTime: number | null
  artist: string
  copyright: string
  gps: { lat: number; lon: number; alt: number } | null
  /** LibRaw EXIF orientation code, 0..7. */
  flip: number
  /** Camera-recorded white balance multipliers. */
  camMul: number[] | null
  /** Multipliers LibRaw actually used when the camera value was unavailable. */
  preMul: number[] | null
  /** LibRaw/DNG XYZ -> camera matrix, inverted to derive absolute Kelvin. */
  camXyz: number[][] | null
  /** Raw sensor black/white levels; useful for highlight reconstruction. */
  black: number | null
  maximum: number | null
  /** Camera-recommended active area, relative to LibRaw's visible frame. */
  rawCrop?: [number, number, number, number] | null
  /** Native camera-preview dimensions, used to avoid unnecessary demosaics. */
  embeddedWidth?: number
  embeddedHeight?: number
}

export interface Photo {
  id: string
  folderId: string
  /** Path relative to the imported folder root, used for display and dedupe. */
  relPath: string
  filename: string
  ext: string
  isRaw: boolean
  /**
   * True when the file itself carries light above SDR white: a gain map, a PQ
   * or HLG transfer, or RAW's own highlight headroom. Absent on photos
   * imported before this was detected — read it through `photoIsHdr`, which
   * supplies the fallback.
   */
  hdr?: boolean
  fileSize: number
  modifiedAt: number
  addedAt: number
  width: number
  height: number
  meta: PhotoMetadata
  rating: number
  flag: PickFlag
  label: ColorLabel
  keywords: string[]
  title: string
  caption: string
  edits: Edits | null
  /** OPFS cache keys. */
  thumbKey: string | null
  /**
   * Bumped each time the grid thumbnail is re-rendered from your edits, so the
   * key changes and the grid picks it up. 0 / absent means the thumbnail is
   * still the one made at import.
   */
  thumbRev?: number
  /**
   * Bumped each time the saved settings change, so the standard preview's
   * cache key — and the blob URL memoised against it — retire with them.
   */
  previewRev?: number
  proxyKey: string | null
  /** Virtual copies point at their master. */
  masterId: string | null
  copyName: string | null
  /** Stacking. */
  stackId: string | null
  stackPosition: number
  stackCollapsed: boolean
  /**
   * Human-readable reason this file could not be decoded, or null when it read
   * cleanly. Set at import and refreshed whenever Develop tries to open it, so
   * an unsupported camera explains itself instead of showing a blank frame.
   */
  readError?: string | null
  /**
   * Handle for files imported individually, which have no folder to resolve
   * their path against. Absent for photos that came from a folder import.
   */
  fileHandle?: FileSystemFileHandle | null
}

export interface CatalogFolder {
  id: string
  name: string
  /**
   * Persisted FileSystemDirectoryHandle, stored via structured clone. Null on
   * the synthetic folder that holds individually imported files, which have no
   * directory of their own.
   */
  handle: FileSystemDirectoryHandle | null
  /** True for the synthetic folder collecting loose, individually picked files. */
  loose?: boolean
  addedAt: number
  photoCount: number
}

export type SmartRuleField =
  | 'rating'
  | 'flag'
  | 'label'
  | 'filename'
  | 'keyword'
  | 'camera'
  | 'lens'
  | 'iso'
  | 'aperture'
  | 'focalLength'
  | 'captureTime'
  | 'edited'
  | 'fileType'

export type SmartRuleOp =
  | 'is'
  | 'isNot'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'gte'
  | 'lte'
  | 'inRange'

export interface SmartRule {
  field: SmartRuleField
  op: SmartRuleOp
  value: string | number | boolean
  value2?: string | number
}

export interface Collection {
  id: string
  name: string
  /** Smart collections compute membership from rules instead of storing it. */
  smart: boolean
  rules: SmartRule[]
  match: 'all' | 'any'
  photoIds: string[]
  createdAt: number
  setId: string | null
}

export interface Preset {
  id: string
  name: string
  group: string
  builtin: boolean
  /** The sections the preset reaches into, for grouping and for the UI. */
  sections: EditSection[]
  /**
   * The individual fields the preset sets, as dotted paths like
   * `basic.contrast`. This is what actually gets applied: a preset that says
   * nothing about white balance must leave the photo's white balance alone,
   * which matters enormously on a RAW and not at all on a JPEG.
   *
   * Optional because presets saved before field-level application exist in
   * catalogs already; those fall back to replacing whole sections.
   */
  paths?: string[]
  edits: Partial<Edits>
  createdAt: number
}

export interface Snapshot {
  id: string
  photoId: string
  name: string
  edits: Edits
  createdAt: number
}

/** One labelled step in Lightroom's linear history list. */
export interface HistoryStep {
  id: string
  label: string
  detail: string
  edits: Edits
  at: number
}
