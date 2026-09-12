/**
 * OPFS-backed binary cache for thumbnails, standard previews, and working
 * proxies.
 *
 * A 2560px half-float proxy is roughly 35–52 MB depending on aspect ratio, so it
 * lives under the same quota-aware LRU as the smaller JPEG tiers and the
 * on-demand native-detail decodes.
 */
import { useUI } from '../state/ui'
import { createBinaryCache, storageEstimate, type CacheData } from './cache'

export { opfsSupported } from './cache'
const binaryCache = createBinaryCache()
export const { cacheRead, cacheTouch, cacheDelete, cacheStats, cacheEvict, cacheClear } = binaryCache

export async function cacheWrite(key: string, data: CacheData): Promise<void> {
  try {
    await binaryCache.cacheWrite(key, data)
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'QuotaExceededError') throw error
    const [{ bytes }, budget] = await Promise.all([cacheStats(), cacheBudget()])
    const size = data instanceof Blob ? data.size : data.byteLength
    // Retry once after making room; originals, models and saved masks are not
    // eviction candidates. A second failure remains visible to the caller.
    await cacheEvict(Math.max(0, Math.min(budget, bytes * 0.8) - size))
    await binaryCache.cacheWrite(key, data)
  }
}

export async function cacheHas(key: string): Promise<boolean> {
  return (await cacheRead(key)) !== null
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

export const thumbKey = (photoId: string) => `thumb/${photoId}.jpg`
/**
 * Revision-suffixed, exactly as the grid thumbnail is.
 *
 * A preview rendered from your edits goes stale the moment you move a slider,
 * and deleting the file is not enough on its own: the blob URL handed to the
 * Library is memoised against this key, so a stable key means the old image
 * stays on screen. A revision in the key retires the URL with the file, and
 * lets a render that started before the edit recognise that it is obsolete
 * rather than writing itself back over the fresh one.
 */
export const previewKey = (photoId: string, rev = 0) => `preview/v4/${photoId}.${rev}.jpg`
export const modelKey = (id: string) => `models/${id}.onnx`
export const proxyKey = (
  sourceId: string,
  modifiedAt: number,
  fileSize: number,
  edge: number,
  quality: 'interactive' | 'full' = 'interactive',
) => `proxy/v2/${sourceId}-${modifiedAt}-${fileSize}-${edge}${quality === 'full' ? '-full' : ''}.rgba16f`

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

/**
 * The byte budget for the cache: whatever the user asked for, or the automatic
 * figure when they haven't said.
 *
 * A chosen limit is still capped by the quota share, because a limit larger
 * than the browser will actually grant isn't a limit, it's a promise the
 * platform breaks — the eviction pass would never fire and writes would start
 * failing instead.
 */
export async function cacheBudget(): Promise<number> {
  const est = await storageEstimate()
  const auto = est.quota && est.quota > 0
    ? Math.min(CACHE_CEILING, Math.floor(est.quota * QUOTA_SHARE))
    : CACHE_CEILING
  const chosen = useUI.getState().cacheLimit
  if (chosen <= 0) return auto
  const ceiling = Math.floor((est.quota ?? 0) * 0.8)
  return ceiling > 0 ? Math.min(chosen, ceiling) : chosen
}

export function scheduleEvict(force = false) {
  const now = Date.now()
  if (evicting || (!force && now - lastEvict < EVICT_INTERVAL)) return
  lastEvict = now
  evicting = true

  const run = async () => {
    try {
      const budget = await cacheBudget()
      const days = useUI.getState().cacheMaxAgeDays
      if (budget > 0) await cacheEvict(budget, days > 0 ? days * 86_400_000 : 0)
    } catch (error) {
      console.warn('[esque] Could not trim the local cache.', error)
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
