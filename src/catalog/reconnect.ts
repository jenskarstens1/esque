import { db, type ManagedOriginal } from './db'
import { ensurePermission } from './fs'
import { MISSING_ORIGINAL, type CatalogDatabase } from './archive'
import { parseRelativePath, sameOriginal } from './schema'
import { nextId } from '../lib/math'
import { isAiGeometry, type CatalogFolder, type Photo } from '../core/types'
import { getAlpha } from '../ai/alpha'
import { managedSourceIds, prepareOriginal } from './originals'

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

export interface LocalFileReconnection {
  kind: 'local-file'
  photo: Photo
  file: File
  copies: number
}

export interface LocalFolderReconnection {
  kind: 'local-folder'
  folder: CatalogFolder
  name: string
  entries: Array<Omit<ReconnectionEntry, 'handle'> & { file: File | null }>
}

export type Reconnection = FolderReconnection | FileReconnection | LocalFileReconnection | LocalFolderReconnection

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

function unchangedOriginal(photo: Photo | undefined, checked: Photo): photo is Photo {
  return !!photo && photo.masterId === null && sameOriginal(photo, checked)
}

function permissionFailure(error: unknown) {
  return error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')
}

export async function missingSources(database: CatalogDatabase = db): Promise<MissingSources> {
  return database.transaction('r', [database.photos, database.folders, database.originals], async () => {
    const [photos, folders, managed] = await Promise.all([
      database.photos.toArray(), database.folders.toArray(), managedSourceIds(database),
    ])
    const byId = new Map(folders.map((folder) => [folder.id, folder]))
    const originals = photos.filter((photo) => photo.masterId === null &&
      !photo.fileHandle && !byId.get(photo.folderId)?.handle && !managed.has(photo.id))
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
  if (photo.fileHandle || folder?.handle || await database.originals.get(photo.id)) {
    return fail('This original already has a connection. Existing handles are never replaced.')
  }
  const file = await handle.getFile()
  if (!matchesFile(photo, file)) {
    return fail('This is not a matching original: filename, byte size and modification date must all match the backup. Choose the unchanged original file.')
  }
  const copies = await database.photos.where('masterId').equals(photo.id).toArray()
  return { kind: 'file', photo, handle, copies: copies.filter((copy) => !copy.fileHandle).length }
}

/** Standard file inputs retain original bytes locally, not filesystem access. */
export async function inspectLocalFileReconnection(
  photoId: string,
  file: File,
  database: CatalogDatabase = db,
): Promise<LocalFileReconnection> {
  const photo = await database.photos.get(photoId)
  if (!photo || photo.masterId !== null) return fail('Choose an original, not a virtual copy.')
  const folder = await database.folders.get(photo.folderId)
  if (photo.fileHandle || folder?.handle || await database.originals.get(photo.id)) {
    return fail('This original already has a connection. Existing connections are never replaced.')
  }
  if (!matchesFile(photo, file)) {
    return fail('This is not a matching original: filename, byte size and modification date must all match the backup. Choose the unchanged original file.')
  }
  const copies = await database.photos.where('masterId').equals(photo.id).toArray()
  return { kind: 'local-file', photo, file, copies: copies.filter((copy) => !copy.fileHandle).length }
}

/** Directory inputs include one root segment; match everything below it exactly. */
export async function inspectLocalFolderReconnection(
  folderId: string,
  files: File[],
  database: CatalogDatabase = db,
): Promise<LocalFolderReconnection> {
  const folder = await database.folders.get(folderId)
  if (!folder || folder.loose || folder.handle) {
    return fail('This folder already has a connection or is no longer available. Existing handles are never replaced.')
  }
  const paths = new Map<string, File>()
  let name = ''
  for (const file of files) {
    const parts = parseRelativePath(file.webkitRelativePath, 'Selected folder path').split('/')
    const root = parts.shift()!
    if (!parts.length || (name && root !== name)) return fail('Choose a single original folder root.')
    name = root
    const path = parts.join('/')
    if (paths.has(path)) return fail('The selected folder contains ambiguous duplicate paths.')
    paths.set(path, file)
  }
  if (!name) return fail('The selected folder contains no files.')
  const photos = await database.photos.where('folderId').equals(folderId).toArray()
  const originals = photos.filter((photo) => photo.masterId === null)
  if (!originals.length) return fail('This folder has no originals to reconnect.')
  const entries = originals.map((photo) => {
    const file = paths.get(parseRelativePath(photo.relPath, 'Original path'))
    const matches = !!file && matchesFile(photo, file)
    return {
      photo, file: matches ? file : null,
      status: !file ? 'missing' as const : matches ? 'matches' as const : 'different' as const,
      detail: !file ? 'This exact relative path was not found.' : matches
        ? 'Path, filename, size and modification date match.'
        : 'The file has a different filename, size or modification date.',
    }
  })
  return { kind: 'local-folder', folder, name, entries }
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
  if (plan.kind === 'local-file' || plan.kind === 'local-folder') {
    return commitLocalReconnection(plan, database)
  }
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

  return database.transaction('rw', [database.photos, database.folders, database.originals], async () => {
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
    if (!unchangedOriginal(photo, plan.photo) || photo.fileHandle || folder?.handle || await database.originals.get(photo.id)) {
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

async function commitLocalReconnection(
  plan: LocalFileReconnection | LocalFolderReconnection,
  database: CatalogDatabase,
): Promise<{ originals: number; virtualCopies: number }> {
  const entries = plan.kind === 'local-file'
    ? [{ photo: plan.photo, file: plan.file, status: 'matches' }]
    : plan.entries
  if (!entries.length || entries.some((entry) => entry.status !== 'matches' || !entry.file)) {
    return fail('Not every original matches. Choose the correct folder, or reconnect available originals individually.')
  }
  // Hashing/reading files must finish before opening the IndexedDB transaction.
  const prepared: ManagedOriginal[] = []
  for (const entry of entries) {
    if (!entry.file || !matchesFile(entry.photo, entry.file)) {
      return fail('A file changed since it was checked. Choose it again; no connection was changed.')
    }
    prepared.push(await prepareOriginal(entry.photo.id, entry.file, entry.file.webkitRelativePath || entry.photo.relPath))
  }
  return database.transaction('rw', [database.photos, database.folders, database.originals], async () => {
    if (plan.kind === 'local-folder') {
      const folder = await database.folders.get(plan.folder.id)
      if (!folder || folder.handle || folder.loose || folder.name !== plan.folder.name) {
        return fail('The folder changed while you were reviewing it. Existing connections were left untouched.')
      }
      const originals = (await database.photos.where('folderId').equals(folder.id).toArray())
        .filter((photo) => photo.masterId === null)
      const checked = new Map(entries.map((entry) => [entry.photo.id, entry.photo]))
      if (originals.length !== checked.size || originals.some((photo) =>
        !checked.has(photo.id) || !sameOriginal(photo, checked.get(photo.id)!))) {
        return fail('The catalog changed while you were reviewing it. Check the folder again.')
      }
    }
    const token = nextId()
    let originals = 0
    let virtualCopies = 0
    for (const [index, entry] of entries.entries()) {
      const photo = await database.photos.get(entry.photo.id)
      if (!photo || photo.masterId !== null || !sameOriginal(photo, entry.photo)) {
        return fail('The original changed while you were reviewing it. No connection was changed.')
      }
      const folder = await database.folders.get(photo.folderId)
      const connected = photo.fileHandle || folder?.handle || await database.originals.get(photo.id)
      if (connected) {
        if (plan.kind === 'local-file') {
          return fail('This original was connected while you were reviewing it. No existing connection was replaced.')
        }
        continue
      }
      const copies = await database.photos.where('masterId').equals(photo.id).toArray()
      if (copies.some((copy) => !sameOriginal(copy, photo))) {
        return fail('A virtual copy no longer identifies this original. No connection was changed.')
      }
      await database.originals.add(prepared[index])
      await database.photos.update(photo.id, { ...previewChanges(photo, token), fileHandle: null })
      originals++
      for (const copy of copies) {
        if (copy.fileHandle) continue
        await database.photos.update(copy.id, { ...previewChanges(copy, token), fileHandle: null })
        virtualCopies++
      }
    }
    return { originals, virtualCopies }
  })
}
