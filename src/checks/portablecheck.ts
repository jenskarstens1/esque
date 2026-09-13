import { db } from '../catalog/db'
import { importLocalFiles } from '../catalog/import'
import { localFiles } from '../catalog/fs'
import { loadPhotoFile, managedSidecarText, restoreFile } from '../catalog/originals'
import { loadPhotoFile as activeSource } from '../catalog/previews'
import { cacheDelete } from '../catalog/opfs'
import { readDropSources } from '../state/dropImport'
import { runCheck } from './checkreport'

async function checkStorageFailures(file: File, check: (value: unknown, label: string) => void) {
  const rejectWrite = () => { throw new DOMException('Test storage full', 'QuotaExceededError') }
  db.originals.hook('creating', rejectWrite)
  try {
    let rejected = false
    try {
      await importLocalFiles([{ file, path: 'portable/storage-full.png' }])
    } catch (error) {
      rejected = error instanceof Error && error.message.includes('storage is full')
    }
    check(rejected, 'Storage exhaustion is explicitly reported')
    check(!await db.photos.filter((photo) => photo.relPath === 'portable/storage-full.png').count(),
      'A failed original write cannot leave a source-less photo')
  } finally {
    db.originals.hook('creating').unsubscribe(rejectWrite)
  }
  const countBeforeFailure = await db.originals.count()
  const rejectPhoto = () => { throw new Error('Test photo transaction failure') }
  db.photos.hook('creating', rejectPhoto)
  try {
    const failed = await importLocalFiles([{ file, path: 'portable/failed-photo.png' }])
    check(failed.added === 0 && failed.failed === 1, 'A photo-write failure is reported')
    check(await db.originals.count() === countBeforeFailure, 'Photo-write failure rolls back its original')
  } finally {
    db.photos.hook('creating').unsubscribe(rejectPhoto)
  }
}

runCheck(async () => {
  const failures: string[] = []
  let assertions = 0
  const check = (value: unknown, label: string) => {
    assertions++
    if (!value) failures.push(label)
  }
  const canvas = new OffscreenCanvas(24, 16)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#4080c0'
  ctx.fillRect(0, 0, 24, 16)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const file = new File([blob, new Uint8Array([0])], '__portable_photo.png', { type: 'image/png', lastModified: 123456 })
  const sources = [
    { file, path: 'portable/north/__portable_photo.png' },
    { file, path: 'portable/south/__portable_photo.png' },
    {
      file: new File([
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="4"/></rdf:RDF></x:xmpmeta>',
      ], '__portable_photo.xmp'),
      path: 'portable/north/__portable_photo.xmp',
    },
  ]
  const before = new Set(await db.photos.toCollection().primaryKeys())
  const originalCount = await db.originals.count()
  try {
    const imported = await importLocalFiles(sources)
    check(imported.added === 2 && imported.failed === 0, 'Files import without native handles')
    const photos = (await db.photos.toArray()).filter((photo) => !before.has(photo.id))
    check(photos.length === 2, 'Each relative path has its own photo')
    check(new Set(photos.map((photo) => photo.relPath)).size === 2, 'Nested duplicate basenames keep distinct paths')
    check(photos.every((photo) => !photo.fileHandle), 'No synthetic file handles enter the database')
    check(await db.originals.count() === originalCount + 2, 'Originals are durable catalog records')
    const north = photos.find((photo) => photo.relPath.includes('/north/'))!
    check(north.rating === 4, 'Portable sidecars apply on import')
    check((await managedSidecarText(north))?.includes('xmp:Rating="4"'), 'Sidecars remain available for later reads')
    const source = await loadPhotoFile(north)
    check(source?.name === file.name && source.lastModified === file.lastModified, 'File metadata survives storage')
    check(source?.size === file.size && (await activeSource(north.id))?.size === file.size,
      'The active Develop/export source reader uses managed originals')
    check(await restoreFile({
      blob: new Blob(['legacy bytes']), name: 'legacy.txt', type: 'text/plain', lastModified: 12,
    }).text() === 'legacy bytes', 'Historical Blob-backed originals remain readable')
    const repeated = await importLocalFiles(sources)
    check(repeated.added === 0 && repeated.skipped === 2, 'Reimport deduplicates by path and original bytes')

    const changed = new File([blob, new Uint8Array([1])], file.name, { type: file.type, lastModified: file.lastModified })
    const collision = await importLocalFiles([{ file: changed, path: sources[0].path }])
    check(collision.added === 1 && collision.skipped === 0, 'Changed original bytes never overwrite existing edits')
    const paths = (await db.photos.toArray()).filter((photo) => !before.has(photo.id)).map((photo) => photo.relPath)
    check(new Set(paths).size === 3, 'Filename collisions get distinct catalog paths')
    if (north.thumbKey) await cacheDelete(north.thumbKey)
    check((await loadPhotoFile(north))?.size === file.size, 'Preview eviction never deletes the original')
    const copyId = crypto.randomUUID()
    await db.photos.add({ ...north, id: copyId, masterId: north.id })
    check((await activeSource(copyId))?.size === file.size, 'Virtual copies resolve their managed master')

    const transfer = new DataTransfer()
    transfer.items.add(file)
    const dropped = await readDropSources(transfer)
    check(dropped.handles.length === 0 && dropped.files[0]?.file.name === file.name,
      'Standard File drops work without native handles')
    check(localFiles([file])[0].path === file.name, 'Loose input files retain their filename')
    const directoryTransfer = new DataTransfer()
    const item = directoryTransfer.items.add(file)!
    Object.defineProperty(directoryTransfer, 'items', { value: [item] })
    Object.defineProperty(item, 'getAsFileSystemHandle', { value: undefined })
    Object.defineProperty(item, 'webkitGetAsEntry', {
      value: () => ({
        name: 'dropped-folder', isDirectory: true, isFile: false,
        createReader: () => {
          let batch = 0
          return {
            readEntries: (resolve: (entries: unknown[]) => void) => {
              batch++
              resolve(batch <= 2 ? [{
                name: `${batch}.png`, isFile: true, isDirectory: false,
                file: (receive: (value: File) => void) => receive(file),
              }] : [])
            },
          }
        },
      }),
    })
    const directoryDrop = await readDropSources(directoryTransfer)
    check(directoryDrop.files.map((entry) => entry.path).join(',') === 'dropped-folder/1.png,dropped-folder/2.png',
      'Legacy directory drops preserve paths and drain every entry batch')
    const fileTransfer = new DataTransfer()
    const fileItem = fileTransfer.items.add(file)!
    Object.defineProperty(fileTransfer, 'items', { value: [fileItem] })
    Object.defineProperty(fileItem, 'getAsFileSystemHandle', { value: undefined })
    Object.defineProperty(fileItem, 'webkitGetAsEntry', {
      value: () => ({
        name: file.name, isDirectory: false, isFile: true,
        file: () => { throw new Error('Path does not exist') },
      }),
    })
    check((await readDropSources(fileTransfer)).files[0]?.file.name === file.name,
      'Captured files do not depend on a readable legacy filesystem entry')

    const controller = new AbortController()
    controller.abort()
    const cancelled = await importLocalFiles([{ file, path: 'portable/cancelled.png' }], { signal: controller.signal })
    check(cancelled.added === 0, 'Cancellation does not publish an unavailable source')

    await checkStorageFailures(file, check)
  } finally {
    const created = (await db.photos.toArray()).filter((photo) => !before.has(photo.id))
    for (const photo of created) if (photo.thumbKey) await cacheDelete(photo.thumbKey)
    await db.transaction('rw', [db.photos, db.originals], async () => {
      await db.photos.bulkDelete(created.map((photo) => photo.id))
      await db.originals.bulkDelete(created.map((photo) => photo.id))
    })
  }
  return { ok: failures.length === 0, assertions, failures }
})
