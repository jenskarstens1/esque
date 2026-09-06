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

export function parseXmp(xml: string): ParsedXmp | null {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) return null

  const bag = crsBag(doc)
  if (!bag.size) return null
  const r = reader(bag)
  const e = defaultEdits()

  // ---- Basic -------------------------------------------------------------
  const wbRaw = r.str('WhiteBalance').trim().toLowerCase()
  if (wbRaw) {
    e.basic.wbMode = WB_MAP[wbRaw] ?? 'custom'
    r.claim('basic.wbMode')
  }
  if (r.mark('basic.temp', 'Temperature')) e.basic.temp = r.num('Temperature', 5500)
  if (r.mark('basic.tint', 'Tint')) e.basic.tint = r.num('Tint')

  if (r.mark('basic.exposure', ['Exposure2012', 'Exposure']))
    e.basic.exposure = r.num(['Exposure2012', 'Exposure'])
  if (r.mark('basic.contrast', ['Contrast2012', 'Contrast']))
    e.basic.contrast = r.num(['Contrast2012', 'Contrast'])
  if (r.mark('basic.highlights', ['Highlights2012', 'HighlightRecovery']))
    e.basic.highlights = r.num(['Highlights2012', 'HighlightRecovery'])
  if (r.mark('basic.shadows', ['Shadows2012', 'FillLight']))
    e.basic.shadows = r.num(['Shadows2012', 'FillLight'])
  if (r.mark('basic.whites', ['Whites2012'])) e.basic.whites = r.num('Whites2012')
  if (r.mark('basic.blacks', ['Blacks2012', 'Blacks']))
    e.basic.blacks = r.num(['Blacks2012', 'Blacks'])

  if (r.mark('basic.texture', 'Texture')) e.basic.texture = r.num('Texture')
  if (r.mark('basic.clarity', ['Clarity2012', 'Clarity']))
    e.basic.clarity = r.num(['Clarity2012', 'Clarity'])
  if (r.mark('basic.dehaze', 'Dehaze')) e.basic.dehaze = r.num('Dehaze')
  if (r.mark('basic.vibrance', 'Vibrance')) e.basic.vibrance = r.num('Vibrance')
  if (r.mark('basic.saturation', 'Saturation')) e.basic.saturation = r.num('Saturation')

  if (r.mark('basic.treatment', 'ConvertToGrayscale'))
    e.basic.treatment = r.bool('ConvertToGrayscale') ? 'bw' : 'color'
  if (r.mark('basic.protectSkin', 'esq:ProtectSkin'))
    e.basic.protectSkin = r.bool('esq:ProtectSkin', true)
  if (r.mark('basic.avoidColorShift', 'esq:AvoidColorShift'))
    e.basic.avoidColorShift = r.bool('esq:AvoidColorShift')

  // ---- Camera profile ----------------------------------------------------
  // On a RAW this is the base rendering every slider then works against, so a
  // preset that names one has to be able to carry it.
  if (r.mark('profile', ['esq:Profile', 'CameraProfile'])) {
    const named = r.str(['esq:Profile', 'CameraProfile']).trim()
    const match = CAMERA_PROFILES.find(
      (p) => p.id === named.toLowerCase() || p.name.toLowerCase() === named.toLowerCase(),
    )
    // An Adobe profile name we don't ship ("Adobe Color", a camera-matching
    // profile) has no equivalent here; leaving the default is more honest than
    // picking something that merely sounds close.
    if (match) e.profile = match.id
    else r.touched.delete('profile')
  }

  // ---- Tone (RawTherapee) ------------------------------------------------
  const RECOVERY: HighlightRecovery[] = ['off', 'clip', 'blend', 'propagate']
  if (r.mark('tone.recovery', 'esq:HighlightRecovery')) {
    const mode = r.str('esq:HighlightRecovery') as HighlightRecovery
    e.tone.recovery = RECOVERY.includes(mode) ? mode : 'off'
  }
  const tone = [
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
  const toneDefaults = defaultEdits().tone
  for (const [key, field] of tone) {
    if (r.mark(`tone.${field}`, key)) e.tone[field] = r.num(key, toneDefaults[field] as number)
  }

  // ---- Tone curve --------------------------------------------------------
  const para = [
    ['ParametricHighlights', 'highlights'],
    ['ParametricLights', 'lights'],
    ['ParametricDarks', 'darks'],
    ['ParametricShadows', 'shadows'],
  ] as const
  for (const [key, field] of para) {
    if (r.mark(`curve.parametric.${field}`, key)) e.curve.parametric[field] = r.num(key)
  }
  if (r.mark('curve.parametric.shadowSplit', 'ParametricShadowSplit'))
    e.curve.parametric.shadowSplit = r.num('ParametricShadowSplit', 25) / 100
  if (r.mark('curve.parametric.midtoneSplit', 'ParametricMidtoneSplit'))
    e.curve.parametric.midtoneSplit = r.num('ParametricMidtoneSplit', 50) / 100
  if (r.mark('curve.parametric.highlightSplit', 'ParametricHighlightSplit'))
    e.curve.parametric.highlightSplit = r.num('ParametricHighlightSplit', 75) / 100

  const channels = [
    ['rgb', ['ToneCurvePV2012', 'ToneCurve']],
    ['red', ['ToneCurvePV2012Red', 'ToneCurveRed']],
    ['green', ['ToneCurvePV2012Green', 'ToneCurveGreen']],
    ['blue', ['ToneCurvePV2012Blue', 'ToneCurveBlue']],
  ] as const
  for (const [field, keys] of channels) {
    const pts = r.points(keys as unknown as string[])
    if (pts) {
      e.curve[field] = pts
      r.claim(`curve.${field}`)
    }
  }
  // A point curve that isn't a straight line means the user was working there.
  if (e.curve.rgb.length > 2 || e.curve.rgb.some((p) => Math.abs(p.x - p.y) > 1e-3)) {
    e.curve.mode = 'point'
    r.claim('curve.mode')
  }
  const CURVE_MODES: CurveMode[] = [
    'standard',
    'weighted',
    'filmLike',
    'saturationAndValue',
    'luminance',
    'perceptual',
  ]
  if (r.mark('curve.mode', 'esq:CurveEditMode')) {
    const editMode = r.str('esq:CurveEditMode')
    if (editMode === 'parametric' || editMode === 'point') e.curve.mode = editMode
  }
  if (r.mark('curve.rgbMode', 'esq:CurveMode')) {
    const mode = r.str('esq:CurveMode') as CurveMode
    e.curve.rgbMode = CURVE_MODES.includes(mode) ? mode : 'standard'
  }

  // ---- Colour mixer ------------------------------------------------------
  for (const band of COLOR_BANDS) {
    const B = cap(band)
    if (r.mark(`colorMixer.hue.${band}`, `HueAdjustment${B}`))
      e.colorMixer.hue[band as ColorBand] = r.num(`HueAdjustment${B}`)
    if (r.mark(`colorMixer.saturation.${band}`, `SaturationAdjustment${B}`))
      e.colorMixer.saturation[band as ColorBand] = r.num(`SaturationAdjustment${B}`)
    if (r.mark(`colorMixer.luminance.${band}`, `LuminanceAdjustment${B}`))
      e.colorMixer.luminance[band as ColorBand] = r.num(`LuminanceAdjustment${B}`)
    if (r.mark(`colorMixer.bw.${band}`, `GrayMixer${B}`))
      e.colorMixer.bw[band as ColorBand] = r.num(`GrayMixer${B}`)
  }

  // ---- Colour grading ----------------------------------------------------
  const wheels = [
    ['shadows', 'ColorGradeShadow', 'SplitToningShadow'],
    ['midtones', 'ColorGradeMidtone', null],
    ['highlights', 'ColorGradeHighlight', 'SplitToningHighlight'],
    ['global', 'ColorGradeGlobal', null],
  ] as const
  for (const [field, modern, legacy] of wheels) {
    const hueKeys = legacy ? [`${modern}Hue`, `${legacy}Hue`] : [`${modern}Hue`]
    const satKeys = legacy ? [`${modern}Sat`, `${legacy}Saturation`] : [`${modern}Sat`]
    if (r.mark(`colorGrading.${field}.hue`, hueKeys)) e.colorGrading[field].hue = r.num(hueKeys)
    if (r.mark(`colorGrading.${field}.saturation`, satKeys))
      e.colorGrading[field].saturation = r.num(satKeys)
    if (r.mark(`colorGrading.${field}.luminance`, `${modern}Lum`))
      e.colorGrading[field].luminance = r.num(`${modern}Lum`)
  }
  if (r.mark('colorGrading.blending', 'ColorGradeBlending'))
    e.colorGrading.blending = r.num('ColorGradeBlending', 50)
  if (r.mark('colorGrading.balance', ['ColorGradeGlobalBalance', 'SplitToningBalance']))
    e.colorGrading.balance = r.num(['ColorGradeGlobalBalance', 'SplitToningBalance'])

  // ---- Detail ------------------------------------------------------------
  if (r.mark('detail.sharpenAmount', 'Sharpness')) e.detail.sharpenAmount = r.num('Sharpness', 40)
  if (r.mark('detail.sharpenRadius', 'SharpenRadius'))
    e.detail.sharpenRadius = r.num('SharpenRadius', 1)
  if (r.mark('detail.sharpenDetail', 'SharpenDetail'))
    e.detail.sharpenDetail = r.num('SharpenDetail', 25)
  if (r.mark('detail.sharpenMasking', 'SharpenEdgeMasking'))
    e.detail.sharpenMasking = r.num('SharpenEdgeMasking')
  if (r.mark('detail.luminanceNR', 'LuminanceSmoothing'))
    e.detail.luminanceNR = r.num('LuminanceSmoothing')
  if (r.mark('detail.luminanceNRDetail', 'LuminanceNoiseReductionDetail'))
    e.detail.luminanceNRDetail = r.num('LuminanceNoiseReductionDetail', 50)
  if (r.mark('detail.luminanceNRContrast', 'LuminanceNoiseReductionContrast'))
    e.detail.luminanceNRContrast = r.num('LuminanceNoiseReductionContrast')
  if (r.mark('detail.colorNR', 'ColorNoiseReduction'))
    e.detail.colorNR = r.num('ColorNoiseReduction', 25)
  if (r.mark('detail.colorNRDetail', 'ColorNoiseReductionDetail'))
    e.detail.colorNRDetail = r.num('ColorNoiseReductionDetail', 50)
  if (r.mark('detail.colorNRSmoothness', 'ColorNoiseReductionSmoothness'))
    e.detail.colorNRSmoothness = r.num('ColorNoiseReductionSmoothness', 50)
  if (r.mark('detail.impulseNR', 'esq:ImpulseNR')) e.detail.impulseNR = r.num('esq:ImpulseNR')

  // ---- Effects -----------------------------------------------------------
  if (r.mark('effects.vignetteAmount', 'PostCropVignetteAmount'))
    e.effects.vignetteAmount = r.num('PostCropVignetteAmount')
  if (r.mark('effects.vignetteMidpoint', 'PostCropVignetteMidpoint'))
    e.effects.vignetteMidpoint = r.num('PostCropVignetteMidpoint', 50)
  if (r.mark('effects.vignetteRoundness', 'PostCropVignetteRoundness'))
    e.effects.vignetteRoundness = r.num('PostCropVignetteRoundness')
  if (r.mark('effects.vignetteFeather', 'PostCropVignetteFeather'))
    e.effects.vignetteFeather = r.num('PostCropVignetteFeather', 50)
  if (r.mark('effects.vignetteHighlights', 'PostCropVignetteHighlightContrast'))
    e.effects.vignetteHighlights = r.num('PostCropVignetteHighlightContrast')
  if (r.mark('effects.grainAmount', 'GrainAmount')) e.effects.grainAmount = r.num('GrainAmount')
  if (r.mark('effects.grainSize', 'GrainSize')) e.effects.grainSize = r.num('GrainSize', 25)
  if (r.mark('effects.grainRoughness', 'GrainFrequency'))
    e.effects.grainRoughness = r.num('GrainFrequency', 50)

  // ---- Calibration -------------------------------------------------------
  const calib = [
    ['ShadowTint', 'shadowTint'],
    ['RedHue', 'redHue'],
    ['RedSaturation', 'redSaturation'],
    ['GreenHue', 'greenHue'],
    ['GreenSaturation', 'greenSaturation'],
    ['BlueHue', 'blueHue'],
    ['BlueSaturation', 'blueSaturation'],
  ] as const
  for (const [key, field] of calib) {
    if (r.mark(`calibration.${field}`, key)) e.calibration[field] = r.num(key)
  }

  // ---- Lens --------------------------------------------------------------
  if (r.mark('lens.enableProfile', 'LensProfileEnable'))
    e.lens.enableProfile = r.num('LensProfileEnable') > 0
  if (r.mark('lens.distortion', 'LensManualDistortionAmount'))
    e.lens.distortion = r.num('LensManualDistortionAmount')
  if (r.mark('lens.vignetting', 'VignetteAmount')) e.lens.vignetting = r.num('VignetteAmount')
  if (r.mark('lens.caRed', 'ChromaticAberrationR')) e.lens.caRed = r.num('ChromaticAberrationR')
  if (r.mark('lens.caBlue', 'ChromaticAberrationB')) e.lens.caBlue = r.num('ChromaticAberrationB')
  if (r.mark('lens.defringePurpleAmount', 'DefringePurpleAmount'))
    e.lens.defringePurpleAmount = r.num('DefringePurpleAmount')
  if (r.mark('lens.defringePurpleHueLo', 'DefringePurpleHueLo'))
    e.lens.defringePurpleHueLo = r.num('DefringePurpleHueLo', 30)
  if (r.mark('lens.defringePurpleHueHi', 'DefringePurpleHueHi'))
    e.lens.defringePurpleHueHi = r.num('DefringePurpleHueHi', 70)
  if (r.mark('lens.defringeGreenAmount', 'DefringeGreenAmount'))
    e.lens.defringeGreenAmount = r.num('DefringeGreenAmount')
  if (r.mark('lens.defringeGreenHueLo', 'DefringeGreenHueLo'))
    e.lens.defringeGreenHueLo = r.num('DefringeGreenHueLo', 40)
  if (r.mark('lens.defringeGreenHueHi', 'DefringeGreenHueHi'))
    e.lens.defringeGreenHueHi = r.num('DefringeGreenHueHi', 60)

  // ---- Transform ---------------------------------------------------------
  const xform = [
    ['PerspectiveVertical', 'vertical'],
    ['PerspectiveHorizontal', 'horizontal'],
    ['PerspectiveRotate', 'rotate'],
    ['PerspectiveAspect', 'aspect'],
    ['PerspectiveX', 'offsetX'],
    ['PerspectiveY', 'offsetY'],
  ] as const
  for (const [key, field] of xform) {
    if (r.mark(`transform.${field}`, key)) e.transform[field] = r.num(key)
  }
  if (r.mark('transform.scale', 'PerspectiveScale'))
    e.transform.scale = r.num('PerspectiveScale', 100)

  // ---- Crop --------------------------------------------------------------
  if (r.bool('HasCrop')) {
    for (const f of ['left', 'top', 'right', 'bottom', 'angle', 'aspect'] as const)
      r.claim(`crop.${f}`)
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

  // ---- Masks -------------------------------------------------------------
  const masksJson = r.str('esq:Masks')
  if (masksJson && r.mark('masks', 'esq:Masks')) {
    try {
      const parsed = JSON.parse(masksJson)
      if (Array.isArray(parsed)) e.masks = parsed.map(normaliseMask).filter(Boolean) as Mask[]
    } catch {
      // A corrupt sidecar should cost you the masks, not the whole develop
      // state, so this is swallowed on purpose.
    }
  }

  // ---- Retouching --------------------------------------------------------
  const spotsJson = r.str('esq:Spots')
  if (spotsJson && r.mark('spots', 'esq:Spots')) {
    try {
      const parsed = JSON.parse(spotsJson)
      if (Array.isArray(parsed)) e.spots = parsed.map(normaliseSpot).filter(Boolean) as SpotEdit[]
    } catch {
      // Same reasoning as the masks: a bad blob costs the spots, nothing else.
    }
  }
  const eyesJson = r.str('esq:RedEye')
  if (eyesJson && r.mark('redEye', 'esq:RedEye')) {
    try {
      const parsed = JSON.parse(eyesJson)
      if (Array.isArray(parsed)) e.redEye = parsed.map(normaliseEye).filter(Boolean) as RedEyeEdit[]
    } catch {
      /* ignored */
    }
  }

  // ---- Identity ----------------------------------------------------------
  const name =
    doc.querySelector('crs\\:Name rdf\\:li')?.textContent?.trim() || r.str('Name') || ''
  const group =
    doc.querySelector('crs\\:Group rdf\\:li')?.textContent?.trim() ||
    r.str('Group') ||
    r.str('Cluster') ||
    ''

  // `crs:RawFileName` names the file the settings belong to, which a preset
  // never has. Lightroom writes `HasSettings="True"` into a developed photo's
  // sidecar as well as into presets, so treating that flag as decisive read
  // every edited photo's sidecar as a preset the user could apply elsewhere.
  const isSidecar = bag.has('RawFileName')
  const isPreset =
    !isSidecar && (r.str('PresetType') !== '' || r.bool('HasSettings') || !!name)

  const paths = [...r.touched]
  // An XMP file is written once and read for years, so it carries the edit
  // version it was written under. Absent means it predates the field, which is
  // v1 — the same rule the catalogue upgrade uses.
  const editVersion = Math.max(1, Math.round(r.num('esq:EditVersion'))) || 1
  return {
    name,
    group,
    edits: migratePartialEdits(e, editVersion) as Edits,
    sections: [...new Set(paths.map(sectionOfPath))],
    paths,
    isPreset,
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
function crsAttributes(e: Edits, sections: EditSection[], only?: string[] | null): string[] {
  const want = new Set(sections)
  const allow = only?.length ? new Set(only) : null
  const out: string[] = [
    'crs:Version="15.0"',
    'crs:ProcessVersion="11.0"',
    `esq:EditVersion="${EDITS_VERSION}"`,
  ]

  /** Emits `attr` when its field is in scope. */
  const put = (path: string, ...attrs: string[]) => {
    if (!want.has(sectionOfPath(path))) return
    if (allow && !allow.has(path)) return
    out.push(...attrs)
  }
  const wants = (path: string) =>
    want.has(sectionOfPath(path)) && (!allow || allow.has(path))

  // `crs:CameraProfile` is the field Lightroom itself uses, so a sidecar
  // written here names the rendering in a way Camera Raw understands even
  // though it won't have our curve.
  put(
    'profile',
    `crs:CameraProfile="${xmlAttr(cameraProfile(e.profile).name)}"`,
    `esq:Profile="${xmlAttr(e.profile)}"`,
  )

  put('basic.wbMode', `crs:WhiteBalance="${WB_OUT[e.basic.wbMode]}"`)
  put('basic.temp', `crs:Temperature="${int(e.basic.temp)}"`)
  put('basic.tint', `crs:Tint="${int(e.basic.tint)}"`)
  put('basic.exposure', `crs:Exposure2012="${n(e.basic.exposure, 2)}"`)
  put('basic.contrast', `crs:Contrast2012="${int(e.basic.contrast)}"`)
  put('basic.highlights', `crs:Highlights2012="${int(e.basic.highlights)}"`)
  put('basic.shadows', `crs:Shadows2012="${int(e.basic.shadows)}"`)
  put('basic.whites', `crs:Whites2012="${int(e.basic.whites)}"`)
  put('basic.blacks', `crs:Blacks2012="${int(e.basic.blacks)}"`)
  put('basic.texture', `crs:Texture="${int(e.basic.texture)}"`)
  put('basic.clarity', `crs:Clarity2012="${int(e.basic.clarity)}"`)
  put('basic.dehaze', `crs:Dehaze="${int(e.basic.dehaze)}"`)
  put('basic.vibrance', `crs:Vibrance="${int(e.basic.vibrance)}"`)
  put('basic.saturation', `crs:Saturation="${int(e.basic.saturation)}"`)
  put(
    'basic.treatment',
    `crs:ConvertToGrayscale="${e.basic.treatment === 'bw' ? 'True' : 'False'}"`,
  )
  put('basic.protectSkin', `esq:ProtectSkin="${e.basic.protectSkin ? 'True' : 'False'}"`)
  put(
    'basic.avoidColorShift',
    `esq:AvoidColorShift="${e.basic.avoidColorShift ? 'True' : 'False'}"`,
  )

  const t = e.tone
  put('tone.recovery', `esq:HighlightRecovery="${t.recovery}"`)
  put('tone.recoveryThreshold', `esq:RecoveryThreshold="${int(t.recoveryThreshold)}"`)
  put('tone.shHighlights', `esq:SHHighlights="${int(t.shHighlights)}"`)
  put('tone.shShadows', `esq:SHShadows="${int(t.shShadows)}"`)
  put('tone.shRadius', `esq:SHRadius="${int(t.shRadius)}"`)
  put('tone.shTonalWidth', `esq:SHTonalWidth="${int(t.shTonalWidth)}"`)
  put('tone.drcAmount', `esq:DRCAmount="${int(t.drcAmount)}"`)
  put('tone.drcDetail', `esq:DRCDetail="${int(t.drcDetail)}"`)
  put('tone.detailFinest', `esq:DetailFinest="${int(t.detailFinest)}"`)
  put('tone.detailFine', `esq:DetailFine="${int(t.detailFine)}"`)
  put('tone.detailCoarse', `esq:DetailCoarse="${int(t.detailCoarse)}"`)
  put('tone.detailCoarsest', `esq:DetailCoarsest="${int(t.detailCoarsest)}"`)
  put('tone.detailThreshold', `esq:DetailThreshold="${int(t.detailThreshold)}"`)

  const p = e.curve.parametric
  put('curve.parametric.shadows', `crs:ParametricShadows="${int(p.shadows)}"`)
  put('curve.parametric.darks', `crs:ParametricDarks="${int(p.darks)}"`)
  put('curve.parametric.lights', `crs:ParametricLights="${int(p.lights)}"`)
  put('curve.parametric.highlights', `crs:ParametricHighlights="${int(p.highlights)}"`)
  put(
    'curve.parametric.shadowSplit',
    `crs:ParametricShadowSplit="${int(p.shadowSplit * 100)}"`,
  )
  put(
    'curve.parametric.midtoneSplit',
    `crs:ParametricMidtoneSplit="${int(p.midtoneSplit * 100)}"`,
  )
  put(
    'curve.parametric.highlightSplit',
    `crs:ParametricHighlightSplit="${int(p.highlightSplit * 100)}"`,
  )
  put('curve.rgbMode', `esq:CurveMode="${e.curve.rgbMode}"`)
  put('curve.mode', `esq:CurveEditMode="${e.curve.mode}"`)

  for (const band of COLOR_BANDS) {
    const B = cap(band)
    put(`colorMixer.hue.${band}`, `crs:HueAdjustment${B}="${int(e.colorMixer.hue[band])}"`)
    put(
      `colorMixer.saturation.${band}`,
      `crs:SaturationAdjustment${B}="${int(e.colorMixer.saturation[band])}"`,
    )
    put(
      `colorMixer.luminance.${band}`,
      `crs:LuminanceAdjustment${B}="${int(e.colorMixer.luminance[band])}"`,
    )
    put(`colorMixer.bw.${band}`, `crs:GrayMixer${B}="${int(e.colorMixer.bw[band])}"`)
  }

  const g = e.colorGrading
  for (const [field, name] of [
    ['shadows', 'Shadow'],
    ['midtones', 'Midtone'],
    ['highlights', 'Highlight'],
    ['global', 'Global'],
  ] as const) {
    put(`colorGrading.${field}.hue`, `crs:ColorGrade${name}Hue="${int(g[field].hue)}"`)
    put(
      `colorGrading.${field}.saturation`,
      `crs:ColorGrade${name}Sat="${int(g[field].saturation)}"`,
    )
    put(
      `colorGrading.${field}.luminance`,
      `crs:ColorGrade${name}Lum="${int(g[field].luminance)}"`,
    )
  }
  put('colorGrading.blending', `crs:ColorGradeBlending="${int(g.blending)}"`)
  put('colorGrading.balance', `crs:SplitToningBalance="${int(g.balance)}"`)

  const d = e.detail
  put('detail.sharpenAmount', `crs:Sharpness="${int(d.sharpenAmount)}"`)
  put('detail.sharpenRadius', `crs:SharpenRadius="${d.sharpenRadius.toFixed(1)}"`)
  put('detail.sharpenDetail', `crs:SharpenDetail="${int(d.sharpenDetail)}"`)
  put('detail.sharpenMasking', `crs:SharpenEdgeMasking="${int(d.sharpenMasking)}"`)
  put('detail.luminanceNR', `crs:LuminanceSmoothing="${int(d.luminanceNR)}"`)
  put(
    'detail.luminanceNRDetail',
    `crs:LuminanceNoiseReductionDetail="${int(d.luminanceNRDetail)}"`,
  )
  put(
    'detail.luminanceNRContrast',
    `crs:LuminanceNoiseReductionContrast="${int(d.luminanceNRContrast)}"`,
  )
  put('detail.colorNR', `crs:ColorNoiseReduction="${int(d.colorNR)}"`)
  put('detail.colorNRDetail', `crs:ColorNoiseReductionDetail="${int(d.colorNRDetail)}"`)
  put(
    'detail.colorNRSmoothness',
    `crs:ColorNoiseReductionSmoothness="${int(d.colorNRSmoothness)}"`,
  )
  put('detail.impulseNR', `esq:ImpulseNR="${int(d.impulseNR)}"`)

  const f = e.effects
  put(
    'effects.vignetteAmount',
    `crs:PostCropVignetteAmount="${int(f.vignetteAmount)}"`,
    `crs:PostCropVignetteStyle="1"`,
  )
  put('effects.vignetteMidpoint', `crs:PostCropVignetteMidpoint="${int(f.vignetteMidpoint)}"`)
  put('effects.vignetteFeather', `crs:PostCropVignetteFeather="${int(f.vignetteFeather)}"`)
  put('effects.vignetteRoundness', `crs:PostCropVignetteRoundness="${int(f.vignetteRoundness)}"`)
  put(
    'effects.vignetteHighlights',
    `crs:PostCropVignetteHighlightContrast="${int(f.vignetteHighlights)}"`,
  )
  put('effects.grainAmount', `crs:GrainAmount="${int(f.grainAmount)}"`)
  put('effects.grainSize', `crs:GrainSize="${int(f.grainSize)}"`)
  put('effects.grainRoughness', `crs:GrainFrequency="${int(f.grainRoughness)}"`)

  const cal = e.calibration
  put('calibration.shadowTint', `crs:ShadowTint="${int(cal.shadowTint)}"`)
  put('calibration.redHue', `crs:RedHue="${int(cal.redHue)}"`)
  put('calibration.redSaturation', `crs:RedSaturation="${int(cal.redSaturation)}"`)
  put('calibration.greenHue', `crs:GreenHue="${int(cal.greenHue)}"`)
  put('calibration.greenSaturation', `crs:GreenSaturation="${int(cal.greenSaturation)}"`)
  put('calibration.blueHue', `crs:BlueHue="${int(cal.blueHue)}"`)
  put('calibration.blueSaturation', `crs:BlueSaturation="${int(cal.blueSaturation)}"`)

  const l = e.lens
  put('lens.enableProfile', `crs:LensProfileEnable="${l.enableProfile ? 1 : 0}"`)
  put('lens.distortion', `crs:LensManualDistortionAmount="${int(l.distortion)}"`)
  put('lens.vignetting', `crs:VignetteAmount="${int(l.vignetting)}"`)
  put('lens.caRed', `crs:ChromaticAberrationR="${int(l.caRed)}"`)
  put('lens.caBlue', `crs:ChromaticAberrationB="${int(l.caBlue)}"`)
  put('lens.defringePurpleAmount', `crs:DefringePurpleAmount="${int(l.defringePurpleAmount)}"`)
  put('lens.defringePurpleHueLo', `crs:DefringePurpleHueLo="${int(l.defringePurpleHueLo)}"`)
  put('lens.defringePurpleHueHi', `crs:DefringePurpleHueHi="${int(l.defringePurpleHueHi)}"`)
  put('lens.defringeGreenAmount', `crs:DefringeGreenAmount="${int(l.defringeGreenAmount)}"`)
  put('lens.defringeGreenHueLo', `crs:DefringeGreenHueLo="${int(l.defringeGreenHueLo)}"`)
  put('lens.defringeGreenHueHi', `crs:DefringeGreenHueHi="${int(l.defringeGreenHueHi)}"`)

  const x = e.transform
  put('transform.vertical', `crs:PerspectiveVertical="${int(x.vertical)}"`)
  put('transform.horizontal', `crs:PerspectiveHorizontal="${int(x.horizontal)}"`)
  put('transform.rotate', `crs:PerspectiveRotate="${x.rotate.toFixed(1)}"`)
  put('transform.aspect', `crs:PerspectiveAspect="${int(x.aspect)}"`)
  put('transform.scale', `crs:PerspectiveScale="${int(x.scale)}"`)
  put('transform.offsetX', `crs:PerspectiveX="${x.offsetX.toFixed(1)}"`)
  put('transform.offsetY', `crs:PerspectiveY="${x.offsetY.toFixed(1)}"`)

  // The crop rectangle is one value in four numbers — `crs:HasCrop` gates the
  // rest of it, so the group travels together or not at all.
  const c = e.crop
  if (['left', 'top', 'right', 'bottom', 'angle'].some((k) => wants(`crop.${k}`))) {
    const cropped =
      c.left > 0 || c.top > 0 || c.right < 1 || c.bottom < 1 || Math.abs(c.angle) > 1e-4
    out.push(`crs:HasCrop="${cropped ? 'True' : 'False'}"`)
    if (cropped) {
      out.push(
        `crs:CropTop="${c.top.toFixed(6)}"`,
        `crs:CropLeft="${c.left.toFixed(6)}"`,
        `crs:CropBottom="${c.bottom.toFixed(6)}"`,
        `crs:CropRight="${c.right.toFixed(6)}"`,
        `crs:CropAngle="${c.angle.toFixed(4)}"`,
        `crs:CropConstrainToWarp="0"`,
      )
    }
  }
  // Adobe stores the orientation in tiff:Orientation and has no key at all
  // for the chosen aspect preset, so the framing lives in our namespace.
  put('crop.aspect', `esq:CropAspect="${c.aspect}"`)
  put('crop.aspectLocked', `esq:CropAspectLocked="${c.aspectLocked ? 1 : 0}"`)
  put('crop.quarterTurns', `esq:QuarterTurns="${c.quarterTurns}"`)
  put('crop.flipH', `esq:FlipH="${c.flipH ? 1 : 0}"`)
  put('crop.flipV', `esq:FlipV="${c.flipV ? 1 : 0}"`)

  // Adobe's MaskGroupBasedCorrections is a deep rdf:Seq of per-mask structs
  // with no room for our extra shapes, so the whole list goes out as one JSON
  // blob. Lightroom ignores it; we round-trip it exactly. Same pragmatic
  // answer for RetouchAreas.
  if (e.masks.length) put('masks', `esq:Masks="${xmlAttr(JSON.stringify(e.masks))}"`)
  if (e.spots.length) put('spots', `esq:Spots="${xmlAttr(JSON.stringify(e.spots))}"`)
  if (e.redEye.length) put('redEye', `esq:RedEye="${xmlAttr(JSON.stringify(e.redEye))}"`)

  return out
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
