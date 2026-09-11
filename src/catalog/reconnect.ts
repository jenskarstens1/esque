import { db } from './db'
import { ensurePermission } from './fs'
import { MISSING_ORIGINAL, type CatalogDatabase } from './archive'
import { parseRelativePath, sameOriginal } from './schema'
import { nextId } from '../lib/math'
import { isAiGeometry, type CatalogFolder, type Photo } from '../core/types'
import { getAlpha } from '../ai/alpha'

export interface MissingSources {
  folders: Array<{ folder: CatalogFolder; originals: Photo[] }>
  originals: Photo[]
  folderNames: Map<string, string>
  /** Current photo components whose coverage is not available to the renderer. */
  detectedMasks: number
}

export interface ReconnectionEntry {
  photo: Photo
  handle: FileSystemFileHandle | null
  status: 'matches' | 'missing' | 'different'
  detail: string
}

export interface FolderReconnection {
  kind: 'folder'
  folder: CatalogFolder
  handle: FileSystemDirectoryHandle
  entries: ReconnectionEntry[]
}

export interface FileReconnection {
  kind: 'file'
  photo: Photo
  handle: FileSystemFileHandle
  copies: number
}

export type Reconnection = FolderReconnection | FileReconnection

function fail(message: string): never {
  throw new Error(message)
}

async function requireRead(handle: FileSystemHandle) {
  if (!await ensurePermission(handle, 'read')) {
    fail('Read permission was denied. Choose the original again and allow read access; no connection was changed.')
  }
}

function matchesFile(photo: Photo, file: File) {
  return file.name === photo.filename && file.size === photo.fileSize && file.lastModified === photo.modifiedAt
}

function permissionFailure(error: unknown) {
  return error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')
}

export async function missingSources(database: CatalogDatabase = db): Promise<MissingSources> {
  return database.transaction('r', [database.photos, database.folders], async () => {
    const [photos, folders] = await Promise.all([database.photos.toArray(), database.folders.toArray()])
    const byId = new Map(folders.map((folder) => [folder.id, folder]))
    const originals = photos.filter((photo) => photo.masterId === null &&
      !photo.fileHandle && !byId.get(photo.folderId)?.handle)
    const grouped = new Map<string, Photo[]>()
    for (const photo of originals) {
      const group = grouped.get(photo.folderId)
      if (group) group.push(photo)
      else grouped.set(photo.folderId, [photo])
    }
    return {
      originals,
      folderNames: new Map(folders.map((folder) => [folder.id, folder.name])),
      detectedMasks: photos.reduce((count, photo) => count +
        (photo.edits?.layers ?? []).reduce((sum, mask) => sum + mask.components.filter((component) =>
          isAiGeometry(component.geometry) &&
          (!component.geometry.cacheKey || !getAlpha(component.geometry.cacheKey)),
        ).length, 0), 0),
      folders: folders.filter((folder) => !folder.loose && !folder.handle)
        .map((folder) => ({ folder, originals: grouped.get(folder.id) ?? [] }))
        .filter((group) => group.originals.length > 0),
    }
  })
}

/** Looks up full stored relative paths, never a scan or a basename search. */
export async function inspectFolderReconnection(
  folderId: string,
  handle: FileSystemDirectoryHandle,
  database: CatalogDatabase = db,
): Promise<FolderReconnection> {
  await requireRead(handle)
  const folder = await database.folders.get(folderId)
  if (!folder || folder.loose || folder.handle) {
    return fail('This folder already has a connection or is no longer available. Existing handles are never replaced.')
  }
  const photos = await database.photos.where('folderId').equals(folderId).toArray()
  const originals = photos.filter((photo) => photo.masterId === null)
  if (!originals.length) return fail('This folder has no originals to reconnect.')
  const entries: ReconnectionEntry[] = []
  for (const photo of originals) {
    const parts = parseRelativePath(photo.relPath, 'Original path').split('/')
    const name = parts.pop()!
    try {
      let directory = handle
      for (const part of parts) directory = await directory.getDirectoryHandle(part)
      const fileHandle = await directory.getFileHandle(name)
      const file = await fileHandle.getFile()
      const matches = matchesFile(photo, file)
      entries.push({
        photo, handle: matches ? fileHandle : null,
        status: matches ? 'matches' : 'different',
        detail: matches ? 'Path, filename, size and modification date match.' : 'The file has a different size or modification date.',
      })
    } catch (error) {
      if (permissionFailure(error)) {
        return fail('Read access to this folder was refused. Choose it again and allow access; no connection was changed.')
      }
      if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error
      entries.push({ photo, handle: null, status: 'missing', detail: 'This exact relative path was not found.' })
    }
  }
  return { kind: 'folder', folder, handle, entries }
}

export async function inspectFileReconnection(
  photoId: string,
  handle: FileSystemFileHandle,
  database: CatalogDatabase = db,
): Promise<FileReconnection> {
  await requireRead(handle)
  const photo = await database.photos.get(photoId)
  if (!photo || photo.masterId !== null) return fail('Choose an original, not a virtual copy.')
  const folder = await database.folders.get(photo.folderId)
  if (photo.fileHandle || folder?.handle) {
    return fail('This original already has a connection. Existing handles are never replaced.')
  }
  const file = await handle.getFile()
  if (!matchesFile(photo, file)) {
    return fail('This is not a matching original: filename, byte size and modification date must all match the backup. Choose the unchanged original file.')
  }
  const copies = await database.photos.where('masterId').equals(photo.id).toArray()
  return { kind: 'file', photo, handle, copies: copies.filter((copy) => !copy.fileHandle).length }
}

function previewChanges(photo: Photo, token: string): Partial<Photo> {
  return {
    // Edited thumbnails get a fresh render identity. Untouched photos must
    // keep the ordinary import key: ensureThumb may reuse that cached image
    // without updating the row, so a placeholder key would strand the cell.
    thumbKey: photo.edits ? `thumb/${photo.id}.reconnect-${token}.jpg` : null,
    thumbRev: photo.edits ? Math.max(1, photo.thumbRev ?? 0) : 0,
    ...(photo.readError === MISSING_ORIGINAL ? { readError: null } : {}),
  }
}

/** The second, explicit confirmation is the only step that persists a handle. */
export async function commitReconnection(
  plan: Reconnection,
  database: CatalogDatabase = db,
): Promise<{ originals: number; virtualCopies: number }> {
  await requireRead(plan.handle)
  if (plan.kind === 'folder') {
    if (!plan.entries.length || plan.entries.some((entry) => entry.status !== 'matches' || !entry.handle)) {
      return fail('Not every original matches. Choose the correct folder, or reconnect available originals individually.')
    }
    for (const entry of plan.entries) {
      if (!entry.handle || !matchesFile(entry.photo, await entry.handle.getFile())) {
        return fail('A file changed since it was checked. Check the folder again; no connection was changed.')
      }
    }
  } else if (!matchesFile(plan.photo, await plan.handle.getFile())) {
    return fail('The file changed since it was checked. Choose it again; no connection was changed.')
  }

  return database.transaction('rw', [database.photos, database.folders], async () => {
    const token = nextId()
    if (plan.kind === 'folder') {
      const folder = await database.folders.get(plan.folder.id)
      if (!folder || folder.handle || folder.loose || folder.name !== plan.folder.name) {
        return fail('The folder changed while you were reviewing it. Existing connections were left untouched.')
      }
      const photos = await database.photos.where('folderId').equals(folder.id).toArray()
      const originals = photos.filter((photo) => photo.masterId === null)
      const checked = new Map(plan.entries.map((entry) => [entry.photo.id, entry.photo]))
      if (originals.length !== checked.size ||
        originals.some((photo) => !checked.has(photo.id) || !sameOriginal(photo, checked.get(photo.id)!))) {
        return fail('The catalog changed while you were reviewing it. Check the folder again.')
      }
      await database.folders.update(folder.id, { handle: plan.handle })
      for (const photo of photos) {
        if (!photo.fileHandle) await database.photos.update(photo.id, previewChanges(photo, token))
      }
      return {
        originals: originals.filter((photo) => !photo.fileHandle).length,
        virtualCopies: photos.filter((photo) => photo.masterId !== null && !photo.fileHandle).length,
      }
    }

    const photo = await database.photos.get(plan.photo.id)
    const folder = photo ? await database.folders.get(photo.folderId) : undefined
    if (!photo || photo.fileHandle || folder?.handle || photo.masterId !== null || !sameOriginal(photo, plan.photo)) {
      return fail('The original changed or was connected while you were reviewing it. No existing connection was replaced.')
    }
    const copies = await database.photos.where('masterId').equals(photo.id).toArray()
    if (copies.some((copy) => !sameOriginal(copy, photo))) {
      return fail('A virtual copy no longer identifies this original. No connection was changed.')
    }
    await database.photos.update(photo.id, { ...previewChanges(photo, token), fileHandle: plan.handle })
    let virtualCopies = 0
    for (const copy of copies) {
      if (copy.fileHandle) continue
      await database.photos.update(copy.id, { ...previewChanges(copy, token), fileHandle: plan.handle })
      virtualCopies++
    }
    return { originals: 1, virtualCopies }
  })
}
