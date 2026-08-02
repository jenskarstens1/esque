import { defaultEdits, getPath, leafPaths, sectionOfPath, setPath } from '../core/defaults'
import type { FileKind } from '../core/defaults'
import type { CurvePoint, EditSection, Edits, Preset } from '../core/types'

/**
 * The esque preset library.
 *
 * Built from published, verifiable recipes rather than invented numbers. The
 * analogue looks follow the parameter sets documented in the open-source
 * `peva3/Lightroom-Presets` corpus (MIT) and its STYLEGUIDE, which derives them
 * from measured emulsion response; the genre and utility presets follow the
 * same house rules that corpus sets out.
 *
 * Names describe the *look*, never the emulsion that inspired it. Film stock
 * names are live trademarks that their owners licence commercially, so shipping
 * "Portra" or "Tri-X" as a product feature would be trademark use in commerce,
 * not fair comment. Adobe ships "Modern 04" and "Vintage 09" for exactly this
 * reason. The descriptive name also travels better — it tells you what the
 * preset does even if you've never shot film.
 *
 * Rules every look in here obeys — these are the ones amateur packs break:
 *
 *  - **Never touch exposure or white balance.** A preset cannot know how bright
 *    your frame is or what light it was shot in. (The one exception is the
 *    film group's small positive exposure bias, which is part of how a negative
 *    stock is rated — it is documented per preset.)
 *  - **Contrast comes from the tone curve, not Clarity.** Clarity is capped at
 *    ±10 for film looks; the crunchy "HDR" failure mode starts around +30.
 *  - **Never double-fade.** A lifted point curve (y > 0 at x = 0) and a positive
 *    Blacks both raise the black point; using both turns shadows to mud. Each
 *    preset does one or the other.
 *  - **A look never writes Detail.** Grain and sharpening do fight, and the old
 *    house rule was to drop sharpening to 10 on any preset carrying grain. But
 *    on a RAW, capture sharpening and colour noise reduction are calibrated to
 *    the sensor, the lens and the ISO — a look that overwrites them is undoing
 *    a per-file correction it knows nothing about. The `Sharpen — …` and
 *    `High ISO Rescue` presets exist to be stacked on top for exactly this.
 *  - **Vibrance and Saturation stay within ~5 of each other**, and HSL
 *    saturation stays inside ±60 outside the deliberately creative group.
 *  - Only the *fields* a look actually changes are declared, so presets layer
 *    over your own white balance, crop, lens corrections and noise reduction.
 *    That last point is the one that matters on a RAW: capture sharpening and
 *    colour NR are per-file corrections, and a look that quietly reset them
 *    would be undoing work the preset knows nothing about.
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
        // Arrays are assigned whole (curves, masks), so they stay opaque.
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
  const paths = [...written].flatMap((path) => leafPaths(getPath(edits, path), path))
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

  const patch: Partial<Edits> = {}
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

/**
 * The "Hollywood matte" curve that runs through the whole cinematic family:
 * black point lifted to 20/255, the shadow quarter-tone pulled down, a neutral
 * midpoint, a small upper-midtone lift and a rolled-off white.
 */
const MATTE = curve([0, 20], [64, 55], [128, 128], [192, 196], [255, 235])

/** A restrained S that adds structure without lifting the black point. */
const GENTLE_S = curve([0, 0], [85, 83], [128, 130], [192, 197], [255, 255])

// ---------------------------------------------------------------------------
// Colour negative film
// ---------------------------------------------------------------------------

const FILM = [
  make(
    'soft-portrait-400',
    'Colour Negative',
    'Soft Portrait 400',
    'The professional portrait negative: soft highlight roll-off, open shadows, luminous skin.',
    ['basic', 'colorMixer', 'colorGrading', 'effects'],
    (e) => {
      // A negative is rated a little hot and printed down; +1/2 stop is part
      // of the stock's character rather than a guess about your exposure.
      e.basic.exposure = 0.5
      e.basic.contrast = -8
      e.basic.highlights = -55
      e.basic.shadows = 32
      e.basic.whites = -2
      e.basic.blacks = 12

      e.colorMixer.hue.orange = -3
      e.colorMixer.saturation.orange = -5
      e.colorMixer.luminance.orange = 15 // lifting orange is the whole skin move
      e.colorMixer.hue.yellow = -8
      e.colorMixer.hue.green = 15
      e.colorMixer.saturation.green = -23
      e.colorMixer.saturation.aqua = -10
      e.colorMixer.hue.blue = -5
      e.colorMixer.saturation.blue = -15
      e.colorMixer.luminance.blue = -10

      e.colorGrading.shadows = { hue: 210, saturation: 8, luminance: 0 }
      e.colorGrading.highlights = { hue: 45, saturation: 12, luminance: 0 }

      e.effects.grainAmount = 28
      e.effects.grainSize = 25
      e.effects.grainRoughness = 50
    },
  ),
  make(
    'soft-portrait-400-push',
    'Colour Negative',
    'Soft Portrait 400 +1',
    'The same emulsion push-processed a stop: more contrast, deeper shadows, coarser grain.',
    ['basic', 'colorMixer', 'colorGrading', 'effects'],
    (e) => {
      e.basic.exposure = 0.35
      e.basic.contrast = 14
      e.basic.highlights = -58
      e.basic.shadows = 43
      e.basic.whites = 4
      e.basic.blacks = -18

      e.colorMixer.hue.orange = -3
      e.colorMixer.saturation.orange = -6
      e.colorMixer.luminance.orange = 14
      e.colorMixer.hue.green = 12
      e.colorMixer.saturation.green = -25
      e.colorMixer.saturation.blue = -15
      e.colorMixer.luminance.blue = -12

      e.colorGrading.shadows = { hue: 240, saturation: 10, luminance: 0 }
      e.colorGrading.highlights = { hue: 50, saturation: 7, luminance: 0 }
      e.colorGrading.balance = 50

      e.effects.grainAmount = 38
      e.effects.grainSize = 40
      e.effects.grainRoughness = 53
    },
  ),
  make(
    'airy-pastel-400',
    'Colour Negative',
    'Airy Pastel 400',
    'The wedding look: flat, bright, mint-green shadows and very pale skin.',
    ['basic', 'colorMixer', 'colorGrading', 'effects'],
    (e) => {
      // Half a stop, like the other 400 stocks: the "airy" comes from the flat
      // curve and the lifted blacks below, not from over-exposing your frame.
      e.basic.exposure = 0.5
      e.basic.contrast = -25
      e.basic.highlights = -50
      e.basic.shadows = 40
      e.basic.blacks = 15
      e.basic.vibrance = -10
      e.basic.saturation = -15

      e.colorMixer.hue.red = -3
      e.colorMixer.saturation.red = -10
      e.colorMixer.saturation.orange = -10
      e.colorMixer.luminance.orange = 10
      e.colorMixer.saturation.yellow = -10
      e.colorMixer.hue.green = -5
      e.colorMixer.saturation.green = -25
      e.colorMixer.saturation.aqua = -12
      e.colorMixer.hue.blue = -5
      e.colorMixer.saturation.blue = -15
      e.colorMixer.luminance.blue = -8
      e.colorMixer.saturation.magenta = -8

      // A green-teal shadow instead of the usual blue — that inversion is
      // what separates this family from the warmer portrait negatives.
      e.colorGrading.shadows = { hue: 160, saturation: 10, luminance: 0 }
      e.colorGrading.highlights = { hue: 40, saturation: 4, luminance: 0 }

      e.effects.grainAmount = 18
      e.effects.grainSize = 18
      e.effects.grainRoughness = 38
    },
  ),
  make(
    'golden-snapshot-200',
    'Colour Negative',
    'Golden Snapshot 200',
    'Drugstore colour: golden highlights, punchy yellows, blue-leaning shade.',
    ['basic', 'colorMixer', 'colorGrading', 'effects'],
    (e) => {
      e.basic.exposure = 0.15
      e.basic.contrast = -13
      e.basic.highlights = -50
      e.basic.shadows = 28
      e.basic.whites = -20
      e.basic.blacks = 20

      e.colorMixer.hue.red = 8
      e.colorMixer.saturation.red = 10
      e.colorMixer.hue.orange = -3
      e.colorMixer.saturation.orange = 15
      e.colorMixer.luminance.orange = 15
      e.colorMixer.hue.yellow = -13
      e.colorMixer.saturation.yellow = 20
      e.colorMixer.luminance.yellow = 10
      e.colorMixer.hue.green = 23
      e.colorMixer.saturation.green = -15
      e.colorMixer.luminance.green = -8
      e.colorMixer.hue.aqua = -13
      e.colorMixer.saturation.aqua = -5
      e.colorMixer.hue.blue = -10
      e.colorMixer.saturation.blue = -15
      e.colorMixer.luminance.blue = -10
      e.colorMixer.hue.purple = -15
      e.colorMixer.saturation.purple = -23
      e.colorMixer.hue.magenta = -15
      e.colorMixer.saturation.magenta = -23

      // A stronger blue-shadow push than the portrait stocks, biased into the
      // shadows so the highlights stay unambiguously gold.
      e.colorGrading.shadows = { hue: 208, saturation: 18, luminance: 0 }
      e.colorGrading.highlights = { hue: 50, saturation: 15, luminance: 0 }
      e.colorGrading.balance = -30

      e.effects.grainAmount = 35
      e.effects.grainSize = 28
      e.effects.grainRoughness = 50
    },
  ),
  make(
    'fine-grain-100',
    'Colour Negative',
    'Fine Grain 100',
    'The finest-grained colour negative there is. Saturated, clean, almost slide-like.',
    ['basic', 'colorMixer', 'colorGrading', 'effects'],
    (e) => {
      e.basic.contrast = 12
      e.basic.highlights = -35
      e.basic.shadows = 18
      e.basic.whites = 5
      e.basic.blacks = -6
      e.basic.vibrance = 12
      e.basic.saturation = 8

      e.colorMixer.saturation.orange = -6
      e.colorMixer.luminance.orange = 8
      e.colorMixer.hue.green = 10
      e.colorMixer.saturation.green = -10
      e.colorMixer.saturation.aqua = 8
      e.colorMixer.luminance.blue = -12

      e.colorGrading.shadows = { hue: 210, saturation: 9, luminance: 0 }
      e.colorGrading.highlights = { hue: 45, saturation: 5, luminance: 0 }

      e.effects.grainAmount = 5
      e.effects.grainSize = 10
      e.effects.grainRoughness = 50
    },
  ),
]

// ---------------------------------------------------------------------------
// Cinematic
// ---------------------------------------------------------------------------

const CINEMATIC = [
  make(
    'teal-orange',
    'Cinematic',
    'Teal & Orange',
    'The colour-grading-suite standard: skin stays warm, everything else cools.',
    ['basic', 'curve', 'colorMixer', 'colorGrading', 'effects'],
    (e) => {
      e.basic.contrast = 24
      e.basic.highlights = -40
      e.basic.shadows = 30
      e.basic.whites = 15

      e.curve.mode = 'point'
      e.curve.rgb = MATTE

      // Pushing green hard toward teal is what separates skin from foliage.
      e.colorMixer.hue.green = -60
      e.colorMixer.saturation.green = -40
      e.colorMixer.saturation.blue = -20
      e.colorMixer.luminance.orange = 10

      e.colorGrading.shadows = { hue: 209, saturation: 20, luminance: 0 }
      e.colorGrading.midtones = { hue: 35, saturation: 8, luminance: 0 }
      e.colorGrading.highlights = { hue: 36, saturation: 15, luminance: 0 }
      e.colorGrading.blending = 75
      e.colorGrading.balance = -30

      e.effects.grainAmount = 15
      e.effects.grainSize = 25
      e.effects.grainRoughness = 50
      e.effects.vignetteAmount = -10
    },
  ),
  make(
    'tungsten-night-800',
    'Cinematic',
    'Tungsten Night 800',
    'Motion-picture stock shot after dark: cool blue night, haloed highlights, soft bloom.',
    ['basic', 'curve', 'colorGrading', 'effects'],
    (e) => {
      e.basic.exposure = 0.75
      e.basic.contrast = 15
      e.basic.highlights = -70
      e.basic.shadows = 50
      e.basic.whites = -30
      e.basic.clarity = -8 // the bloom
      e.basic.dehaze = -8 // the atmosphere

      e.curve.mode = 'point'
      e.curve.rgb = MATTE

      e.colorGrading.shadows = { hue: 210, saturation: 25, luminance: 0 }
      e.colorGrading.highlights = { hue: 50, saturation: 13, luminance: 0 }
      e.colorGrading.blending = 75

      e.effects.grainAmount = 40
      e.effects.grainSize = 23
      e.effects.grainRoughness = 50
      e.effects.vignetteAmount = -8
    },
  ),
  make(
    'moody-pastoral',
    'Cinematic',
    'Moody Pastoral',
    'Overcast and earthy. Greens go olive, shadows go cool, skin still glows.',
    ['basic', 'curve', 'colorMixer', 'colorGrading', 'effects'],
    (e) => {
      e.basic.contrast = 35
      e.basic.highlights = -65
      e.basic.shadows = 60
      e.basic.whites = 15
      e.basic.blacks = -15

      e.curve.mode = 'point'
      e.curve.rgb = MATTE

      e.colorMixer.hue.green = 45
      e.colorMixer.saturation.green = -55
      e.colorMixer.saturation.yellow = -30
      e.colorMixer.luminance.orange = 55

      e.colorGrading.shadows = { hue: 255, saturation: 10, luminance: 0 }
      e.colorGrading.highlights = { hue: 155, saturation: 8, luminance: 0 }
      e.colorGrading.blending = 75

      e.effects.grainAmount = 30
      e.effects.grainSize = 32
      e.effects.grainRoughness = 55
      e.effects.vignetteAmount = -25
      e.effects.vignetteMidpoint = 40
      e.effects.vignetteFeather = 75
    },
  ),
  make(
    'cross-processed',
    'Cinematic',
    'Cross Process',
    'Slide film run through negative chemistry: cyan shadows, magenta highlights, wild hues.',
    ['basic', 'curve', 'colorMixer', 'colorGrading', 'effects'],
    (e) => {
      e.basic.contrast = 50
      e.basic.highlights = -60
      e.basic.shadows = 30
      e.basic.whites = 20
      e.basic.clarity = 18
      e.basic.dehaze = 15
      e.basic.saturation = 10

      e.curve.mode = 'point'
      e.curve.rgb = MATTE

      e.colorMixer.hue.red = 15
      e.colorMixer.saturation.red = -30
      e.colorMixer.luminance.red = -15
      e.colorMixer.saturation.orange = -15
      e.colorMixer.hue.yellow = -30
      e.colorMixer.saturation.yellow = -40
      e.colorMixer.hue.green = 30
      e.colorMixer.saturation.green = 30
      e.colorMixer.luminance.green = -15
      e.colorMixer.hue.aqua = 15
      e.colorMixer.saturation.aqua = 22
      e.colorMixer.hue.blue = -15
      e.colorMixer.saturation.blue = -15
      e.colorMixer.hue.purple = 30
      e.colorMixer.hue.magenta = 40
      e.colorMixer.saturation.magenta = -10

      e.colorGrading.shadows = { hue: 160, saturation: 22, luminance: 0 }
      e.colorGrading.highlights = { hue: 305, saturation: 18, luminance: 0 }
      e.colorGrading.blending = 75
      e.colorGrading.balance = -40

      e.effects.grainAmount = 25
      e.effects.grainSize = 25
      e.effects.grainRoughness = 50
    },
  ),
]

// ---------------------------------------------------------------------------
// Black & white — saturation to -100, then the mixer's luminance row is the
// grayscale channel mixer, exactly as Lightroom's Gray Mixer works.
// ---------------------------------------------------------------------------

const mono = (e: Edits) => {
  e.basic.saturation = -100
  e.basic.vibrance = 0
}

const MONOCHROME = [
  make(
    'reportage-400',
    'Black & White',
    'Reportage 400',
    'Press black and white: hard blacks, dark skies, unmistakable grain.',
    ['basic', 'colorMixer', 'effects'],
    (e) => {
      mono(e)
      e.basic.contrast = 35
      e.basic.highlights = -14
      e.basic.shadows = 25
      e.basic.whites = 15
      e.basic.blacks = -30

      e.colorMixer.luminance.red = 30
      e.colorMixer.luminance.orange = 20
      e.colorMixer.luminance.yellow = -5
      e.colorMixer.luminance.green = -25
      e.colorMixer.luminance.blue = -40 // the dramatic sky, and the whole point
      e.colorMixer.luminance.magenta = -5

      e.effects.grainAmount = 55
      e.effects.grainSize = 35
      e.effects.grainRoughness = 65
    },
  ),
  make(
    'fibre-print-400',
    'Black & White',
    'Fibre Print 400',
    'A workhorse 400 stock printed on warm fibre paper. Cool shadows, warm whites.',
    ['basic', 'colorMixer', 'colorGrading', 'effects'],
    (e) => {
      mono(e)
      e.basic.contrast = 8
      e.basic.highlights = -24
      e.basic.shadows = 16
      e.basic.whites = 5
      e.basic.blacks = -11

      e.colorMixer.luminance.red = 15
      e.colorMixer.luminance.orange = 10
      e.colorMixer.luminance.yellow = 5
      e.colorMixer.luminance.green = -5
      e.colorMixer.luminance.aqua = -10
      e.colorMixer.luminance.blue = -19

      e.colorGrading.shadows = { hue: 230, saturation: 8, luminance: 0 }
      e.colorGrading.highlights = { hue: 50, saturation: 5, luminance: 0 }
      e.colorGrading.balance = -20

      e.effects.grainAmount = 36
      e.effects.grainSize = 28
      e.effects.grainRoughness = 50
    },
  ),
  make(
    'long-scale-100',
    'Black & White',
    'Long Scale 100',
    'A slow, tabular-grain stock. Nearly grainless, gentle sky, everything separated.',
    ['basic', 'colorMixer', 'effects'],
    (e) => {
      mono(e)
      e.basic.contrast = 15
      e.basic.highlights = -30
      e.basic.shadows = 20
      e.basic.whites = 5
      e.basic.blacks = -15

      e.colorMixer.luminance.red = 10
      e.colorMixer.luminance.orange = 10
      e.colorMixer.luminance.yellow = 5
      e.colorMixer.luminance.aqua = -5
      e.colorMixer.luminance.blue = -15

      e.effects.grainAmount = 15
      e.effects.grainSize = 20
      e.effects.grainRoughness = 48
    },
  ),
]

// ---------------------------------------------------------------------------
// Genre — subject-led starting points rather than film looks
// ---------------------------------------------------------------------------

const GENRE = [
  make(
    'editorial-clean',
    'Genre',
    'Editorial Clean',
    'Neutral, crisp and quiet. No toning, no grain, nothing to date it.',
    ['basic', 'curve', 'colorMixer', 'colorGrading', 'effects'],
    (e) => {
      e.basic.contrast = 12
      e.basic.highlights = -25
      e.basic.shadows = 10
      e.basic.blacks = -5

      e.curve.mode = 'point'
      e.curve.rgb = GENTLE_S

      e.colorMixer.hue.green = 8
      e.colorMixer.saturation.green = -8
      e.colorMixer.saturation.aqua = -5

      e.colorGrading.shadows = { hue: 215, saturation: 3, luminance: 0 }
      e.colorGrading.highlights = { hue: 40, saturation: 3, luminance: 0 }

      e.effects.vignetteAmount = -5
      e.effects.vignetteFeather = 80
    },
  ),
  make(
    'portrait-skin',
    'Genre',
    'Portrait',
    'Skin-safe: orange lifted and calmed, contrast held back, everything soft.',
    ['basic', 'curve', 'colorMixer', 'colorGrading', 'effects'],
    (e) => {
      e.basic.contrast = -5
      e.basic.highlights = -30
      e.basic.shadows = 22
      e.basic.whites = 5
      e.basic.blacks = 8

      e.curve.mode = 'point'
      e.curve.rgb = curve([0, 0], [85, 84], [128, 130], [195, 198], [255, 255])

      e.colorMixer.saturation.red = -8
      e.colorMixer.saturation.orange = -10
      e.colorMixer.luminance.orange = 12
      e.colorMixer.saturation.yellow = -5

      e.colorGrading.shadows = { hue: 210, saturation: 6, luminance: 0 }
      e.colorGrading.highlights = { hue: 45, saturation: 6, luminance: 0 }

      e.effects.grainAmount = 20
      e.effects.grainSize = 22
      e.effects.grainRoughness = 40
      e.effects.vignetteAmount = -8
      e.effects.vignetteMidpoint = 60
      e.effects.vignetteFeather = 85
    },
  ),
  make(
    'landscape',
    'Genre',
    'Landscape',
    'Foliage naturalised, sky deepened, haze cut. Structure without crunch.',
    ['basic', 'curve', 'colorMixer', 'colorGrading', 'effects'],
    (e) => {
      e.basic.contrast = 28
      e.basic.highlights = -55
      e.basic.shadows = 28
      e.basic.whites = 10
      e.basic.blacks = -10
      e.basic.texture = 12
      e.basic.dehaze = 15

      e.curve.mode = 'point'
      e.curve.rgb = curve([0, 0], [75, 68], [128, 130], [195, 205], [255, 255])

      e.colorMixer.hue.yellow = -10
      e.colorMixer.saturation.yellow = -8
      e.colorMixer.luminance.yellow = -5
      e.colorMixer.hue.green = 25
      e.colorMixer.saturation.green = -15
      e.colorMixer.luminance.green = -10
      e.colorMixer.hue.aqua = 5
      e.colorMixer.saturation.aqua = 5
      e.colorMixer.luminance.aqua = -10
      e.colorMixer.saturation.blue = -8
      e.colorMixer.luminance.blue = -20

      e.colorGrading.shadows = { hue: 220, saturation: 10, luminance: 0 }
      e.colorGrading.highlights = { hue: 150, saturation: 8, luminance: 0 }
      e.colorGrading.blending = 70

      e.effects.grainAmount = 15
      e.effects.grainSize = 20
      e.effects.grainRoughness = 40
      e.effects.vignetteAmount = -12
      e.effects.vignetteFeather = 80
    },
  ),
  make(
    'golden-hour',
    'Genre',
    'Golden Hour',
    'Warms the light without turning the whole frame orange.',
    ['basic', 'curve', 'colorMixer', 'colorGrading', 'effects'],
    (e) => {
      e.basic.contrast = 12
      e.basic.highlights = -25
      e.basic.shadows = 18
      e.basic.whites = 8

      e.curve.mode = 'point'
      e.curve.rgb = curve([0, 5], [85, 85], [128, 130], [195, 200], [255, 252])

      e.colorMixer.saturation.orange = 18
      e.colorMixer.luminance.orange = 15
      e.colorMixer.hue.yellow = -12
      e.colorMixer.saturation.yellow = 12
      e.colorMixer.luminance.yellow = 8

      e.colorGrading.shadows = { hue: 38, saturation: 8, luminance: 0 }
      e.colorGrading.midtones = { hue: 42, saturation: 5, luminance: 0 }
      e.colorGrading.highlights = { hue: 48, saturation: 15, luminance: 0 }
      e.colorGrading.blending = 70
      e.colorGrading.balance = 20

      e.effects.grainAmount = 22
      e.effects.grainSize = 25
      e.effects.grainRoughness = 45
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
    'Sharpen — Detail',
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
    'Sharpen — Portrait',
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
    'Grain — 35mm',
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
    'Grain — Medium Format',
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
    'Vignette — Classic',
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
  { id: 'profile', label: 'Profile', section: 'profile', paths: ['profile'] },
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
  { id: 'masks', label: 'Masking', section: 'masks', paths: null },
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
