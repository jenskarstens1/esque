import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ColorLabel, PickFlag, Photo } from '../core/types'

export type Source =
  | { kind: 'all' }
  | { kind: 'folder'; id: string }
  | { kind: 'collection'; id: string }
  | { kind: 'previousImport' }

export type SortKey = 'capture' | 'filename' | 'rating' | 'added' | 'modified' | 'iso'

export interface Filters {
  rating: number
  ratingOp: 'gte' | 'eq' | 'lte'
  flags: PickFlag[]
  labels: ColorLabel[]
  text: string
  cameras: string[]
  lenses: string[]
  fileType: 'all' | 'raw' | 'rendered'
  edited: 'all' | 'edited' | 'unedited'
  keywords: string[]
}

export const emptyFilters = (): Filters => ({
  rating: 0,
  ratingOp: 'gte',
  flags: [],
  labels: [],
  text: '',
  cameras: [],
  lenses: [],
  fileType: 'all',
  edited: 'all',
  keywords: [],
})

export const filtersActive = (f: Filters) =>
  f.rating > 0 ||
  f.flags.length > 0 ||
  f.labels.length > 0 ||
  f.text.trim().length > 0 ||
  f.cameras.length > 0 ||
  f.lenses.length > 0 ||
  f.fileType !== 'all' ||
  f.edited !== 'all' ||
  f.keywords.length > 0

interface CatalogState {
  source: Source
  filters: Filters
  sortKey: SortKey
  sortAsc: boolean

  /** IDs in current view order — kept in sync by the Library module. */
  visibleIds: string[]
  selected: string[]
  /** The photo shown in Loupe/Develop; always a member of `selected`. */
  primaryId: string | null
  /** Anchor for shift-click ranges. */
  anchorId: string | null

  setSource: (s: Source) => void
  setFilters: (patch: Partial<Filters>) => void
  clearFilters: () => void
  setSort: (key: SortKey, asc?: boolean) => void
  setVisible: (ids: string[]) => void

  select: (id: string, mode?: 'replace' | 'toggle' | 'range') => void
  selectMany: (ids: string[]) => void
  selectAll: () => void
  clearSelection: () => void
  step: (delta: number) => void
  setPrimary: (id: string | null) => void
}

/**
 * Where the viewer was: which source, how it was filtered and sorted, and
 * which photograph they had open.
 *
 * A reload is not a new session — the catalogue, its previews and the edits
 * are all still on the machine, so coming back to the first photo of "All
 * Photographs" throws away the only part of the state that was in the
 * photographer's head. `visibleIds` is deliberately absent: it is the view the
 * Library publishes from the live query, and a saved copy of it would be a
 * claim about rows that may no longer exist.
 */
const persisted = (s: CatalogState) => ({
  source: s.source,
  filters: s.filters,
  sortKey: s.sortKey,
  sortAsc: s.sortAsc,
  selected: s.selected,
  primaryId: s.primaryId,
  anchorId: s.anchorId,
})

export const useCatalog = create<CatalogState>()(persist((set, get) => ({
  source: { kind: 'all' },
  filters: emptyFilters(),
  sortKey: 'capture',
  sortAsc: true,

  visibleIds: [],
  selected: [],
  primaryId: null,
  anchorId: null,

  setSource: (source) => set({ source, selected: [], primaryId: null, anchorId: null }),
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  clearFilters: () => set({ filters: emptyFilters() }),
  setSort: (sortKey, asc) => set((s) => ({ sortKey, sortAsc: asc ?? (sortKey === s.sortKey ? !s.sortAsc : true) })),

  setVisible: (visibleIds) =>
    set((s) => {
      const alive = new Set(visibleIds)
      const selected = s.selected.filter((id) => alive.has(id))
      let primaryId = s.primaryId && alive.has(s.primaryId) ? s.primaryId : null
      // Keep something selected so Develop always has a subject.
      if (!primaryId && visibleIds.length) primaryId = selected[0] ?? visibleIds[0]
      return {
        visibleIds,
        selected: selected.length ? selected : primaryId ? [primaryId] : [],
        primaryId,
      }
    }),

  select: (id, mode = 'replace') => {
    const { selected, visibleIds, anchorId } = get()
    if (mode === 'toggle') {
      const has = selected.includes(id)
      const next = has ? selected.filter((x) => x !== id) : [...selected, id]
      set({
        selected: next,
        primaryId: has ? (next[next.length - 1] ?? null) : id,
        anchorId: id,
      })
      return
    }
    if (mode === 'range' && anchorId) {
      const a = visibleIds.indexOf(anchorId)
      const b = visibleIds.indexOf(id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        set({ selected: visibleIds.slice(lo, hi + 1), primaryId: id })
        return
      }
    }
    set({ selected: [id], primaryId: id, anchorId: id })
  },

  selectMany: (ids) => set({ selected: ids, primaryId: ids[ids.length - 1] ?? null }),
  selectAll: () => set((s) => ({ selected: [...s.visibleIds], primaryId: s.visibleIds[0] ?? null })),
  clearSelection: () => set({ selected: [], primaryId: null }),

  step: (delta) => {
    const { visibleIds, primaryId } = get()
    if (!visibleIds.length) return
    const i = primaryId ? visibleIds.indexOf(primaryId) : -1
    const next = visibleIds[Math.max(0, Math.min(visibleIds.length - 1, i + delta))]
    if (next) set({ selected: [next], primaryId: next, anchorId: next })
  },

  setPrimary: (primaryId) => set({ primaryId }),
}), {
  name: 'esque.catalog',
  partialize: persisted,
  // A saved source can name a folder or collection that has since been
  // deleted, which would restore the photographer into a view with nothing in
  // it and no obvious way out. The whole catalogue is the honest fallback.
  onRehydrateStorage: () => (state) => {
    if (!state) return
    // Keep the store's own invariant: the primary is a member of the selection.
    const selected = state.primaryId && !state.selected.includes(state.primaryId)
      ? [state.primaryId]
      : state.selected
    if (selected !== state.selected) useCatalog.setState({ selected })

    const { source } = state
    if (source.kind !== 'folder' && source.kind !== 'collection') return
    void (async () => {
      const { db } = await import('../catalog/db')
      const row =
        source.kind === 'folder'
          ? await db.folders.get(source.id)
          : await db.collections.get(source.id)
      // Only reset if nothing has moved on since — the viewer may well have
      // clicked somewhere else while IndexedDB was answering.
      if (!row && useCatalog.getState().source === source) {
        useCatalog.setState({ source: { kind: 'all' } })
      }
    })()
  },
}))

// ---------------------------------------------------------------------------
// Filtering & sorting, applied client-side over the Dexie result set.
// ---------------------------------------------------------------------------

function matchesRating(photo: Photo, filters: Filters) {
  if (filters.rating <= 0) return true
  if (filters.ratingOp === 'gte') return photo.rating >= filters.rating
  if (filters.ratingOp === 'lte') return photo.rating <= filters.rating
  return photo.rating === filters.rating
}

function matchesClassification(photo: Photo, filters: Filters) {
  if (filters.flags.length && !filters.flags.includes(photo.flag)) return false
  if (filters.labels.length && !filters.labels.includes(photo.label)) return false
  if (filters.fileType === 'raw' && !photo.isRaw) return false
  if (filters.fileType === 'rendered' && photo.isRaw) return false
  if (filters.edited === 'edited' && !photo.edits) return false
  if (filters.edited === 'unedited' && photo.edits) return false
  return true
}

function matchesMetadata(photo: Photo, filters: Filters) {
  if (filters.cameras.length && !filters.cameras.includes(photo.meta.cameraModel)) return false
  if (filters.lenses.length && !filters.lenses.includes(photo.meta.lens)) return false
  if (filters.keywords.length && !filters.keywords.every((keyword) => photo.keywords.includes(keyword))) {
    return false
  }
  return true
}

function matchesText(photo: Photo, text: string) {
  if (!text) return true
  const haystack =
    `${photo.filename} ${photo.title} ${photo.caption} ${photo.keywords.join(' ')} ${photo.meta.cameraModel} ${photo.meta.lens}`
      .toLowerCase()
  return haystack.includes(text)
}

export function applyFilters(photos: Photo[], f: Filters): Photo[] {
  const text = f.text.trim().toLowerCase()
  return photos.filter((p) => {
    if (!matchesRating(p, f)) return false
    if (!matchesClassification(p, f)) return false
    if (!matchesMetadata(p, f)) return false
    return matchesText(p, text)
  })
}

export function sortPhotos(photos: Photo[], key: SortKey, asc: boolean): Photo[] {
  const dir = asc ? 1 : -1
  const value = (p: Photo): number | string => {
    switch (key) {
      case 'capture':
        return p.meta.captureTime ?? p.modifiedAt
      case 'filename':
        return p.filename.toLowerCase()
      case 'rating':
        return p.rating
      case 'added':
        return p.addedAt
      case 'modified':
        return p.modifiedAt
      case 'iso':
        return p.meta.iso
    }
  }
  return [...photos].sort((a, b) => {
    const va = value(a)
    const vb = value(b)
    if (va === vb) return a.filename.localeCompare(b.filename) * dir
    return (va < vb ? -1 : 1) * dir
  })
}
