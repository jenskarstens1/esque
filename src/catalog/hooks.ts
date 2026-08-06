import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useRef, useState } from 'react'
import { db } from './db'
import { cacheRead, previewKey, thumbKey } from './opfs'
import { ensurePreview, ensureThumb } from './previews'
import { applyFilters, sortPhotos, useCatalog } from '../state/catalog'
import type { Photo } from '../core/types'

/** Photo count in the whole catalog, for chrome that hides itself when empty. */
export function usePhotoCount(): number {
  return useLiveQuery(() => db.photos.count(), [], 0) ?? 0
}

/* One shared empty array, so a source that hasn't resolved yet doesn't hand
   every memo below it a new identity on each render. */
const NO_PHOTOS: Photo[] = []

/**
 * The source query itself, still `undefined` until Dexie has answered it.
 *
 * A live query has no result on the render it is created, and every mount
 * creates a new one — so "nothing yet" and "nothing here" are the same value to
 * anyone reading `?? []`. `usePhotos` has to tell them apart, because acting on
 * the first as though it were the second throws away the selection.
 */
function useSourceQuery(): Photo[] | undefined {
  const source = useCatalog((s) => s.source)

  return useLiveQuery(async () => {
    if (source.kind === 'folder') {
      return db.photos.where('folderId').equals(source.id).toArray()
    }
    if (source.kind === 'collection') {
      const c = await db.collections.get(source.id)
      if (!c) return []
      if (c.smart) {
        const all = await db.photos.toArray()
        return applySmartRules(all, c)
      }
      const photos = await db.photos.bulkGet(c.photoIds)
      return photos.filter(Boolean) as Photo[]
    }
    if (source.kind === 'previousImport') {
      const all = await db.photos.orderBy('addedAt').reverse().toArray()
      const latest = all[0]?.addedAt
      return latest ? all.filter((p) => p.addedAt === latest) : []
    }
    return db.photos.toArray()
  }, [source.kind, 'id' in source ? source.id : ''])
}

/** Photos for the current source, before filtering — what the filter bar counts. */
export function useSourcePhotos(): Photo[] {
  return useSourceQuery() ?? NO_PHOTOS
}

/** Photos for the current source, filtered and sorted. */
export function usePhotos(): Photo[] {
  const filters = useCatalog((s) => s.filters)
  const sortKey = useCatalog((s) => s.sortKey)
  const sortAsc = useCatalog((s) => s.sortAsc)
  const setVisible = useCatalog((s) => s.setVisible)

  const raw = useSourceQuery()

  const photos = useMemo(
    () => sortPhotos(applyFilters(raw ?? NO_PHOTOS, filters), sortKey, sortAsc),
    [raw, filters, sortKey, sortAsc],
  )

  const ids = useMemo(() => photos.map((p) => p.id), [photos])
  // Joining 20 000 ids into a string on every render is measurable; a rolling
  // hash collapses membership to a number just as reliably for change detection.
  const idKey = useMemo(() => {
    let h = ids.length
    for (const id of ids) {
      for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0
    }
    return h
  }, [ids])
  // Moving between Library and Develop remounts whoever calls this, and the
  // fresh live query reads empty for a frame. Publishing that would empty
  // `visibleIds`, which drops the selection with it; the real answer lands a
  // moment later, finds no primary, and falls back to the first photo in the
  // catalogue — so Develop opens someone else's photograph instead of the one
  // that was on screen. An unresolved query is not a view, so it publishes
  // nothing and the selection survives the switch.
  const resolved = raw !== undefined
  useEffect(() => {
    if (!resolved) return
    setVisible(ids)
    // idKey collapses the array into a stable primitive so this only fires on
    // real membership changes, not on every re-render.
  }, [idKey, resolved]) // eslint-disable-line react-hooks/exhaustive-deps

  return photos
}

export function usePhoto(id: string | null): Photo | undefined {
  return useLiveQuery(async () => (id ? db.photos.get(id) : undefined), [id])
}

export function useSelectedPhotos(): Photo[] {
  const selected = useCatalog((s) => s.selected)
  const key = selected.join(',')
  return (
    useLiveQuery(async () => {
      const rows = await db.photos.bulkGet(selected)
      return rows.filter(Boolean) as Photo[]
    }, [key]) ?? []
  )
}

export function useFolders() {
  return useLiveQuery(() => db.folders.orderBy('name').toArray(), []) ?? []
}

export function useCollections() {
  return useLiveQuery(() => db.collections.orderBy('name').toArray(), []) ?? []
}

// ---------------------------------------------------------------------------
// Cached blob URLs
// ---------------------------------------------------------------------------

const urlCache = new Map<string, string>()
const MAX_URLS = 900

function rememberUrl(key: string, url: string) {
  urlCache.set(key, url)
  if (urlCache.size > MAX_URLS) {
    // Map preserves insertion order, so the first entry is the oldest.
    const oldest = urlCache.keys().next().value as string | undefined
    if (oldest && oldest !== key) {
      URL.revokeObjectURL(urlCache.get(oldest)!)
      urlCache.delete(oldest)
    }
  }
}

/**
 * Resolves an OPFS cache key to an object URL, memoised across the session.
 *
 * On a cache miss it calls `ensure` to generate the asset and then re-reads —
 * which is what makes previews appear for photos that have never been opened,
 * and what lets the grid recover after the cache is evicted.
 */
export function useCachedUrl(
  key: string | null,
  ensure?: () => Promise<boolean>,
): string | null {
  const [url, setUrl] = useState<string | null>(() => (key ? (urlCache.get(key) ?? null) : null))
  const ensureRef = useRef(ensure)
  ensureRef.current = ensure

  useEffect(() => {
    if (!key) {
      setUrl(null)
      return
    }
    const cached = urlCache.get(key)
    if (cached) {
      setUrl(cached)
      return
    }

    let alive = true
    setUrl(null)

    const publish = (file: File | null) => {
      if (!alive || !file) return false
      // Another component may have won the race while we were reading.
      const existing = urlCache.get(key)
      const u = existing ?? URL.createObjectURL(file)
      if (!existing) rememberUrl(key, u)
      setUrl(u)
      return true
    }

    void (async () => {
      if (publish(await cacheRead(key))) return
      if (!alive || !ensureRef.current) return
      if (!(await ensureRef.current())) return
      if (!alive) return
      publish(await cacheRead(key))
    })()

    return () => {
      alive = false
    }
  }, [key])

  return url
}

export function useThumbUrl(photo: Photo | undefined): string | null {
  const id = photo?.id ?? null
  const rev = photo?.thumbRev ?? 0
  const ensure = useMemo(() => {
    if (!id) return undefined
    // A rendered thumbnail that's been evicted has to be re-rendered from the
    // edits; regenerating from the file would silently put the camera's own
    // rendering back in the grid.
    if (rev > 0)
      return async () => {
        const row = await db.photos.get(id)
        if (!row?.edits) return ensureThumb(id)
        const { refreshThumb } = await import('../develop/thumbs')
        refreshThumb(row.id, row.edits)
        return false
      }
    return () => ensureThumb(id)
  }, [id, rev])
  return useCachedUrl(photo ? (photo.thumbKey ?? thumbKey(photo.id)) : null, ensure)
}

export function usePreviewUrl(photo: Photo | undefined): string | null {
  const id = photo?.id ?? null
  const ensure = useMemo(() => (id ? () => ensurePreview(id) : undefined), [id])
  return useCachedUrl(id ? previewKey(id) : null, ensure)
}

// ---------------------------------------------------------------------------

import type { Collection, SmartRule } from '../core/types'

function ruleMatches(p: Photo, r: SmartRule): boolean {
  const str = (v: unknown) => String(v ?? '').toLowerCase()
  const target = str(r.value)
  switch (r.field) {
    case 'rating':
      return compareNum(p.rating, r)
    case 'iso':
      return compareNum(p.meta.iso, r)
    case 'aperture':
      return compareNum(p.meta.aperture, r)
    case 'focalLength':
      return compareNum(p.meta.focalLength, r)
    case 'captureTime':
      return compareNum(p.meta.captureTime ?? 0, r)
    case 'flag':
      return r.op === 'isNot' ? p.flag !== r.value : p.flag === r.value
    case 'label':
      return r.op === 'isNot' ? p.label !== r.value : p.label === r.value
    case 'edited': {
      // The value arrives as a real boolean from a rule built in code and as
      // "true"/"false" from one built by a `<select>`; both mean the same thing.
      const want = r.value === true || r.value === 'true'
      return !!p.edits === want
    }
    case 'fileType':
      return r.value === 'raw' ? p.isRaw : !p.isRaw
    case 'keyword':
      return r.op === 'notContains'
        ? !p.keywords.some((k) => str(k).includes(target))
        : p.keywords.some((k) => str(k).includes(target))
    case 'camera':
      return compareText(str(p.meta.cameraModel), target, r.op)
    case 'lens':
      return compareText(str(p.meta.lens), target, r.op)
    case 'filename':
      return compareText(str(p.filename), target, r.op)
  }
}

function compareNum(v: number, r: SmartRule): boolean {
  const a = Number(r.value)
  switch (r.op) {
    case 'gte':
      return v >= a
    case 'lte':
      return v <= a
    case 'inRange':
      return v >= a && v <= Number(r.value2 ?? a)
    case 'isNot':
      return v !== a
    default:
      return v === a
  }
}

function compareText(v: string, target: string, op: SmartRule['op']): boolean {
  switch (op) {
    case 'is':
      return v === target
    case 'isNot':
      return v !== target
    case 'notContains':
      return !v.includes(target)
    case 'startsWith':
      return v.startsWith(target)
    case 'endsWith':
      return v.endsWith(target)
    default:
      return v.includes(target)
  }
}

/** Membership of a smart collection: the rules are the collection. */
export function applySmartRules<T extends Pick<Collection, 'rules' | 'match'>>(
  photos: Photo[],
  c: T,
): Photo[] {
  if (!c.rules.length) return photos
  return photos.filter((p) =>
    c.match === 'all'
      ? c.rules.every((r) => ruleMatches(p, r))
      : c.rules.some((r) => ruleMatches(p, r)),
  )
}
