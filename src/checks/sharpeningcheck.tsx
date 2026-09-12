import { createRoot } from 'react-dom/client'
import { db } from '../catalog/db'
import { applyImportDefaults } from '../catalog/importDefaults'
import { defaultEdits, rawDetailDefaults, resetSection, type FileKind } from '../core/defaults'
import { floatToHalf, HALF_ONE } from '../core/half'
import { EDITS_VERSION, type Photo, type Preset } from '../core/types'
import type { SourceImage } from '../core/workingImage'
import { applyAuto, autoDevelop, autoTone } from '../develop/auto'
import { migrateEdits } from '../develop/migrate'
import { isSectionModified } from '../develop/modified'
import { useDevelop } from '../develop/session'
import { parseXmp } from '../develop/xmp'
import { EditSlider } from '../modules/develop/EditSlider'
import { useUI } from '../state/ui'
import { runCheck } from './checkreport'
import '../styles/index.css'

const failures: string[] = []
let assertions = 0
const ok = (condition: unknown, message: string) => {
  assertions++
  if (!condition) failures.push(message)
}
const equal = (actual: unknown, expected: unknown, message: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expected), message)
const tick = () => new Promise<void>((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
const kinds: FileKind[] = ['raw', 'rendered']
const photoIds: string[] = []
const presetIds: string[] = []

function checkDefaults() {
  const isos = [-100, 0, NaN, Infinity, -Infinity, 50, 100, 150, 200, 400, 800, 1600, 3200, 6400, 12800, 1e8]
  for (const iso of isos) {
    ok(rawDetailDefaults(iso).sharpenAmount === 0, `RAW detail ISO ${iso}: sharpening off`)
    for (const kind of kinds) {
      const edits = defaultEdits(kind, undefined, iso)
      const label = `${kind} ISO ${iso}`
      ok(edits.detail.sharpenAmount === 0, `${label}: default sharpening off`)
      ok(edits.profile.name === 'standard', `${label}: Standard profile retained`)
      ok(!isSectionModified(edits, 'detail', kind, iso), `${label}: default detail not modified`)
      edits.detail.sharpenAmount = 62
      ok(isSectionModified(edits, 'detail', kind, iso), `${label}: explicit sharpening is modified`)
      const reset = resetSection(edits, 'detail', kind)
      ok(reset.detail.sharpenAmount === 0, `${label}: shared detail reset disables sharpening`)
      ok(edits.detail.sharpenAmount === 62, `${label}: reset does not mutate its input`)
    }
  }

  // ISO, masking, luminance NR/detail/contrast, colour NR/detail/smoothness.
  const noiseBaselines = [
    [0, 10, 0, 50, 0, 55, 50, 50],
    [100, 0, 0, 60, 0, 55, 50, 50],
    [200, 0, 0, 60, 0, 55, 50, 50],
    [400, 5, 5, 60, 0, 55, 50, 50],
    [800, 10, 15, 60, 5, 55, 50, 55],
    [1600, 20, 40, 55, 15, 55, 50, 65],
    [3200, 30, 60, 50, 25, 55, 50, 80],
    [6400, 40, 70, 50, 30, 60, 50, 85],
    [12800, 40, 70, 50, 30, 60, 50, 85],
  ]
  for (const [iso, ...expected] of noiseBaselines) {
    const detail = rawDetailDefaults(iso)
    equal([
      detail.sharpenMasking, detail.luminanceNR, detail.luminanceNRDetail,
      detail.luminanceNRContrast, detail.colorNR, detail.colorNRDetail, detail.colorNRSmoothness,
    ], expected, `ISO ${iso}: noise reduction and dormant masking unchanged`)
    equal([detail.sharpenRadius, detail.sharpenDetail, detail.impulseNR], [1, 25, 0],
      `ISO ${iso}: dormant sharpening subcontrols and impulse NR unchanged`)
    const rendered = defaultEdits('rendered', undefined, iso).detail
    equal([rendered.luminanceNR, rendered.colorNR, rendered.sharpenMasking], [0, 0, 0],
      `rendered ISO ${iso}: NR and masking remain off`)
  }
}

function checkSavedAndImportedValues() {
  for (const amount of [0, 30, 40, 60, 62.5, 70, 150]) {
    const edits = defaultEdits('raw')
    edits.detail.sharpenAmount = amount
    edits.detail.luminanceNR = 24
    for (let version = 1; version <= EDITS_VERSION; version++) {
      equal(migrateEdits({ ...edits, version }).detail, edits.detail,
        `migration v${version}: preserves saved sharpening ${amount} and NR`)
    }
  }
  const xmp = (sharpness: string) => `<x:xmpmeta xmlns:x="adobe:ns:meta/">
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
        crs:Contrast2012="12" ${sharpness}/>
    </rdf:RDF></x:xmpmeta>`
  const omitted = parseXmp(xmp(''))
  ok(omitted?.edits.detail.sharpenAmount === 0, 'XMP: omitted sharpening defaults off')
  ok(!omitted?.paths.includes('detail.sharpenAmount'), 'XMP: omitted sharpening remains unscoped')
  for (const value of ['0', '40', '62.5', '150', 'invalid', '1/0']) {
    const parsed = parseXmp(xmp(`crs:Sharpness="${value}"`))
    const expected = Number.isFinite(Number(value)) ? Number(value) : 0
    ok(parsed?.edits.detail.sharpenAmount === expected, `XMP ${value}: valid amounts kept, invalid defaults off`)
  }
}

function checkAuto() {
  for (const kind of kinds) {
    const edits = defaultEdits(kind, undefined, 6400)
    const data = new Uint16Array(32 * 32 * 4)
    for (let i = 0; i < 32 * 32; i++) {
      const value = floatToHalf(0.02 + 0.6 * (i / (32 * 32 - 1)))
      data.set([value, value, value, HALF_ONE], i * 4)
    }
    const image: SourceImage = {
      width: 32, height: 32, data, isRaw: kind === 'raw',
      asShot: { temp: edits.basic.temp, tint: edits.basic.tint }, whiteLevel: 1,
    }
    for (const amount of [0, 62]) {
      edits.detail.sharpenAmount = amount
      const detail = structuredClone(edits.detail)
      Object.assign(edits.basic, autoTone(image, edits))
      equal(edits.detail, detail, `${kind}: Auto Tone preserves sharpening ${amount} and NR`)
      applyAuto(edits, autoDevelop(image, edits))
      equal(edits.detail, detail, `${kind}: Auto Develop preserves sharpening ${amount} and NR`)
    }
  }
}

function photo(kind: FileKind, iso: number): Photo {
  const id = `sharpeningcheck-${crypto.randomUUID()}`
  photoIds.push(id)
  return {
    id, folderId: id, relPath: 'check', filename: 'check', ext: kind === 'raw' ? 'arw' : 'jpg',
    isRaw: kind === 'raw', fileSize: 1, modifiedAt: 0, addedAt: 0, width: 32, height: 32,
    meta: {
      cameraMake: 'Check', cameraModel: 'Check', lens: '', iso, shutter: 0, aperture: 0,
      focalLength: 0, captureTime: null, artist: '', copyright: '', gps: null,
      flip: 0, camMul: null, preMul: null, camXyz: null, black: null, maximum: null,
    },
    rating: 0, flag: 'unflagged', label: 'none', keywords: [], title: '', caption: '',
    edits: null, thumbKey: null, proxyKey: null, masterId: null, copyName: null,
    stackId: null, stackPosition: 0, stackCollapsed: false,
  }
}

async function checkSessionAndSliders(host: HTMLElement) {
  for (const kind of kinds) {
    for (const iso of [0, 100, 6400]) {
      const fixture = photo(kind, iso)
      const label = `${kind} ISO ${iso}`
      await db.photos.put(fixture)
      await useDevelop.getState().load(fixture)
      const defaults = structuredClone(useDevelop.getState().edits)
      equal([
        defaults.detail.sharpenAmount, useDevelop.getState().original.detail.sharpenAmount,
        useDevelop.getState().before.detail.sharpenAmount,
      ], [0, 0, 0], `${label}: fresh session and compare baselines have no sharpening`)
      useDevelop.getState().update('detail.sharpenAmount', 'Sharpen Amount', (edits) => {
        edits.detail.sharpenAmount = 62
        edits.detail.sharpenRadius = 1.4
        edits.detail.luminanceNR = 24
        edits.basic.exposure = 0.5
      })
      const chosen = structuredClone(useDevelop.getState().edits)
      await useDevelop.getState().flush()
      const stored = await db.photos.get(fixture.id)
      ok(stored?.edits?.detail.sharpenAmount === 62, `${label}: chosen sharpening persisted`)
      await useDevelop.getState().load(null)
      await useDevelop.getState().load(stored!)
      equal(useDevelop.getState().edits.detail, chosen.detail, `${label}: reopen preserves saved Detail`)
      ok(useDevelop.getState().before.detail.sharpenAmount === 0, `${label}: compare defaults remain off`)

      for (const selector of ['[role="slider"]', 'button[title="Sharpen Amount: double-click to reset"]']) {
        await tick()
        const target = host.querySelector(selector)
        if (!target) throw new Error(`Missing ${selector}`)
        target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        equal(useDevelop.getState().edits.detail, { ...chosen.detail, sharpenAmount: 0 },
          `${label}: double-click ${selector} resets amount only`)
        useDevelop.getState().undo()
        equal(useDevelop.getState().edits.detail, chosen.detail, `${label}: undo restores chosen Detail`)
      }

      useDevelop.getState().resetSection('detail')
      equal(useDevelop.getState().edits.detail, defaults.detail, `${label}: Detail reset uses ISO defaults`)
      ok(useDevelop.getState().edits.basic.exposure === 0.5, `${label}: Detail reset preserves exposure`)
      useDevelop.getState().undo()
      equal(useDevelop.getState().edits.detail, chosen.detail, `${label}: undo Detail reset retains sharpening`)
      useDevelop.getState().resetAll()
      equal(useDevelop.getState().edits.detail, defaults.detail, `${label}: Reset All uses ISO defaults`)
      ok(useDevelop.getState().edits.basic.exposure === 0, `${label}: Reset All resets exposure`)
      await useDevelop.getState().load(null)
    }
  }
}

async function checkImportDefaults() {
  const tone: Preset = {
    id: `sharpeningcheck-${crypto.randomUUID()}`, name: 'Tone only', group: 'Check',
    builtin: false, sections: ['basic'], paths: ['basic.contrast'],
    edits: { basic: { ...defaultEdits().basic, contrast: 12 } }, createdAt: 0,
  }
  const sharpen: Preset = {
    ...tone, id: `sharpeningcheck-${crypto.randomUUID()}`, name: 'Chosen sharpening',
    sections: ['detail'], paths: ['detail.sharpenAmount'],
    edits: { detail: { ...defaultEdits().detail, sharpenAmount: 57 } },
  }
  presetIds.push(tone.id, sharpen.id)
  await db.presets.bulkPut([tone, sharpen])
  for (const kind of kinds) {
    const fixture = photo(kind, 6400)
    await db.photos.put(fixture)
    useUI.setState({ importDevelop: 'none', importPresetId: null, previewOnImport: false })
    await applyImportDefaults([fixture.id])
    ok((await db.photos.get(fixture.id))?.edits === null, `${kind}: normal import does not create edits`)
    useUI.setState({ importDevelop: 'preset', importPresetId: tone.id })
    await applyImportDefaults([fixture.id])
    const toned = (await db.photos.get(fixture.id))?.edits
    ok(toned?.basic.contrast === 12, `${kind}: import tone preset applied`)
    equal(toned?.detail, defaultEdits(kind, undefined, 6400).detail,
      `${kind}: import tone preset leaves sharpening off and NR at ISO defaults`)

    const chosen = structuredClone(toned!)
    chosen.detail.sharpenAmount = 62
    chosen.detail.luminanceNR = 24
    await db.photos.update(fixture.id, { edits: chosen })
    await applyImportDefaults([fixture.id])
    equal((await db.photos.get(fixture.id))?.edits?.detail, chosen.detail,
      `${kind}: import tone preset preserves explicit saved sharpening and NR`)
    useUI.setState({ importPresetId: sharpen.id })
    await applyImportDefaults([fixture.id])
    equal((await db.photos.get(fixture.id))?.edits?.detail, { ...chosen.detail, sharpenAmount: 57 },
      `${kind}: explicit import sharpening preset still works without changing NR`)
  }
}

runCheck(async () => {
  const savedSession = useDevelop.getState()
  const { importDevelop, importPresetId, previewOnImport, autoWriteSidecars } = useUI.getState()
  const host = document.getElementById('root')!
  const root = createRoot(host)
  try {
    useUI.setState({ autoWriteSidecars: false })
    root.render(<EditSlider path="detail.sharpenAmount" label="Sharpen Amount" min={0} max={150} origin={0} />)
    checkDefaults()
    checkSavedAndImportedValues()
    checkAuto()
    await checkSessionAndSliders(host)
    await checkImportDefaults()
  } finally {
    root.unmount()
    await useDevelop.getState().load(null)
    useDevelop.setState(savedSession)
    useUI.setState({ importDevelop, importPresetId, previewOnImport, autoWriteSidecars })
    await db.photos.bulkDelete(photoIds)
    await db.presets.bulkDelete(presetIds)
  }
  return { pass: failures.length === 0, assertions, failures }
})
