import { createRoot } from 'react-dom/client'
import Dexie from 'dexie'
import { db, EsqueDB } from '../catalog/db'
import { applyImportDefaults } from '../catalog/importDefaults'
import { ALL_SECTIONS, defaultEdits, defaultMaskAdjustments, rawDetailDefaults, resetSection, type FileKind } from '../core/defaults'
import { floatToHalf, HALF_ONE } from '../core/half'
import { EDITS_VERSION, type Photo, type Preset } from '../core/types'
import type { SourceImage } from '../core/workingImage'
import { applyAuto, autoDevelop, autoTone } from '../develop/auto'
import { migrateEdits, migratePartialEdits } from '../develop/migrate'
import { withLayerDefaults } from '../develop/layers'
import { isSectionModified } from '../develop/modified'
import { useDevelop } from '../develop/session'
import { editsToSidecar, parsePresetFile, parseXmp } from '../develop/xmp'
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
  for (const amount of [0, 29, 62.5, 71, 150]) {
    const edits = defaultEdits('raw')
    edits.detail.sharpenAmount = amount
    edits.detail.luminanceNR = 24
    for (let version = 1; version <= EDITS_VERSION; version++) {
      equal(migrateEdits({ ...edits, version }).detail, edits.detail,
        `migration v${version}: preserves saved sharpening ${amount} and NR`)
    }
  }
  checkLegacyCaptureSharpening()
  const xmp = (sharpness: string) => `<x:xmpmeta xmlns:x="adobe:ns:meta/">
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
        crs:Contrast2012="12" ${sharpness}/>
    </rdf:RDF></x:xmpmeta>`
  const omitted = parseXmp(xmp(''))
  ok(omitted?.edits.detail.sharpenAmount === 0, 'XMP: omitted sharpening defaults off')
  ok(!omitted?.paths.includes('detail.sharpenAmount'), 'XMP: omitted sharpening remains unscoped')
  for (const value of ['0', '30', '45', '60', '65', '70', '62.5', '150', 'invalid', '1/0']) {
    const parsed = parseXmp(xmp(`crs:Sharpness="${value}"`))
    const expected = Number.isFinite(Number(value)) ? Number(value) : 0
    ok(parsed?.edits.detail.sharpenAmount === expected, `XMP ${value}: valid amounts kept, invalid defaults off`)
  }
  checkInheritedSharpening()
}

function checkLegacyCaptureSharpening() {
  const legacy = () => {
    const edits = defaultEdits('raw')
    edits.detail.luminanceNR = 24
    return edits
  }
  for (let amount = 30; amount <= 70; amount++) {
    const edits = legacy()
    edits.detail.sharpenAmount = amount
    for (let version = 1; version < 5; version++) {
      const out = migrateEdits({ ...edits, version })
      ok(out.detail.sharpenAmount === 0, `migration v${version}: drops the old ${amount} baseline`)
      equal({ ...out.detail, sharpenAmount: amount }, edits.detail,
        `migration v${version}: dropping ${amount} leaves the rest of Detail alone`)
      equal(migrateEdits(out).detail, out.detail,
        `migration v${version}: dropping ${amount} is idempotent`)
      ok(edits.detail.sharpenAmount === amount, 'migration: input is not mutated')
    }
    equal(migrateEdits({ ...edits, version: EDITS_VERSION }).detail, edits.detail,
      `migration: a current stack keeps its ${amount}`)
  }
  for (const [label, moved] of [
    ['radius', { sharpenRadius: 1.4 }],
    ['detail', { sharpenDetail: 60 }],
  ] as const) {
    const edits = legacy()
    edits.detail = { ...edits.detail, sharpenAmount: 70, ...moved }
    equal(migrateEdits({ ...edits, version: 1 }).detail, edits.detail,
      `migration: 70 next to a chosen ${label} is kept`)
  }
  const masked = legacy()
  masked.detail = { ...masked.detail, sharpenAmount: 70, sharpenMasking: 50 }
  ok(migrateEdits({ ...masked, version: 1 }).detail.sharpenAmount === 0,
    'migration: masking of its own does not rescue the old baseline')

  const scopedDetail = { ...legacy().detail, sharpenAmount: 70 }
  const scoped = migratePartialEdits({ version: 1, detail: scopedDetail })
  ok(scoped.detail?.sharpenAmount === 0, 'preset migration: drops the old baseline it scoped')
  ok(scopedDetail.sharpenAmount === 70, 'preset migration: input is not mutated')
  ok(!('detail' in migratePartialEdits({ version: 1, basic: defaultEdits('raw').basic })),
    'preset migration: leaves an unscoped Detail section unscoped')
}

const sidecar = (body: string) => `<x:xmpmeta xmlns:x="adobe:ns:meta/">
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
        xmlns:esq="https://esque.photo/ns/1.0/"
        crs:RawFileName="DSC_0042.NEF" crs:Contrast2012="12" ${body}/>
    </rdf:RDF></x:xmpmeta>`
const ACR = 'crs:Sharpness="40" crs:SharpenRadius="+1.0" crs:SharpenDetail="25" crs:SharpenEdgeMasking="0"'

function checkInheritedSharpening() {
  const factory = parseXmp(sidecar(ACR))
  ok(factory?.edits.detail.sharpenAmount === 0, 'sidecar: Camera Raw factory sharpening is not inherited')
  ok(!factory?.paths.includes('detail.sharpenAmount'), 'sidecar: inherited sharpening leaves the section unscoped')
  ok(!factory?.sections.includes('detail'), 'sidecar: inherited sharpening does not scope Detail')
  ok(factory?.paths.includes('basic.contrast'), 'sidecar: the rest of the file still applies')

  const amountOnly = parseXmp(sidecar('crs:Sharpness="40"'))
  ok(amountOnly?.edits.detail.sharpenAmount === 0, 'sidecar: a bare factory amount is not inherited either')

  for (const [label, body] of [
    ['a different amount', ACR.replace('"40"', '"65"')],
    ['a different radius', ACR.replace('"+1.0"', '"+1.6"')],
    ['a different detail', ACR.replace('crs:SharpenDetail="25"', 'crs:SharpenDetail="60"')],
    ['masking of its own', ACR.replace('crs:SharpenEdgeMasking="0"', 'crs:SharpenEdgeMasking="35"')],
  ] as const) {
    const parsed = parseXmp(sidecar(body))
    ok(parsed?.paths.includes('detail.sharpenAmount'),
      `sidecar: ${label} reads as a decision and is kept`)
    ok(parsed?.edits.detail.sharpenAmount === (label === 'a different amount' ? 65 : 40),
      `sidecar: ${label} retains its numeric amount`)
  }

  const radiusOnly = parseXmp(sidecar('crs:SharpenRadius="1"'))
  ok(radiusOnly?.paths.includes('detail.sharpenRadius'),
    'sidecar: a subcontrol without Amount remains explicit')

  checkForeignSharpeningPresets()
  checkEsqueSidecars()
}

function checkForeignSharpeningPresets() {
  for (const amount of [40, 70]) {
    const xml = sidecar(ACR.replace('"40"', `"${amount}"`))
    const named = parseXmp(xml.replace('crs:RawFileName="DSC_0042.NEF"', 'crs:Name="Sharpen"'))
    ok(named?.isPreset && named.edits.detail.sharpenAmount === amount,
      `preset: named foreign XMP preserves ${amount}`)
    const imported = parsePresetFile('sharpen.xmp', xml)
    ok(imported?.edits.detail?.sharpenAmount === amount,
      `preset: explicitly imported XMP preserves ${amount}`)
    ok(imported?.edits.version === EDITS_VERSION, 'preset: imported patch has a current version')
    if (imported) {
      ok(migratePartialEdits(imported.edits).detail?.sharpenAmount === amount,
        'preset: subsequent migration preserves imported sharpening')
    }
    const lua = parsePresetFile('sharpen.lrtemplate', `s = {
      settings = {
        Sharpness = ${amount},
        SharpenRadius = 1,
        SharpenDetail = 25,
        SharpenEdgeMasking = 0,
\t},
}`)
    ok(lua?.edits.detail?.sharpenAmount === amount,
      `preset: lrtemplate preserves ${amount}`)
  }
}

function checkEsqueSidecars() {
  const own = parseXmp(sidecar(`esq:EditVersion="${EDITS_VERSION}" ${ACR}`))
  ok(own?.edits.detail.sharpenAmount === 40, "sidecar: esque's own sharpening round-trips")
  ok(own?.paths.includes('detail.sharpenAmount'), "sidecar: esque's own sharpening stays scoped")

  const legacy = parseXmp(sidecar('esq:EditVersion="4" crs:Sharpness="70" crs:SharpenRadius="+1.0" crs:SharpenDetail="25"'))
  ok(legacy?.edits.detail.sharpenAmount === 0, 'sidecar: an old esque baseline is migrated away')
  const chosen = parseXmp(sidecar('esq:EditVersion="4" crs:Sharpness="70" crs:SharpenRadius="+1.6" crs:SharpenDetail="25"'))
  ok(chosen?.edits.detail.sharpenAmount === 70, 'sidecar: an old esque stack keeps a sharpening it was given')

  const unversioned = parseXmp(sidecar('crs:Sharpness="70" crs:SharpenRadius="+1.0" crs:SharpenDetail="25"'))
  ok(unversioned?.edits.detail.sharpenAmount === 70, 'sidecar: foreign 70 is not an esque baseline')

  const oldEdits = defaultEdits('raw')
  oldEdits.detail.sharpenAmount = 70
  oldEdits.layers = [withLayerDefaults({
    id: 'legacy', adjustments: { ...defaultMaskAdjustments(), tint: 20 },
  })]
  const oldXml = editsToSidecar(oldEdits, ALL_SECTIONS, { filename: 'legacy.nef' })
    .replace(/ esq:EditVersion="\d+"/, '')
  const old = parseXmp(oldXml)
  ok(old?.edits.detail.sharpenAmount === 0, 'sidecar: unversioned esque sharpening is migrated')
  ok(old?.edits.layers[0]?.adjustments.tint === -20, 'sidecar: unversioned esque tint still migrates')
}

async function checkCatalogUpgrade() {
  for (const version of [2, 3, 4]) {
    const name = `sharpening-upgrade-${crypto.randomUUID()}`
    const upgraded = new EsqueDB(name)
    const previous = new Dexie(name)
    const schema = Object.fromEntries(upgraded.tables
      .filter((table) => version >= 4 || table.name !== 'cacheMetadata')
      .map((table) => [
        table.name,
        [table.schema.primKey.src, ...table.schema.indexes.map((index) => index.src)].join(', '),
      ]))
    previous.version(version).stores(schema)
    try {
      const legacy = photo('raw', 100)
      legacy.edits = defaultEdits('raw')
      legacy.edits.version = 4
      legacy.edits.detail.sharpenAmount = 70
      legacy.thumbRev = 7
      legacy.thumbKey = `thumb/${legacy.id}.7.jpg`
      legacy.previewRev = 9
      const current = photo('raw', 100)
      current.edits = defaultEdits('raw')
      current.edits.detail.sharpenAmount = 70
      const fresh = photo('raw', 100)
      const preset: Preset = {
        id: 'legacy', name: 'Legacy', group: '', builtin: false, sections: ['detail'],
        paths: ['detail.sharpenAmount'], edits: { version: 4, detail: legacy.edits.detail },
        createdAt: 0,
      }
      await previous.table('photos').bulkPut([legacy, current, fresh])
      await previous.table('snapshots').put({
        id: 'legacy', photoId: legacy.id, name: 'Legacy', edits: legacy.edits, createdAt: 0,
      })
      await previous.table('presets').put(preset)
      await previous.table('cache').put({ key: 'proxy/keep', blob: new Blob(['pixels']), modifiedAt: 0 })
      if (version === 4) {
        await previous.table('cacheMetadata').put({ key: 'proxy/keep', accessedAt: 123 })
      }
      previous.close()
      await upgraded.open()

      const saved = await upgraded.photos.get(legacy.id)
      equal(saved?.edits, migrateEdits(legacy.edits), `catalog v${version}: photo edits migrated`)
      equal([saved?.thumbRev, saved?.thumbKey, saved?.previewRev],
        [8, `thumb/${legacy.id}.8.jpg`, 10], `catalog v${version}: renders invalidated`)
      equal(await upgraded.photos.get(current.id), current, `catalog v${version}: current edits unchanged`)
      equal(await upgraded.photos.get(fresh.id), fresh, `catalog v${version}: unedited photo unchanged`)
      equal((await upgraded.snapshots.get('legacy'))?.edits, saved?.edits,
        `catalog v${version}: snapshot migrated`)
      const migratedPreset = await upgraded.presets.get('legacy')
      equal(migratedPreset?.edits, migratePartialEdits(preset.edits),
        `catalog v${version}: preset migrated`)
      equal(migratedPreset?.paths, preset.paths, `catalog v${version}: preset scope retained`)
      ok(await (await upgraded.cache.get('proxy/keep'))?.blob.text() === 'pixels',
        `catalog v${version}: RAW cache retained`)
      if (version === 4) {
        ok((await upgraded.cacheMetadata.get('proxy/keep'))?.accessedAt === 123,
          'catalog v4: cache metadata retained')
      }
      upgraded.close()
      await upgraded.open()
      equal(await upgraded.photos.get(legacy.id), saved, `catalog v${version}: reopen is idempotent`)
    } finally {
      previous.close()
      await upgraded.delete()
    }
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
    await checkCatalogUpgrade()
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
