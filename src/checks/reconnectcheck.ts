import { EsqueDB } from '../catalog/db'
import { removePhotos } from '../catalog/actions'
import { MISSING_ORIGINAL, portablePhoto } from '../catalog/archive'
import { loadPhotoFile } from '../catalog/originals'
import {
  commitReconnection, inspectLocalFileReconnection, inspectLocalFolderReconnection, missingSources,
} from '../catalog/reconnect'
import { defaultEdits } from '../core/defaults'
import type { Photo } from '../core/types'

const database = new EsqueDB(`esque-reconnect-check-${crypto.randomUUID()}`)
const failures: string[] = []
let assertions = 0
function ok(condition: unknown, label: string) {
  assertions++
  if (!condition) failures.push(label)
}
async function rejects(action: () => Promise<unknown>, label: string) {
  try { await action(); ok(false, label) } catch { ok(true, label) }
}
function original(path: string, filename = 'shot.jpg', bytes = 'original'): File {
  const file = new File([bytes], filename, { type: 'image/jpeg', lastModified: 1_700_000_000_000 })
  Object.defineProperty(file, 'webkitRelativePath', { value: path })
  return file
}
const file = original('Shoot/Day 1/shot.jpg')
function photo(id: string, relPath = 'Day 1/shot.jpg'): Photo {
  return {
    id, folderId: 'shoot', relPath, filename: file.name, ext: 'jpg', isRaw: false,
    fileSize: file.size, modifiedAt: file.lastModified, addedAt: 1,
    width: 1, height: 1, rating: 4, flag: 'pick', label: 'green',
    keywords: ['test'], title: 'Kept title', caption: '', edits: defaultEdits('rendered'),
    thumbKey: null, proxyKey: null, masterId: null, copyName: null,
    stackId: null, stackPosition: 0, stackCollapsed: false, readError: MISSING_ORIGINAL,
    fileHandle: null,
    meta: {
      cameraMake: '', cameraModel: '', lens: '', iso: 100, shutter: 0, aperture: 0,
      focalLength: 0, captureTime: null, artist: '', copyright: '', gps: null,
      flip: 0, camMul: null, preMul: null, camXyz: null, black: null, maximum: null,
    },
  }
}

async function run() {
  await database.folders.add({ id: 'shoot', name: 'Shoot', handle: null, addedAt: 1, photoCount: 3 })
  const master = photo(crypto.randomUUID())
  const copy = { ...photo(crypto.randomUUID()), masterId: master.id, copyName: 'Copy' }
  copy.edits!.basic.exposure = 1.5
  await database.photos.bulkAdd([master, copy])
  ok((await missingSources(database)).originals.length === 1, 'missing list excludes virtual copies')
  for (const mismatch of [
    original('', 'wrong.jpg'),
    original('', file.name, 'short'),
    new File(['original'], file.name, { lastModified: file.lastModified + 1 }),
  ]) {
    await rejects(() => inspectLocalFileReconnection(master.id, mismatch, database), 'mismatching file is rejected')
  }
  ok(await database.originals.count() === 0, 'mismatch never stores bytes')
  await rejects(() => inspectLocalFileReconnection(copy.id, file, database), 'copy cannot be reconnected as an original')
  const plan = await inspectLocalFileReconnection(master.id, file, database)
  ok(await database.originals.count() === 0, 'inspection does not persist')
  const before = JSON.stringify(portablePhoto(master))
  const result = await commitReconnection(plan, database)
  ok(result.originals === 1 && result.virtualCopies === 1, 'managed reconnection counts master and copy')
  ok(JSON.stringify(portablePhoto((await database.photos.get(master.id))!)) === before, 'metadata and edits are preserved')
  ok((await database.photos.get(copy.id))?.edits?.basic.exposure === 1.5, 'independent copy edits are preserved')
  ok((await database.photos.get(master.id))?.readError === null, 'missing-original error clears')
  ok((await missingSources(database)).originals.length === 0, 'managed original is no longer listed missing')
  await rejects(() => commitReconnection(plan, database), 'stale confirmation cannot overwrite managed bytes')
  database.close()
  await database.open()
  const restored = await loadPhotoFile(master.id, database)
  ok(await restored?.text() === 'original' && restored?.lastModified === file.lastModified, 'original bytes and metadata survive DB reopen')
  ok(await (await loadPhotoFile(copy.id, database))?.text() === 'original', 'virtual copy reads persisted master bytes')

  const second = photo(crypto.randomUUID(), 'Day 2/shot.jpg')
  await database.photos.add(second)
  const partial = await inspectLocalFolderReconnection('shoot', [file], database)
  ok(partial.entries.some((entry) => entry.photo.id === second.id && entry.status === 'missing'), 'same basename at wrong relative path is missing')
  await rejects(() => commitReconnection(partial, database), 'partial folder is rejected atomically')
  const wrong = await inspectLocalFolderReconnection('shoot', [file, original('Shoot/Day 2/shot.jpg', 'shot.jpg', 'wrong')], database)
  ok(wrong.entries.some((entry) => entry.status === 'different'), 'folder metadata mismatch is reported')
  await rejects(() => commitReconnection(wrong, database), 'mismatched folder cannot commit')
  const full = await inspectLocalFolderReconnection('shoot', [file, original('Shoot/Day 2/shot.jpg')], database)
  const connected = await commitReconnection(full, database)
  ok(connected.originals === 1 && await database.originals.count() === 2, 'folder reconnect preserves connected originals and adds missing ones')
  ok((await database.originals.get(second.id))?.importPath === 'Shoot/Day 2/shot.jpg', 'managed folder stores full import path')
  ok((await missingSources(database)).folders.length === 0, 'fully managed folder is not offered as missing')

  const stale = photo(crypto.randomUUID())
  await database.photos.add(stale)
  const stalePlan = await inspectLocalFileReconnection(stale.id, file, database)
  await database.photos.update(stale.id, { fileSize: 500 })
  await rejects(() => commitReconnection(stalePlan, database), 'catalog identity changed during review is rejected')
  ok(!await database.originals.get(stale.id), 'stale rejection leaves no original blob')

  const atomic = photo(crypto.randomUUID())
  const badCopy = { ...photo(crypto.randomUUID()), masterId: atomic.id, fileSize: 500 }
  await database.photos.bulkAdd([atomic, badCopy])
  const atomicPlan = await inspectLocalFileReconnection(atomic.id, file, database)
  await rejects(() => commitReconnection(atomicPlan, database), 'inconsistent copy rejects managed reconnection')
  ok(!await database.originals.get(atomic.id), 'copy validation failure leaves no blob')
  const quotaFolder = { id: 'quota-folder', name: 'Quota', handle: null, addedAt: 1, photoCount: 2 }
  await database.folders.add(quotaFolder)
  const quotaPhotos = ['one', 'two'].map((name) => ({
    ...photo(crypto.randomUUID(), `${name}/shot.jpg`), folderId: quotaFolder.id,
  }))
  await database.photos.bulkAdd(quotaPhotos)
  const quotaPlan = await inspectLocalFolderReconnection(quotaFolder.id, [
    original('Quota/one/shot.jpg'), original('Quota/two/shot.jpg'),
  ], database)
  let writes = 0
  const quotaFailure = () => {
    if (++writes === 2) throw new DOMException('Injected quota failure', 'QuotaExceededError')
  }
  database.originals.hook('creating', quotaFailure)
  try {
    await rejects(() => commitReconnection(quotaPlan, database), 'storage failure during a folder commit is surfaced')
  } finally {
    database.originals.hook('creating').unsubscribe(quotaFailure)
  }
  ok((await database.originals.bulkGet(quotaPhotos.map((entry) => entry.id))).every((entry) => !entry),
    'storage failure rolls back even previously added folder blobs')
  ok((await database.photos.bulkGet(quotaPhotos.map((entry) => entry.id))).every((entry) => entry?.readError === MISSING_ORIGINAL),
    'storage failure rolls back photo source and preview changes')
  await database.collections.add({
    id: 'collection', name: 'Kept', smart: false, rules: [], match: 'all',
    photoIds: [master.id, copy.id, second.id], createdAt: 1, setId: null,
  })
  await removePhotos(copy.id, database)
  ok(!!await database.originals.get(master.id), 'deleting only a copy preserves original bytes')
  await database.photos.add(copy)
  const failDeletion = () => { throw new Error('Injected photo deletion failure') }
  database.photos.hook('deleting', failDeletion)
  try {
    await rejects(() => removePhotos(master.id, database), 'photo deletion failure is propagated')
  } finally {
    database.photos.hook('deleting').unsubscribe(failDeletion)
  }
  ok(!!await database.photos.get(master.id) && !!await database.originals.get(master.id), 'failed deletion rolls back original-byte deletion')
  await removePhotos(master.id, database)
  ok(!await database.photos.get(master.id) && !await database.photos.get(copy.id), 'deleting master removes its dependents')
  ok(!await database.originals.get(master.id) && !!await database.originals.get(second.id), 'deleting master removes only its managed original')
  ok(JSON.stringify((await database.collections.get('collection'))?.photoIds) === JSON.stringify([second.id]), 'deletion cleans collection membership')
}

void run().catch((error: unknown) => failures.push(String(error))).finally(async () => {
  await database.delete()
  const result = { pass: failures.length === 0, assertions, failures }
  Object.assign(window, { __done: true, __result: result })
  document.getElementById('root')!.textContent = JSON.stringify(result, null, 2)
})
