/**
 * OPFS-backed binary cache for thumbnails, standard previews, and working
 * proxies.
 *
 * A 2560px half-float proxy is roughly 35–52 MB depending on aspect ratio, so it
 * lives under the same quota-aware LRU as the smaller JPEG tiers. Native-detail
 * frames remain memory-only; persisting only the standard tier keeps reopening
 * an edited RAW instant without letting 40 MP buffers consume the whole origin.
 */

let rootPromise: Promise<FileSystemDirectoryHandle> | null = null

const root = () => {
  rootPromise ??= navigator.storage.getDirectory()
  return rootPromise
}

export const opfsSupported = () =>
  typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory

async function dirFor(key: string, create: boolean) {
  const parts = key.split('/')
  const file = parts.pop()!
  let dir = await root()
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create })
  }
  return { dir, file }
}

export async function cacheWrite(key: string, data: Blob | ArrayBuffer | Uint8Array) {
  const { dir, file } = await dirFor(key, true)
  const handle = await dir.getFileHandle(file, { create: true })
  const writable = await handle.createWritable()
  try {
    await writable.write(data as FileSystemWriteChunkType)
  } finally {
    await writable.close()
  }
}

export async function cacheRead(key: string): Promise<File | null> {
  try {
    const { dir, file } = await dirFor(key, false)
    const handle = await dir.getFileHandle(file)
    const cached = await handle.getFile()
    // createWritable() creates/truncates the entry before close(). A concurrent
    // StrictMode mount can observe that temporary zero-byte file while another
    // component is still generating it; treating it as a hit permanently caches
    // a broken object URL even though the completed JPEG is valid milliseconds
    // later.
    return cached.size > 0 ? cached : null
  } catch {
    return null
  }
}

export async function cacheHas(key: string): Promise<boolean> {
  return (await cacheRead(key)) !== null
}

export async function cacheDelete(key: string) {
  try {
    const { dir, file } = await dirFor(key, false)
    await dir.removeEntry(file)
  } catch {
    /* already gone */
  }
}

/** Blob URLs are revoked by the caller; see `useObjectUrl`. */
export async function cacheUrl(key: string): Promise<string | null> {
  const file = await cacheRead(key)
  return file ? URL.createObjectURL(file) : null
}

export interface CacheStats {
  bytes: number
  files: number
  quota: number
  usage: number
}

async function walk(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: Array<{ key: string; size: number; mtime: number }>,
) {
  for await (const [name, handle] of dir.entries()) {
    const key = prefix ? `${prefix}/${name}` : name
    if (handle.kind === 'directory') {
      await walk(handle as FileSystemDirectoryHandle, key, out)
    } else {
      const f = await (handle as FileSystemFileHandle).getFile()
      out.push({ key, size: f.size, mtime: f.lastModified })
    }
  }
}

export async function cacheStats(): Promise<CacheStats> {
  const entries: Array<{ key: string; size: number; mtime: number }> = []
  try {
    await walk(await root(), '', entries)
  } catch {
    /* empty cache */
  }
  const est = await navigator.storage.estimate().catch(() => ({ quota: 0, usage: 0 }))
  return {
    bytes: entries.reduce((n, e) => n + e.size, 0),
    files: entries.length,
    quota: est.quota ?? 0,
    usage: est.usage ?? 0,
  }
}

/** Evicts least-recently-modified entries until the cache fits `maxBytes`. */
export async function cacheEvict(maxBytes: number): Promise<number> {
  const entries: Array<{ key: string; size: number; mtime: number }> = []
  await walk(await root(), '', entries)
  let total = entries.reduce((n, e) => n + e.size, 0)
  if (total <= maxBytes) return 0

  entries.sort((a, b) => a.mtime - b.mtime)
  let freed = 0
  for (const e of entries) {
    if (total <= maxBytes) break
    await cacheDelete(e.key)
    total -= e.size
    freed += e.size
  }
  return freed
}

export async function cacheClear() {
  const dir = await root()
  for await (const [name] of dir.entries()) {
    await dir.removeEntry(name, { recursive: true }).catch(() => {})
  }
}

export const thumbKey = (photoId: string) => `thumb/${photoId}.jpg`
export const previewKey = (photoId: string) => `preview/v3/${photoId}.jpg`
export const proxyKey = (
  sourceId: string,
  modifiedAt: number,
  fileSize: number,
) => `proxy/v1/${sourceId}-${modifiedAt}-${fileSize}.rgba16f`

/**
 * Trims the cache to a fraction of the origin's storage quota.
 *
 * Chromium hands out a large but finite quota per origin; once it is exhausted
 * every OPFS write starts failing, which looks to the user like previews
 * silently breaking. Runs at most once a minute and never blocks the caller.
 */
const EVICT_INTERVAL = 60_000
const QUOTA_SHARE = 0.25
const CACHE_CEILING = 3 * 1024 * 1024 * 1024
let lastEvict = 0
let evicting = false

export function scheduleEvict(force = false) {
  const now = Date.now()
  if (evicting || (!force && now - lastEvict < EVICT_INTERVAL)) return
  lastEvict = now
  evicting = true

  const run = async () => {
    try {
      const est = await navigator.storage.estimate()
      const budget = Math.min(CACHE_CEILING, Math.floor((est.quota ?? 0) * QUOTA_SHARE))
      if (budget > 0) await cacheEvict(budget)
    } catch {
      /* eviction is best-effort */
    } finally {
      evicting = false
    }
  }

  if ('requestIdleCallback' in globalThis) {
    ;(globalThis as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(
      () => void run(),
    )
  } else {
    setTimeout(() => void run(), 0)
  }
}
