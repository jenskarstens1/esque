import { db } from './db'

type CacheDatabase = Pick<typeof db, 'cache' | 'cacheMetadata'>
type Entry = { key: string; size: number; mtime: number; backend: 'opfs' | 'idb' }
export type CacheData = Blob | ArrayBuffer | Uint8Array

export const opfsSupported = () =>
  typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function'

const unavailable = (error: unknown) => error instanceof Error &&
  ['NotSupportedError', 'SecurityError', 'NotAllowedError'].includes(error.name)
const missing = (error: unknown) => error instanceof Error && error.name === 'NotFoundError'
// AI coverage is part of an edit, not a regenerable preview.
const pinned = (key: string) => key.startsWith('models/') || key.startsWith('ai/')
const CACHE_DIRS = new Set(['thumb', 'preview', 'proxy', 'ai', 'models'])

const asBlob = (data: CacheData) => data instanceof Blob ? data
  : new Blob([data instanceof Uint8Array ? new Uint8Array(data).buffer : data])

/** Injectable storage keeps the fallback and its failures testable in isolated catalogs. */
export function createBinaryCache(
  database: CacheDatabase = db,
  getRoot: () => Promise<FileSystemDirectoryHandle | null> = async () =>
    opfsSupported() ? navigator.storage.getDirectory() : null,
) {
  let rootPromise: Promise<FileSystemDirectoryHandle | null> | null = null
  let writableAvailable = true

  // Throttle repeated reads, but commit the first touch before returning pixels
  // so a reload cannot erase the recency of a just-opened photograph.
  const lastUsed = new Map<string, number>()
  const USED_ENTRIES = 4096

  async function markUsed(key: string, force = false) {
    const now = Date.now()
    if (!force && now - (lastUsed.get(key) ?? 0) < 60_000) return
    await database.cacheMetadata.db.transaction('rw', database.cacheMetadata, async () => {
      const row = await database.cacheMetadata.get(key)
      await database.cacheMetadata.put({ ...row, key, accessedAt: Math.max(now, row?.accessedAt ?? 0) })
    })
    lastUsed.delete(key)
    lastUsed.set(key, now)
    if (lastUsed.size > USED_ENTRIES) {
      // Map keeps insertion order, so the first key is the least recent.
      const oldest = lastUsed.keys().next().value
      if (oldest !== undefined) lastUsed.delete(oldest)
    }
  }

  const root = () => {
    rootPromise ??= getRoot().catch((error: unknown) => {
      if (unavailable(error)) return null
      rootPromise = null
      throw error
    })
    return rootPromise
  }

  async function dirFor(key: string, create: boolean) {
    const parts = key.split('/')
    if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
      throw new Error('Invalid cache key.')
    }
    const file = parts.pop()!
    let dir = await root()
    if (!dir) return null
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create })
    return { dir, file }
  }

  async function cacheWrite(key: string, data: CacheData): Promise<void> {
    let writable: FileSystemWritableFileStream | null = null
    if (writableAvailable) {
      try {
        const path = await dirFor(key, true)
        if (path) {
          const handle = await path.dir.getFileHandle(path.file, { create: true })
          if (typeof handle.createWritable === 'function') writable = await handle.createWritable()
          else writableAvailable = false
        }
      } catch (error) {
        // Quota, I/O and transaction errors are not missing browser features.
        if (!unavailable(error)) throw error
        writableAvailable = false
      }
    }
    if (!writable) {
      await database.cache.put({ key, blob: asBlob(data), modifiedAt: Date.now() })
      await markUsed(key, true)
      return
    }
    try {
      await writable.write(data as FileSystemWriteChunkType)
      await writable.close()
    } catch (error) {
      await writable.abort().catch(() => {})
      throw error
    }
    // A cache written in a browser without OPFS may survive a browser upgrade.
    await database.cache.delete(key)
    await markUsed(key, true)
  }

  async function cacheRead(key: string, touch = true): Promise<File | null> {
    try {
      const stored = await database.cache.get(key)
      if (stored) {
        if (!stored.blob.size) return null
        if (touch) await markUsed(key)
        return new File([stored.blob], key.split('/').at(-1)!, {
          type: stored.blob.type, lastModified: stored.modifiedAt,
        })
      }
      const path = await dirFor(key, false)
      if (!path) return null
      const handle = await path.dir.getFileHandle(path.file)
      const file = await handle.getFile()
      // A concurrent OPFS writer can temporarily expose an empty entry.
      if (!file.size) return null
      if (touch) await markUsed(key)
      return file
    } catch (error) {
      if (!missing(error) && !unavailable(error)) {
        console.warn('[esque] Could not read the local cache.', error)
      }
      return null
    }
  }

  async function remove(entry: Pick<Entry, 'key' | 'backend'>) {
    if (entry.backend === 'idb') {
      await database.cache.delete(entry.key)
      return
    }
    try {
      const path = await dirFor(entry.key, false)
      if (path) await path.dir.removeEntry(path.file)
    } catch (error) {
      if (!missing(error)) throw error
    }
  }

  async function cacheDelete(key: string) {
    lastUsed.delete(key)
    await remove({ key, backend: 'idb' })
    await remove({ key, backend: 'opfs' })
    await database.cacheMetadata.delete(key)
  }

  async function entries(): Promise<Entry[]> {
    const out: Entry[] = []
    await database.cache.each((entry) => {
      out.push({ key: entry.key, size: entry.blob.size, mtime: entry.modifiedAt, backend: 'idb' })
    })
    const visit = async (directory: FileSystemDirectoryHandle, prefix: string) => {
      for await (const [name, handle] of directory.entries()) {
        // Only walk cache-owned tiers, not other OPFS files or imported roots.
        if (!prefix && !CACHE_DIRS.has(name)) continue
        const key = prefix ? `${prefix}/${name}` : name
        if (handle.kind === 'directory') await visit(handle as FileSystemDirectoryHandle, key)
        else {
          try {
            const file = await (handle as FileSystemFileHandle).getFile()
            out.push({ key, size: file.size, mtime: file.lastModified, backend: 'opfs' })
          } catch (error) {
            if (!missing(error)) throw error
          }
        }
      }
    }
    const directory = await root()
    if (directory) await visit(directory, '')
    return out
  }

  async function cacheStats() {
    const all = await entries()
    const estimate = await storageEstimate()
    return {
      bytes: all.reduce((sum, entry) => sum + entry.size, 0),
      files: all.length,
      quota: estimate.quota ?? 0,
      usage: estimate.usage ?? 0,
    }
  }

  async function cacheEvict(maxBytes: number, maxAgeMs = 0): Promise<number> {
    const all = await entries()
    const metadata = new Map((await database.cacheMetadata.toArray()).map((row) => [row.key, row.accessedAt]))
    const usedAt = (entry: Entry) =>
      Math.max(entry.mtime, metadata.get(entry.key) ?? 0, lastUsed.get(entry.key) ?? 0)
    let total = all.reduce((sum, entry) => sum + entry.size, 0)
    let freed = 0
    const cutoff = maxAgeMs > 0 ? Date.now() - maxAgeMs : -Infinity
    const candidates = all
      .filter((entry) => !pinned(entry.key))
      .sort((a, b) => usedAt(a) - usedAt(b))
    for (const entry of candidates) {
      if (total <= maxBytes && usedAt(entry) >= cutoff) break
      await remove(entry)
      lastUsed.delete(entry.key)
      await database.cacheMetadata.delete(entry.key)
      total -= entry.size
      freed += entry.size
    }
    return freed
  }

  async function cacheClear(options: { previewsOnly?: boolean } = {}) {
    for (const entry of await entries()) {
      if (options.previewsOnly && pinned(entry.key)) continue
      lastUsed.delete(entry.key)
      await remove(entry)
      await database.cacheMetadata.delete(entry.key)
    }
  }

  return { cacheWrite, cacheRead, cacheTouch: markUsed, cacheDelete, cacheStats, cacheEvict, cacheClear }
}

export async function storageEstimate(): Promise<StorageEstimate> {
  return await navigator.storage?.estimate?.().catch(() => ({})) ?? {}
}
