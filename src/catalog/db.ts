import Dexie, { type EntityTable } from 'dexie'
import { migrateEdits, migratePartialEdits, needsMigration } from '../develop/migrate'
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

/** File metadata is explicit: some engines clone a File as a plain Blob. */
export interface StoredFile {
  blob: Blob
  name: string
  type: string
  lastModified: number
}

/** User originals are durable catalog data, never disposable preview cache. */
export interface ManagedOriginal extends StoredFile {
  id: string
  digest: string
  importPath: string
  identity: string
  sidecar?: StoredFile
}

export interface BinaryCacheEntry {
  key: string
  blob: Blob
  modifiedAt: number
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
  originals!: EntityTable<ManagedOriginal, 'id'>
  cache!: EntityTable<BinaryCacheEntry, 'key'>

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
    this.version(2).stores({
      originals: 'id, identity',
      cache: 'key, modifiedAt',
    })
    // Local Tint changed sign, so every stack stored under the old meaning has
    // to be rewritten before it is next rendered. Doing it as a Dexie upgrade
    // means it happens once, inside a transaction, rather than being re-checked
    // at every one of the many places that read a photo's edits.
    this.version(3).upgrade(async (tx) => {
      await tx.table('photos').toCollection().modify((photo: Photo) => {
        if (!needsMigration(photo.edits)) return
        photo.edits = migrateEdits(photo.edits!)
        // Whatever was rendered from the old stack no longer matches it. Both
        // caches are revision-keyed, so moving the revision is the whole
        // invalidation — the stale files fall out through the usual LRU.
        const rev = (photo.thumbRev ?? 0) + 1
        photo.thumbRev = rev
        photo.thumbKey = `thumb/${photo.id}.${rev}.jpg`
        photo.previewRev = (photo.previewRev ?? 0) + 1
      })
      await tx.table('snapshots').toCollection().modify((snap: Snapshot) => {
        if (needsMigration(snap.edits)) snap.edits = migrateEdits(snap.edits)
      })
      await tx.table('presets').toCollection().modify((preset: Preset) => {
        if (needsMigration(preset.edits)) preset.edits = migratePartialEdits(preset.edits)
      })
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
export async function resetCatalog(database: typeof db = db) {
  await database.transaction(
    'rw',
    [database.photos, database.folders, database.collections, database.snapshots, database.originals],
    async () => {
      await Promise.all([
        database.photos.clear(),
        database.folders.clear(),
        database.collections.clear(),
        database.snapshots.clear(),
        database.originals.clear(),
      ])
    },
  )
}
