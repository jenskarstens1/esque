/**
 * Lightroom / Camera Raw XMP interop.
 *
 * Two jobs:
 *  1. read `.xmp` presets and sidecars written by Lightroom and Camera Raw,
 *  2. write them back out, so a photo edited in esque opens correctly in
 *     Lightroom and vice versa.
 *
 * Adobe's `crs:` namespace is a flat bag of attributes and a handful of
 * `rdf:Seq` lists. Values arrive as strings, sometimes as attributes and
 * sometimes as child elements depending on which version wrote the file, so
 * everything is read through one accessor that checks both.
 */
import { defaultEdits, defaultMaskAdjustments, sectionOfPath } from '../core/defaults'
import { CAMERA_PROFILES, cameraProfile } from '../core/profiles'
import { COLOR_BANDS, EDITS_VERSION } from '../core/types'
import { migratePartialEdits } from './migrate'
import type {
  ColorBand,
  CropAspect,
  CurveMode,
  CurvePoint,
  EditSection,
  Edits,
  HighlightRecovery,
  Preset,
  WhiteBalanceMode,
  Mask,
  MaskAdjustments,
  MaskComponent,
  MaskGeometry,
  Point2,
  RedEyeEdit,
  SpotEdit,
} from '../core/types'
import { clamp, nextId } from '../lib/math'

const CRS = 'http://ns.adobe.com/camera-raw-settings/1.0/'
/*
 * Adobe has no field for RawTherapee's tone mapping, detail bands or curve
 * modes, so those live in a namespace of our own. Lightroom skips what it
 * doesn't know, which keeps the sidecar readable at both ends.
 */
const ESQ = 'https://esque.photo/ns/1.0/'

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Flattens every crs value in the document into one map. */
function crsBag(doc: Document): Map<string, string> {
  const bag = new Map<string, string>()

  const descriptions = doc.getElementsByTagNameNS(
    'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    'Description',
  )
  for (const desc of Array.from(descriptions)) {
    for (const attr of Array.from(desc.attributes)) {
      if (attr.namespaceURI === CRS) bag.set(attr.localName, attr.value)
      else if (attr.namespaceURI === ESQ) bag.set(`esq:${attr.localName}`, attr.value)
    }
  }

  // Element form: <crs:Exposure2012>+0.35</crs:Exposure2012>
  for (const el of Array.from([
    ...Array.from(doc.getElementsByTagNameNS(CRS, '*')),
    ...Array.from(doc.getElementsByTagNameNS(ESQ, '*')),
  ])) {
    const key = el.namespaceURI === ESQ ? `esq:${el.localName}` : el.localName
    if (bag.has(key)) continue
    const seq = el.getElementsByTagNameNS(
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
      'li',
    )
    if (seq.length) {
      bag.set(
        key,
        Array.from(seq)
          .map((li) => li.textContent?.trim() ?? '')
          .join('|'),
      )
    } else {
      const text = el.textContent?.trim()
      if (text) bag.set(key, text)
    }
  }

  return bag
}

const cap = (b: string) => b[0].toUpperCase() + b.slice(1)

interface Reader {
  has(key: string): boolean
  /** First present key wins, so PV2012 names take priority over legacy ones. */
  num(keys: string | string[], fallback?: number): number
  bool(keys: string | string[], fallback?: boolean): boolean
  str(keys: string | string[], fallback?: string): string
  points(keys: string | string[]): CurvePoint[] | null
  /**
   * The exact fields the file mentioned, as dotted `Edits` paths.
   *
   * A Lightroom preset is a sparse list of crs attributes, and applying it
   * should change that list and nothing else. Recording only the *section*
   * meant a preset carrying a single `crs:Contrast2012` also reset white
   * balance, exposure and treatment — harmless on a JPEG, ruinous on a RAW.
   */
  touched: Set<string>
  /** Declares `path` as present when any of `keys` is in the file. */
  mark(path: string, keys: string | string[]): boolean
  /** Declares `path` as present unconditionally, for fields read another way. */
  claim(path: string): void
}

function reader(bag: Map<string, string>): Reader {
  const list = (k: string | string[]) => (Array.isArray(k) ? k : [k])
  const first = (keys: string | string[]): string | undefined => {
    for (const k of list(keys)) {
      const v = bag.get(k)
      if (v !== undefined && v !== '') return v
    }
    return undefined
  }
  const touched = new Set<string>()

  return {
    touched,
    has: (k) => first(k) !== undefined,
    num(keys, fallback = 0) {
      const raw = first(keys)
      if (raw === undefined) return fallback
      // Lightroom writes rationals like "4/5" for a few legacy fields.
      if (raw.includes('/')) {
        const [n, d] = raw.split('/').map(Number)
        return d ? n / d : fallback
      }
      const v = Number.parseFloat(raw)
      return Number.isFinite(v) ? v : fallback
    },
    bool(keys, fallback = false) {
      const raw = first(keys)
      if (raw === undefined) return fallback
      return raw.toLowerCase() === 'true' || raw === '1'
    },
    str(keys, fallback = '') {
      return first(keys) ?? fallback
    },
    points(keys) {
      const raw = first(keys)
      if (raw === undefined) return null
      const pts = raw
        .split('|')
        .map((pair) => pair.split(',').map((n) => Number.parseFloat(n.trim())))
        .filter((p) => p.length === 2 && p.every(Number.isFinite))
        .map(([x, y]) => ({ x: x / 255, y: y / 255 }))
      return pts.length >= 2 ? pts : null
    },
    mark(path, keys) {
      const hit = first(keys) !== undefined
      if (hit) touched.add(path)
      return hit
    },
    claim(path) {
      touched.add(path)
    },
  }
}

const WB_MAP: Record<string, WhiteBalanceMode> = {
  'as shot': 'asShot',
  asshot: 'asShot',
  auto: 'auto',
  daylight: 'daylight',
  cloudy: 'cloudy',
  shade: 'shade',
  tungsten: 'tungsten',
  fluorescent: 'fluorescent',
  flash: 'flash',
  custom: 'custom',
}

export interface ParsedXmp {
  name: string
  group: string
  edits: Edits
  /** Only the sections the file actually specified. */
  sections: EditSection[]
  /** The individual fields it specified, as dotted `Edits` paths. */
  paths: string[]
  /** True when the file is a preset rather than a per-photo sidecar. */
  isPreset: boolean
  /** Lightroom's own amount-scaling flag, preserved on round-trip. */
  supportsAmount: boolean
}

type NumberField = readonly [
  path: string,
  keys: string | string[],
  fallback: number | undefined,
  set: (value: number) => void,
]

function readNumbers(r: Reader, fields: NumberField[]): void {
  for (const [path, keys, fallback, set] of fields) {
    if (r.mark(path, keys)) set(r.num(keys, fallback))
  }
}

function parseBasic(r: Reader, e: Edits): void {
  const wbRaw = r.str('WhiteBalance').trim().toLowerCase()
  if (wbRaw) {
    e.basic.wbMode = WB_MAP[wbRaw] ?? 'custom'
    r.claim('basic.wbMode')
  }
  readNumbers(r, [
    ['basic.temp', 'Temperature', 5500, (v) => (e.basic.temp = v)],
    ['basic.tint', 'Tint', undefined, (v) => (e.basic.tint = v)],
    ['basic.exposure', ['Exposure2012', 'Exposure'], undefined, (v) => (e.basic.exposure = v)],
    ['basic.contrast', ['Contrast2012', 'Contrast'], undefined, (v) => (e.basic.contrast = v)],
    ['basic.highlights', ['Highlights2012', 'HighlightRecovery'], undefined, (v) => (e.basic.highlights = v)],
    ['basic.shadows', ['Shadows2012', 'FillLight'], undefined, (v) => (e.basic.shadows = v)],
    ['basic.whites', 'Whites2012', undefined, (v) => (e.basic.whites = v)],
    ['basic.blacks', ['Blacks2012', 'Blacks'], undefined, (v) => (e.basic.blacks = v)],
    ['basic.texture', 'Texture', undefined, (v) => (e.basic.texture = v)],
    ['basic.clarity', ['Clarity2012', 'Clarity'], undefined, (v) => (e.basic.clarity = v)],
    ['basic.dehaze', 'Dehaze', undefined, (v) => (e.basic.dehaze = v)],
    ['basic.vibrance', 'Vibrance', undefined, (v) => (e.basic.vibrance = v)],
    ['basic.saturation', 'Saturation', undefined, (v) => (e.basic.saturation = v)],
  ])
  if (r.mark('basic.treatment', 'ConvertToGrayscale'))
    e.basic.treatment = r.bool('ConvertToGrayscale') ? 'bw' : 'color'
  if (r.mark('basic.protectSkin', 'esq:ProtectSkin'))
    e.basic.protectSkin = r.bool('esq:ProtectSkin', true)
  if (r.mark('basic.avoidColorShift', 'esq:AvoidColorShift'))
    e.basic.avoidColorShift = r.bool('esq:AvoidColorShift')
}

function parseProfile(r: Reader, e: Edits): void {
  if (!r.mark('profile', ['esq:Profile', 'CameraProfile'])) return
  const named = r.str(['esq:Profile', 'CameraProfile']).trim().toLowerCase()
  const match = CAMERA_PROFILES.find((p) => p.id === named || p.name.toLowerCase() === named)
  if (match) e.profile = match.id
  else r.touched.delete('profile')
}

function parseTone(r: Reader, e: Edits): void {
  const recovery: HighlightRecovery[] = ['off', 'clip', 'blend', 'propagate']
  if (r.mark('tone.recovery', 'esq:HighlightRecovery')) {
    const mode = r.str('esq:HighlightRecovery') as HighlightRecovery
    e.tone.recovery = recovery.includes(mode) ? mode : 'off'
  }
  const defaults = defaultEdits().tone
  const fields = [
    ['esq:RecoveryThreshold', 'recoveryThreshold'],
    ['esq:SHHighlights', 'shHighlights'],
    ['esq:SHShadows', 'shShadows'],
    ['esq:SHRadius', 'shRadius'],
    ['esq:SHTonalWidth', 'shTonalWidth'],
    ['esq:DRCAmount', 'drcAmount'],
    ['esq:DRCDetail', 'drcDetail'],
    ['esq:DetailFinest', 'detailFinest'],
    ['esq:DetailFine', 'detailFine'],
    ['esq:DetailCoarse', 'detailCoarse'],
    ['esq:DetailCoarsest', 'detailCoarsest'],
    ['esq:DetailThreshold', 'detailThreshold'],
  ] as const
  for (const [key, field] of fields) {
    if (r.mark(`tone.${field}`, key)) e.tone[field] = r.num(key, defaults[field] as number)
  }
}

function parseCurve(r: Reader, e: Edits): void {
  const parametric = [
    ['ParametricHighlights', 'highlights'],
    ['ParametricLights', 'lights'],
    ['ParametricDarks', 'darks'],
    ['ParametricShadows', 'shadows'],
  ] as const
  for (const [key, field] of parametric) {
    if (r.mark(`curve.parametric.${field}`, key)) e.curve.parametric[field] = r.num(key)
  }
  readNumbers(r, [
    ['curve.parametric.shadowSplit', 'ParametricShadowSplit', 25, (v) => (e.curve.parametric.shadowSplit = v / 100)],
    ['curve.parametric.midtoneSplit', 'ParametricMidtoneSplit', 50, (v) => (e.curve.parametric.midtoneSplit = v / 100)],
    ['curve.parametric.highlightSplit', 'ParametricHighlightSplit', 75, (v) => (e.curve.parametric.highlightSplit = v / 100)],
  ])
  for (const [field, keys] of [
    ['rgb', ['ToneCurvePV2012', 'ToneCurve']],
    ['red', ['ToneCurvePV2012Red', 'ToneCurveRed']],
    ['green', ['ToneCurvePV2012Green', 'ToneCurveGreen']],
    ['blue', ['ToneCurvePV2012Blue', 'ToneCurveBlue']],
  ] as const) {
    const points = r.points(keys as unknown as string[])
    if (points) {
      e.curve[field] = points
      r.claim(`curve.${field}`)
    }
  }
  if (e.curve.rgb.length > 2 || e.curve.rgb.some((p) => Math.abs(p.x - p.y) > 1e-3)) {
    e.curve.mode = 'point'
    r.claim('curve.mode')
  }
  if (r.mark('curve.mode', 'esq:CurveEditMode')) {
    const mode = r.str('esq:CurveEditMode')
    if (mode === 'parametric' || mode === 'point') e.curve.mode = mode
  }
  if (r.mark('curve.rgbMode', 'esq:CurveMode')) {
    const mode = r.str('esq:CurveMode') as CurveMode
    const modes: CurveMode[] = ['standard', 'weighted', 'filmLike', 'saturationAndValue', 'luminance', 'perceptual']
    e.curve.rgbMode = modes.includes(mode) ? mode : 'standard'
  }
}

function parseColor(r: Reader, e: Edits): void {
  for (const band of COLOR_BANDS) {
    const name = cap(band)
    readNumbers(r, [
      [`colorMixer.hue.${band}`, `HueAdjustment${name}`, undefined, (v) => (e.colorMixer.hue[band as ColorBand] = v)],
      [`colorMixer.saturation.${band}`, `SaturationAdjustment${name}`, undefined, (v) => (e.colorMixer.saturation[band as ColorBand] = v)],
      [`colorMixer.luminance.${band}`, `LuminanceAdjustment${name}`, undefined, (v) => (e.colorMixer.luminance[band as ColorBand] = v)],
      [`colorMixer.bw.${band}`, `GrayMixer${name}`, undefined, (v) => (e.colorMixer.bw[band as ColorBand] = v)],
    ])
  }
  for (const [field, modern, legacy] of [
    ['shadows', 'ColorGradeShadow', 'SplitToningShadow'],
    ['midtones', 'ColorGradeMidtone', null],
    ['highlights', 'ColorGradeHighlight', 'SplitToningHighlight'],
    ['global', 'ColorGradeGlobal', null],
  ] as const) {
    const hue = legacy ? [`${modern}Hue`, `${legacy}Hue`] : [`${modern}Hue`]
    const saturation = legacy ? [`${modern}Sat`, `${legacy}Saturation`] : [`${modern}Sat`]
    readNumbers(r, [
      [`colorGrading.${field}.hue`, hue, undefined, (v) => (e.colorGrading[field].hue = v)],
      [`colorGrading.${field}.saturation`, saturation, undefined, (v) => (e.colorGrading[field].saturation = v)],
      [`colorGrading.${field}.luminance`, `${modern}Lum`, undefined, (v) => (e.colorGrading[field].luminance = v)],
    ])
  }
  readNumbers(r, [
    ['colorGrading.blending', 'ColorGradeBlending', 50, (v) => (e.colorGrading.blending = v)],
    ['colorGrading.balance', ['ColorGradeGlobalBalance', 'SplitToningBalance'], undefined, (v) => (e.colorGrading.balance = v)],
  ])
}

function parseDetailEffects(r: Reader, e: Edits): void {
  readNumbers(r, [
    ['detail.sharpenAmount', 'Sharpness', 40, (v) => (e.detail.sharpenAmount = v)],
    ['detail.sharpenRadius', 'SharpenRadius', 1, (v) => (e.detail.sharpenRadius = v)],
    ['detail.sharpenDetail', 'SharpenDetail', 25, (v) => (e.detail.sharpenDetail = v)],
    ['detail.sharpenMasking', 'SharpenEdgeMasking', undefined, (v) => (e.detail.sharpenMasking = v)],
    ['detail.luminanceNR', 'LuminanceSmoothing', undefined, (v) => (e.detail.luminanceNR = v)],
    ['detail.luminanceNRDetail', 'LuminanceNoiseReductionDetail', 50, (v) => (e.detail.luminanceNRDetail = v)],
    ['detail.luminanceNRContrast', 'LuminanceNoiseReductionContrast', undefined, (v) => (e.detail.luminanceNRContrast = v)],
    ['detail.colorNR', 'ColorNoiseReduction', 25, (v) => (e.detail.colorNR = v)],
    ['detail.colorNRDetail', 'ColorNoiseReductionDetail', 50, (v) => (e.detail.colorNRDetail = v)],
    ['detail.colorNRSmoothness', 'ColorNoiseReductionSmoothness', 50, (v) => (e.detail.colorNRSmoothness = v)],
    ['detail.impulseNR', 'esq:ImpulseNR', undefined, (v) => (e.detail.impulseNR = v)],
    ['effects.vignetteAmount', 'PostCropVignetteAmount', undefined, (v) => (e.effects.vignetteAmount = v)],
    ['effects.vignetteMidpoint', 'PostCropVignetteMidpoint', 50, (v) => (e.effects.vignetteMidpoint = v)],
    ['effects.vignetteRoundness', 'PostCropVignetteRoundness', undefined, (v) => (e.effects.vignetteRoundness = v)],
    ['effects.vignetteFeather', 'PostCropVignetteFeather', 50, (v) => (e.effects.vignetteFeather = v)],
    ['effects.vignetteHighlights', 'PostCropVignetteHighlightContrast', undefined, (v) => (e.effects.vignetteHighlights = v)],
    ['effects.grainAmount', 'GrainAmount', undefined, (v) => (e.effects.grainAmount = v)],
    ['effects.grainSize', 'GrainSize', 25, (v) => (e.effects.grainSize = v)],
    ['effects.grainRoughness', 'GrainFrequency', 50, (v) => (e.effects.grainRoughness = v)],
  ])
}

function parseCalibrationLensTransform(r: Reader, e: Edits): void {
  readNumbers(r, [
    ['calibration.shadowTint', 'ShadowTint', undefined, (v) => (e.calibration.shadowTint = v)],
    ['calibration.redHue', 'RedHue', undefined, (v) => (e.calibration.redHue = v)],
    ['calibration.redSaturation', 'RedSaturation', undefined, (v) => (e.calibration.redSaturation = v)],
    ['calibration.greenHue', 'GreenHue', undefined, (v) => (e.calibration.greenHue = v)],
    ['calibration.greenSaturation', 'GreenSaturation', undefined, (v) => (e.calibration.greenSaturation = v)],
    ['calibration.blueHue', 'BlueHue', undefined, (v) => (e.calibration.blueHue = v)],
    ['calibration.blueSaturation', 'BlueSaturation', undefined, (v) => (e.calibration.blueSaturation = v)],
    ['lens.distortion', 'LensManualDistortionAmount', undefined, (v) => (e.lens.distortion = v)],
    ['lens.vignetting', 'VignetteAmount', undefined, (v) => (e.lens.vignetting = v)],
    ['lens.caRed', 'ChromaticAberrationR', undefined, (v) => (e.lens.caRed = v)],
    ['lens.caBlue', 'ChromaticAberrationB', undefined, (v) => (e.lens.caBlue = v)],
    ['lens.defringePurpleAmount', 'DefringePurpleAmount', undefined, (v) => (e.lens.defringePurpleAmount = v)],
    ['lens.defringePurpleHueLo', 'DefringePurpleHueLo', 30, (v) => (e.lens.defringePurpleHueLo = v)],
    ['lens.defringePurpleHueHi', 'DefringePurpleHueHi', 70, (v) => (e.lens.defringePurpleHueHi = v)],
    ['lens.defringeGreenAmount', 'DefringeGreenAmount', undefined, (v) => (e.lens.defringeGreenAmount = v)],
    ['lens.defringeGreenHueLo', 'DefringeGreenHueLo', 40, (v) => (e.lens.defringeGreenHueLo = v)],
    ['lens.defringeGreenHueHi', 'DefringeGreenHueHi', 60, (v) => (e.lens.defringeGreenHueHi = v)],
    ['transform.vertical', 'PerspectiveVertical', undefined, (v) => (e.transform.vertical = v)],
    ['transform.horizontal', 'PerspectiveHorizontal', undefined, (v) => (e.transform.horizontal = v)],
    ['transform.rotate', 'PerspectiveRotate', undefined, (v) => (e.transform.rotate = v)],
    ['transform.aspect', 'PerspectiveAspect', undefined, (v) => (e.transform.aspect = v)],
    ['transform.offsetX', 'PerspectiveX', undefined, (v) => (e.transform.offsetX = v)],
    ['transform.offsetY', 'PerspectiveY', undefined, (v) => (e.transform.offsetY = v)],
    ['transform.scale', 'PerspectiveScale', 100, (v) => (e.transform.scale = v)],
  ])
  if (r.mark('lens.enableProfile', 'LensProfileEnable'))
    e.lens.enableProfile = r.num('LensProfileEnable') > 0
}

function parseCrop(r: Reader, e: Edits): void {
  if (r.bool('HasCrop')) {
    for (const field of ['left', 'top', 'right', 'bottom', 'angle', 'aspect'] as const)
      r.claim(`crop.${field}`)
    e.crop.left = r.num('CropLeft')
    e.crop.top = r.num('CropTop')
    e.crop.right = r.num('CropRight', 1)
    e.crop.bottom = r.num('CropBottom', 1)
    e.crop.angle = r.num('CropAngle')
    e.crop.aspect = 'free'
  }
  const aspect = r.str('esq:CropAspect')
  if (aspect && r.mark('crop.aspect', 'esq:CropAspect')) e.crop.aspect = aspect as CropAspect
  if (r.mark('crop.aspectLocked', 'esq:CropAspectLocked'))
    e.crop.aspectLocked = r.num('esq:CropAspectLocked') > 0
  if (r.mark('crop.quarterTurns', 'esq:QuarterTurns'))
    e.crop.quarterTurns = ((Math.round(r.num('esq:QuarterTurns')) % 4) + 4) % 4
  if (r.mark('crop.flipH', 'esq:FlipH')) e.crop.flipH = r.num('esq:FlipH') > 0
  if (r.mark('crop.flipV', 'esq:FlipV')) e.crop.flipV = r.num('esq:FlipV') > 0
}

function parseJsonList<T>(
  r: Reader,
  path: string,
  key: string,
  normalise: (raw: unknown) => T | null,
  set: (items: T[]) => void,
): void {
  const raw = r.str(key)
  if (!raw || !r.mark(path, key)) return
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) set(parsed.map(normalise).filter((item): item is T => item !== null))
  } catch {
    // Corrupt local-adjustment data must not discard the rest of a sidecar.
  }
}

function parseLocalAdjustments(r: Reader, e: Edits): void {
  parseJsonList(r, 'masks', 'esq:Masks', normaliseMask, (items) => (e.masks = items))
  parseJsonList(r, 'spots', 'esq:Spots', normaliseSpot, (items) => (e.spots = items))
  parseJsonList(r, 'redEye', 'esq:RedEye', normaliseEye, (items) => (e.redEye = items))
}

export function parseXmp(xml: string): ParsedXmp | null {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) return null

  const bag = crsBag(doc)
  if (!bag.size) return null
  const r = reader(bag)
  const edits = defaultEdits()
  parseBasic(r, edits)
  parseProfile(r, edits)
  parseTone(r, edits)
  parseCurve(r, edits)
  parseColor(r, edits)
  parseDetailEffects(r, edits)
  parseCalibrationLensTransform(r, edits)
  parseCrop(r, edits)
  parseLocalAdjustments(r, edits)

  const name = doc.querySelector('crs\\:Name rdf\\:li')?.textContent?.trim() || r.str('Name') || ''
  const group =
    doc.querySelector('crs\\:Group rdf\\:li')?.textContent?.trim() ||
    r.str('Group') ||
    r.str('Cluster') ||
    ''
  const paths = [...r.touched]
  const editVersion = Math.max(1, Math.round(r.num('esq:EditVersion'))) || 1
  return {
    name,
    group,
    edits: migratePartialEdits(edits, editVersion) as Edits,
    sections: [...new Set(paths.map(sectionOfPath))],
    paths,
    isPreset: !bag.has('RawFileName') && (r.str('PresetType') !== '' || r.bool('HasSettings') || !!name),
    supportsAmount: r.bool('SupportsAmount'),
  }
}

// ---------------------------------------------------------------------------
// .lrtemplate (Lightroom 3–5 era presets, a Lua table)
// ---------------------------------------------------------------------------

/** Maps the Lua key names, which match the crs attribute names exactly. */
export function parseLrTemplate(text: string): ParsedXmp | null {
  const settings = text.match(/settings\s*=\s*\{([\s\S]*?)\n\t*\}/)
  if (!settings) return null

  const bag = new Map<string, string>()
  const pair = /(\w+)\s*=\s*("([^"]*)"|-?[\d.]+|true|false)/g
  let m: RegExpExecArray | null
  while ((m = pair.exec(settings[1]))) {
    bag.set(m[1], m[3] ?? m[2])
  }

  // Point curves are Lua arrays of alternating x, y values.
  for (const [luaKey, crsKey] of [
    ['ToneCurvePV2012', 'ToneCurvePV2012'],
    ['ToneCurvePV2012Red', 'ToneCurvePV2012Red'],
    ['ToneCurvePV2012Green', 'ToneCurvePV2012Green'],
    ['ToneCurvePV2012Blue', 'ToneCurvePV2012Blue'],
    ['ToneCurve', 'ToneCurve'],
  ] as const) {
    const arr = text.match(new RegExp(`${luaKey}\\s*=\\s*\\{([^}]*)\\}`))
    if (!arr) continue
    const nums = arr[1]
      .split(',')
      .map((n) => Number.parseFloat(n.trim()))
      .filter(Number.isFinite)
    const pts: string[] = []
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push(`${nums[i]}, ${nums[i + 1]}`)
    if (pts.length >= 2) bag.set(crsKey, pts.join('|'))
  }

  const title = text.match(/title\s*=\s*"([^"]*)"/)
  const group = text.match(/group\s*=\s*\{[^}]*?value\s*=\s*"([^"]*)"/)

  // Reuse the XMP path by synthesising a minimal document.
  const attrs = [...bag]
    .map(([k, v]) => `crs:${k}="${escapeXml(v)}"`)
    .join('\n   ')
  const xml = `<?xml version="1.0"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="${CRS}"
   ${attrs}/>
 </rdf:RDF>
</x:xmpmeta>`

  const parsed = parseXmp(xml)
  if (!parsed) return null
  return {
    ...parsed,
    name: title?.[1] ?? parsed.name,
    group: group?.[1] ?? parsed.group,
    isPreset: true,
  }
}

/** Reads whichever of the two formats a file actually is. */
export function parsePresetFile(filename: string, text: string): Preset | null {
  const parsed = filename.toLowerCase().endsWith('.lrtemplate')
    ? parseLrTemplate(text)
    : parseXmp(text)
  if (!parsed || !parsed.paths.length) return null

  // The patch carries whole sections so the shape stays inspectable, but
  // `paths` is what gets applied — a Lightroom pack that only sets Contrast has
  // no business resetting the photo's white balance.
  const patch: Partial<Edits> = {}
  for (const section of parsed.sections) {
    ;(patch as unknown as Record<string, unknown>)[section] = (
      parsed.edits as unknown as Record<string, unknown>
    )[section]
  }

  const stem = filename.replace(/\.[^.]+$/, '')
  return {
    id: nextId(),
    name: parsed.name || stem,
    group: parsed.group || 'Imported',
    builtin: false,
    sections: parsed.sections,
    paths: parsed.paths,
    edits: patch,
    createdAt: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const n = (v: number, decimals = 0): string => {
  const r = Number(v.toFixed(decimals))
  return decimals === 0 ? String(Math.round(r)) : (r > 0 ? '+' : '') + r.toFixed(decimals)
}

const int = (v: number): string => String(Math.round(v))

function curveSeq(tag: string, pts: CurvePoint[]): string {
  const items = pts
    .map((p) => `     <rdf:li>${Math.round(p.x * 255)}, ${Math.round(p.y * 255)}</rdf:li>`)
    .join('\n')
  return `   <crs:${tag}>\n    <rdf:Seq>\n${items}\n    </rdf:Seq>\n   </crs:${tag}>`
}

const WB_OUT: Record<WhiteBalanceMode, string> = {
  asShot: 'As Shot',
  auto: 'Auto',
  daylight: 'Daylight',
  cloudy: 'Cloudy',
  shade: 'Shade',
  tungsten: 'Tungsten',
  fluorescent: 'Fluorescent',
  flash: 'Flash',
  custom: 'Custom',
}

/**
 * Builds the crs attribute list for a set of sections, optionally narrowed to
 * an exact set of fields.
 *
 * The narrowing is what makes a field-level preset survive a trip through disk.
 * Writing a whole section for a preset that only carries `basic.contrast` would
 * put `crs:Temperature` and `crs:Exposure2012` in the file, and re-importing it
 * would hand back a preset that once again resets your white balance — the
 * exact failure the field-level model exists to prevent.
 */
type PutAttribute = (path: string, ...attributes: string[]) => void

interface AttributeWriter {
  out: string[]
  put: PutAttribute
  wants(path: string): boolean
}

function attributeWriter(sections: EditSection[], only?: string[] | null): AttributeWriter {
  const wanted = new Set(sections)
  const allowed = only?.length ? new Set(only) : null
  const out = [
    'crs:Version="15.0"',
    'crs:ProcessVersion="11.0"',
    `esq:EditVersion="${EDITS_VERSION}"`,
  ]
  const wants = (path: string) => wanted.has(sectionOfPath(path)) && (!allowed || allowed.has(path))
  return { out, wants, put: (path, ...attributes) => { if (wants(path)) out.push(...attributes) } }
}

function writeBasicAttributes(e: Edits, put: PutAttribute): void {
  const b = e.basic
  put('profile', `crs:CameraProfile="${xmlAttr(cameraProfile(e.profile).name)}"`, `esq:Profile="${xmlAttr(e.profile)}"`)
  put('basic.wbMode', `crs:WhiteBalance="${WB_OUT[b.wbMode]}"`)
  for (const [path, attribute] of [
    ['basic.temp', `crs:Temperature="${int(b.temp)}"`], ['basic.tint', `crs:Tint="${int(b.tint)}"`],
    ['basic.exposure', `crs:Exposure2012="${n(b.exposure, 2)}"`], ['basic.contrast', `crs:Contrast2012="${int(b.contrast)}"`],
    ['basic.highlights', `crs:Highlights2012="${int(b.highlights)}"`], ['basic.shadows', `crs:Shadows2012="${int(b.shadows)}"`],
    ['basic.whites', `crs:Whites2012="${int(b.whites)}"`], ['basic.blacks', `crs:Blacks2012="${int(b.blacks)}"`],
    ['basic.texture', `crs:Texture="${int(b.texture)}"`], ['basic.clarity', `crs:Clarity2012="${int(b.clarity)}"`],
    ['basic.dehaze', `crs:Dehaze="${int(b.dehaze)}"`], ['basic.vibrance', `crs:Vibrance="${int(b.vibrance)}"`],
    ['basic.saturation', `crs:Saturation="${int(b.saturation)}"`],
    ['basic.treatment', `crs:ConvertToGrayscale="${b.treatment === 'bw' ? 'True' : 'False'}"`],
    ['basic.protectSkin', `esq:ProtectSkin="${b.protectSkin ? 'True' : 'False'}"`],
    ['basic.avoidColorShift', `esq:AvoidColorShift="${b.avoidColorShift ? 'True' : 'False'}"`],
  ] as const) put(path, attribute)
}

function writeToneAttributes(e: Edits, put: PutAttribute): void {
  const t = e.tone
  for (const [path, attribute] of [
    ['tone.recovery', `esq:HighlightRecovery="${t.recovery}"`], ['tone.recoveryThreshold', `esq:RecoveryThreshold="${int(t.recoveryThreshold)}"`],
    ['tone.shHighlights', `esq:SHHighlights="${int(t.shHighlights)}"`], ['tone.shShadows', `esq:SHShadows="${int(t.shShadows)}"`],
    ['tone.shRadius', `esq:SHRadius="${int(t.shRadius)}"`], ['tone.shTonalWidth', `esq:SHTonalWidth="${int(t.shTonalWidth)}"`],
    ['tone.drcAmount', `esq:DRCAmount="${int(t.drcAmount)}"`], ['tone.drcDetail', `esq:DRCDetail="${int(t.drcDetail)}"`],
    ['tone.detailFinest', `esq:DetailFinest="${int(t.detailFinest)}"`], ['tone.detailFine', `esq:DetailFine="${int(t.detailFine)}"`],
    ['tone.detailCoarse', `esq:DetailCoarse="${int(t.detailCoarse)}"`], ['tone.detailCoarsest', `esq:DetailCoarsest="${int(t.detailCoarsest)}"`],
    ['tone.detailThreshold', `esq:DetailThreshold="${int(t.detailThreshold)}"`],
  ] as const) put(path, attribute)
}

function writeCurveAttributes(e: Edits, put: PutAttribute): void {
  const p = e.curve.parametric
  for (const [path, attribute] of [
    ['curve.parametric.shadows', `crs:ParametricShadows="${int(p.shadows)}"`], ['curve.parametric.darks', `crs:ParametricDarks="${int(p.darks)}"`],
    ['curve.parametric.lights', `crs:ParametricLights="${int(p.lights)}"`], ['curve.parametric.highlights', `crs:ParametricHighlights="${int(p.highlights)}"`],
    ['curve.parametric.shadowSplit', `crs:ParametricShadowSplit="${int(p.shadowSplit * 100)}"`],
    ['curve.parametric.midtoneSplit', `crs:ParametricMidtoneSplit="${int(p.midtoneSplit * 100)}"`],
    ['curve.parametric.highlightSplit', `crs:ParametricHighlightSplit="${int(p.highlightSplit * 100)}"`],
    ['curve.rgbMode', `esq:CurveMode="${e.curve.rgbMode}"`], ['curve.mode', `esq:CurveEditMode="${e.curve.mode}"`],
  ] as const) put(path, attribute)
}

function writeColorAttributes(e: Edits, put: PutAttribute): void {
  for (const band of COLOR_BANDS) {
    const name = cap(band)
    put(`colorMixer.hue.${band}`, `crs:HueAdjustment${name}="${int(e.colorMixer.hue[band])}"`)
    put(`colorMixer.saturation.${band}`, `crs:SaturationAdjustment${name}="${int(e.colorMixer.saturation[band])}"`)
    put(`colorMixer.luminance.${band}`, `crs:LuminanceAdjustment${name}="${int(e.colorMixer.luminance[band])}"`)
    put(`colorMixer.bw.${band}`, `crs:GrayMixer${name}="${int(e.colorMixer.bw[band])}"`)
  }
  for (const [field, name] of [['shadows', 'Shadow'], ['midtones', 'Midtone'], ['highlights', 'Highlight'], ['global', 'Global']] as const) {
    put(`colorGrading.${field}.hue`, `crs:ColorGrade${name}Hue="${int(e.colorGrading[field].hue)}"`)
    put(`colorGrading.${field}.saturation`, `crs:ColorGrade${name}Sat="${int(e.colorGrading[field].saturation)}"`)
    put(`colorGrading.${field}.luminance`, `crs:ColorGrade${name}Lum="${int(e.colorGrading[field].luminance)}"`)
  }
  put('colorGrading.blending', `crs:ColorGradeBlending="${int(e.colorGrading.blending)}"`)
  put('colorGrading.balance', `crs:SplitToningBalance="${int(e.colorGrading.balance)}"`)
}

function writeDetailEffectsAttributes(e: Edits, put: PutAttribute): void {
  const d = e.detail
  const f = e.effects
  for (const [path, attribute] of [
    ['detail.sharpenAmount', `crs:Sharpness="${int(d.sharpenAmount)}"`], ['detail.sharpenRadius', `crs:SharpenRadius="${d.sharpenRadius.toFixed(1)}"`],
    ['detail.sharpenDetail', `crs:SharpenDetail="${int(d.sharpenDetail)}"`], ['detail.sharpenMasking', `crs:SharpenEdgeMasking="${int(d.sharpenMasking)}"`],
    ['detail.luminanceNR', `crs:LuminanceSmoothing="${int(d.luminanceNR)}"`], ['detail.luminanceNRDetail', `crs:LuminanceNoiseReductionDetail="${int(d.luminanceNRDetail)}"`],
    ['detail.luminanceNRContrast', `crs:LuminanceNoiseReductionContrast="${int(d.luminanceNRContrast)}"`], ['detail.colorNR', `crs:ColorNoiseReduction="${int(d.colorNR)}"`],
    ['detail.colorNRDetail', `crs:ColorNoiseReductionDetail="${int(d.colorNRDetail)}"`], ['detail.colorNRSmoothness', `crs:ColorNoiseReductionSmoothness="${int(d.colorNRSmoothness)}"`],
    ['detail.impulseNR', `esq:ImpulseNR="${int(d.impulseNR)}"`],
  ] as const) put(path, attribute)
  put('effects.vignetteAmount', `crs:PostCropVignetteAmount="${int(f.vignetteAmount)}"`, 'crs:PostCropVignetteStyle="1"')
  for (const [path, attribute] of [
    ['effects.vignetteMidpoint', `crs:PostCropVignetteMidpoint="${int(f.vignetteMidpoint)}"`], ['effects.vignetteFeather', `crs:PostCropVignetteFeather="${int(f.vignetteFeather)}"`],
    ['effects.vignetteRoundness', `crs:PostCropVignetteRoundness="${int(f.vignetteRoundness)}"`], ['effects.vignetteHighlights', `crs:PostCropVignetteHighlightContrast="${int(f.vignetteHighlights)}"`],
    ['effects.grainAmount', `crs:GrainAmount="${int(f.grainAmount)}"`], ['effects.grainSize', `crs:GrainSize="${int(f.grainSize)}"`],
    ['effects.grainRoughness', `crs:GrainFrequency="${int(f.grainRoughness)}"`],
  ] as const) put(path, attribute)
}

function writeCalibrationLensTransformAttributes(e: Edits, put: PutAttribute): void {
  const cal = e.calibration
  const l = e.lens
  const x = e.transform
  for (const [path, attribute] of [
    ['calibration.shadowTint', `crs:ShadowTint="${int(cal.shadowTint)}"`], ['calibration.redHue', `crs:RedHue="${int(cal.redHue)}"`],
    ['calibration.redSaturation', `crs:RedSaturation="${int(cal.redSaturation)}"`], ['calibration.greenHue', `crs:GreenHue="${int(cal.greenHue)}"`],
    ['calibration.greenSaturation', `crs:GreenSaturation="${int(cal.greenSaturation)}"`], ['calibration.blueHue', `crs:BlueHue="${int(cal.blueHue)}"`],
    ['calibration.blueSaturation', `crs:BlueSaturation="${int(cal.blueSaturation)}"`], ['lens.enableProfile', `crs:LensProfileEnable="${l.enableProfile ? 1 : 0}"`],
    ['lens.distortion', `crs:LensManualDistortionAmount="${int(l.distortion)}"`], ['lens.vignetting', `crs:VignetteAmount="${int(l.vignetting)}"`],
    ['lens.caRed', `crs:ChromaticAberrationR="${int(l.caRed)}"`], ['lens.caBlue', `crs:ChromaticAberrationB="${int(l.caBlue)}"`],
    ['lens.defringePurpleAmount', `crs:DefringePurpleAmount="${int(l.defringePurpleAmount)}"`], ['lens.defringePurpleHueLo', `crs:DefringePurpleHueLo="${int(l.defringePurpleHueLo)}"`],
    ['lens.defringePurpleHueHi', `crs:DefringePurpleHueHi="${int(l.defringePurpleHueHi)}"`], ['lens.defringeGreenAmount', `crs:DefringeGreenAmount="${int(l.defringeGreenAmount)}"`],
    ['lens.defringeGreenHueLo', `crs:DefringeGreenHueLo="${int(l.defringeGreenHueLo)}"`], ['lens.defringeGreenHueHi', `crs:DefringeGreenHueHi="${int(l.defringeGreenHueHi)}"`],
    ['transform.vertical', `crs:PerspectiveVertical="${int(x.vertical)}"`], ['transform.horizontal', `crs:PerspectiveHorizontal="${int(x.horizontal)}"`],
    ['transform.rotate', `crs:PerspectiveRotate="${x.rotate.toFixed(1)}"`], ['transform.aspect', `crs:PerspectiveAspect="${int(x.aspect)}"`],
    ['transform.scale', `crs:PerspectiveScale="${int(x.scale)}"`], ['transform.offsetX', `crs:PerspectiveX="${x.offsetX.toFixed(1)}"`],
    ['transform.offsetY', `crs:PerspectiveY="${x.offsetY.toFixed(1)}"`],
  ] as const) put(path, attribute)
}

function writeCropAttributes(e: Edits, writer: AttributeWriter): void {
  const c = e.crop
  if (['left', 'top', 'right', 'bottom', 'angle'].some((field) => writer.wants(`crop.${field}`))) {
    const cropped = c.left > 0 || c.top > 0 || c.right < 1 || c.bottom < 1 || Math.abs(c.angle) > 1e-4
    writer.out.push(`crs:HasCrop="${cropped ? 'True' : 'False'}"`)
    if (cropped) writer.out.push(`crs:CropTop="${c.top.toFixed(6)}"`, `crs:CropLeft="${c.left.toFixed(6)}"`, `crs:CropBottom="${c.bottom.toFixed(6)}"`, `crs:CropRight="${c.right.toFixed(6)}"`, `crs:CropAngle="${c.angle.toFixed(4)}"`, 'crs:CropConstrainToWarp="0"')
  }
  writer.put('crop.aspect', `esq:CropAspect="${c.aspect}"`)
  writer.put('crop.aspectLocked', `esq:CropAspectLocked="${c.aspectLocked ? 1 : 0}"`)
  writer.put('crop.quarterTurns', `esq:QuarterTurns="${c.quarterTurns}"`)
  writer.put('crop.flipH', `esq:FlipH="${c.flipH ? 1 : 0}"`)
  writer.put('crop.flipV', `esq:FlipV="${c.flipV ? 1 : 0}"`)
}

function writeLocalAdjustmentAttributes(e: Edits, put: PutAttribute): void {
  if (e.masks.length) put('masks', `esq:Masks="${xmlAttr(JSON.stringify(e.masks))}"`)
  if (e.spots.length) put('spots', `esq:Spots="${xmlAttr(JSON.stringify(e.spots))}"`)
  if (e.redEye.length) put('redEye', `esq:RedEye="${xmlAttr(JSON.stringify(e.redEye))}"`)
}

function crsAttributes(e: Edits, sections: EditSection[], only?: string[] | null): string[] {
  const writer = attributeWriter(sections, only)
  writeBasicAttributes(e, writer.put)
  writeToneAttributes(e, writer.put)
  writeCurveAttributes(e, writer.put)
  writeColorAttributes(e, writer.put)
  writeDetailEffectsAttributes(e, writer.put)
  writeCalibrationLensTransformAttributes(e, writer.put)
  writeCropAttributes(e, writer)
  writeLocalAdjustmentAttributes(e, writer.put)
  return writer.out
}

/**
 * Rebuilds a mask from parsed JSON.
 *
 * A sidecar is a file on disk that anything could have written, so every field
 * is checked against a freshly built default rather than trusted. An entry that
 * isn't a recognisable mask is dropped.
 */
function normaliseMask(raw: unknown): Mask | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const comps = Array.isArray(o.components)
    ? o.components.map(normaliseComponent).filter((c): c is MaskComponent => !!c)
    : []
  if (!comps.length) return null

  const base = defaultMaskAdjustments()
  const adj = (o.adjustments ?? {}) as Record<string, unknown>
  for (const key of Object.keys(base) as Array<keyof MaskAdjustments & string>) {
    const v = adj[key]
    if (key === 'curve') {
      if (Array.isArray(v))
        base.curve = v
          .filter((p): p is CurvePoint => !!p && typeof p === 'object' && 'x' in p && 'y' in p)
          .map((p) => ({ x: num(p.x, 0), y: num(p.y, 0) }))
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      base[key] = v as never
    }
  }

  return {
    id: typeof o.id === 'string' && o.id ? o.id : nextId(),
    name: typeof o.name === 'string' && o.name ? o.name : 'Mask',
    visible: o.visible !== false,
    inverted: o.inverted === true,
    opacity: clamp(num(o.opacity, 1), 0, 1),
    components: comps,
    adjustments: base,
  }
}

const MASK_KIND_SET = new Set([
  'linear',
  'radial',
  'brush',
  'colorRange',
  'luminanceRange',
  'aiSubject',
  'aiSky',
  'aiBackground',
  'aiPerson',
  'aiObjects',
])

function normaliseComponent(raw: unknown): MaskComponent | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const g = o.geometry as Record<string, unknown> | undefined
  if (!g || typeof g.kind !== 'string' || !MASK_KIND_SET.has(g.kind)) return null
  const blend = o.blend
  return {
    id: typeof o.id === 'string' && o.id ? o.id : nextId(),
    blend:
      blend === 'add' || blend === 'subtract' || blend === 'intersect'
        ? blend
        : 'add',
    invert: o.invert === true,
    geometry: normaliseGeometry(g),
  }
}

function normaliseGeometry(g: Record<string, unknown>): MaskGeometry {
  const kind = g.kind as MaskGeometry['kind']
  const pt = (v: unknown, dx: number, dy: number): Point2 => {
    const p = (v ?? {}) as Record<string, unknown>
    return { x: num(p.x, dx), y: num(p.y, dy) }
  }
  switch (kind) {
    case 'linear':
      return { kind, start: pt(g.start, 0.5, 0.3), end: pt(g.end, 0.5, 0.7) }
    case 'radial':
      return {
        kind,
        center: pt(g.center, 0.5, 0.5),
        radiusX: num(g.radiusX, 0.22),
        radiusY: num(g.radiusY, 0.22),
        rotation: num(g.rotation, 0),
        feather: num(g.feather, 50),
      }
    case 'brush':
      return {
        kind,
        dabs: (Array.isArray(g.dabs) ? g.dabs : []).map((d) => {
          const o = (d ?? {}) as Record<string, unknown>
          return {
            x: num(o.x, 0),
            y: num(o.y, 0),
            radius: num(o.radius, 0.05),
            flow: num(o.flow, 1),
            erase: o.erase === true,
          }
        }),
        feather: num(g.feather, 50),
        autoMask: g.autoMask === true,
      }
    case 'colorRange':
      return {
        kind,
        samples: (Array.isArray(g.samples) ? g.samples : []).map((s) => {
          const o = (s ?? {}) as Record<string, unknown>
          return { r: num(o.r, 0), g: num(o.g, 0), b: num(o.b, 0) }
        }),
        refine: num(g.refine, 50),
      }
    case 'luminanceRange': {
      const r = Array.isArray(g.range) ? g.range : []
      return {
        kind,
        range: [num(r[0], 0), num(r[1], 0.15), num(r[2], 0.85), num(r[3], 1)],
        smoothness: num(g.smoothness, 50),
      }
    }
    default:
      return {
        kind,
        cacheKey: typeof g.cacheKey === 'string' ? g.cacheKey : null,
        refine: num(g.refine, 50),
      }
  }
}

const num = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
function normaliseSpot(raw: unknown): SpotEdit | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const pt = (v: unknown): Point2 => {
    const p = (v ?? {}) as Record<string, unknown>
    return { x: num(p.x, 0.5), y: num(p.y, 0.5) }
  }
  const radius = num(o.radius, 0.04)
  if (!(radius > 0)) return null
  return {
    id: typeof o.id === 'string' && o.id ? o.id : nextId(),
    mode: o.mode === 'clone' ? 'clone' : 'heal',
    target: pt(o.target),
    source: pt(o.source),
    radius,
    feather: clamp(num(o.feather, 50), 0, 100),
    opacity: clamp(num(o.opacity, 1), 0, 1),
  }
}

function normaliseEye(raw: unknown): RedEyeEdit | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const c = (o.center ?? {}) as Record<string, unknown>
  const radius = num(o.radius, 0.03)
  if (!(radius > 0)) return null
  return {
    id: typeof o.id === 'string' && o.id ? o.id : nextId(),
    kind: o.kind === 'pet' ? 'pet' : 'human',
    center: { x: num(c.x, 0.5), y: num(c.y, 0.5) },
    radius,
    darken: clamp(num(o.darken, 50), 0, 100),
  }
}

/** Escapes a string for use inside a double-quoted XML attribute. */
function xmlAttr(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#10;')
}

function curveElements(e: Edits, sections: EditSection[], only?: string[] | null): string {
  if (!sections.includes('curve')) return ''
  const allow = only?.length ? new Set(only) : null
  const seqs = (
    [
      ['rgb', 'ToneCurvePV2012'],
      ['red', 'ToneCurvePV2012Red'],
      ['green', 'ToneCurvePV2012Green'],
      ['blue', 'ToneCurvePV2012Blue'],
    ] as const
  )
    .filter(([field]) => !allow || allow.has(`curve.${field}`))
    .map(([field, tag]) => curveSeq(tag, e.curve[field]))
  return seqs.length ? '\n' + seqs.join('\n') : ''
}

/** Serialises a preset in the shape Lightroom Classic expects in `Settings/`. */
export function presetToXmp(preset: Preset, edits: Edits): string {
  // A field-level preset writes only its own fields, so exporting and
  // re-importing gives back the same preset rather than a section-wide one.
  const only = preset.paths ?? null
  const attrs = crsAttributes(edits, preset.sections, only)
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="esque">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="${CRS}"
    xmlns:esq="${ESQ}"
   crs:PresetType="Normal"
   crs:Cluster=""
   crs:UUID="${preset.id.replace(/-/g, '').toUpperCase().padEnd(32, '0').slice(0, 32)}"
   crs:SupportsAmount="False"
   crs:SupportsColor="True"
   crs:SupportsMonochrome="True"
   crs:SupportsHighDynamicRange="True"
   crs:SupportsNormalDynamicRange="True"
   crs:SupportsSceneReferred="True"
   crs:SupportsOutputReferred="True"
   crs:HasSettings="True"
   ${attrs.join('\n   ')}>
   <crs:Name>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">${escapeXml(preset.name)}</rdf:li>
    </rdf:Alt>
   </crs:Name>
   <crs:Group>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">${escapeXml(preset.group)}</rdf:li>
    </rdf:Alt>
   </crs:Group>${curveElements(edits, preset.sections, only)}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`
}

export interface SidecarInfo {
  filename: string
  rating?: number
  label?: string
  title?: string
  caption?: string
  keywords?: string[]
}

/**
 * A full XMP sidecar for a photo — the file Lightroom reads when it sees
 * `IMG_0001.xmp` next to `IMG_0001.RAF`.
 */
export function editsToSidecar(
  edits: Edits,
  sections: EditSection[],
  info: SidecarInfo,
): string {
  const attrs = crsAttributes(edits, sections)
  const dc: string[] = []
  if (info.title) {
    dc.push(
      `   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(info.title)}</rdf:li></rdf:Alt></dc:title>`,
    )
  }
  if (info.caption) {
    dc.push(
      `   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(info.caption)}</rdf:li></rdf:Alt></dc:description>`,
    )
  }
  if (info.keywords?.length) {
    dc.push(
      `   <dc:subject><rdf:Bag>${info.keywords
        .map((k) => `<rdf:li>${escapeXml(k)}</rdf:li>`)
        .join('')}</rdf:Bag></dc:subject>`,
    )
  }

  const xmpAttrs = [
    `xmp:Rating="${info.rating ?? 0}"`,
    `xmp:CreatorTool="esque"`,
    `xmp:MetadataDate="${new Date().toISOString()}"`,
  ]
  if (info.label) xmpAttrs.push(`xmp:Label="${escapeXml(info.label)}"`)

  return `<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="esque">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:crs="${CRS}"
    xmlns:esq="${ESQ}"
   crs:RawFileName="${escapeXml(info.filename)}"
   ${xmpAttrs.join('\n   ')}
   ${attrs.join('\n   ')}>
${dc.join('\n')}${curveElements(edits, sections)}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`
}

/** Pulls the non-crs bits Lightroom stores in a sidecar. */
export function parseSidecarMetadata(xml: string): {
  rating: number | null
  label: string | null
  title: string | null
  caption: string | null
  keywords: string[]
} {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const XMP = 'http://ns.adobe.com/xap/1.0/'
  const DC = 'http://purl.org/dc/elements/1.1/'
  const descriptions = Array.from(
    doc.getElementsByTagNameNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'Description'),
  )

  const attr = (ns: string, name: string) => {
    for (const d of descriptions) {
      const v = d.getAttributeNS(ns, name)
      if (v) return v
    }
    const el = doc.getElementsByTagNameNS(ns, name)[0]
    return el?.textContent?.trim() ?? null
  }
  const alt = (ns: string, name: string) => {
    const el = doc.getElementsByTagNameNS(ns, name)[0]
    return el?.textContent?.trim() ?? null
  }

  const rating = attr(XMP, 'Rating')
  return {
    rating: rating !== null ? Number.parseInt(rating, 10) : null,
    label: attr(XMP, 'Label'),
    title: alt(DC, 'title'),
    caption: alt(DC, 'description'),
    keywords: Array.from(doc.getElementsByTagNameNS(DC, 'subject'))
      .flatMap((el) =>
        Array.from(
          el.getElementsByTagNameNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'li'),
        ),
      )
      .map((li) => li.textContent?.trim() ?? '')
      .filter(Boolean),
  }
}
