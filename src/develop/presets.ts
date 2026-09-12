import { defaultEdits, getPath, leafPaths, sectionOfPath, setPath } from '../core/defaults'
import type { FileKind } from '../core/defaults'
import { EDITS_VERSION } from '../core/types'
import type { CurvePoint, EditSection, Edits, Preset } from '../core/types'

/**
 * The esque preset library.
 *
 * Public recipe references are credited in README.md. These are adaptations
 * for esque's tone curves and colour pipeline, not measured film simulations.
 * Looks replace creative settings as a unit; Tools remain sparse, stackable
 * patches. Neither guesses the photo's exposure or white balance.
 */

const base = defaultEdits()

/**
 * Runs a preset's builder against a recording proxy so we learn exactly which
 * fields it *assigned*, not merely which ones ended up different.
 *
 * The distinction is the whole ballgame. `Grain — 35mm` sets size 25 and
 * roughness 50, which happen to be the stock values; a diff would drop them,
 * and stacking that preset over a coarse-grained look would leave you with 35mm
 * grain at medium-format size. `High ISO Rescue` sets grain to 0 on purpose,
 * because grain and noise reduction fight — a diff would drop that too.
 */
function record(build: (e: Edits) => void): { edits: Edits; paths: string[] } {
  const edits = structuredClone(base)
  const written = new Set<string>()

  const wrap = (target: Record<string, unknown>, prefix: string): Record<string, unknown> =>
    new Proxy(target, {
      get(t, key: string) {
        const value = t[key]
        // Arrays are assigned whole (curves, layers), so they stay opaque.
        return value && typeof value === 'object' && !Array.isArray(value)
          ? wrap(value as Record<string, unknown>, `${prefix}${key}.`)
          : value
      },
      set(t, key: string, value: unknown) {
        t[key] = value
        written.add(`${prefix}${key}`)
        return true
      },
    })

  build(wrap(edits as unknown as Record<string, unknown>, '') as unknown as Edits)

  // Assigning a whole object — `e.colorGrading.shadows = { hue, saturation,
  // luminance }` — means all of its leaves.
  const paths = [...new Set([...written].flatMap((path) => leafPaths(getPath(edits, path), path)))]
  return { edits, paths }
}

function make(
  id: string,
  group: string,
  name: string,
  note: string,
  sections: EditSection[],
  build: (e: Edits) => void,
): Preset & { note: string } {
  const { edits, paths } = record(build)

  const declared = new Set(sections)
  const stray = paths.filter((p) => !declared.has(sectionOfPath(p)))
  if (stray.length) {
    // A look that writes outside the sections it advertises would apply fields
    // the preset browser never mentions. Better to fail loudly at module load
    // than to ship a preset that quietly changes something else.
    throw new Error(`Preset "${id}" writes undeclared sections: ${stray.join(', ')}`)
  }

  // Stamped for the same reason a user preset is: an unversioned patch reads
  // as the oldest one and would be migrated when it should not be.
  const patch: Partial<Edits> = { version: EDITS_VERSION }
  for (const path of paths) {
    const section = sectionOfPath(path)
    if (patch[section] === undefined) {
      ;(patch as unknown as Record<string, unknown>)[section] = structuredClone(
        (edits as unknown as Record<string, unknown>)[section],
      )
    }
  }
  return {
    id,
    name,
    group,
    note,
    builtin: true,
    sections: [...new Set(paths.map(sectionOfPath))],
    paths,
    edits: patch,
    createdAt: 0,
  }
}

/** Point-curve helper: values are 0..255 like Lightroom's, converted to 0..1. */
const curve = (...pts: Array<[number, number]>): CurvePoint[] =>
  pts.map(([x, y]) => ({ x: x / 255, y: y / 255 }))

function look(
  id: string,
  group: string,
  name: string,
  note: string,
  build: (e: Edits) => void,
): Preset & { note: string } {
  return make(id, group, name, note, ['basic', 'curve', 'colorMixer', 'colorGrading', 'effects'], (e) => {
    // Explicit defaults prevent a previous look's B&W treatment, channel
    // curves, toning or grain from leaking into the next selection.
    e.basic.contrast = 0
    e.basic.highlights = 0
    e.basic.shadows = 0
    e.basic.whites = 0
    e.basic.blacks = 0
    e.basic.texture = 0
    e.basic.clarity = 0
    e.basic.dehaze = 0
    e.basic.vibrance = 0
    e.basic.saturation = 0
    e.basic.treatment = 'color'
    e.curve = structuredClone(base.curve)
    e.curve.mode = 'point'
    e.colorMixer = structuredClone(base.colorMixer)
    e.colorGrading = structuredClone(base.colorGrading)
    e.effects = structuredClone(base.effects)
    build(e)
  })
}

// ---------------------------------------------------------------------------
// Colour negative-inspired looks. References and modifications: README.md.
// ---------------------------------------------------------------------------

const FILM = [
  look(
    'soft-portrait-400',
    'Colour Negative',
    'Soft Portrait',
    'Soft whites, quiet warm colours and a fine grain. A gentle portrait starting point.',
    (e) => {
      // Questtion Preset 10: soften its shoulder and reduce scene corrections.
      e.basic.highlights = -14
      e.basic.shadows = 10
      e.basic.clarity = -4
      e.basic.saturation = -5
      e.curve.rgb = curve([0, 6], [32, 31], [128, 133], [224, 229], [255, 249])
      e.curve.blue = curve([0, 1], [56, 58], [192, 192], [255, 255])
      e.colorMixer.saturation.orange = -8
      e.colorMixer.luminance.orange = 4
      e.colorMixer.saturation.yellow = -8
      e.colorGrading.highlights = { hue: 48, saturation: 5, luminance: 0 }
      e.effects.grainAmount = 10
      e.effects.grainSize = 20
      e.effects.grainRoughness = 42
    },
  ),
  look(
    'soft-portrait-400-push',
    'Colour Negative',
    'Portrait Rich',
    'Deeper midtones and more texture than Soft Portrait, without an exposure boost.',
    (e) => {
      // A firmer original variant of the same Preset 10 reference.
      e.basic.highlights = -10
      e.basic.shadows = 4
      e.basic.saturation = -2
      e.curve.rgb = curve([0, 2], [32, 25], [96, 88], [160, 165], [224, 232], [255, 253])
      e.curve.blue = curve([0, 2], [56, 59], [192, 191], [255, 254])
      e.colorMixer.saturation.orange = -6
      e.colorMixer.luminance.orange = 3
      e.colorMixer.saturation.yellow = -10
      e.colorMixer.saturation.green = -12
      e.colorGrading.highlights = { hue: 44, saturation: 4, luminance: 0 }
      e.effects.grainAmount = 18
      e.effects.grainSize = 26
      e.effects.grainRoughness = 48
    },
  ),
  look(
    'airy-pastel-400',
    'Colour Negative',
    'Pastel Daylight',
    'Cool soft whites and pastel colour, with enough shadow depth to keep the image clear.',
    (e) => {
      // mecabify: retain cool compression, not +90 orange or +52 blue toning.
      e.basic.contrast = -5
      e.basic.highlights = -12
      e.basic.shadows = 12
      e.basic.clarity = -3
      e.basic.vibrance = 3
      e.basic.saturation = -9
      e.curve.rgb = curve([0, 6], [48, 49], [128, 136], [208, 213], [255, 249])
      e.colorMixer.saturation.orange = 3
      e.colorMixer.luminance.orange = 5
      e.colorMixer.saturation.yellow = -7
      e.colorMixer.saturation.green = -14
      e.colorMixer.saturation.blue = -6
      e.colorGrading.shadows = { hue: 206, saturation: 2, luminance: 0 }
      e.colorGrading.highlights = { hue: 222, saturation: 4, luminance: 0 }
      e.effects.grainAmount = 6
      e.effects.grainSize = 18
      e.effects.grainRoughness = 38
    },
  ),
  look(
    'golden-snapshot-200',
    'Colour Negative',
    'Golden Print',
    'Warm print colour, honeyed highlights and a little grain. Best in daylight.',
    (e) => {
      // Golden_Days: original gentler blue curve, no fixed WB or black lift.
      e.basic.highlights = -12
      e.basic.shadows = 6
      e.basic.clarity = -3
      e.basic.saturation = -2
      e.curve.rgb = curve([0, 4], [48, 43], [128, 130], [208, 215], [255, 252])
      e.curve.blue = curve([0, 0], [60, 55], [188, 187], [255, 255])
      e.colorMixer.saturation.orange = -4
      e.colorMixer.hue.yellow = -6
      e.colorMixer.saturation.yellow = 5
      e.colorMixer.saturation.green = -10
      e.colorGrading.highlights = { hue: 52, saturation: 6, luminance: 0 }
      e.colorGrading.midtones = { hue: 358, saturation: 2, luminance: 0 }
      e.effects.grainAmount = 15
      e.effects.grainSize = 24
      e.effects.grainRoughness = 46
    },
  ),
  look(
    'fine-grain-100',
    'Colour Negative',
    'Fine Colour',
    'Clear colour separation, a cool finish and barely visible grain.',
    (e) => {
      // 9bichrome: moderate HSL separation; replace extreme parametric tone.
      e.basic.highlights = -16
      e.basic.shadows = 8
      e.basic.vibrance = 6
      e.basic.saturation = 2
      e.curve.rgb = curve([0, 1], [48, 44], [128, 129], [208, 215], [255, 254])
      e.colorMixer.hue.orange = -4
      e.colorMixer.saturation.red = -10
      e.colorMixer.luminance.red = 6
      e.colorMixer.saturation.orange = 4
      e.colorMixer.saturation.yellow = -8
      e.colorMixer.saturation.aqua = 4
      e.colorMixer.saturation.blue = 5
      e.colorGrading.shadows = { hue: 266, saturation: 2, luminance: 0 }
      e.colorGrading.highlights = { hue: 223, saturation: 2, luminance: 0 }
      e.effects.grainAmount = 4
      e.effects.grainSize = 16
      e.effects.grainRoughness = 40
    },
  ),
]

// ---------------------------------------------------------------------------
// Cinematic
// ---------------------------------------------------------------------------

const CINEMATIC = [
  look(
    'teal-orange',
    'Cinematic',
    'Teal & Orange',
    'Cyan shadows against warm midtones. A restrained colour contrast for people and city scenes.',
    (e) => {
      // Basketball OR/CY: keep the opposing hues, not its gym-light correction.
      e.basic.highlights = -14
      e.basic.shadows = 6
      e.basic.saturation = -4
      e.curve.rgb = curve([0, 5], [48, 40], [128, 128], [208, 216], [255, 251])
      e.colorMixer.hue.green = 24
      e.colorMixer.saturation.green = -18
      e.colorMixer.hue.blue = -8
      e.colorMixer.saturation.blue = -8
      e.colorMixer.saturation.orange = -5
      e.colorGrading.shadows = { hue: 197, saturation: 9, luminance: 0 }
      e.colorGrading.midtones = { hue: 40, saturation: 4, luminance: 0 }
      e.colorGrading.highlights = { hue: 48, saturation: 3, luminance: 0 }
      e.colorGrading.blending = 45
      e.colorGrading.balance = 10
      e.effects.grainAmount = 8
      e.effects.grainSize = 22
    },
  ),
  look(
    'tungsten-night-800',
    'Cinematic',
    'Night Lights',
    'Quiet green and aqua tones let warm lights stand out. Balance mixed lighting first.',
    (e) => {
      // NightFactory: omit 3900 K / +58 tint and reduce clarity from +40.
      e.basic.highlights = -22
      e.basic.shadows = 10
      e.basic.clarity = 3
      e.basic.vibrance = 4
      e.curve.rgb = curve([0, 3], [48, 39], [128, 126], [208, 211], [255, 251])
      e.colorMixer.hue.red = -8
      e.colorMixer.hue.orange = -10
      e.colorMixer.hue.yellow = 12
      e.colorMixer.saturation.green = -32
      e.colorMixer.saturation.aqua = -20
      e.colorMixer.saturation.blue = -10
      e.colorMixer.saturation.purple = -18
      e.curve.blue = curve([0, 3], [64, 67], [192, 192], [255, 254])
      e.effects.grainAmount = 12
      e.effects.grainSize = 24
      e.effects.grainRoughness = 46
    },
  ),
  look(
    'moody-pastoral',
    'Cinematic',
    'Olive Cinema',
    'Muted olive foliage, cool shade and a gold midtone bias. For overcast outdoor scenes.',
    (e) => {
      // Preset 4: reduce gold/cyan toning and keep the white endpoint bright.
      e.basic.highlights = -16
      e.basic.shadows = 5
      e.basic.saturation = -5
      e.curve.rgb = curve([0, 4], [48, 39], [128, 124], [208, 211], [255, 250])
      e.curve.blue = curve([0, 2], [64, 65], [164, 161], [255, 255])
      e.colorMixer.hue.yellow = 10
      e.colorMixer.hue.green = -22
      e.colorMixer.saturation.green = -25
      e.colorMixer.luminance.green = -6
      e.colorMixer.saturation.yellow = -14
      e.colorMixer.saturation.orange = -4
      e.colorGrading.shadows = { hue: 169, saturation: 5, luminance: 0 }
      e.colorGrading.midtones = { hue: 53, saturation: 4, luminance: 0 }
      e.colorGrading.balance = 15
      e.effects.grainAmount = 10
      e.effects.grainSize = 24
    },
  ),
  look(
    'cross-processed',
    'Cinematic',
    'Cross Process',
    'Cool shadows and rose-tinted whites. Deliberately stylised, without crushed blacks.',
    (e) => {
      // mecabify's compressed colour, reinterpreted with original channel curves.
      e.basic.highlights = -10
      e.basic.shadows = 4
      e.basic.saturation = -5
      e.curve.rgb = curve([0, 7], [48, 42], [128, 127], [208, 218], [255, 249])
      e.curve.red = curve([0, 0], [64, 59], [192, 195], [255, 255])
      e.curve.green = curve([0, 2], [64, 65], [192, 189], [255, 251])
      e.curve.blue = curve([0, 5], [64, 70], [192, 195], [255, 255])
      e.colorMixer.saturation.orange = -8
      e.colorMixer.saturation.yellow = -12
      e.colorMixer.hue.green = 16
      e.colorGrading.shadows = { hue: 190, saturation: 4, luminance: 0 }
      e.colorGrading.highlights = { hue: 320, saturation: 5, luminance: 0 }
      e.effects.grainAmount = 12
      e.effects.grainSize = 22
    },
  ),
]

// ---------------------------------------------------------------------------
// Questtion BW 3: three original print contrasts and eight-band B&W mixes.
// ---------------------------------------------------------------------------

const mono = (e: Edits) => {
  e.basic.treatment = 'bw'
}

const MONOCHROME = [
  look(
    'reportage-400',
    'Black & White',
    'Reportage',
    'A firm black-and-white print, with darker blues and visible but restrained grain.',
    (e) => {
      mono(e)
      e.basic.highlights = -10
      e.basic.shadows = 6
      e.curve.rgb = curve([0, 2], [60, 48], [128, 128], [187, 200], [255, 253])
      e.colorMixer.bw.red = 8
      e.colorMixer.bw.orange = 10
      e.colorMixer.bw.yellow = -4
      e.colorMixer.bw.green = -14
      e.colorMixer.bw.aqua = -12
      e.colorMixer.bw.blue = -24
      e.colorMixer.bw.purple = -8
      e.colorMixer.bw.magenta = 2
      e.effects.grainAmount = 24
      e.effects.grainSize = 28
      e.effects.grainRoughness = 55
    },
  ),
  look(
    'fibre-print-400',
    'Black & White',
    'Silver Print',
    'Deep warm colours in grey, lighter blues and a subtle warm-paper finish.',
    (e) => {
      mono(e)
      e.basic.highlights = -8
      e.basic.shadows = 8
      e.curve.rgb = curve([0, 3], [60, 54], [128, 130], [187, 197], [255, 251])
      e.colorMixer.bw.red = -4
      e.colorMixer.bw.orange = -8
      e.colorMixer.bw.yellow = -12
      e.colorMixer.bw.green = -16
      e.colorMixer.bw.aqua = -8
      e.colorMixer.bw.blue = 12
      e.colorMixer.bw.purple = 8
      e.colorMixer.bw.magenta = 2
      e.colorGrading.highlights = { hue: 48, saturation: 2, luminance: 0 }
      e.effects.grainAmount = 14
      e.effects.grainSize = 23
      e.effects.grainRoughness = 45
    },
  ),
  look(
    'long-scale-100',
    'Black & White',
    'Soft Monochrome',
    'Open, neutral greys with a soft shoulder. No grain or colour toning.',
    (e) => {
      mono(e)
      e.basic.highlights = -12
      e.basic.shadows = 12
      e.curve.rgb = curve([0, 5], [60, 61], [128, 134], [200, 205], [255, 250])
      e.colorMixer.bw.red = -2
      e.colorMixer.bw.orange = -3
      e.colorMixer.bw.yellow = -6
      e.colorMixer.bw.green = -8
      e.colorMixer.bw.aqua = -4
      e.colorMixer.bw.blue = 10
      e.colorMixer.bw.purple = 4
      e.colorMixer.bw.magenta = 1
    },
  ),
]

// ---------------------------------------------------------------------------
// Genre — subject-led starting points rather than film looks
// ---------------------------------------------------------------------------

const GENRE = [
  look(
    'editorial-clean',
    'Genre',
    'Editorial Clean',
    'A light tonal tidy-up with neutral colour. No toning, grain or vignette.',
    (e) => {
      // Preset 8's simple open-shadow curve, with less white compression.
      e.basic.highlights = -6
      e.basic.shadows = 5
      e.curve.rgb = curve([0, 0], [32, 34], [72, 75], [160, 163], [255, 253])
    },
  ),
  look(
    'portrait-skin',
    'Genre',
    'Portrait',
    'Quiet red and orange tones with gentle microcontrast. No grain or colour cast.',
    (e) => {
      // Preset 1, without its dark midtones or strongly lowered white endpoint.
      e.basic.highlights = -10
      e.basic.shadows = 8
      e.basic.clarity = -5
      e.curve.rgb = curve([0, 1], [48, 47], [128, 131], [211, 214], [255, 253])
      e.colorMixer.saturation.red = -4
      e.colorMixer.saturation.orange = -7
      e.colorMixer.luminance.orange = 3
      e.colorMixer.saturation.yellow = -10
    },
  ),
  look(
    'landscape',
    'Genre',
    'Landscape',
    'Clear blues, controlled yellows and a little structure. No added grain or colour toning.',
    (e) => {
      // 9bichrome's colour separation, rebuilt as a clean landscape variant.
      e.basic.highlights = -18
      e.basic.shadows = 10
      e.basic.texture = 5
      e.basic.dehaze = 3
      e.basic.vibrance = 7
      e.curve.rgb = curve([0, 1], [48, 44], [128, 129], [208, 214], [255, 254])
      e.colorMixer.saturation.red = -6
      e.colorMixer.hue.yellow = -4
      e.colorMixer.saturation.yellow = -10
      e.colorMixer.saturation.green = 2
      e.colorMixer.luminance.green = -3
      e.colorMixer.hue.aqua = 3
      e.colorMixer.saturation.aqua = 5
      e.colorMixer.saturation.blue = 8
      e.colorMixer.luminance.blue = -8
    },
  ),
  look(
    'golden-hour',
    'Genre',
    'Golden Hour',
    'A gentle gold highlight bias and warm shadows. Keeps the photo’s white balance intact.',
    (e) => {
      // Golden_Days, with a lighter curve and no grain for a clean alternative.
      e.basic.highlights = -10
      e.basic.shadows = 8
      e.curve.rgb = curve([0, 1], [64, 65], [128, 133], [208, 214], [255, 253])
      e.curve.blue = curve([0, 0], [60, 57], [189, 188], [255, 255])
      e.colorMixer.saturation.orange = -3
      e.colorMixer.hue.yellow = -4
      e.colorMixer.saturation.yellow = 3
      e.colorGrading.highlights = { hue: 52, saturation: 5, luminance: 0 }
      e.colorGrading.balance = 8
    },
  ),
]

// ---------------------------------------------------------------------------
// Tools — single-purpose, safe to stack under a look
// ---------------------------------------------------------------------------

const TOOLS = [
  make(
    'recover-highlights',
    'Tools',
    'Recover Highlights',
    'Pulls back a blown sky and nothing else.',
    ['basic'],
    (e) => {
      e.basic.highlights = -60
      e.basic.whites = -18
    },
  ),
  make(
    'open-shadows',
    'Tools',
    'Open Shadows',
    'Opens the darks without lifting the black point into haze.',
    ['basic'],
    (e) => {
      e.basic.shadows = 45
      e.basic.blacks = -8
    },
  ),
  make(
    'clear-haze',
    'Tools',
    'Clear Haze',
    'Dehaze plus a little contrast, kept below the point where skies band.',
    ['basic'],
    (e) => {
      e.basic.dehaze = 25
      e.basic.contrast = 8
      e.basic.blacks = -6
    },
  ),
  make(
    'matte-fade',
    'Tools',
    'Matte Fade',
    'The lifted black point on its own. Stack it under any look.',
    ['curve'],
    (e) => {
      e.curve.mode = 'point'
      e.curve.rgb = curve([0, 18], [128, 128], [255, 240])
    },
  ),
  make(
    'nr-high-iso',
    'Tools',
    'High ISO Rescue',
    'Aggressive noise reduction with the detail sliders held high, then a masked sharpen.',
    ['basic', 'detail', 'effects'],
    (e) => {
      // Contrast is never added to a noisy frame — it amplifies the noise.
      e.basic.contrast = -8
      e.basic.highlights = -25
      e.basic.shadows = 20
      e.basic.whites = -5

      e.detail.luminanceNR = 55
      e.detail.luminanceNRDetail = 55
      e.detail.luminanceNRContrast = 60
      e.detail.colorNR = 40
      e.detail.colorNRDetail = 50
      e.detail.colorNRSmoothness = 55
      e.detail.sharpenAmount = 25
      e.detail.sharpenRadius = 1.2
      e.detail.sharpenDetail = 30
      e.detail.sharpenMasking = 40

      // Grain on top of noise reduction is the two of them fighting.
      e.effects.grainAmount = 0
    },
  ),
  make(
    'sharpen-detail',
    'Tools',
    'Detail Sharpen',
    'For landscape and architecture: small radius, high detail, masked off flat areas.',
    ['detail'],
    (e) => {
      e.detail.sharpenAmount = 55
      e.detail.sharpenRadius = 0.8
      e.detail.sharpenDetail = 45
      e.detail.sharpenMasking = 25
    },
  ),
  make(
    'sharpen-portrait',
    'Tools',
    'Portrait Sharpen',
    'Wider radius and a heavy mask, so skin stays smooth and eyes stay sharp.',
    ['detail'],
    (e) => {
      e.detail.sharpenAmount = 40
      e.detail.sharpenRadius = 1.3
      e.detail.sharpenDetail = 20
      e.detail.sharpenMasking = 70
    },
  ),
  make(
    'grain-35mm',
    'Tools',
    '35mm Grain',
    'Standard 35mm colour negative grain, at a realistic size.',
    ['effects'],
    (e) => {
      e.effects.grainAmount = 28
      e.effects.grainSize = 25
      e.effects.grainRoughness = 50
    },
  ),
  make(
    'grain-medium-format',
    'Tools',
    'Medium Format Grain',
    'The same emulsion on a much bigger negative: about half the apparent grain.',
    ['effects'],
    (e) => {
      e.effects.grainAmount = 16
      e.effects.grainSize = 22
      e.effects.grainRoughness = 45
    },
  ),
  make(
    'vignette-classic',
    'Tools',
    'Classic Vignette',
    'Wide and feathered. You should feel it, not see it.',
    ['effects'],
    (e) => {
      e.effects.vignetteAmount = -22
      e.effects.vignetteMidpoint = 55
      e.effects.vignetteFeather = 80
      e.effects.vignetteRoundness = 10
      e.effects.vignetteHighlights = 20
    },
  ),
]

export const BUILTIN_PRESETS: Array<Preset & { note: string }> = [
  ...FILM,
  ...CINEMATIC,
  ...MONOCHROME,
  ...GENRE,
  ...TOOLS,
]

/**
 * Applies a preset onto a full edit set, field by field.
 *
 * Field-level is not a refinement, it is the difference between a preset that
 * works on a RAW and one that doesn't. Replacing whole sections meant any look
 * touching Basic also reset White Balance to As Shot / 5500 / 0 and Exposure to
 * whatever the preset happened to leave there — invisible on a JPEG, where the
 * white balance is already baked into the pixels, and destructive on a RAW,
 * where it is the single most important thing you set. Same story in Detail:
 * a grain preset would quietly undo the capture sharpening and colour noise
 * reduction that only a RAW needs in the first place.
 *
 * Presets stored before `paths` existed fall back to the old behaviour, because
 * that is the only faithful reading of what they recorded.
 */
export function applyPreset(current: Edits, preset: Preset): Edits {
  const next = structuredClone(current)
  const patch = preset.edits as unknown as Record<string, unknown>

  if (preset.paths?.length) {
    for (const path of preset.paths) {
      const value = getPath(patch, path)
      if (value !== undefined) setPath(next, path, structuredClone(value))
    }
    return next
  }

  for (const section of preset.sections) {
    if (patch[section] !== undefined) {
      ;(next as unknown as Record<string, unknown>)[section] = structuredClone(patch[section])
    }
  }
  return next
}

// ---------------------------------------------------------------------------
// Preset scopes
//
// Sections are the right granularity for a panel and the wrong one for a
// preset. Lightroom's own Copy Settings dialog splits Basic into White Balance,
// Tone, Presence and Treatment for the same reason: they answer different
// questions. "What light was this shot in" is a property of the frame, "how
// contrasty do I want it" is a property of the look, and a preset should be
// able to carry the second without the first.
// ---------------------------------------------------------------------------

export interface PresetScope {
  id: string
  label: string
  /** The panel this scope lives under, for grouping in the UI. */
  section: EditSection
  /** The fields it covers; `null` means the whole section. */
  paths: string[] | null
}

const basicPaths = (...fields: string[]) => fields.map((f) => `basic.${f}`)
const detailPaths = (...fields: string[]) => fields.map((f) => `detail.${f}`)

export const PRESET_SCOPES: PresetScope[] = [
  { id: 'profile', label: 'RAW Profile', section: 'profile', paths: null },
  {
    id: 'whiteBalance',
    label: 'White Balance',
    section: 'basic',
    paths: basicPaths('wbMode', 'temp', 'tint'),
  },
  {
    id: 'exposure',
    label: 'Exposure',
    section: 'basic',
    paths: ['basic.exposure'],
  },
  {
    id: 'basicTone',
    label: 'Basic Tone',
    section: 'basic',
    paths: basicPaths('contrast', 'highlights', 'shadows', 'whites', 'blacks'),
  },
  {
    id: 'presence',
    label: 'Presence',
    section: 'basic',
    paths: basicPaths('texture', 'clarity', 'dehaze', 'vibrance', 'saturation'),
  },
  {
    id: 'treatment',
    label: 'Treatment',
    section: 'basic',
    paths: basicPaths('treatment', 'avoidColorShift', 'protectSkin'),
  },
  { id: 'tone', label: 'Tone', section: 'tone', paths: null },
  { id: 'curve', label: 'Tone Curve', section: 'curve', paths: null },
  { id: 'colorMixer', label: 'Color Mixer', section: 'colorMixer', paths: null },
  { id: 'colorGrading', label: 'Color Grading', section: 'colorGrading', paths: null },
  {
    id: 'sharpening',
    label: 'Sharpening',
    section: 'detail',
    paths: detailPaths('sharpenAmount', 'sharpenRadius', 'sharpenDetail', 'sharpenMasking'),
  },
  {
    id: 'noiseReduction',
    label: 'Noise Reduction',
    section: 'detail',
    paths: detailPaths(
      'luminanceNR',
      'luminanceNRDetail',
      'luminanceNRContrast',
      'colorNR',
      'colorNRDetail',
      'colorNRSmoothness',
      'impulseNR',
    ),
  },
  { id: 'effects', label: 'Effects', section: 'effects', paths: null },
  { id: 'calibration', label: 'Calibration', section: 'calibration', paths: null },
  { id: 'lens', label: 'Lens Corrections', section: 'lens', paths: null },
  { id: 'transform', label: 'Transform', section: 'transform', paths: null },
  { id: 'crop', label: 'Crop', section: 'crop', paths: null },
  { id: 'layers', label: 'Masking', section: 'layers', paths: null },
  { id: 'spots', label: 'Spot Removal', section: 'spots', paths: null },
  { id: 'redEye', label: 'Red Eye', section: 'redEye', paths: null },
]

/**
 * What a new preset stores unless you say otherwise: the look, never the
 * frame-specific corrections. White balance, exposure, crop, retouching, lens
 * profiles and noise reduction all describe *this* photo — a preset carrying
 * them would be applying one photo's circumstances to another. Exposure gets
 * its own tick because it is the one people expect to be there and the one that
 * most often makes a preset look broken on the next frame.
 */
export const DEFAULT_PRESET_SCOPES = [
  'profile',
  'basicTone',
  'presence',
  'treatment',
  'tone',
  'curve',
  'colorMixer',
  'colorGrading',
  'effects',
  'calibration',
]

/** Expands a set of scope ids into the leaf paths they cover. */
export function scopePaths(scopeIds: string[], kind: FileKind = 'raw'): string[] {
  const fresh = defaultEdits(kind) as unknown as Record<string, unknown>
  const out = new Set<string>()
  for (const id of scopeIds) {
    const scope = PRESET_SCOPES.find((s) => s.id === id)
    if (!scope) continue
    const paths = scope.paths ?? leafPaths(fresh[scope.section], scope.section)
    for (const p of paths) out.add(p)
  }
  return [...out]
}
