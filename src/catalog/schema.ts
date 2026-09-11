import { defaultEdits, getPath, leafPaths } from '../core/defaults'
import { migrateEdits, migratePartialEdits } from '../develop/migrate'
import { SEGMENT_MODEL_IDS } from '../ai/models'
import { RAW_EXTENSIONS, RENDERED_EXTENSIONS } from './fs'
import {
  EDITS_VERSION,
  type AiMaskGeometry,
  type CatalogFolder,
  type Collection,
  type CurvePoint,
  type Edits,
  type EditSection,
  type Layer,
  type MaskAdjustments,
  type MaskComponent,
  type MaskGeometry,
  type Photo,
  type PhotoMetadata,
  type Preset,
  type SmartRule,
  type Snapshot,
  type LayerBlend,
  type LayerContent,
  type LayerTransform,
} from '../core/types'
import { BLEND_MODE_LABELS } from '../develop/layers'

export const CATALOG_ARCHIVE_VERSION = 1
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024

export type PortableGeometry = Exclude<MaskGeometry, AiMaskGeometry> | Omit<AiMaskGeometry, 'cacheKey'>
export type PortableComponent = Omit<MaskComponent, 'geometry'> & { geometry: PortableGeometry }
export type PortableMask = Omit<Layer, 'components' | 'children'> & {
  components: PortableComponent[]
  children: PortableMask[] | null
}
export type PortableEdits = Omit<Edits, 'layers'> & { layers: PortableMask[] }
export type PortablePhoto = Omit<
  Photo, 'fileHandle' | 'thumbKey' | 'thumbRev' | 'previewRev' | 'proxyKey' | 'readError' | 'edits'
> & { edits: PortableEdits | null }
export type PortableFolder = Omit<CatalogFolder, 'handle'>
export type PortablePreset = Omit<Preset, 'edits'> & { edits: Partial<PortableEdits> }
export type PortableSnapshot = Omit<Snapshot, 'edits'> & { edits: PortableEdits }

export interface CatalogArchive {
  format: 'esque.catalog'
  version: 1
  createdAt: number
  photos: PortablePhoto[]
  folders: PortableFolder[]
  collections: Collection[]
  /** The current DB stores set identities on collections, not in a separate table. */
  collectionSetIds: string[]
  presets: PortablePreset[]
  snapshots: PortableSnapshot[]
}

export class ArchiveValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveValidationError'
  }
}

type Parser<T> = (value: unknown, path: string) => T
type Shape<T> = { [K in keyof T]-?: Parser<T[K]> }

function invalid(path: string, reason: string): never {
  throw new ArchiveValidationError(`${path}: ${reason}.`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
}

function object<T extends object>(shape: Shape<T>): Parser<T> {
  return (value, path) => {
    if (!isRecord(value)) return invalid(path, 'expected an object')
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(shape, key)) invalid(`${path}.${key}`, 'unrecognised field')
    }
    // Only the output accumulator is asserted; every input field passes its
    // parser before assignment. Unknown input is never cast to a catalog type.
    const result = {} as T
    for (const key in shape) {
      const parsed = shape[key](value[key], `${path}.${key}`)
      if (parsed !== undefined) result[key] = parsed
    }
    return result
  }
}

function number(min: number, max: number, integer = false): Parser<number> {
  return (value, path) => {
    if (typeof value !== 'number' || !Number.isFinite(value) ||
      value < min || value > max || (integer && !Number.isSafeInteger(value))) {
      return invalid(path, `expected ${integer ? 'an integer' : 'a finite number'} from ${min} to ${max}`)
    }
    return value
  }
}

function text(max = 4096, min = 0): Parser<string> {
  return (value, path) => {
    if (typeof value !== 'string' || value.length < min || value.length > max || value.includes('\0')) {
      return invalid(path, `expected text of ${min}–${max} characters without null characters`)
    }
    return value
  }
}

function oneOf<const T extends readonly (string | number | boolean)[]>(...values: T): Parser<T[number]> {
  return (value, path) => {
    for (const candidate of values) if (candidate === value) return candidate
    return invalid(path, `expected ${values.join(', ')}`)
  }
}

const boolean: Parser<boolean> = (value, path) =>
  typeof value === 'boolean' ? value : invalid(path, 'expected true or false')

function nullable<T>(parse: Parser<T>): Parser<T | null> {
  return (value, path) => value === null ? null : parse(value, path)
}

function optional<T>(parse: Parser<T>): Parser<T | undefined> {
  return (value, path) => value === undefined ? undefined : parse(value, path)
}

function array<T>(parse: Parser<T>, max = 100_000, min = 0): Parser<T[]> {
  return (value, path) => {
    if (!Array.isArray(value) || value.length > max || value.length < min) {
      return invalid(path, `expected a list with ${min}–${max} entries`)
    }
    return value.map((entry: unknown, i: number) => parse(entry, `${path}[${i}]`))
  }
}

function unique<T>(values: T[], key: (value: T) => string, path: string): T[] {
  const seen = new Set<string>()
  for (const value of values) {
    const id = key(value)
    if (seen.has(id)) invalid(path, `duplicate identity ${id}`)
    seen.add(id)
  }
  return values
}

const id: Parser<string> = (value, path) => {
  const parsed = text(200, 1)(value, path)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(parsed)) invalid(path, 'invalid identity')
  return parsed
}
const identity = (value: string) => value
const ids: Parser<string[]> = (value, path) => unique(array(id)(value, path), identity, path)
const percent = number(0, 100)
const signedPercent = number(-100, 100)
const unit = number(0, 1)
const coordinate = number(-10, 10)
const positiveRadius = number(0.000001, 10)
const integer = number(0, Number.MAX_SAFE_INTEGER, true)
const timestamp = number(-8_640_000_000_000_000, 8_640_000_000_000_000, true)
const dimension = number(0, 1_000_000, true)
const point = object<{ x: number; y: number }>({ x: coordinate, y: coordinate })

function four<T>(parse: Parser<T>): Parser<[T, T, T, T]> {
  return (value, path) => {
    const entries = array(parse, 4, 4)(value, path)
    return [entries[0], entries[1], entries[2], entries[3]]
  }
}

const curve: Parser<CurvePoint[]> = (value, path) => {
  const points = array(object<CurvePoint>({ x: unit, y: unit }), 4096, 2)(value, path)
  for (let i = 1; i < points.length; i++) {
    if (points[i].x - points[i - 1].x < 0.000001) invalid(path, 'curve points must have distinct, increasing x coordinates')
  }
  return points
}

const bandValues = object<Edits['colorMixer']['hue']>({
  red: signedPercent, orange: signedPercent, yellow: signedPercent, green: signedPercent,
  aqua: signedPercent, blue: signedPercent, purple: signedPercent, magenta: signedPercent,
})
const gradeWheel = object<Edits['colorGrading']['global']>({
  hue: number(0, 360), saturation: percent, luminance: signedPercent,
})

const maskAdjustments = object<MaskAdjustments>({
  exposure: number(-20, 20), contrast: signedPercent, highlights: signedPercent,
  shadows: signedPercent, whites: signedPercent, blacks: signedPercent,
  texture: signedPercent, clarity: signedPercent, dehaze: signedPercent,
  temp: signedPercent, tint: signedPercent, saturation: signedPercent,
  hue: number(0, 360), hueStrength: percent, colorize: percent, sharpness: signedPercent,
  noise: percent, moire: percent, defringe: percent, curve,
})

const geometry: Parser<PortableGeometry> = (value, path) => {
  if (!isRecord(value)) return invalid(path, 'expected mask geometry')
  if (value.kind === 'aiSky' || value.kind === 'aiObjects') {
    return invalid(path, 'this build cannot regenerate Sky/Object coverage; keep the original catalog and use a build that supports those detections')
  }
  switch (value.kind) {
    case 'linear':
      return object<Extract<PortableGeometry, { kind: 'linear' }>>({
        kind: oneOf('linear'), start: point, end: point,
      })(value, path)
    case 'radial':
      return object<Extract<PortableGeometry, { kind: 'radial' }>>({
        kind: oneOf('radial'), center: point, radiusX: positiveRadius, radiusY: positiveRadius,
        rotation: number(-1000, 1000), feather: percent,
      })(value, path)
    case 'brush':
      return object<Extract<PortableGeometry, { kind: 'brush' }>>({
        kind: oneOf('brush'),
        dabs: array(object({
          x: coordinate, y: coordinate, radius: positiveRadius, flow: unit, erase: boolean,
        }), 1_000_000),
        feather: percent, autoMask: boolean,
      })(value, path)
    case 'colorRange':
      return object<Extract<PortableGeometry, { kind: 'colorRange' }>>({
        kind: oneOf('colorRange'),
        samples: array(object({
          r: number(-1, 100_000), g: number(-1, 100_000), b: number(-1, 100_000),
        }), 4096),
        refine: percent,
      })(value, path)
    case 'luminanceRange': {
      const parsed = object<Extract<PortableGeometry, { kind: 'luminanceRange' }>>({
        kind: oneOf('luminanceRange'), range: four(unit), smoothness: percent,
      })(value, path)
      if (parsed.range.some((n, i) => i > 0 && n < parsed.range[i - 1])) {
        invalid(path, 'luminance range stops must be ordered')
      }
      return parsed
    }
    default:
      return object<Omit<AiMaskGeometry, 'cacheKey'>>({
        kind: oneOf('aiSubject', 'aiBackground', 'aiPerson'),
        model: optional(oneOf(...SEGMENT_MODEL_IDS)),
        hint: optional(object({ x: unit, y: unit, w: unit, h: unit })),
        refine: percent,
      })(value, path)
  }
}

const BLEND_MODE_IDS = Object.keys(BLEND_MODE_LABELS) as [LayerBlend, ...LayerBlend[]]

function three<T>(parse: Parser<T>): Parser<[T, T, T]> {
  return (value, path) => {
    const entries = array(parse, 3, 3)(value, path)
    return [entries[0], entries[1], entries[2]]
  }
}

const layerTransform = object<LayerTransform>({
  offsetX: number(-400, 400), offsetY: number(-400, 400),
  scale: number(1, 1000), rotate: number(-360, 360),
  flipH: boolean, flipV: boolean,
})

const layerContent: Parser<LayerContent> = (value, path) => {
  if (!isRecord(value)) return invalid(path, 'expected an object')
  switch (value.kind) {
    case 'fill':
      return object<Extract<LayerContent, { kind: 'fill' }>>({
        kind: oneOf('fill'), color: three(unit),
      })(value, path)
    case 'image':
      // `source` names a cache entry, not a file: pixels live in local storage,
      // so an archive opened elsewhere renders the layer as nothing until the
      // image is imported again.
      return object<Extract<LayerContent, { kind: 'image' }>>({
        kind: oneOf('image'), source: text(1024, 1), width: dimension, height: dimension,
      })(value, path)
    default:
      return object<Extract<LayerContent, { kind: 'adjust' }>>({ kind: oneOf('adjust') })(value, path)
  }
}

/** Deep enough for any stack a person builds, shallow enough to bound the parse. */
const MAX_LAYER_DEPTH = 8

function layerAt(depth: number): Parser<PortableMask> {
  return (value, path) => {
    if (depth > MAX_LAYER_DEPTH) invalid(path, 'layer groups are nested too deeply')
    return object<PortableMask>({
      id, name: text(4096, 1), visible: boolean, inverted: boolean, opacity: unit,
      blend: oneOf(...BLEND_MODE_IDS),
      components: array(object<PortableComponent>({
        id, blend: oneOf('add', 'subtract', 'intersect'), invert: boolean, geometry,
      }), 4096),
      content: layerContent,
      adjustments: maskAdjustments,
      transform: layerTransform,
      clipped: boolean,
      children: nullable(array(layerAt(depth + 1), 4096)),
      isolate: boolean,
    })(value, path)
  }
}

const layers: Parser<PortableMask[]> = (value, path) => {
  const parsed = array(layerAt(0), 4096)(value, path)
  const flat: PortableMask[] = []
  const walk = (list: PortableMask[]) => {
    for (const layer of list) {
      flat.push(layer)
      if (layer.children) walk(layer.children)
    }
  }
  walk(parsed)
  unique(flat, (layer) => layer.id, path)
  const components = new Set<string>()
  for (const layer of flat) {
    for (const component of layer.components) {
      if (components.has(component.id)) invalid(`${path}.components`, 'component identities must be unique within the edit stack')
      components.add(component.id)
    }
  }
  return parsed
}

const editShape: Shape<PortableEdits> = {
  // Every version the migrations can bring forward, not just the current one:
  // an archive is a file someone made months ago and it has to still open.
  version: number(1, EDITS_VERSION),
  profile: text(200, 1),
  basic: object<Edits['basic']>({
    wbMode: oneOf('asShot', 'auto', 'daylight', 'cloudy', 'shade', 'tungsten', 'fluorescent', 'flash', 'custom'),
    temp: number(100, 100_000), tint: number(-1000, 1000), exposure: number(-20, 20),
    contrast: signedPercent, highlights: signedPercent, shadows: signedPercent,
    whites: signedPercent, blacks: signedPercent, texture: signedPercent, clarity: signedPercent,
    dehaze: signedPercent, vibrance: signedPercent, saturation: signedPercent,
    treatment: oneOf('color', 'bw'), avoidColorShift: boolean, protectSkin: boolean,
  }),
  tone: object<Edits['tone']>({
    recovery: oneOf('off', 'clip', 'blend', 'propagate'), recoveryThreshold: percent,
    shHighlights: percent, shShadows: percent, shRadius: number(1, 100), shTonalWidth: number(1, 100),
    drcAmount: percent, drcDetail: percent, detailFinest: signedPercent, detailFine: signedPercent,
    detailCoarse: signedPercent, detailCoarsest: signedPercent, detailThreshold: percent,
  }),
  curve: object<Edits['curve']>({
    mode: oneOf('parametric', 'point'),
    rgbMode: oneOf('standard', 'weighted', 'filmLike', 'saturationAndValue', 'luminance', 'perceptual'),
    parametric: object({
      highlights: signedPercent, lights: signedPercent, darks: signedPercent, shadows: signedPercent,
      shadowSplit: unit, midtoneSplit: unit, highlightSplit: unit,
    }),
    rgb: curve, red: curve, green: curve, blue: curve,
  }),
  colorMixer: object<Edits['colorMixer']>({
    hue: bandValues, saturation: bandValues, luminance: bandValues, bw: bandValues,
  }),
  colorGrading: object<Edits['colorGrading']>({
    shadows: gradeWheel, midtones: gradeWheel, highlights: gradeWheel, global: gradeWheel,
    blending: percent, balance: signedPercent,
  }),
  detail: object<Edits['detail']>({
    sharpenAmount: number(0, 150), sharpenRadius: number(0.1, 10), sharpenDetail: percent,
    sharpenMasking: percent, luminanceNR: percent, luminanceNRDetail: percent,
    luminanceNRContrast: percent, colorNR: percent, colorNRDetail: percent,
    colorNRSmoothness: percent, impulseNR: percent,
  }),
  lens: object<Edits['lens']>({
    enableProfile: boolean, distortion: signedPercent, vignetting: signedPercent,
    caRed: signedPercent, caBlue: signedPercent,
    defringePurpleAmount: percent, defringePurpleHueLo: percent, defringePurpleHueHi: percent,
    defringeGreenAmount: percent, defringeGreenHueLo: percent, defringeGreenHueHi: percent,
  }),
  transform: object<Edits['transform']>({
    vertical: signedPercent, horizontal: signedPercent, rotate: number(-180, 180),
    aspect: signedPercent, scale: number(1, 1000), offsetX: signedPercent, offsetY: signedPercent,
  }),
  crop: object<Edits['crop']>({
    left: unit, top: unit, right: unit, bottom: unit, angle: number(-45, 45),
    aspect: oneOf('free', 'original', '1x1', '4x5', '5x7', '2x3', '4x3', '16x9', '3x1', '65x24'),
    aspectLocked: boolean, quarterTurns: number(0, 3, true), flipH: boolean, flipV: boolean,
  }),
  effects: object<Edits['effects']>({
    vignetteAmount: signedPercent, vignetteMidpoint: percent, vignetteRoundness: signedPercent,
    vignetteFeather: percent, vignetteHighlights: percent, grainAmount: percent,
    grainSize: percent, grainRoughness: percent,
  }),
  calibration: object<Edits['calibration']>({
    shadowTint: signedPercent, redHue: signedPercent, redSaturation: signedPercent,
    greenHue: signedPercent, greenSaturation: signedPercent, blueHue: signedPercent, blueSaturation: signedPercent,
  }),
  layers,
  spots: array(object<Edits['spots'][number]>({
    id, mode: oneOf('heal', 'clone'), target: point, source: point,
    radius: positiveRadius, feather: percent, opacity: unit,
  }), 100_000),
  redEye: array(object<Edits['redEye'][number]>({
    id, kind: oneOf('human', 'pet'), center: point, radius: positiveRadius, darken: percent,
  }), 100_000),
}

function validateEditRelations(edits: Partial<PortableEdits>, path: string) {
  if (edits.crop && (edits.crop.right - edits.crop.left < 0.000001 || edits.crop.bottom - edits.crop.top < 0.000001)) {
    invalid(`${path}.crop`, 'crop must have positive width and height')
  }
  if (edits.curve) {
    const p = edits.curve.parametric
    if (p.shadowSplit > p.midtoneSplit || p.midtoneSplit > p.highlightSplit) {
      invalid(`${path}.curve`, 'curve split points must be ordered')
    }
  }
  if (edits.spots) unique(edits.spots, (spot) => spot.id, `${path}.spots`)
  if (edits.redEye) unique(edits.redEye, (eye) => eye.id, `${path}.redEye`)
}

const editParser: Parser<PortableEdits> = (value, path) => {
  const parsed = object(editShape)(value, path)
  validateEditRelations(parsed, path)
  return migrateEdits(parsed as unknown as Edits) as unknown as PortableEdits
}

const partialEditParser: Parser<Partial<PortableEdits>> = (value, path) => {
  const parsed = object<Partial<PortableEdits>>({
    version: optional(editShape.version), profile: optional(editShape.profile),
    basic: optional(editShape.basic), tone: optional(editShape.tone), curve: optional(editShape.curve),
    colorMixer: optional(editShape.colorMixer), colorGrading: optional(editShape.colorGrading),
    detail: optional(editShape.detail), lens: optional(editShape.lens), transform: optional(editShape.transform),
    crop: optional(editShape.crop), effects: optional(editShape.effects), calibration: optional(editShape.calibration),
    layers: optional(editShape.layers), spots: optional(editShape.spots), redEye: optional(editShape.redEye),
  })(value, path)
  validateEditRelations(parsed, path)
  return migratePartialEdits(parsed as unknown as Partial<Edits>) as unknown as Partial<PortableEdits>
}

const metadataParser = object<PhotoMetadata>({
  cameraMake: text(), cameraModel: text(), lens: text(), iso: number(0, 100_000_000),
  shutter: number(0, 100_000_000), aperture: number(0, 100_000), focalLength: number(0, 100_000),
  captureTime: nullable(timestamp), artist: text(65_536), copyright: text(65_536),
  gps: nullable(object({ lat: number(-90, 90), lon: number(-180, 180), alt: number(-100_000, 100_000_000) })),
  flip: number(0, 7, true), camMul: nullable(array(number(0, 1_000_000), 4, 3)),
  preMul: nullable(array(number(0, 1_000_000), 4, 3)),
  camXyz: nullable(array(array(number(-1000, 1000), 3, 3), 4, 3)),
  black: nullable(number(0, 1_000_000_000)), maximum: nullable(number(0, 1_000_000_000)),
  rawCrop: optional(nullable(four(dimension))),
  embeddedWidth: optional(dimension), embeddedHeight: optional(dimension),
})

export const parseRelativePath: Parser<string> = (value, path) => {
  const parsed = text(16_384, 1)(value, path)
  if (parsed.includes('\\') || parsed.split('/').some((part) => !part || part === '.' || part === '..')) {
    invalid(path, 'expected a safe path relative to its folder')
  }
  return parsed
}

const photoParser = object<PortablePhoto>({
  id, folderId: id, relPath: parseRelativePath, filename: text(4096, 1), ext: text(40, 1),
  isRaw: boolean, hdr: optional(boolean), fileSize: integer, modifiedAt: timestamp, addedAt: timestamp,
  width: dimension, height: dimension, meta: metadataParser,
  rating: number(0, 5, true), flag: oneOf('unflagged', 'pick', 'reject'),
  label: oneOf('none', 'red', 'yellow', 'green', 'blue', 'purple'),
  keywords: array(text(4096, 1), 100_000), title: text(65_536), caption: text(1_000_000),
  edits: nullable(editParser), masterId: nullable(id), copyName: nullable(text(4096)),
  stackId: nullable(id), stackPosition: integer, stackCollapsed: boolean,
})

const ruleValue: Parser<SmartRule['value']> = (value, path) => {
  if (typeof value === 'boolean') return value
  return typeof value === 'number' ? number(-8.64e15, 8.64e15)(value, path) : text(65_536)(value, path)
}

const ruleParser: Parser<SmartRule> = (value, path) => {
  const parsed = object<SmartRule>({
    field: oneOf('rating', 'flag', 'label', 'filename', 'keyword', 'camera', 'lens', 'iso',
      'aperture', 'focalLength', 'captureTime', 'edited', 'fileType'),
    op: oneOf('is', 'isNot', 'contains', 'notContains', 'startsWith', 'endsWith', 'gte', 'lte', 'inRange'),
    value: ruleValue,
    value2: optional((entry, at) => typeof entry === 'number'
      ? number(-8.64e15, 8.64e15)(entry, at) : text(65_536)(entry, at)),
  })(value, path)
  if (parsed.op === 'inRange' && parsed.value2 === undefined) invalid(path, 'range needs a second value')
  const numberFields = ['rating', 'iso', 'aperture', 'focalLength', 'captureTime']
  if (numberFields.includes(parsed.field)) {
    if (!['is', 'isNot', 'gte', 'lte', 'inRange'].includes(parsed.op)) invalid(path, 'numeric rule has an incompatible operator')
    const readNumber = (entry: unknown) => {
      const candidate = typeof entry === 'string' && entry.trim() ? Number(entry) : entry
      const min = parsed.field === 'captureTime' ? -8.64e15 : 0
      const max = parsed.field === 'rating' ? 5 : 8.64e15
      return number(min, max, parsed.field === 'rating')(candidate, `${path}.value`)
    }
    const first = readNumber(parsed.value)
    if (parsed.value2 !== undefined) {
      const second = readNumber(parsed.value2)
      if (parsed.op === 'inRange' && first > second) invalid(path, 'range start must not follow its end')
    }
  } else {
    switch (parsed.field) {
      case 'flag':
        oneOf('pick', 'reject', 'unflagged')(parsed.value, `${path}.value`)
        if (!['is', 'isNot'].includes(parsed.op)) invalid(path, 'flag rule has an incompatible operator')
        break
      case 'label':
        oneOf('none', 'red', 'yellow', 'green', 'blue', 'purple')(parsed.value, `${path}.value`)
        if (!['is', 'isNot'].includes(parsed.op)) invalid(path, 'label rule has an incompatible operator')
        break
      case 'edited':
        oneOf(true, false, 'true', 'false')(parsed.value, `${path}.value`)
        if (parsed.op !== 'is') invalid(path, 'edit-state rule must use is')
        break
      case 'fileType':
        oneOf('raw', 'rendered')(parsed.value, `${path}.value`)
        if (parsed.op !== 'is') invalid(path, 'file-type rule must use is')
        break
      default:
        text(65_536)(parsed.value, `${path}.value`)
        if (!['is', 'isNot', 'contains', 'notContains', 'startsWith', 'endsWith'].includes(parsed.op)) {
          invalid(path, 'text rule has an incompatible operator')
        }
    }
  }
  return parsed
}

const collectionParser = object<Collection>({
  id, name: text(4096, 1), smart: boolean, rules: array(ruleParser, 10_000),
  match: oneOf('all', 'any'), photoIds: ids, createdAt: timestamp, setId: nullable(id),
})

const section: Parser<EditSection> = oneOf(
  'profile', 'basic', 'tone', 'curve', 'colorMixer', 'colorGrading', 'detail',
  'lens', 'transform', 'crop', 'effects', 'calibration', 'layers', 'spots', 'redEye',
)
const presetPaths = new Set(leafPaths(defaultEdits()).filter((path) => path !== 'version'))
const presetParser: Parser<PortablePreset> = (value, path) => {
  const parsed = object<PortablePreset>({
    id, name: text(4096, 1), group: text(4096), builtin: oneOf(false),
    sections: array(section, 15, 1), paths: optional(array(text(200, 1), 4096)),
    edits: partialEditParser, createdAt: timestamp,
  })(value, path)
  unique(parsed.sections, identity, `${path}.sections`)
  for (const name of parsed.sections) {
    if (parsed.edits[name] === undefined) invalid(`${path}.edits`, `missing declared section ${name}`)
  }
  if (parsed.paths) {
    unique(parsed.paths, identity, `${path}.paths`)
    for (const entry of parsed.paths) {
      if (!presetPaths.has(entry) || getPath(parsed.edits, entry) === undefined ||
        !parsed.sections.some((name) => entry === name || entry.startsWith(`${name}.`))) {
        invalid(`${path}.paths`, `invalid or missing edit path ${entry}`)
      }
    }
  }
  return parsed
}

const archiveParser = object<CatalogArchive>({
  format: oneOf('esque.catalog'), version: oneOf(CATALOG_ARCHIVE_VERSION), createdAt: timestamp,
  photos: array(photoParser),
  folders: array(object<PortableFolder>({
    id, name: text(4096, 1), loose: optional(boolean), addedAt: timestamp, photoCount: integer,
  })),
  collections: array(collectionParser), collectionSetIds: ids,
  presets: array(presetParser),
  snapshots: array(object<PortableSnapshot>({
    id, photoId: id, name: text(4096, 1), edits: editParser, createdAt: timestamp,
  })),
})

function validatePhotos(
  archive: CatalogArchive,
  folders: Map<string, PortableFolder>,
  photos: Map<string, PortablePhoto>,
) {
  const sources = new Set<string>()
  for (const photo of archive.photos) {
    if (!folders.has(photo.folderId)) invalid(`Photo ${photo.id}`, 'folder reference is missing')
    if (photo.filename.includes('/') || photo.filename.includes('\\')) {
      invalid(`Photo ${photo.id}`, 'filename must not contain a directory path')
    }
    if ((!folders.get(photo.folderId)?.loose && photo.filename !== photo.relPath.split('/').at(-1)) ||
      photo.ext !== photo.filename.split('.').at(-1)?.toLowerCase()) {
      invalid(`Photo ${photo.id}`, 'filename, extension and relative path disagree')
    }
    if ((!RAW_EXTENSIONS.has(photo.ext) && !RENDERED_EXTENSIONS.has(photo.ext)) ||
      photo.isRaw !== RAW_EXTENSIONS.has(photo.ext)) {
      invalid(`Photo ${photo.id}`, 'unsupported file extension or inconsistent RAW/rendered identity')
    }
    if (photo.masterId !== null) {
      const master = photos.get(photo.masterId)
      if (!master || master.masterId !== null || !sameOriginal(photo, master)) {
        invalid(`Photo ${photo.id}`, 'virtual copy must reference its original with the same file identity')
      }
      continue
    }
    const source = JSON.stringify([photo.folderId, photo.relPath])
    if (sources.has(source)) invalid(`Photo ${photo.id}`, 'duplicate original folder/path identity')
    sources.add(source)
  }
}

function validateCollections(
  archive: CatalogArchive,
  photos: Map<string, PortablePhoto>,
  sets: Set<string>,
) {
  const usedSets = new Set<string>()
  for (const collection of archive.collections) {
    if (collection.setId !== null && !sets.has(collection.setId)) {
      invalid(`Collection ${collection.id}`, 'collection set reference is missing')
    }
    if (collection.photoIds.some((photoId) => !photos.has(photoId))) {
      invalid(`Collection ${collection.id}`, 'photo reference is missing')
    }
    if (collection.smart && collection.photoIds.length) {
      invalid(`Collection ${collection.id}`, 'smart collections cannot carry static membership')
    }
    if (collection.setId) usedSets.add(collection.setId)
  }
  return usedSets
}

function validateCollectionSets(sets: Set<string>, usedSets: Set<string>) {
  for (const setId of sets) {
    if (!usedSets.has(setId)) {
      invalid(`Collection set ${setId}`, 'no collection carries this set identity')
    }
  }
}

function validateSnapshots(archive: CatalogArchive, photos: Map<string, PortablePhoto>) {
  for (const snapshot of archive.snapshots) {
    if (!photos.has(snapshot.photoId)) {
      invalid(`Snapshot ${snapshot.id}`, 'photo reference is missing')
    }
  }
}

/** Validates and rebuilds the entire graph before any DB access is allowed. */
export function validateCatalogArchive(value: unknown): CatalogArchive {
  if (isRecord(value) && value.format === 'esque.catalog' && value.version !== CATALOG_ARCHIVE_VERSION) {
    invalid('Backup version', `unsupported version (this build reads version ${CATALOG_ARCHIVE_VERSION})`)
  }
  const archive = archiveParser(value, 'Backup')
  for (const table of ['photos', 'folders', 'collections', 'presets', 'snapshots'] as const) {
    unique<{ id: string }>(archive[table], (entry) => entry.id, `Backup.${table}`)
  }
  const folders = new Map(archive.folders.map((folder) => [folder.id, folder]))
  const photos = new Map(archive.photos.map((photo) => [photo.id, photo]))
  const sets = new Set(archive.collectionSetIds)
  validatePhotos(archive, folders, photos)
  const usedSets = validateCollections(archive, photos, sets)
  validateCollectionSets(sets, usedSets)
  validateSnapshots(archive, photos)
  return archive
}

export function parseCatalogArchive(text: string): CatalogArchive {
  if (text.length > MAX_ARCHIVE_BYTES || new Blob([text]).size > MAX_ARCHIVE_BYTES) {
    invalid('Backup', 'file exceeds the 64 MB catalog limit (original photos do not belong in this file)')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return invalid('Backup', 'not valid JSON; choose an esque catalog backup, not an XMP sidecar')
  }
  return validateCatalogArchive(value)
}

export function sameOriginal(
  a: Pick<Photo, 'folderId' | 'relPath' | 'filename' | 'ext' | 'fileSize' | 'modifiedAt' | 'isRaw'>,
  b: Pick<Photo, 'folderId' | 'relPath' | 'filename' | 'ext' | 'fileSize' | 'modifiedAt' | 'isRaw'>,
): boolean {
  return a.folderId === b.folderId && a.relPath === b.relPath && a.fileSize === b.fileSize &&
    a.modifiedAt === b.modifiedAt && a.isRaw === b.isRaw && a.filename === b.filename && a.ext === b.ext
}
