import Dexie, { type EntityTable } from 'dexie'
import type {
  CatalogFolder,
  Collection,
  Photo,
  Preset,
  Snapshot,
} from '../core/types'

export interface Setting {
  key: string
  value: unknown
}

/**
 * The catalog. IndexedDB stores structured clones, which means
 * FileSystemDirectoryHandle round-trips intact — that's what lets esque
 * reconnect to real folders on disk across sessions without a server.
 */
class EsqueDB extends Dexie {
  photos!: EntityTable<Photo, 'id'>
  folders!: EntityTable<CatalogFolder, 'id'>
  collections!: EntityTable<Collection, 'id'>
  presets!: EntityTable<Preset, 'id'>
  snapshots!: EntityTable<Snapshot, 'id'>
  settings!: EntityTable<Setting, 'key'>

  constructor() {
    super('esque')
    this.version(1).stores({
      // Compound [folderId+relPath] is the dedupe key on re-import.
      photos:
        'id, folderId, [folderId+relPath], addedAt, rating, flag, label, masterId, stackId, ' +
        'meta.captureTime, meta.cameraModel, meta.lens, meta.iso, filename, ext, *keywords',
      folders: 'id, name, addedAt',
      collections: 'id, name, smart, setId, createdAt',
      presets: 'id, name, group, builtin',
      snapshots: 'id, photoId, createdAt',
      settings: 'key',
    })
  }
}

export const db = new EsqueDB()

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key)
  return row === undefined ? fallback : (row.value as T)
}

export async function setSetting(key: string, value: unknown) {
  await db.settings.put({ key, value })
}

/** Wipes everything. Used by Settings › Reset catalog. */
export async function resetCatalog() {
  await db.transaction(
    'rw',
    [db.photos, db.folders, db.collections, db.snapshots],
    async () => {
      await Promise.all([
        db.photos.clear(),
        db.folders.clear(),
        db.collections.clear(),
        db.snapshots.clear(),
      ])
    },
  )
}
