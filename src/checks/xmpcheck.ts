import { withLayerDefaults } from '../develop/layers'
import { defaultEdits, ALL_SECTIONS, cloneEdits, defaultMaskAdjustments } from '../core/defaults'
import { parseXmp, editsToSidecar, presetToXmp } from '../develop/xmp'
import { applySidecarText, sidecarNames } from '../catalog/sidecar'
import type { Edits, EditSection, Preset } from '../core/types'

/*
 * XMP round-trip check. Writes a fully-adjusted Edits tree to a sidecar and to
 * a preset, reads both back, and compares field by field. Anything the writer
 * emits but the reader drops — or vice versa — shows up as a named difference
 * rather than as a setting that silently resets on the next import.
 *
 * The last section covers the layer above that: turning a sidecar found on disk
 * into changes to a catalog record. That layer is the one that can lose a
 * photographer's work, because it runs unattended at import and it overwrites —
 * so what it must *not* touch is checked as carefully as what it must.
 */

declare global {
  interface Window {
    __result?: unknown
    __done?: boolean
  }
}

const failures: string[] = []
const fail = (m: string) => failures.push(m)

/** Moves every leaf off its default so a dropped field cannot pass by luck. */
function perturb(e: Edits): Edits {
  const next = cloneEdits(e)
  next.profile = 'landscape'
  next.basic.temp = 4850
  next.basic.tint = -12
  next.basic.exposure = 0.65
  next.basic.contrast = 18
  next.basic.highlights = -40
  next.basic.shadows = 35
  next.basic.whites = 12
  next.basic.blacks = -8
  next.basic.texture = 22
  next.basic.clarity = 14
  next.basic.dehaze = 9
  next.basic.vibrance = 27
  next.basic.saturation = -6
  next.basic.treatment = 'bw'
  next.basic.protectSkin = false
  next.basic.avoidColorShift = true

  next.tone.recovery = 'propagate'
  next.tone.recoveryThreshold = 62
  next.tone.shHighlights = 44
  next.tone.shShadows = 31
  next.tone.shRadius = 55
  next.tone.shTonalWidth = 68
  next.tone.drcAmount = 37
  next.tone.drcDetail = 21
  next.tone.detailFinest = 11
  next.tone.detailFine = -14
  next.tone.detailCoarse = 26
  next.tone.detailCoarsest = -9
  next.tone.detailThreshold = 41

  next.curve.rgbMode = 'filmLike'
  next.curve.parametric.shadows = 15
  next.curve.parametric.darks = -10
  next.curve.parametric.lights = 20
  next.curve.parametric.highlights = -25
  next.curve.rgb = [
    { x: 0, y: 0.04 },
    { x: 0.5, y: 0.58 },
    { x: 1, y: 1 },
  ]

  let i = 1
  for (const band of Object.keys(next.colorMixer.hue) as Array<
    keyof typeof next.colorMixer.hue
  >) {
    next.colorMixer.hue[band] = i * 3
    next.colorMixer.saturation[band] = -i * 4
    next.colorMixer.luminance[band] = i * 5
    next.colorMixer.bw[band] = i * 6 - 20
    i++
  }

  next.colorGrading.shadows = { hue: 210, saturation: 30, luminance: -10 }
  next.colorGrading.midtones = { hue: 60, saturation: 15, luminance: 5 }
  next.colorGrading.highlights = { hue: 40, saturation: 25, luminance: 8 }
  next.colorGrading.global = { hue: 300, saturation: 10, luminance: -4 }
  next.colorGrading.blending = 70
  next.colorGrading.balance = -20

  next.detail.sharpenAmount = 55
  next.detail.sharpenRadius = 1.4
  next.detail.sharpenDetail = 35
  next.detail.sharpenMasking = 20
  next.detail.luminanceNR = 18
  next.detail.luminanceNRDetail = 60
  next.detail.luminanceNRContrast = 12
  next.detail.colorNR = 30
  next.detail.colorNRDetail = 55
  next.detail.colorNRSmoothness = 45
  next.detail.impulseNR = 38

  next.effects.vignetteAmount = -25
  next.effects.vignetteMidpoint = 40
  next.effects.vignetteRoundness = 10
  next.effects.vignetteFeather = 60
  next.effects.vignetteHighlights = 15
  next.effects.grainAmount = 20
  next.effects.grainSize = 30
  next.effects.grainRoughness = 55

  next.calibration.shadowTint = 6
  next.calibration.redHue = -8
  next.calibration.redSaturation = 12
  next.calibration.greenHue = 4
  next.calibration.greenSaturation = -6
  next.calibration.blueHue = 10
  next.calibration.blueSaturation = 14

  next.lens.enableProfile = true
  next.lens.distortion = 15
  next.lens.vignetting = 22
  next.lens.caRed = 9
  next.lens.caBlue = -7
  next.lens.defringePurpleAmount = 8
  next.lens.defringePurpleHueLo = 32
  next.lens.defringePurpleHueHi = 68
  next.lens.defringeGreenAmount = 6
  next.lens.defringeGreenHueLo = 38
  next.lens.defringeGreenHueHi = 62

  next.transform.vertical = 12
  next.transform.horizontal = -8
  next.transform.rotate = 2.5
  next.transform.aspect = 6
  next.transform.scale = 105
  next.transform.offsetX = 1.5
  next.transform.offsetY = -2.5

  next.crop.left = 0.125
  next.crop.top = 0.0625
  next.crop.right = 0.875
  next.crop.bottom = 0.9375
  next.crop.angle = -3.25
  next.crop.aspect = '16x9'
  next.crop.aspectLocked = true
  next.crop.quarterTurns = 3
  next.crop.flipH = true
  next.crop.flipV = true

  // One mask per geometry kind, so a shape the writer forgets shows up as a
  // named difference instead of quietly vanishing on the next import.
  next.layers = [
    withLayerDefaults({
      id: 'mask-a',
      name: 'Sky',
      visible: true,
      inverted: true,
      opacity: 0.8,
      components: [
        {
          id: 'c-lin',
          blend: 'add',
          invert: false,
          geometry: {
            kind: 'linear',
            start: { x: 0.1, y: 0.2 },
            end: { x: 0.9, y: 0.6 },
          },
        },
        {
          id: 'c-rad',
          blend: 'subtract',
          invert: true,
          geometry: {
            kind: 'radial',
            center: { x: 0.4, y: 0.45 },
            radiusX: 0.3,
            radiusY: 0.18,
            rotation: 22,
            feather: 65,
          },
        },
        {
          id: 'c-lum',
          blend: 'intersect',
          invert: false,
          geometry: { kind: 'luminanceRange', range: [0.05, 0.2, 0.7, 0.95], smoothness: 40 },
        },
      ],
      adjustments: {
        ...maskAdjustments(),
        exposure: -0.75,
        contrast: 22,
        highlights: -30,
        shadows: 18,
        whites: 9,
        blacks: -12,
        texture: 14,
        clarity: -20,
        dehaze: 25,
        temp: -15,
        tint: 8,
        saturation: 30,
        hue: 210,
        hueStrength: 45,
        colorize: 35,
        sharpness: 40,
        noise: 12,
        moire: 6,
        defringe: 18,
        curve: [
          { x: 0, y: 0.02 },
          { x: 0.5, y: 0.55 },
          { x: 1, y: 0.98 },
        ],
      },
    }),
    withLayerDefaults({
      id: 'mask-b',
      name: 'Brushwork',
      visible: false,
      inverted: false,
      opacity: 0.35,
      components: [
        {
          id: 'c-brush',
          blend: 'add',
          invert: false,
          geometry: {
            kind: 'brush',
            dabs: [
              { x: 0.2, y: 0.3, radius: 0.05, flow: 0.8, erase: false },
              { x: 0.25, y: 0.32, radius: 0.05, flow: 0.8, erase: true },
            ],
            feather: 70,
            autoMask: true,
          },
        },
        {
          id: 'c-color',
          blend: 'subtract',
          invert: false,
          geometry: {
            kind: 'colorRange',
            samples: [
              { r: 0.2, g: 0.5, b: 0.8 },
              { r: 0.7, g: 0.1, b: 0.15 },
            ],
            refine: 30,
          },
        },
        {
          id: 'c-ai',
          blend: 'add',
          invert: false,
          geometry: { kind: 'aiSubject', cacheKey: null, refine: 60 },
        },
      ],
      adjustments: maskAdjustments(),
    }),
  ]

  next.spots = [
    {
      id: 'sp-1',
      mode: 'heal',
      target: { x: 0.3, y: 0.4 },
      source: { x: 0.6, y: 0.55 },
      radius: 0.06,
      feather: 65,
      opacity: 0.9,
    },
    {
      id: 'sp-2',
      mode: 'clone',
      target: { x: 0.7, y: 0.2 },
      source: { x: 0.2, y: 0.8 },
      radius: 0.03,
      feather: 20,
      opacity: 0.5,
    },
  ]
  next.redEye = [
    { id: 're-1', kind: 'human', center: { x: 0.42, y: 0.33 }, radius: 0.02, darken: 70 },
    { id: 're-2', kind: 'pet', center: { x: 0.58, y: 0.34 }, radius: 0.025, darken: 35 },
  ]

  return next
}

const maskAdjustments = defaultMaskAdjustments

/** Sections whose fields the XMP layer is expected to carry both ways. */
const ROUND_TRIPPED: EditSection[] = [
  'profile',
  'basic',
  'tone',
  'curve',
  'colorMixer',
  'colorGrading',
  'detail',
  'effects',
  'calibration',
  'lens',
  'transform',
  'crop',
  'layers',
  'spots',
  'redEye',
]

/** Fields the writer deliberately rounds or has no Adobe equivalent for. */
const TOLERANCE: Record<string, number> = {
  'basic.temp': 1,
  'curve.rgb': 0.004,
  'curve.red': 0.004,
  'curve.green': 0.004,
  'curve.blue': 0.004,
  'transform.rotate': 0.05,
  'transform.offsetX': 0.05,
  'transform.offsetY': 0.05,
  'detail.sharpenRadius': 0.05,
}

function compare(label: string, want: unknown, got: unknown, path: string) {
  if (Array.isArray(want)) {
    if (!Array.isArray(got) || got.length !== want.length)
      return fail(`${label} ${path}: array shape changed`)
    want.forEach((v, i) => compare(label, v, got[i], path))
    return
  }
  if (want && typeof want === 'object') {
    for (const k of Object.keys(want as object)) {
      compare(
        label,
        (want as Record<string, unknown>)[k],
        (got as Record<string, unknown> | undefined)?.[k],
        path ? `${path}.${k}` : k,
      )
    }
    return
  }
  if (typeof want === 'number' && typeof got === 'number') {
    const tol = TOLERANCE[path] ?? TOLERANCE[path.replace(/\.\w+$/, '')] ?? 0.51
    if (Math.abs(want - got) > tol) fail(`${label} ${path}: wrote ${want}, read ${got}`)
    return
  }
  if (want !== got) fail(`${label} ${path}: wrote ${JSON.stringify(want)}, read ${JSON.stringify(got)}`)
}

const source = perturb(defaultEdits())

// --- Sidecar --------------------------------------------------------------
const sidecar = editsToSidecar(source, ALL_SECTIONS, { filename: 'IMG_0001.ARW', rating: 4 })
const readSidecar = parseXmp(sidecar)
if (!readSidecar) {
  fail('sidecar: did not parse')
} else {
  for (const section of ROUND_TRIPPED) {
    if (!readSidecar.sections.includes(section))
      fail(`sidecar: section “${section}” not reported as present`)
    compare('sidecar', source[section], readSidecar.edits[section], section)
  }
}

// --- Preset ---------------------------------------------------------------
const preset: Preset = {
  id: 'test-preset',
  name: 'Round Trip',
  group: 'Checks',
  builtin: false,
  sections: ROUND_TRIPPED,
  edits: {},
  createdAt: 0,
}
const presetXml = presetToXmp(preset, source)
const readPreset = parseXmp(presetXml)
if (!readPreset) {
  fail('preset: did not parse')
} else {
  if (readPreset.name !== preset.name) fail(`preset: name came back “${readPreset.name}”`)
  if (readPreset.group !== preset.group) fail(`preset: group came back “${readPreset.group}”`)
  if (!readPreset.isPreset) fail('preset: not recognised as a preset')
  for (const section of ROUND_TRIPPED)
    compare('preset', source[section], readPreset.edits[section], section)
}

// --- Defaults must survive untouched --------------------------------------
const plain = defaultEdits()
const plainXml = editsToSidecar(plain, ALL_SECTIONS, { filename: 'IMG_0002.ARW' })
const readPlain = parseXmp(plainXml)
if (!readPlain) fail('defaults: did not parse')
else for (const section of ROUND_TRIPPED) compare('defaults', plain[section], readPlain.edits[section], section)

// --- A foreign sidecar must not invent sections ---------------------------
const foreign = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:Exposure2012="+0.50"/>
 </rdf:RDF>
</x:xmpmeta>`
const readForeign = parseXmp(foreign)
if (!readForeign) fail('foreign: did not parse')
else {
  if (readForeign.sections.length !== 1 || readForeign.sections[0] !== 'basic')
    fail(`foreign: reported sections ${JSON.stringify(readForeign.sections)}`)
  if (Math.abs(readForeign.edits.basic.exposure - 0.5) > 1e-6)
    fail(`foreign: exposure came back ${readForeign.edits.basic.exposure}`)
  if (readForeign.edits.tone.drcAmount !== defaultEdits().tone.drcAmount)
    fail('foreign: tone drifted off its default')
}

// --- Applying a sidecar to a photo ----------------------------------------

// Adobe's spelling first, because that is the one that gets written.
{
  const names = sidecarNames('trip/IMG_0001.ARW')
  if (names[0] !== 'trip/IMG_0001.xmp') fail(`sidecar name: got “${names[0]}”`)
  if (!names.includes('trip/IMG_0001.ARW.xmp')) fail('sidecar name: appended spelling not tried')
  // A dot in a directory name is not an extension.
  if (sidecarNames('2024.raw/IMG')[0] !== '2024.raw/IMG.xmp')
    fail(`sidecar name: a dotted folder confused it — ${sidecarNames('2024.raw/IMG')[0]}`)
}

// The full article: settings and metadata together, as Lightroom writes it.
{
  const full = editsToSidecar(source, ALL_SECTIONS, {
    filename: 'IMG_0001.ARW',
    rating: 4,
    label: 'blue',
    title: 'Harbour',
    caption: 'Low tide, late light',
    keywords: ['coast', 'boats'],
  })
  const applied = applySidecarText(full)
  if (!applied) fail('apply: a full sidecar produced no changes')
  else {
    const c = applied.changes
    if (c.rating !== 4) fail(`apply: rating came back ${c.rating}`)
    if (c.label !== 'blue') fail(`apply: label came back ${c.label}`)
    if (c.title !== 'Harbour') fail(`apply: title came back “${c.title}”`)
    if (c.caption !== 'Low tide, late light') fail(`apply: caption came back “${c.caption}”`)
    if (JSON.stringify(c.keywords) !== JSON.stringify(['coast', 'boats']))
      fail(`apply: keywords came back ${JSON.stringify(c.keywords)}`)
    if (!c.edits) fail('apply: no develop settings')
    else if (Math.abs(c.edits.basic.exposure - source.basic.exposure) > 0.01)
      fail(`apply: exposure came back ${c.edits.basic.exposure}`)
    if (!applied.applied.edits || !applied.applied.metadata)
      fail(`apply: reported ${JSON.stringify(applied.applied)}`)
  }
}

// A sidecar that says nothing about a field must not clear it. This is the one
// that costs a caption: a rating-only sidecar written by a tagging tool would
// otherwise blank every text field on the photograph it was meant to describe.
{
  const ratingOnly = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="3"/>
 </rdf:RDF>
</x:xmpmeta>`
  const applied = applySidecarText(ratingOnly)
  if (!applied) fail('apply: a rating-only sidecar produced no changes')
  else {
    const keys = Object.keys(applied.changes)
    if (keys.length !== 1 || keys[0] !== 'rating')
      fail(`apply: a rating-only sidecar also changed ${JSON.stringify(keys)}`)
    if (applied.applied.edits) fail('apply: a rating-only sidecar claimed develop settings')
  }
}

// A preset is not a photograph's settings, however close it is sitting.
{
  const asPreset = presetToXmp(
    { id: 'p', name: 'Not Yours', group: 'G', builtin: false, sections: ROUND_TRIPPED, edits: {}, createdAt: 0 },
    source,
  )
  const applied = applySidecarText(asPreset)
  if (applied?.changes.edits) fail('apply: a preset was applied as if it were a sidecar')
}

// Nothing to say means no write at all, so an empty file cannot reset a record.
{
  if (applySidecarText('<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>') !== null)
    fail('apply: an empty sidecar produced changes')
  if (applySidecarText('not xml at all') !== null) fail('apply: junk produced changes')
}

// Ratings and labels arrive from other people's software and cannot be trusted.
{
  const odd = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"
   xmp:Rating="9" xmp:Label="Chartreuse"/>
 </rdf:RDF>
</x:xmpmeta>`
  const applied = applySidecarText(odd)
  if (applied && applied.changes.rating !== 5) fail(`apply: rating 9 became ${applied.changes.rating}`)
  if (applied && 'label' in applied.changes)
    fail(`apply: an unknown label was accepted as ${applied.changes.label}`)
}

window.__result = {
  pass: failures.length === 0,
  failures,
  sidecarBytes: sidecar.length,
  presetBytes: presetXml.length,
  sections: readSidecar?.sections ?? [],
}
window.__done = true
