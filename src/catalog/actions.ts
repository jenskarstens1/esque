import { db } from './db'
import { cacheDelete, previewKey, thumbKey } from './opfs'
import { nextId } from '../lib/math'
import { cloneEdits, defaultEdits, editsKind } from '../core/defaults'
import type { ColorLabel, Edits, PickFlag, Photo } from '../core/types'

const ids = (target: string | string[]) => (Array.isArray(target) ? target : [target])

export async function setRating(target: string | string[], rating: number) {
  await db.photos.bulkUpdate(ids(target).map((key) => ({ key, changes: { rating } })))
}

export async function setFlag(target: string | string[], flag: PickFlag) {
  await db.photos.bulkUpdate(ids(target).map((key) => ({ key, changes: { flag } })))
}

export async function setLabel(target: string | string[], label: ColorLabel) {
  await db.photos.bulkUpdate(ids(target).map((key) => ({ key, changes: { label } })))
}

export async function setPhotoFields(id: string, changes: Partial<Photo>) {
  await db.photos.update(id, changes)
}

export async function addKeywords(target: string | string[], keywords: string[]) {
  const list = ids(target)
  const photos = (await db.photos.bulkGet(list)).filter(Boolean) as Photo[]
  await db.photos.bulkUpdate(
    photos.map((p) => ({
      key: p.id,
      changes: { keywords: [...new Set([...p.keywords, ...keywords])].sort() },
    })),
  )
}

export async function removeKeyword(target: string | string[], keyword: string) {
  const photos = (await db.photos.bulkGet(ids(target))).filter(Boolean) as Photo[]
  await db.photos.bulkUpdate(
    photos.map((p) => ({ key: p.id, changes: { keywords: p.keywords.filter((k) => k !== keyword) } })),
  )
}

export async function saveEdits(id: string, edits: Edits) {
  await db.photos.update(id, { edits })
  // The cached preview no longer reflects the photo, so drop it and let the
  // render pipeline regenerate on next view.
  await cacheDelete(previewKey(id))
  // The grid thumbnail doesn't reflect it either. Re-rendered in the
  // background so the Library shows your edit, not the camera's.
  const { refreshThumb } = await import('../develop/thumbs')
  refreshThumb(id, edits)
}

export async function resetEdits(target: string | string[]) {
  await db.photos.bulkUpdate(ids(target).map((key) => ({ key, changes: { edits: null } })))
  await Promise.all(ids(target).map((id) => cacheDelete(previewKey(id))))
  const { resetThumb } = await import('../develop/thumbs')
  await Promise.all(ids(target).map((id) => resetThumb(id)))
}

/** Applies one photo's develop settings to others — Lightroom's Paste/Sync. */
export async function copyEditsTo(sourceId: string, targets: string[], sections?: (keyof Edits)[]) {
  const src = await db.photos.get(sourceId)
  if (!src) return
  const srcEdits =
    src.edits ?? defaultEdits(editsKind(src.isRaw), undefined, src.meta.iso)
  const rows = (await db.photos.bulkGet(targets)).filter(Boolean) as Photo[]

  await db.photos.bulkUpdate(
    rows.map((p) => {
      let next: Edits
      if (!sections?.length) {
        next = cloneEdits(srcEdits)
      } else {
        // An unedited target starts from *its own* baseline, so syncing a look
        // onto a JPEG doesn't hand it a RAW's capture sharpening as a side
        // effect of the fields nobody selected.
        next = cloneEdits(
          p.edits ?? defaultEdits(editsKind(p.isRaw), undefined, p.meta.iso),
        )
        for (const key of sections) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(next as any)[key] = structuredClone((srcEdits as any)[key])
        }
      }
      // Crop is per-photo geometry; carrying it across differently framed shots
      // is almost never what the user means.
      return { key: p.id, changes: { edits: next } }
    }),
  )
  await Promise.all(rows.map((p) => cacheDelete(previewKey(p.id))))
  // Synced photos aren't open in Develop, so their thumbnails are the only
  // place the user will see the result — refresh them too.
  const { refreshThumb } = await import('../develop/thumbs')
  const updated = (await db.photos.bulkGet(rows.map((p) => p.id))).filter(Boolean) as Photo[]
  for (const p of updated) if (p.edits) refreshThumb(p.id, p.edits)
}

export async function createVirtualCopy(sourceId: string): Promise<string | null> {
  const src = await db.photos.get(sourceId)
  if (!src) return null
  const masterId = src.masterId ?? src.id
  const siblings = await db.photos.where('masterId').equals(masterId).count()
  const copy: Photo = {
    ...structuredClone(src),
    id: nextId(),
    masterId,
    copyName: `Copy ${siblings + 1}`,
    addedAt: Date.now(),
    // Virtual copies share the master's thumbnail until they're edited.
    thumbKey: src.thumbKey,
  }
  await db.photos.add(copy)
  return copy.id
}

/** Removes photos from the catalog. Files on disk are never touched. */
export async function removePhotos(target: string | string[]) {
  const list = ids(target)
  await db.photos.bulkDelete(list)
  await Promise.all(
    list.flatMap((id) => [cacheDelete(thumbKey(id)), cacheDelete(previewKey(id))]),
  )
  const collections = await db.collections.toArray()
  await Promise.all(
    collections
      .filter((c) => !c.smart && c.photoIds.some((id) => list.includes(id)))
      .map((c) =>
        db.collections.update(c.id, { photoIds: c.photoIds.filter((id) => !list.includes(id)) }),
      ),
  )
}

export async function removeFolder(folderId: string) {
  const photos = await db.photos.where('folderId').equals(folderId).toArray()
  await removePhotos(photos.map((p) => p.id))
  await db.folders.delete(folderId)
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export async function createCollection(name: string, photoIds: string[] = []) {
  const id = nextId()
  await db.collections.add({
    id,
    name,
    smart: false,
    rules: [],
    match: 'all',
    photoIds,
    createdAt: Date.now(),
    setId: null,
  })
  return id
}

export async function addToCollection(collectionId: string, photoIds: string[]) {
  const c = await db.collections.get(collectionId)
  if (!c || c.smart) return
  await db.collections.update(collectionId, {
    photoIds: [...new Set([...c.photoIds, ...photoIds])],
  })
}

export async function removeFromCollection(collectionId: string, photoIds: string[]) {
  const c = await db.collections.get(collectionId)
  if (!c || c.smart) return
  const drop = new Set(photoIds)
  await db.collections.update(collectionId, {
    photoIds: c.photoIds.filter((id) => !drop.has(id)),
  })
}

// ---------------------------------------------------------------------------
// Stacks
// ---------------------------------------------------------------------------

export async function stackPhotos(photoIds: string[]) {
  if (photoIds.length < 2) return
  const stackId = nextId()
  await db.photos.bulkUpdate(
    photoIds.map((key, i) => ({
      key,
      changes: { stackId, stackPosition: i, stackCollapsed: true },
    })),
  )
}

export async function unstackPhotos(stackId: string) {
  const rows = await db.photos.where('stackId').equals(stackId).toArray()
  await db.photos.bulkUpdate(
    rows.map((p) => ({
      key: p.id,
      changes: { stackId: null, stackPosition: 0, stackCollapsed: false },
    })),
  )
}

export async function toggleStack(stackId: string) {
  const rows = await db.photos.where('stackId').equals(stackId).toArray()
  const collapsed = !rows[0]?.stackCollapsed
  await db.photos.bulkUpdate(
    rows.map((p) => ({ key: p.id, changes: { stackCollapsed: collapsed } })),
  )
}
