import Dexie, { type EntityTable } from 'dexie'
import { createRoot } from 'react-dom/client'
import { db, type ManagedOriginal, type Setting } from '../catalog/db'
import {
  archiveBlob, createCatalogArchive, flushCatalogEdits, portablePhoto, portablePreset, portableSnapshot,
  type CatalogDatabase,
} from '../catalog/archive'
import { MERGE_TABLES, mergeCatalogArchive } from '../catalog/merge'
import { ArchiveValidationError, parseCatalogArchive, type CatalogArchive } from '../catalog/schema'
import { commitReconnection, inspectFileReconnection, inspectFolderReconnection, missingSources } from '../catalog/reconnect'
import { defaultEdits, defaultMaskAdjustments } from '../core/defaults'
import { isAiGeometry, type CatalogFolder, type Collection, type Edits, type Photo, type Preset, type Snapshot } from '../core/types'
import { SettingsDialog } from '../shell/SettingsDialog'
import { useImporter } from '../state/importer'
import { useExport } from '../state/exportStore'
import { useDevelop } from '../develop/session'
import { alphaKey, dropAlphasFor, getAlpha, putAlpha } from '../ai/alpha'
import { detect, detectStatus, useDetect } from '../ai/detect'
import { cacheDelete } from '../catalog/opfs'
import '../styles/index.css'

declare global {
  interface Window {
    __result?: unknown
    __done?: boolean
  }
}

// These tests never clear or populate the application DB. Each scenario owns
// a uniquely named database using the actual current Dexie schema.
class CheckDB extends Dexie implements CatalogDatabase {
  photos!: EntityTable<Photo, 'id'>
  folders!: EntityTable<CatalogFolder, 'id'>
  collections!: EntityTable<Collection, 'id'>
  presets!: EntityTable<Preset, 'id'>
  snapshots!: EntityTable<Snapshot, 'id'>
  originals!: EntityTable<ManagedOriginal, 'id'>
  settings!: EntityTable<Setting, 'key'>

  constructor() {
    super(`esque-catalog-check-${crypto.randomUUID()}`)
    this.version(1).stores(Object.fromEntries(db.tables.map((table) => [
      table.name, [table.schema.primKey.src, ...table.schema.indexes.map((index) => index.src)].join(','),
    ])))
  }
}

const databases: CheckDB[] = []
const fresh = () => {
  const database = new CheckDB()
  databases.push(database)
  return database
}
const failures: string[] = []
let assertions = 0
const ok = (condition: unknown, message: string) => {
  assertions++
  if (!condition) failures.push(message)
}
const canonical = (value: unknown) => JSON.stringify(value, (_key, entry: unknown) =>
  entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
    : entry)
const equal = (a: unknown, b: unknown, message: string) => ok(canonical(a) === canonical(b), message)
const pause = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(condition: () => boolean, message: string) {
  const deadline = Date.now() + 5000
  while (!condition() && Date.now() < deadline) await pause()
  ok(condition(), message)
}

async function rejected(action: () => Promise<unknown>, message: string, validation = false) {
  try {
    await action()
    ok(false, message)
  } catch (error) {
    ok(!validation || error instanceof ArchiveValidationError, `${message}: expected an archive validation error`)
  }
}

const content = (database: CatalogDatabase) => database.transaction('r', [
  database.photos, database.folders, database.collections, database.presets, database.snapshots,
], async () => JSON.stringify(await Promise.all([
  database.photos.toArray(), database.folders.toArray(), database.collections.toArray(),
  database.presets.toArray(), database.snapshots.toArray(),
])))

function edits(): Edits {
  const value = defaultEdits('rendered')
  value.basic.exposure = 1.25
  value.effects.grainAmount = 24
  value.crop.left = 0.1
  value.masks = [{
    id: 'mask-1', name: 'Window light', visible: true, inverted: false, opacity: 0.8,
    components: [
      { id: 'linear-1', blend: 'add', invert: false, geometry: { kind: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } } },
      { id: 'brush-1', blend: 'subtract', invert: true, geometry: { kind: 'brush', feather: 40, autoMask: true, dabs: [{ x: 0.3, y: 0.2, radius: 0.1, flow: 0.5, erase: false }] } },
      { id: 'radial-1', blend: 'intersect', invert: false, geometry: { kind: 'radial', center: { x: 0.5, y: 0.5 }, radiusX: 0.3, radiusY: 0.4, rotation: 0.2, feather: 60 } },
      { id: 'color-1', blend: 'add', invert: false, geometry: { kind: 'colorRange', samples: [{ r: 0.2, g: 0.5, b: 0.8 }], refine: 50 } },
      { id: 'luminance-1', blend: 'add', invert: false, geometry: { kind: 'luminanceRange', range: [0, 0.2, 0.8, 1], smoothness: 40 } },
      { id: 'ai-1', blend: 'add', invert: false, geometry: { kind: 'aiSubject', cacheKey: 'ai/private-original-cache', model: 'u2netp', refine: 50 } },
    ],
    adjustments: { ...defaultMaskAdjustments(), exposure: 0.4 },
  }]
  value.spots = [{ id: 'spot-1', mode: 'heal', source: { x: 0.1, y: 0.2 }, target: { x: 0.2, y: 0.3 }, radius: 0.02, feather: 70, opacity: 0.8 }]
  value.redEye = [{ id: 'eye-1', kind: 'human', center: { x: 0.5, y: 0.5 }, radius: 0.02, darken: 60 }]
  return value
}

async function writeFile(directory: FileSystemDirectoryHandle, name: string, bytes: number[]) {
  const handle = await directory.getFileHandle(name, { create: true })
  const writer = await handle.createWritable()
  await writer.write(new Uint8Array(bytes))
  await writer.close()
  return handle
}

async function photo(
  id: string, folderId: string, relPath: string, handle: FileSystemFileHandle,
): Promise<Photo> {
  const file = await handle.getFile()
  return {
    id, folderId, relPath, filename: file.name, ext: 'jpg', isRaw: false, hdr: false,
    fileSize: file.size, modifiedAt: file.lastModified, addedAt: 1_700_000_000_000,
    width: 800, height: 600,
    meta: {
      cameraMake: 'Check', cameraModel: 'Synthetic camera', lens: '35 mm', iso: 800,
      shutter: 0.008, aperture: 2.8, focalLength: 35, captureTime: 1_600_000_000_000,
      artist: 'Café 日本', copyright: 'Local check', gps: { lat: 52.5, lon: 13.4, alt: 35 },
      flip: 0, camMul: [2, 1, 1.5, 1], preMul: [2, 1, 1.5, 1],
      camXyz: [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]],
      black: 512, maximum: 16_383, rawCrop: [0, 0, 800, 600], embeddedWidth: 400, embeddedHeight: 300,
    },
    rating: 4, flag: 'pick', label: 'green', keywords: ['travel', '日本'], title: 'Window light', caption: 'My saved description',
    edits: edits(), thumbKey: 'thumb/private-thumb-pointer.jpg', thumbRev: 99, proxyKey: 'proxy/private-proxy-pointer',
    fileHandle: handle, masterId: null, copyName: null, stackId: 'stack-1', stackPosition: 0, stackCollapsed: true,
    readError: 'Transient read error must not travel',
  }
}

function denied<T extends FileSystemHandle>(handle: T): T {
  return new Proxy(handle, {
    get(target, key) {
      if (key === 'queryPermission' || key === 'requestPermission') return async () => 'denied'
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

let storageRoot: FileSystemDirectoryHandle | null = null
let checkRootName: string | null = null
const root = createRoot(document.getElementById('root')!)

async function drive() {
  storageRoot = await navigator.storage.getDirectory()
  checkRootName = `catalog-check-${crypto.randomUUID()}`
  const files = await storageRoot.getDirectoryHandle(checkRootName, { create: true })
  const shoot = await files.getDirectoryHandle('Shoot', { create: true })
  const day = await shoot.getDirectoryHandle('Day 1', { create: true })
  const masterHandle = await writeFile(day, 'shot.jpg', [1, 2, 3, 4])
  const looseHandle = await writeFile(files, 'loose.jpg', [5, 6, 7])
  const duplicateHandle = await writeFile(files, 'shot.jpg', [8, 9])
  const source = fresh()
  const master = await photo('photo-master', 'folder-shoot', 'Day 1/shot.jpg', masterHandle)
  master.fileHandle = null
  const copy: Photo = { ...structuredClone(master), id: 'photo-copy', masterId: master.id, copyName: 'Warm edit', stackPosition: 1 }
  copy.edits!.basic.exposure = -0.75
  const loose = await photo('photo-loose', 'folder-loose', 'loose.jpg', looseHandle)
  const renamedLoose = await photo('photo-loose-collision', 'folder-loose', 'shot (2).jpg', duplicateHandle)
  loose.stackId = null
  renamedLoose.stackId = null
  renamedLoose.edits = null
  await source.folders.bulkAdd([
    { id: 'folder-shoot', name: 'Shoot', handle: shoot, addedAt: 1, photoCount: 2 },
    { id: 'folder-loose', name: 'Imported Files', handle: null, loose: true, addedAt: 2, photoCount: 2 },
  ])
  await source.photos.bulkAdd([master, copy, loose, renamedLoose])
  await source.collections.bulkAdd([
    { id: 'collection-regular', name: 'Keepers', smart: false, rules: [], match: 'all', photoIds: [master.id, copy.id, loose.id], createdAt: 3, setId: 'set-project' },
    { id: 'collection-smart', name: 'Edited four-star', smart: true, rules: [{ field: 'rating', op: 'gte', value: 4 }, { field: 'edited', op: 'is', value: true }], match: 'all', photoIds: [], createdAt: 4, setId: 'set-project' },
  ])
  const userPreset: Preset = {
    id: 'preset-user', name: 'My exposure', group: 'User Presets', builtin: false,
    sections: ['basic'], paths: ['basic.exposure'], edits: { basic: edits().basic }, createdAt: 5,
  }
  await source.presets.bulkAdd([userPreset, { ...userPreset, id: 'preset-built-in', builtin: true }])
  await source.snapshots.bulkAdd([
    { id: 'snapshot-master', photoId: master.id, name: 'Before warmth', edits: edits(), createdAt: 6 },
    { id: 'snapshot-copy', photoId: copy.id, name: 'Copy state', edits: copy.edits!, createdAt: 7 },
  ])
  await source.settings.add({ key: 'export.destination', value: shoot })

  const archive = await createCatalogArchive(source)
  const json = await archiveBlob(archive).text()
  const roundtrip = parseCatalogArchive(json)
  equal(roundtrip, archive, 'archive JSON round-trips all portable records')
  ok(archive.photos.length === 4 && archive.presets.length === 1 && archive.snapshots.length === 2, 'all catalog tables are covered; built-ins excluded')
  equal(archive.collectionSetIds, ['set-project'], 'collection set identities are retained')
  for (const forbidden of ['fileHandle', 'thumbKey', 'thumbRev', 'proxyKey', 'cacheKey', '"handle"', 'readError', 'export.destination', 'private-original-cache', 'private-proxy-pointer']) {
    ok(!json.includes(forbidden), `no ${forbidden} is serialized`)
  }
  ok(isAiGeometry(master.edits!.masks[0].components[5].geometry) && master.edits!.masks[0].components[5].geometry.cacheKey !== null, 'backup projection leaves original AI cache pointers unchanged')

  const target = fresh()
  const restored = await mergeCatalogArchive(roundtrip, target)
  for (const table of MERGE_TABLES) {
    equal(restored.counts[table], { added: archive[table].length, skipped: 0, conflicts: 0 }, `roundtrip ${table} counts`)
  }
  ok(restored.virtualCopiesAdded === 1 && restored.collectionSetsAdded === 1, 'copy/set counts are accurate')
  equal((await createCatalogArchive(target)).photos, archive.photos, 'restored photos, masks, metadata and edits match')
  equal((await createCatalogArchive(target)).collections, archive.collections, 'collections and rules match')
  equal((await createCatalogArchive(target)).snapshots, archive.snapshots, 'all snapshots and their edits match')
  equal((await createCatalogArchive(target)).presets, archive.presets, 'partial user preset payload matches')
  const restoredCopy = await target.photos.get(copy.id)
  ok(restoredCopy?.masterId === master.id && restoredCopy.edits?.basic.exposure === -0.75, 'virtual copy keeps its own edits and master')
  const restoredAI = restoredCopy?.edits?.masks[0].components[5].geometry
  ok(restoredAI && isAiGeometry(restoredAI) && restoredAI.cacheKey === null, 'detected mask geometry survives without a stale cache pointer')

  const beforeRepeat = await content(target)
  const repeated = await mergeCatalogArchive(roundtrip, target)
  for (const table of MERGE_TABLES) equal(repeated.counts[table], { added: 0, skipped: archive[table].length, conflicts: 0 }, `repeated ${table} is idempotent`)
  equal(await content(target), beforeRepeat, 'repeated import does not change any stored record')

  const currentEdits = edits()
  currentEdits.basic.exposure = 3
  await target.photos.update(master.id, { edits: currentEdits, rating: 5, title: 'Current work' })
  await target.folders.update('folder-shoot', { handle: shoot, photoCount: 50 })
  await target.collections.update('collection-regular', { name: 'Live collection', photoIds: [master.id] })
  await target.presets.update('preset-user', { name: 'Live preset' })
  await target.snapshots.update('snapshot-master', { name: 'Live snapshot', edits: currentEdits })
  const preserved = await content(target)
  const conflict = await mergeCatalogArchive(roundtrip, target)
  equal(await content(target), preserved, 'conflicting existing records and edits are byte-for-byte unchanged')
  ok(conflict.conflicts.length === 5, `exactly five changed records conflict, got ${conflict.conflicts.length}`)
  ok(await (await target.folders.get('folder-shoot'))!.handle!.isSameEntry(shoot), 'existing native folder handle is preserved')
  for (const table of MERGE_TABLES) ok(conflict.counts[table].added === 0 && conflict.counts[table].conflicts === 1, `changed ${table} conflict is accurately counted`)

  const malformed: Array<[string, unknown]> = [
    ['unsupported archive version', { ...archive, version: 2 }],
    ['wrong format', { ...archive, format: 'photos' }],
    ['unknown root field', { ...archive, filesystem: {} }],
    ['missing table', { ...archive, snapshots: undefined }],
    ['duplicate identity', { ...archive, photos: [...archive.photos, archive.photos[0]] }],
    ['missing folder reference', { ...archive, folders: [] }],
    ['missing collection reference', { ...archive, collections: [{ ...archive.collections[0], photoIds: ['missing-photo'] }] }],
    ['missing set reference', { ...archive, collectionSetIds: [] }],
    ['unreferenced set', { ...archive, collectionSetIds: [...archive.collectionSetIds, 'missing-set'] }],
    ['missing snapshot reference', { ...archive, snapshots: [{ ...archive.snapshots[0], photoId: 'missing-photo' }] }],
    ['invalid preset path', { ...archive, presets: [{ ...archive.presets[0], paths: ['basic.__proto__'] }] }],
    ['invalid preset section', { ...archive, presets: [{ ...archive.presets[0], sections: ['masks'] }] }],
    ['invalid numeric rating', { ...archive, photos: archive.photos.map((entry, i) => i ? entry : { ...entry, rating: 6 }) }],
    ['negative file size', { ...archive, photos: archive.photos.map((entry, i) => i ? entry : { ...entry, fileSize: -1 }) }],
    ['non-finite metadata', { ...archive, photos: archive.photos.map((entry, i) => i ? entry : { ...entry, meta: { ...entry.meta, iso: Infinity } }) }],
    ['path traversal', { ...archive, photos: archive.photos.map((entry, i) => i ? entry : { ...entry, relPath: '../shot.jpg' }) }],
    ['serialized handle', { ...archive, folders: archive.folders.map((entry) => ({ ...entry, handle: {} })) }],
    ['serialized cache', { ...archive, photos: archive.photos.map((entry) => ({ ...entry, thumbKey: 'thumb/foreign.jpg' })) }],
    ['missing edit section', { ...archive, photos: archive.photos.map((entry, i) => i ? entry : { ...entry, edits: { ...entry.edits, basic: undefined } }) }],
    ['unsupported edit version', { ...archive, snapshots: archive.snapshots.map((entry) => ({ ...entry, edits: { ...entry.edits, version: 999 } })) }],
    ['non-finite edit', { ...archive, snapshots: archive.snapshots.map((entry) => ({ ...entry, edits: { ...entry.edits, basic: { ...entry.edits.basic, exposure: NaN } } })) }],
    ['invalid crop', { ...archive, snapshots: archive.snapshots.map((entry) => ({ ...entry, edits: { ...entry.edits, crop: { ...entry.edits.crop, right: 0 } } })) }],
    ['duplicate mask component', { ...archive, snapshots: archive.snapshots.map((entry) => ({ ...entry, edits: { ...entry.edits, masks: entry.edits.masks.map((mask) => ({ ...mask, components: [...mask.components, mask.components[0]] })) } })) }],
    ['bad smart operator', { ...archive, collections: [{ ...archive.collections[1], rules: [{ field: 'rating', op: 'execute', value: 3 }] }] }],
    ['incompatible smart value', { ...archive, collections: [{ ...archive.collections[1], rules: [{ field: 'rating', op: 'gte', value: true }] }] }],
    ['serialized AI cache', { ...archive, snapshots: archive.snapshots.map((entry) => ({ ...entry, edits: { ...entry.edits, masks: entry.edits.masks.map((mask) => ({ ...mask, components: mask.components.map((component) => component.geometry.kind === 'aiSubject' ? { ...component, geometry: { ...component.geometry, cacheKey: 'foreign-cache' } } : component) })) } })) }],
    ['unregenerable Sky detection', { ...archive, snapshots: archive.snapshots.map((entry) => ({ ...entry, edits: { ...entry.edits, masks: entry.edits.masks.map((mask) => ({ ...mask, components: mask.components.map((component) => component.geometry.kind === 'aiSubject' ? { ...component, geometry: { ...component.geometry, kind: 'aiSky' } } : component) })) } })) }],
    ['unregenerable Object detection', { ...archive, snapshots: archive.snapshots.map((entry) => ({ ...entry, edits: { ...entry.edits, masks: entry.edits.masks.map((mask) => ({ ...mask, components: mask.components.map((component) => component.geometry.kind === 'aiSubject' ? { ...component, geometry: { ...component.geometry, kind: 'aiObjects' } } : component) })) } })) }],
    ['unsafe loose filename', { ...archive, photos: archive.photos.map((entry) => entry.id === loose.id ? { ...entry, filename: '../loose.jpg' } : entry) }],
    ['virtual copy cycle', { ...archive, photos: archive.photos.map((entry) => entry.id === master.id ? { ...entry, masterId: copy.id } : entry) }],
  ]
  for (const [name, input] of malformed) {
    await rejected(() => mergeCatalogArchive(input, target), `reject ${name}`, true)
    equal(await content(target), preserved, `${name} leaves all existing tables unchanged`)
  }
  await rejected(async () => parseCatalogArchive('{'), 'reject malformed JSON', true)
  const polluted: unknown = JSON.parse(json.replace('"basic":{', '"basic":{"__proto__":{"polluted":true},'))
  await rejected(() => mergeCatalogArchive(polluted, target), 'reject prototype keys', true)

  const failed = fresh()
  await failed.folders.add({ id: 'untouched-folder', name: 'Untouched', handle: null, addedAt: 0, photoCount: 0 })
  const unchanged = await content(failed)
  const failWrite = () => { throw new Error('Injected DB write failure') }
  failed.snapshots.hook('creating', failWrite)
  await rejected(() => mergeCatalogArchive(archive, failed), 'DB failure must reject the entire merge')
  equal(await content(failed), unchanged, 'a late DB failure rolls back folders/photos/collections and preserves prior rows')
  failed.snapshots.hook('creating').unsubscribe(failWrite)

  const alias = fresh()
  await alias.folders.bulkAdd((await source.folders.toArray()).map((folder) => ({ ...folder, handle: null })))
  const existingOriginal = { ...master, id: 'different-existing-id', title: 'Do not touch', edits: currentEdits }
  await alias.photos.add(existingOriginal)
  await alias.presets.add({ ...userPreset, id: 'other-preset-id' })
  const aliasResult = await mergeCatalogArchive(archive, alias)
  ok(aliasResult.counts.photos.added === 3 && aliasResult.counts.photos.conflicts === 1, 'same full folder/path is skipped rather than duplicated')
  equal(portablePhoto((await alias.photos.get(existingOriginal.id))!), portablePhoto(existingOriginal), 'alternate-ID source keeps current edits')
  ok((await alias.photos.get(copy.id))?.masterId === existingOriginal.id, 'virtual copy remaps only to a fully matching source fingerprint')
  ok((await alias.snapshots.get('snapshot-master'))?.photoId === existingOriginal.id, 'snapshot source reference remaps safely')
  ok((await alias.collections.get('collection-regular'))?.photoIds.includes(existingOriginal.id), 'collection source reference remaps safely')
  ok(aliasResult.counts.presets.conflicts === 1 && await alias.presets.count() === 1, 'same preset group/name is not overwritten or duplicated')
  const aliasBefore = await content(alias)
  await mergeCatalogArchive(archive, alias)
  equal(await content(alias), aliasBefore, 'alternate-ID source mapping remains idempotent')

  const wrongIdentity = fresh()
  await wrongIdentity.folders.bulkAdd((await source.folders.toArray()).map((folder) => ({ ...folder, handle: null })))
  await wrongIdentity.photos.add({ ...master, id: 'unrelated-photo', fileSize: master.fileSize + 1 })
  const blocked = await mergeCatalogArchive(archive, wrongIdentity)
  ok(!(await wrongIdentity.photos.get(master.id)) && !(await wrongIdentity.photos.get(copy.id)), 'source mismatch cannot be silently relinked')
  ok(!(await wrongIdentity.collections.get('collection-regular')), 'collection with an unresolved member is skipped whole')
  ok(!(await wrongIdentity.snapshots.get('snapshot-master')), 'snapshot with an unresolved owner is skipped')
  ok(blocked.counts.collections.conflicts === 1 && blocked.counts.snapshots.conflicts === 2, 'dependent conflict counts are complete')

  const changedFolder = fresh()
  await changedFolder.folders.add({ id: 'folder-shoot', name: 'Another folder', handle: files, addedAt: 1, photoCount: 0 })
  const blockedFolder = await mergeCatalogArchive(archive, changedFolder)
  ok(blockedFolder.counts.photos.conflicts === 2 && !(await changedFolder.photos.get(master.id)), 'a conflicting folder cannot silently supply a handle to new photos')
  ok(await (await changedFolder.folders.get('folder-shoot'))!.handle!.isSameEntry(files), 'conflicting folder handle stays untouched')

  const reconnect = fresh()
  await mergeCatalogArchive(archive, reconnect)
  equal((await missingSources(reconnect)).originals.length, 3, 'unconnected master originals are listed once, not virtual copies')
  equal((await missingSources(reconnect)).detectedMasks, 3, 'missing AI coverage is explicitly tracked for current photos')
  const wrongRoot = await inspectFolderReconnection('folder-shoot', files, reconnect)
  ok(wrongRoot.entries.every((entry) => entry.status === 'missing'), 'a matching basename elsewhere is not a relative-path match')
  await rejected(() => commitReconnection(wrongRoot, reconnect), 'unmatched folder cannot be connected')
  ok((await reconnect.folders.get('folder-shoot'))?.handle === null, 'failed folder connection leaves handle null')
  await rejected(() => inspectFolderReconnection('folder-shoot', denied(shoot), reconnect), 'permission denial is surfaced')
  ok((await reconnect.folders.get('folder-shoot'))?.handle === null, 'permission denial does not mutate the folder')
  const folderPlan = await inspectFolderReconnection('folder-shoot', shoot, reconnect)
  ok(folderPlan.entries.every((entry) => entry.status === 'matches'), 'all original folder paths and signatures match')
  ok((await reconnect.folders.get('folder-shoot'))?.handle === null, 'inspection alone does not connect the folder')
  const editsBefore = portablePhoto((await reconnect.photos.get(master.id))!)
  const connectedFolder = await commitReconnection(folderPlan, reconnect)
  equal(connectedFolder, { originals: 1, virtualCopies: 1 }, 'folder connection counts originals and copies')
  equal(portablePhoto((await reconnect.photos.get(master.id))!), editsBefore, 'folder reconnection does not change metadata or edits')
  equal((await missingSources(reconnect)).detectedMasks, 3, 'reconnecting originals does not falsely mark AI coverage recovered')
  ok(await (await reconnect.folders.get('folder-shoot'))!.handle!.isSameEntry(shoot), 'folder connection persists a usable native handle')
  await rejected(() => commitReconnection(folderPlan, reconnect), 'a reviewed connection cannot replace an existing handle')
  await rejected(() => inspectFileReconnection(loose.id, duplicateHandle, reconnect), 'wrong loose file is rejected')
  const filePlan = await inspectFileReconnection(loose.id, looseHandle, reconnect)
  ok(!(await reconnect.photos.get(loose.id))?.fileHandle, 'file inspection alone does not store a handle')
  const looseCopy = { ...(await reconnect.photos.get(loose.id))!, id: 'loose-virtual-copy', masterId: loose.id, copyName: 'Loose copy', edits: currentEdits }
  const connectedCopy = { ...looseCopy, id: 'connected-loose-copy', fileHandle: masterHandle }
  await reconnect.photos.bulkAdd([looseCopy, connectedCopy])
  const connectedFile = await commitReconnection(filePlan, reconnect)
  equal(connectedFile, { originals: 1, virtualCopies: 1 }, 'loose reconnection counts only newly connected copies')
  equal(await (await reconnect.photos.get(loose.id))!.fileHandle!.getFile().then((file) => file.size), loose.fileSize, 'loose original handle is usable after reconnection')
  ok(await (await reconnect.photos.get(looseCopy.id))!.fileHandle!.isSameEntry(looseHandle), 'loose virtual copy gains its original handle')
  equal((await reconnect.photos.get(looseCopy.id))?.edits, currentEdits, 'loose virtual copy keeps its independent edits')
  ok(await (await reconnect.photos.get(connectedCopy.id))!.fileHandle!.isSameEntry(masterHandle), 'already-connected virtual copy handle is never overwritten')
  await rejected(() => commitReconnection(filePlan, reconnect), 'loose reconnection never replaces an existing handle')
  const collisionPlan = await inspectFileReconnection(renamedLoose.id, duplicateHandle, reconnect)
  await commitReconnection(collisionPlan, reconnect)
  ok((await reconnect.photos.get(renamedLoose.id))?.thumbKey === null, 'unedited originals keep a usable standard thumbnail identity, not a missing placeholder')
  equal((await missingSources(reconnect)).originals.length, 0, 'synthetic loose paths still reconnect by their original filename')
  equal(portablePreset((await reconnect.presets.get(userPreset.id))!), archive.presets[0], 'reconnection preserves presets')
  equal(portableSnapshot((await reconnect.snapshots.get('snapshot-master'))!), archive.snapshots.find((entry) => entry.id === 'snapshot-master'), 'reconnection preserves snapshots')

  const stale = fresh()
  await mergeCatalogArchive(archive, stale)
  const stalePlan = await inspectFileReconnection(loose.id, looseHandle, stale)
  await stale.photos.update(loose.id, { fileSize: 999 })
  await rejected(() => commitReconnection(stalePlan, stale), 'catalog identity changes during review abort reconnect')
  ok(!(await stale.photos.get(loose.id))?.fileHandle, 'stale review does not store its handle')

  const changedFile = fresh()
  await mergeCatalogArchive(archive, changedFile)
  const changedFilePlan = await inspectFileReconnection(renamedLoose.id, duplicateHandle, changedFile)
  await writeFile(files, 'shot.jpg', [8, 9, 10])
  await rejected(() => commitReconnection(changedFilePlan, changedFile), 'file mutation during review aborts reconnection')
  ok(!(await changedFile.photos.get(renamedLoose.id))?.fileHandle, 'changed file is not connected')
  reconnect.close()
  await reconnect.open()
  ok(await (await reconnect.folders.get('folder-shoot'))!.handle!.isSameEntry(shoot), 'folder handle survives closing and reopening the database')
  ok(await (await reconnect.photos.get(loose.id))!.fileHandle!.isSameEntry(looseHandle), 'file handle survives closing and reopening the database')

  // Exercise the real Detect cached-result path with synthetic coverage: no
  // model downloads or inference are required by this local regression.
  const recoveryId = `recovery-${crypto.randomUUID()}`
  const recoveryKey = alphaKey(recoveryId, 'aiSubject', 'u2netp')
  const recoveryEdits = structuredClone((await reconnect.photos.get(master.id))!.edits!)
  const recoveryGeometry = recoveryEdits.masks[0].components[5].geometry
  if (!isAiGeometry(recoveryGeometry)) throw new Error('Missing AI fixture')
  const recoveryPhoto: Photo = {
    ...(await reconnect.photos.get(master.id))!, id: recoveryId, masterId: master.id,
    copyName: 'Coverage check', edits: recoveryEdits,
  }
  await reconnect.photos.add(recoveryPhoto)
  const incomplete = (await missingSources(reconnect)).detectedMasks
  try {
    recoveryGeometry.cacheKey = recoveryKey
    await reconnect.photos.update(recoveryId, { edits: recoveryEdits })
    equal((await missingSources(reconnect)).detectedMasks, incomplete, 'a cache pointer alone does not count as successful detection')
    putAlpha(recoveryKey, { size: 2, data: new Float32Array([0, 0.25, 0.75, 1]) })
    ok(await detect({ photoId: recoveryId, kind: 'aiSubject', modelId: 'u2netp' }), 'Detect can load an available coverage result for the restored component')
    ok(detectStatus(recoveryKey).phase === 'ready' && getAlpha(recoveryKey)?.data[2] === 0.75, 'successful Detect makes the actual coverage available to the renderer')
    equal((await missingSources(reconnect)).detectedMasks, incomplete - 1, 'recovery warning clears only when coverage is actually available')
    const recovered = (await reconnect.photos.get(recoveryId))!
    ok(recovered.id === recoveryId && recovered.masterId === master.id && recovered.edits?.basic.exposure === recoveryEdits.basic.exposure, 'coverage recovery retains IDs and unrelated edits')
  } finally {
    dropAlphasFor(recoveryId)
    await cacheDelete(recoveryKey)
    const status = { ...useDetect.getState().status }
    delete status[recoveryKey]
    useDetect.setState({ status })
  }

  // Exercise the real application barrier without writing application records.
  const originalFlush = useDevelop.getState().flush
  const pending: { release?: () => void } = {}
  const gate = new Promise<void>((resolve) => { pending.release = resolve })
  let started = false
  let finished = false
  try {
    useDevelop.setState({ flush: async () => { started = true; await gate } })
    const waiting = flushCatalogEdits(db).then(() => { finished = true })
    await until(() => started, 'backup invokes the durable edit barrier')
    ok(!finished, 'backup waits for in-flight edits rather than only starting the flush')
    pending.release?.()
    await waiting
    ok(finished, 'backup proceeds when edits become durable')
    useDevelop.setState({ flush: async () => { throw new Error('Injected durable save failure') } })
    await rejected(() => flushCatalogEdits(db), 'failed edit flush barrier propagates its rejection')
  } finally {
    pending.release?.()
    useDevelop.setState({ flush: originalFlush })
  }

  await uiChecks(archive)
}

async function uiChecks(archive: CatalogArchive) {
  let closes = 0
  root.render(<SettingsDialog open onClose={() => { closes++ }} />)
  await until(() => !!document.querySelector('#settings-tab-files'), 'settings renders the Files tab')
  document.querySelector<HTMLButtonElement>('#settings-tab-files')?.click()
  await until(() => !!document.querySelector('#catalog-backup-heading'), 'backup controls are integrated in Settings Files')
  const rail = document.querySelector<HTMLElement>('[role="tablist"][aria-label="Settings sections"]')!
  if (rail.scrollWidth > rail.clientWidth) {
    ok(getComputedStyle(rail).overflowX === 'auto', 'narrow settings rail can scroll to every tab')
    document.getElementById('settings-tab-about')?.focus()
    const about = document.getElementById('settings-tab-about')!.getBoundingClientRect()
    const bounds = rail.getBoundingClientRect()
    ok(about.left >= bounds.left && about.right <= bounds.right, 'focusing a clipped settings tab brings it into view')
  }
  document.getElementById('settings-tab-files')?.focus()
  const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === name)
  ok(button('Save backup…') && button('Restore backup…') && button('Reconnect originals…'), 'save, merge restore and reconnect are discoverable')
  ok(document.body.textContent?.includes('XMP sidecars are not a full catalog backup'), 'coverage explicitly distinguishes XMP')
  const importer = useImporter.getState().active
  const exporter = useExport.getState().running
  try {
    useImporter.setState({ active: true })
    await until(() => !!button('Save backup…')?.disabled && !!button('Restore backup…')?.disabled, 'backup and restore are blocked during import')
    useImporter.setState({ active: false })
    useExport.setState({ running: true })
    await until(() => !!button('Reconnect originals…')?.disabled, 'reconnection is blocked during export')
  } finally {
    useImporter.setState({ active: importer })
    useExport.setState({ running: exporter })
  }
  await until(() => !button('Save backup…')?.disabled, 'operations re-enable when background tasks finish')
  const descriptor = Object.getOwnPropertyDescriptor(window, 'showSaveFilePicker')
  const picker: { cancel?: () => void } = {}
  try {
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: () =>
      new Promise<FileSystemFileHandle>((_resolve, reject) => {
        picker.cancel = () => reject(new DOMException('Cancelled', 'AbortError'))
      }),
    })
    button('Save backup…')?.click()
    await until(() => !!document.querySelector<HTMLButtonElement>('#settings-tab-display')?.disabled, 'settings navigation is locked while backup is pending')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    ok(closes === 0, 'Escape cannot dismiss settings during a pending backup')
    picker.cancel?.()
    await until(() => !button('Save backup…')?.disabled, 'cancelled file picker unlocks the UI')
    ok(!document.querySelector('[role="alert"]'), 'picker cancellation is not reported as a failure')
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => {
      throw new DOMException('Permission denied', 'NotAllowedError')
    } })
    button('Save backup…')?.click()
    await until(() => !!document.querySelector('[role="alert"]')?.textContent?.includes('Permission denied'), 'picker permission errors are surfaced rather than treated as cancellation')
  } finally {
    if (descriptor) Object.defineProperty(window, 'showSaveFilePicker', descriptor)
    else Reflect.deleteProperty(window, 'showSaveFilePicker')
  }
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Choose an esque catalog backup"]')!
  const setFile = (text: string) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([text], 'check.esque.json', { type: 'application/json' }))
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  setFile('{')
  await until(() => !!document.querySelector('[role="alert"]')?.textContent?.includes('not valid JSON'), 'invalid backup produces a recoverable inline error')
  setFile(JSON.stringify(archive))
  await until(() => !!document.querySelector('[role="dialog"][aria-label="Restore catalog backup"]'), 'valid backup opens a review before any writes')
  ok(document.body.textContent?.includes('Existing records always win'), 'merge review states non-overwriting behavior')
  ok(document.querySelector('[role="dialog"][aria-label="Restore catalog backup"]')?.textContent?.includes('restored look will be incomplete'), 'restore review explicitly warns that omitted AI coverage changes the look until recovered')
  button('Cancel')?.click()
  await until(() => !document.querySelector('[role="dialog"][aria-label="Restore catalog backup"]'), 'restore review can be cancelled without writes')
}

drive().catch((error: unknown) => {
  failures.push(`Unhandled: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`)
}).finally(async () => {
  const keepUI = new URLSearchParams(window.location.search).has('ui')
  if (!keepUI) root.unmount()
  for (const database of databases) {
    try { await database.delete() } catch (error) { failures.push(`DB cleanup: ${String(error)}`) }
  }
  if (storageRoot && checkRootName) {
    try { await storageRoot.removeEntry(checkRootName, { recursive: true }) } catch (error) { failures.push(`File cleanup: ${String(error)}`) }
  }
  window.__result = { pass: failures.length === 0, assertions, failures }
  window.__done = true
  if (!keepUI) document.getElementById('root')!.textContent = JSON.stringify(window.__result, null, 2)
})
