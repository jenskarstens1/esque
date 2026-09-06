import { db, type ManagedOriginal, type StoredFile } from './db'
import { resolveFile } from './fs'
import type { Photo } from '../core/types'

export type SourceDatabase = Pick<typeof db, 'photos' | 'folders' | 'originals'>
export const originalId = (photo: Pick<Photo, 'id' | 'masterId'>) => photo.masterId ?? photo.id

export const storeFile = (file: File): StoredFile => ({
  blob: file.slice(0, file.size, file.type),
  name: file.name,
  type: file.type,
  lastModified: file.lastModified,
})

export const restoreFile = (stored: StoredFile): File =>
  new File([stored.blob], stored.name, { type: stored.type, lastModified: stored.lastModified })

export async function prepareOriginal(
  id: string,
  file: File,
  importPath = file.webkitRelativePath || file.name,
  sidecar?: File,
): Promise<ManagedOriginal> {
  const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return {
    ...storeFile(file), id, digest, importPath,
    identity: JSON.stringify([importPath, file.name, file.size, file.lastModified, digest]),
    ...(sidecar ? { sidecar: storeFile(sidecar) } : {}),
  }
}

/**
 * One original reader for previews, Develop and exports. Native connections
 * stay authoritative; a virtual copy without its own handle uses its master.
 */
export async function loadPhotoFile(
  photoOrId: Photo | string,
  database: SourceDatabase = db,
): Promise<File | null> {
  const photo = typeof photoOrId === 'string' ? await database.photos.get(photoOrId) : photoOrId
  if (!photo) return null
  if (photo.fileHandle) {
    try {
      return await photo.fileHandle.getFile()
    } catch {
      return null
    }
  }
  const sourceId = originalId(photo)
  const master = photo.masterId ? await database.photos.get(sourceId) : photo
  if (master?.fileHandle) {
    try {
      return await master.fileHandle.getFile()
    } catch {
      return null
    }
  }
  const source = master ?? photo
  const managed = await database.originals.get(sourceId)
  if (managed) return restoreFile(managed)
  const folder = await database.folders.get(source.folderId)
  return folder?.handle ? resolveFile(folder.handle, source.relPath) : null
}

export async function managedSidecarText(photo: Photo, database: SourceDatabase = db): Promise<string | null> {
  const source = await database.originals.get(originalId(photo))
  return source?.sidecar ? source.sidecar.blob.text() : null
}

/** Uses the key index; source lists must not read gigabytes of original blobs. */
export async function managedSourceIds(database: Pick<SourceDatabase, 'originals'> = db): Promise<Set<string>> {
  return new Set(await database.originals.toCollection().primaryKeys())
}
