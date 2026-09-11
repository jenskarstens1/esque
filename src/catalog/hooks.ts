import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useRef, useState } from 'react'
import { db } from './db'
import { cacheRead, previewKey, thumbKey } from './opfs'
import { ensurePreview, ensureThumb } from './previews'
import { applyFilters, sortPhotos, useCatalog } from '../state/catalog'
import { selectionValues } from './selectionValues'
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
 *
 * For the same reason the *previous* answer is held across a remount. Crossing
 * back from Develop rebuilds this query from scratch, and for those frames the
 * Library honestly believed it was empty — long enough to put the "no photos
 * here" screen on top of a full catalogue, mid-switch. The same source resolved
 * a moment ago to a set that is still true, so that is what it shows until
 * Dexie answers. A *different* source has nothing to stand in with and waits,
 * exactly as before.
 */
let lastSourceAnswer: { key: string; photos: Photo[] } | null = null

export function useSourceQuery(): Photo[] | undefined {
  const source = useCatalog((s) => s.source)
  const sourceId = 'id' in source ? source.id : ''
  const key = `${source.kind}/${sourceId}`

  const answer = useLiveQuery(async () => {
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
  }, [source.kind, sourceId])

  if (answer) {
    if (lastSourceAnswer?.photos !== answer) lastSourceAnswer = { key, photos: answer }
    return answer
  }
  return lastSourceAnswer?.key === key ? lastSourceAnswer.photos : undefined
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

/**
 * The last row each id answered with, so a remount has something true to draw.
 *
 * A live query has no result on the render it is created, and crossing between
 * Library and Develop creates a new one. For those frames Develop has no photo
 * at all: no stand-in, nothing under the canvas that hasn't drawn yet, so the
 * viewport goes black in the middle of a switch that should have been
 * continuous. Standing in with the row this very id last resolved to is not a
 * guess — it is the same photograph, a few frames old, and it is replaced the
 * moment Dexie answers.
 *
 * A handful of entries is all it takes to bridge a remount, so the map is
 * capped rather than left to grow with everything ever opened.
 */
const lastKnownPhoto = new Map<string, Photo>()
const LAST_KNOWN_PHOTOS = 8

export function usePhoto(id: string | null): Photo | undefined {
  // Wrapped, because `undefined` from the query itself cannot tell "not
  // answered yet" from "answered: this photo is gone" — and standing in for a
  // photo that has been deleted would keep it on screen after it was removed.
  const answer = useLiveQuery(
    async () => ({ row: id ? await db.photos.get(id) : undefined }),
    [id],
  )

  if (!id) return undefined
  if (!answer) return lastKnownPhoto.get(id)

  if (!answer.row) {
    lastKnownPhoto.delete(id)
    return undefined
  }
  if (lastKnownPhoto.get(id) !== answer.row) {
    // Re-inserted rather than updated: Map keeps insertion order, which is what
    // makes the eviction below drop the least recently seen photo.
    lastKnownPhoto.delete(id)
    lastKnownPhoto.set(id, answer.row)
    if (lastKnownPhoto.size > LAST_KNOWN_PHOTOS) {
      const oldest = lastKnownPhoto.keys().next().value
      if (oldest !== undefined) lastKnownPhoto.delete(oldest)
    }
  }
  return answer.row
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

export function usePhotoSelection() {
  const selected = useCatalog((s) => s.selected)
  const primaryId = useCatalog((s) => s.primaryId)
  const ids = useMemo(
    () => selected.length ? selected : primaryId ? [primaryId] : [],
    [selected, primaryId],
  )
  const key = JSON.stringify(ids)
  const result = useLiveQuery(async () => {
    const rows = await db.photos.bulkGet(ids)
    return { key, photos: rows.filter((photo): photo is Photo => photo !== undefined) }
  }, [key])
  // A selection can change before its query resolves. Never use the old
  // selection's common value to decide whether a click should clear the new one.
  const ready = result !== undefined && result.key === key && result.photos.length === ids.length
  const photos = ready && result ? result.photos : NO_PHOTOS
  return useMemo(
    () => ({ ids, photos, values: selectionValues(photos), ready: ready && ids.length > 0 }),
    [ids, photos, ready],
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

/** Releases a memoised URL, for when the asset behind its key is retired. */
export function forgetCachedUrl(key: string) {
  const url = urlCache.get(key)
  if (!url) return
  urlCache.delete(key)
  // The <img> pointing at it is about to be handed a new src; revoking under
  // it would blank the frame in between.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
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
  // Keyed by revision so a saved edit retires the memoised URL along with the
  // file. Without it the Library keeps handing back the preview of a look the
  // photographer has already moved away from.
  return useCachedUrl(id ? previewKey(id, photo?.previewRev ?? 0) : null, ensure)
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
