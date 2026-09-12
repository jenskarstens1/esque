import { changedPaths, defaultEdits, getPath, rawDetailDefaults, SECTION_LABELS } from '../core/defaults'
import { applyPreset, BUILTIN_PRESETS, PRESET_SCOPES, scopePaths } from '../develop/presets'
import { parsePresetFile, presetToXmp } from '../develop/xmp'
import type { Edits, Preset } from '../core/types'
import { profileEdits } from '../core/profiles'

/*
 * Preset application check.
 *
 * The thing being guarded here is that a preset applies *only* the fields it
 * declares. Whole-section application is invisible on a JPEG — its white
 * balance is already baked into the pixels — and ruinous on a RAW, where white
 * balance, capture sharpening and colour noise reduction are the per-file
 * decisions a look knows nothing about.
 */

declare global {
  interface Window {
    __result?: unknown
    __done?: boolean
  }
}

const failures: string[] = []
const fail = (m: string) => failures.push(m)
const ok = (cond: boolean, m: string) => {
  if (!cond) fail(m)
}

/**
 * A photo mid-edit: custom white balance, a lifted exposure, hand-tuned capture
 * sharpening and noise reduction, a crop and a lens profile. Everything here is
 * a property of *this* frame, so no look is allowed to touch any of it.
 */
function editedRaw(): Edits {
  const e = defaultEdits('raw')
  e.profile = profileEdits('portrait')
  e.basic.wbMode = 'custom'
  e.basic.temp = 3150
  e.basic.tint = 14
  e.basic.exposure = 1.35
  e.detail.sharpenAmount = 62
  e.detail.sharpenRadius = 0.9
  e.detail.sharpenMasking = 45
  e.detail.luminanceNR = 38
  e.detail.colorNR = 55
  e.lens.enableProfile = true
  e.crop.left = 0.1
  e.crop.right = 0.9
  e.transform.rotate = 2.5
  e.effects.grainAmount = 41
  return e
}

/**
 * Fields no preset may ever carry: they describe the frame, not the look. A
 * preset that moved any of these would be applying one photo's circumstances
 * to another.
 */
const FRAME_ONLY = [
  'profile',
  'basic.wbMode',
  'basic.temp',
  'basic.tint',
  'basic.exposure',
  'crop.left',
  'crop.right',
  'transform.rotate',
  'lens.enableProfile',
  'detail.sharpenAmount',
  'detail.sharpenRadius',
  'detail.sharpenMasking',
  'detail.luminanceNR',
  'detail.colorNR',
]

/** The only presets whose whole job is a Detail correction. */
const DETAIL_TOOLS = new Set(['nr-high-iso', 'sharpen-detail', 'sharpen-portrait'])

// --- Built-ins declare exactly what they assign ---------------------------
//
// A path list derived by diffing against the defaults would silently drop
// deliberate assignments that land on a default value, so check the two
// directions separately: nothing may change that wasn't declared, and every
// declared path must survive being applied over a photo that already has a
// different value there.

for (const preset of BUILTIN_PRESETS) {
  const label = `${preset.id}`

  ok(!!preset.paths?.length, `${label}: declares no paths`)
  if (!preset.paths?.length) continue
  ok(new Set(preset.paths).size === preset.paths.length, `${label}: duplicate paths`)

  const before = editedRaw()
  const after = applyPreset(before, preset)
  const declared = new Set(preset.paths)

  for (const path of changedPaths(before, after)) {
    ok(declared.has(path), `${label}: changed undeclared field ${path}`)
  }
  for (const path of preset.paths) {
    const want = getPath(preset.edits as unknown as Record<string, unknown>, path)
    const got = getPath(after, path)
    ok(
      JSON.stringify(want) === JSON.stringify(got),
      `${label}: ${path} applied as ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
    )
  }

  for (const path of FRAME_ONLY) {
    if (DETAIL_TOOLS.has(preset.id) && path.startsWith('detail.')) continue
    ok(
      JSON.stringify(getPath(before, path)) === JSON.stringify(getPath(after, path)),
      `${label}: moved ${path}, which belongs to the photo not the look`,
    )
  }

  for (const section of preset.sections) {
    ok(section in SECTION_LABELS, `${label}: unknown section “${section}”`)
  }
}

// --- Choosing another look replaces the look, not the photo corrections ----

const looks = BUILTIN_PRESETS.filter((p) => p.group !== 'Tools')
ok(new Set(BUILTIN_PRESETS.map((p) => p.id)).size === BUILTIN_PRESETS.length, 'duplicate preset IDs')

for (const kind of ['raw', 'rendered'] as const) {
  const before = defaultEdits(kind)
  before.basic.exposure = 1.35
  before.basic.wbMode = 'custom'
  before.basic.temp = 3150
  before.basic.tint = 14
  before.curve.parametric.lights = 25
  before.curve.red = [{ x: 0, y: 0.06 }, { x: 1, y: 0.96 }]
  before.colorGrading.global = { hue: 290, saturation: 30, luminance: 4 }
  before.colorMixer.bw.orange = 60
  before.effects.vignetteAmount = -40
  before.calibration.redHue = 8
  before.tone.recovery = 'blend'

  for (const next of looks) {
    const direct = applyPreset(before, next)
    ok(direct.basic.treatment === (next.group === 'Black & White' ? 'bw' : 'color'),
      `${kind}/${next.id}: wrong treatment`)
    ok(direct.basic.saturation > -100, `${next.id}: destroys hue before the B&W channel mixer`)
    ok(direct.curve.parametric.lights === 0, `${next.id}: left an old parametric curve active`)
    ok(direct.colorGrading.global.saturation === 0, `${next.id}: left an old global grade active`)
    ok(direct.tone.recovery === 'blend', `${next.id}: reset highlight recovery`)
    ok(direct.calibration.redHue === 8, `${next.id}: reset camera calibration`)
    for (const previous of looks) {
      const switched = applyPreset(applyPreset(before, previous), next)
      ok(JSON.stringify(switched) === JSON.stringify(direct),
        `${kind}/${previous.id} -> ${next.id}: inherited part of the previous look`)
    }
    ok(JSON.stringify(applyPreset(direct, next)) === JSON.stringify(direct),
      `${kind}/${next.id}: applying a look twice changes it`)
  }
}

for (const preset of looks) {
  const e = applyPreset(defaultEdits(), preset)
  for (const channel of ['rgb', 'red', 'green', 'blue'] as const) {
    const points = e.curve[channel]
    ok(points[0].x === 0 && points.at(-1)?.x === 1, `${preset.id}/${channel}: curve misses an endpoint`)
    for (let i = 0; i < points.length; i++) {
      const p = points[i]
      ok(Number.isFinite(p.x) && Number.isFinite(p.y) && p.y >= 0 && p.y <= 1,
        `${preset.id}/${channel}: invalid curve point`)
      if (i) ok(p.x > points[i - 1].x && p.y >= points[i - 1].y,
        `${preset.id}/${channel}: curve reverses tones`)
    }
  }
  ok(!(e.curve.rgb[0].y > 0 && e.basic.blacks > 0), `${preset.id}: lifts blacks twice`)
  ok(e.effects.grainAmount <= 30, `${preset.id}: grain overwhelms the look`)
  if (preset.group === 'Black & White') {
    ok(Object.values(e.colorMixer.bw).some((v) => v !== 0), `${preset.id}: no B&W channel separation`)
    ok(Object.values(e.colorMixer.luminance).every((v) => v === 0),
      `${preset.id}: writes the bypassed colour luminance mixer`)
  }
}

// --- Deliberate assignments that happen to equal a default ----------------

const grain = BUILTIN_PRESETS.find((p) => p.id === 'grain-35mm')
if (!grain) fail('grain-35mm: missing')
else {
  ok(
    grain.paths?.includes('effects.grainSize') === true,
    'grain-35mm: dropped grainSize, which is only coincidentally the default',
  )
  const coarse = editedRaw()
  coarse.effects.grainSize = 60
  ok(applyPreset(coarse, grain).effects.grainSize === 25, 'grain-35mm: left a coarse grain size in place')
}

const highIso = BUILTIN_PRESETS.find((p) => p.id === 'nr-high-iso')
if (!highIso) fail('nr-high-iso: missing')
else {
  const grainy = editedRaw()
  const after = applyPreset(grainy, highIso)
  ok(after.effects.grainAmount === 0, 'nr-high-iso: left grain on top of noise reduction')
  ok(after.detail.colorNR === 40, 'nr-high-iso: did not apply colour noise reduction')
}

// --- A look must not undo capture sharpening ------------------------------

for (const preset of BUILTIN_PRESETS) {
  if (DETAIL_TOOLS.has(preset.id)) continue
  ok(
    !preset.paths?.some((p) => p.startsWith('detail.')),
    `${preset.id}: a look preset writes Detail, which is a per-file correction`,
  )
  const after = applyPreset(editedRaw(), preset)
  ok(after.detail.sharpenAmount === 62, `${preset.id}: reset capture sharpening`)
  ok(after.detail.colorNR === 55, `${preset.id}: reset colour noise reduction`)
}

// --- A foreign Lightroom preset touches one field only --------------------

const foreignXmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:PresetType="Normal" crs:HasSettings="True" crs:Contrast2012="+22"/>
 </rdf:RDF>
</x:xmpmeta>`

const foreign = parsePresetFile('Punchy.xmp', foreignXmp)
if (!foreign) fail('foreign: did not parse as a preset')
else {
  ok(
    JSON.stringify(foreign.paths) === JSON.stringify(['basic.contrast']),
    `foreign: declared ${JSON.stringify(foreign.paths)}`,
  )
  const before = editedRaw()
  const after = applyPreset(before, foreign)
  ok(
    JSON.stringify(changedPaths(before, after)) === JSON.stringify(['basic.contrast']),
    `foreign: changed ${JSON.stringify(changedPaths(before, after))}`,
  )
  ok(after.basic.temp === 3150 && after.basic.wbMode === 'custom', 'foreign: reset white balance')
  ok(Math.abs(after.basic.contrast - 22) < 0.51, `foreign: contrast came back ${after.basic.contrast}`)
}

// --- An unknown Adobe profile name is dropped, not guessed ----------------

const adobeProfile = parsePresetFile(
  'Adobe.xmp',
  `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:PresetType="Normal" crs:HasSettings="True" crs:CameraProfile="Adobe Color"
   crs:Clarity2012="+8"/>
 </rdf:RDF>
</x:xmpmeta>`,
)
if (!adobeProfile) fail('adobe profile: did not parse')
else
  ok(
    !adobeProfile.paths?.includes('profile'),
    'adobe profile: guessed an esque profile from an Adobe name',
  )

// --- Presets survive export and re-import as field-level ------------------

for (const preset of BUILTIN_PRESETS) {
  const { id } = preset
  const full = { ...defaultEdits('raw'), ...preset.edits } as Edits
  const reread = parsePresetFile(`${id}.xmp`, presetToXmp(preset, full))
  if (!reread) {
    fail(`${id}: export did not re-import`)
    continue
  }
  const before = editedRaw()
  const direct = changedPaths(before, applyPreset(before, preset))
  const viaXmp = changedPaths(before, applyPreset(before, reread))
  ok(
    JSON.stringify(direct) === JSON.stringify(viaXmp),
    `${id}: round trip changed ${JSON.stringify(viaXmp)} instead of ${JSON.stringify(direct)}`,
  )
  const applied = applyPreset(before, preset)
  const imported = applyPreset(before, reread)
  for (const path of preset.paths ?? []) {
    const want = getPath(applied, path)
    const got = getPath(imported, path)
    ok(JSON.stringify(want) === JSON.stringify(got),
      `${id}: ${path} changed value during XMP round trip`)
  }
}

// --- The camera profile is carried, not dropped ---------------------------

const profilePreset: Preset = {
  id: 'profile-only',
  name: 'Landscape Profile',
  group: 'Checks',
  builtin: false,
  sections: ['profile'],
  paths: ['profile'],
  edits: { profile: profileEdits('landscape') },
  createdAt: 0,
}
{
  const before = editedRaw()
  const after = applyPreset(before, profilePreset)
  ok(after.profile.name === 'landscape', `profile preset: applied as ${after.profile.name}`)
  // The profile is a group of values now, so it changes as several leaves.
  const touched = changedPaths(before, after)
  ok(
    touched.length > 0 && touched.every((p) => p === 'profile' || p.startsWith('profile.')),
    `profile preset: touched something other than the profile (${touched.join(', ')})`,
  )

  const reread = parsePresetFile(
    'profile.xmp',
    presetToXmp(profilePreset, { ...defaultEdits('raw'), profile: profileEdits('landscape') }),
  )
  if (!reread) fail('profile preset: did not re-import')
  else {
    ok(
      JSON.stringify(reread.paths) === JSON.stringify(['profile']),
      `profile preset: re-imported as ${JSON.stringify(reread.paths)}`,
    )
    ok(applyPreset(before, reread).profile.name === 'landscape', 'profile preset: lost the profile')
  }
}

// --- Legacy presets keep the old whole-section behaviour ------------------

{
  const legacy: Preset = {
    id: 'legacy',
    name: 'Legacy',
    group: 'Checks',
    builtin: false,
    sections: ['basic'],
    edits: { basic: { ...defaultEdits('raw').basic, contrast: 30 } },
    createdAt: 0,
  }
  const after = applyPreset(editedRaw(), legacy)
  ok(after.basic.contrast === 30, 'legacy: did not apply')
  ok(after.basic.wbMode === 'asShot', 'legacy: no longer replaces the whole section')
}

// --- Sharpening is opt-in; noise defaults still depend on the file --------

{
  const raw = defaultEdits('raw')
  const rendered = defaultEdits('rendered')
  ok(raw.detail.sharpenAmount === 0, `raw: sharpening is ${raw.detail.sharpenAmount}`)
  ok(raw.detail.sharpenMasking === 10, `raw: sharpening mask is ${raw.detail.sharpenMasking}`)
  // Luminance noise reduction stays off at base ISO.
  ok(raw.detail.luminanceNR === 0, `raw: luminance NR is ${raw.detail.luminanceNR}`)
  ok(rawDetailDefaults(100).luminanceNR === 0, 'raw: luminance NR is not zero at base ISO')
  ok(
    rawDetailDefaults(100).sharpenAmount === 0,
    `raw: base-ISO sharpening is ${rawDetailDefaults(100).sharpenAmount}`,
  )
  ok(
    rawDetailDefaults(100).colorNR === 55,
    `raw: base-ISO colour NR is ${rawDetailDefaults(100).colorNR}`,
  )
  ok(
    rawDetailDefaults(12800).luminanceNR <= 75,
    `raw: luminance NR reaches ${rawDetailDefaults(12800).luminanceNR} at ISO 12800`,
  )
  ok(
    rawDetailDefaults(12800).sharpenAmount === 0,
    `raw: high-ISO sharpening is ${rawDetailDefaults(12800).sharpenAmount}`,
  )
  ok(raw.detail.colorNR === 55, `raw: colour NR is ${raw.detail.colorNR}`)
  ok(rendered.detail.sharpenAmount === 0, `rendered: sharpening is ${rendered.detail.sharpenAmount}`)
  ok(rendered.detail.sharpenMasking === 0, `rendered: sharpening mask is ${rendered.detail.sharpenMasking}`)
  ok(rendered.detail.luminanceNR === 0, `rendered: luminance NR is ${rendered.detail.luminanceNR}`)
  ok(rendered.detail.colorNR === 0, `rendered: colour NR is ${rendered.detail.colorNR}`)
  ok(
    JSON.stringify(changedPaths(raw, rendered)) ===
      JSON.stringify([
        'basic.temp',
        'detail.sharpenMasking',
        'detail.colorNR',
      ]),
    `rendered: differs at ${JSON.stringify(changedPaths(raw, rendered))}`,
  )
}

// --- Scopes cover every field exactly once --------------------------------

{
  const everything = scopePaths(
    PRESET_SCOPES.map((s) => s.id),
    'raw',
  )
  const all = new Set(changedPaths(defaultEdits('raw'), editedRaw()))
  for (const path of all) ok(everything.includes(path), `scopes: nothing covers ${path}`)

  const seen = new Map<string, string>()
  for (const scope of PRESET_SCOPES) {
    for (const path of scopePaths([scope.id], 'raw')) {
      const prior = seen.get(path)
      ok(!prior, `scopes: ${path} is in both “${prior}” and “${scope.id}”`)
      seen.set(path, scope.id)
    }
  }

  ok(
    !scopePaths(['basicTone', 'presence', 'treatment'], 'raw').some((p) =>
      ['basic.wbMode', 'basic.temp', 'basic.tint', 'basic.exposure'].includes(p),
    ),
    'scopes: the look scopes drag white balance or exposure along',
  )
}

window.__result = {
  pass: failures.length === 0,
  failures,
  presets: BUILTIN_PRESETS.length,
  scopes: PRESET_SCOPES.length,
}
window.__done = true
