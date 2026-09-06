import { db } from './db'
import {
  catalogTables, flushCatalogEdits, localEdits, localPhoto, localPreset,
  portableFolder, portablePhoto, portablePreset, portableSnapshot,
  type CatalogDatabase,
} from './archive'
import {
  sameOriginal, validateCatalogArchive,
  type PortablePhoto,
} from './schema'
import type { Photo } from '../core/types'
import { BUILTIN_PRESETS } from '../develop/presets'

export const MERGE_TABLES = ['photos', 'folders', 'collections', 'presets', 'snapshots'] as const
export type MergeTable = typeof MERGE_TABLES[number]
export interface MergeCount {
  added: number
  skipped: number
  conflicts: number
}
export interface MergeConflict {
  table: MergeTable
  id: string
  name: string
  reason: string
}
export interface MergeResult {
  counts: Record<MergeTable, MergeCount>
  conflicts: MergeConflict[]
  addedPhotoIds: string[]
  virtualCopiesAdded: number
  collectionSetsAdded: number
}

/** Object member order does not turn an unchanged record into a conflict. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b)
const sourceKey = (photo: Pick<Photo, 'folderId' | 'relPath'>) =>
  JSON.stringify([photo.folderId, photo.relPath])

/**
 * Never puts/updates an existing record. The entire untrusted graph is parsed
 * first; every conflict decision and every add then shares one transaction.
 */
export async function mergeCatalogArchive(
  input: unknown,
  database: CatalogDatabase = db,
): Promise<MergeResult> {
  const archive = validateCatalogArchive(input)
  await flushCatalogEdits(database)
  return database.transaction('rw', catalogTables(database), async () => {
    const [oldPhotos, oldFolders, oldCollections, oldPresets, oldSnapshots] = await Promise.all([
      database.photos.toArray(), database.folders.toArray(), database.collections.toArray(),
      database.presets.toArray(), database.snapshots.toArray(),
    ])
    const result: MergeResult = {
      counts: {
        photos: { added: 0, skipped: 0, conflicts: 0 },
        folders: { added: 0, skipped: 0, conflicts: 0 },
        collections: { added: 0, skipped: 0, conflicts: 0 },
        presets: { added: 0, skipped: 0, conflicts: 0 },
        snapshots: { added: 0, skipped: 0, conflicts: 0 },
      },
      conflicts: [], addedPhotoIds: [], virtualCopiesAdded: 0, collectionSetsAdded: 0,
    }
    const skip = (table: MergeTable, record: { id: string }, name: string, reason?: string) => {
      result.counts[table].skipped++
      if (reason) {
        result.counts[table].conflicts++
        result.conflicts.push({ table, id: record.id, name, reason })
      }
    }

    const folders = new Map(oldFolders.map((folder) => [folder.id, folder]))
    const usableFolders = new Set<string>()
    for (const folder of archive.folders) {
      const existing = folders.get(folder.id)
      if (existing) {
        skip('folders', folder, folder.name, same(portableFolder(existing), folder)
          ? undefined : 'An existing folder with this ID was kept unchanged.')
        // A renamed/different folder may point somewhere else. Do not silently
        // make new records resolve against that existing handle.
        if (existing.name === folder.name && existing.addedAt === folder.addedAt &&
          !!existing.loose === !!folder.loose) usableFolders.add(folder.id)
      } else {
        const restored = { ...folder, handle: null }
        await database.folders.add(restored)
        folders.set(folder.id, restored)
        usableFolders.add(folder.id)
        result.counts.folders.added++
      }
    }

    const photos = new Map(oldPhotos.map((photo) => [photo.id, photo]))
    const originals = new Map<string, Photo[]>()
    for (const photo of oldPhotos) {
      if (photo.masterId === null) {
        const key = sourceKey(photo)
        originals.set(key, [...(originals.get(key) ?? []), photo])
      }
    }
    const photoIds = new Map<string, string>()
    const acceptPhoto = async (incoming: PortablePhoto) => {
      const masterId = incoming.masterId === null ? null : photoIds.get(incoming.masterId)
      const mapped = { ...incoming, masterId: masterId ?? null }
      const existing = photos.get(incoming.id)
      if (existing) {
        skip('photos', incoming, incoming.filename, same(portablePhoto(existing), mapped)
          ? undefined : 'The existing photo, metadata and edits were kept unchanged.')
        if (sameOriginal(existing, incoming) &&
          existing.masterId === mapped.masterId && (incoming.masterId === null || masterId)) {
          photoIds.set(incoming.id, existing.id)
        }
        return
      }
      if (!usableFolders.has(incoming.folderId)) {
        skip('photos', incoming, incoming.filename, 'Its folder ID conflicts with a different existing folder.')
        return
      }
      if (incoming.masterId !== null && !masterId) {
        skip('photos', incoming, incoming.filename, 'Its original could not be merged safely.')
        return
      }
      if (incoming.masterId === null) {
        const matches = originals.get(sourceKey(incoming)) ?? []
        if (matches.length) {
          skip('photos', incoming, incoming.filename, 'This full folder/path is already catalogued under another ID.')
          if (matches.length === 1 && sameOriginal(matches[0], incoming)) {
            photoIds.set(incoming.id, matches[0].id)
          }
          return
        }
      }
      const restored = localPhoto(mapped)
      if (folders.get(incoming.folderId)?.handle) restored.readError = null
      await database.photos.add(restored)
      photos.set(restored.id, restored)
      photoIds.set(incoming.id, restored.id)
      if (incoming.masterId === null) originals.set(sourceKey(incoming), [restored])
      result.counts.photos.added++
      result.addedPhotoIds.push(restored.id)
      if (restored.masterId !== null) result.virtualCopiesAdded++
    }
    for (const photo of archive.photos) if (photo.masterId === null) await acceptPhoto(photo)
    for (const photo of archive.photos) if (photo.masterId !== null) await acceptPhoto(photo)

    const collections = new Map(oldCollections.map((collection) => [collection.id, collection]))
    const existingSets = new Set(oldCollections.flatMap((collection) => collection.setId ? [collection.setId] : []))
    const addedSets = new Set<string>()
    for (const collection of archive.collections) {
      const mappedIds = collection.photoIds.map((photoId) => photoIds.get(photoId))
      const missing = mappedIds.some((photoId) => photoId === undefined)
      const restored = { ...collection, photoIds: [...new Set(mappedIds.filter((photoId) => photoId !== undefined))] }
      const existing = collections.get(collection.id)
      if (existing) {
        skip('collections', collection, collection.name, !missing && same(existing, restored)
          ? undefined : 'The existing collection and its membership were kept unchanged.')
      } else if (missing) {
        skip('collections', collection, collection.name, 'At least one member photo conflicts; the collection was not partially restored.')
      } else {
        await database.collections.add(restored)
        result.counts.collections.added++
        if (collection.setId && !existingSets.has(collection.setId)) addedSets.add(collection.setId)
      }
    }
    result.collectionSetsAdded = addedSets.size

    const snapshots = new Map(oldSnapshots.map((snapshot) => [snapshot.id, snapshot]))
    for (const snapshot of archive.snapshots) {
      const photoId = photoIds.get(snapshot.photoId)
      const existing = snapshots.get(snapshot.id)
      if (existing) {
        skip('snapshots', snapshot, snapshot.name, photoId && same(portableSnapshot(existing), { ...snapshot, photoId })
          ? undefined : 'The existing snapshot was kept unchanged.')
      } else if (!photoId) {
        skip('snapshots', snapshot, snapshot.name, 'Its photo could not be merged safely.')
      } else {
        await database.snapshots.add({ ...snapshot, photoId, edits: localEdits(snapshot.edits) })
        result.counts.snapshots.added++
      }
    }

    const presets = new Map(oldPresets.map((preset) => [preset.id, preset]))
    const presetNames = new Set(oldPresets.map((preset) => JSON.stringify([preset.group.toLowerCase(), preset.name.toLowerCase()])))
    const builtins = new Set(BUILTIN_PRESETS.map((preset) => preset.id))
    for (const preset of archive.presets) {
      const existing = presets.get(preset.id)
      const name = JSON.stringify([preset.group.toLowerCase(), preset.name.toLowerCase()])
      if (existing) {
        skip('presets', preset, preset.name, same(portablePreset(existing), preset)
          ? undefined : 'The existing preset was kept unchanged.')
      } else if (builtins.has(preset.id) || presetNames.has(name)) {
        skip('presets', preset, preset.name, 'A built-in ID or an existing group/name already identifies this preset.')
      } else {
        await database.presets.add(localPreset(preset))
        presetNames.add(name)
        result.counts.presets.added++
      }
    }
    return result
  })
}
