import { db } from './db'
import { resolveFile, writeSibling } from './fs'
import { invalidateRendered } from './previews'
import { parseXmp, parseSidecarMetadata, editsToSidecar } from '../develop/xmp'
import { ALL_SECTIONS, adoptStoredEdits } from '../develop/session'
import { defaultEdits, editsKind } from '../core/defaults'
import type { ColorLabel, Photo } from '../core/types'

/**
 * XMP sidecars, in both directions.
 *
 * A sidecar is how every other raw converter says what it did to a photograph:
 * `IMG_0001.xmp` beside `IMG_0001.RAF`, holding the develop settings, the star
 * rating, the label and the keywords. esque could already write one on export
 * and could already parse one — `src/develop/xmp.ts` is a complete Lightroom
 * `crs:` reader — but nothing ever went looking for one on disk, so work done
 * in Lightroom arrived here as a blank photograph and work done here never left.
 *
 * Reading them closes that loop, and it is the difference between a catalog you
 * can try and a catalog you can move into.
 *
 * Nothing here is automatic beyond import. Overwriting a photographer's edits
 * from a file they forgot was there is not a mistake worth risking, so
 * re-reading later is a command they choose.
 */

/**
 * The sidecar names to look for, most conventional first.
 *
 * Two spellings are in the wild: Adobe replaces the extension
 * (`IMG_0001.xmp`), while a number of other tools append to the whole filename
 * (`IMG_0001.RAF.xmp`) so that two files differing only by extension cannot
 * collide. Both are read; only Adobe's is written.
 */
export function sidecarNames(relPath: string): string[] {
  const dot = relPath.lastIndexOf('.')
  const slash = relPath.lastIndexOf('/')
  const stripped = dot > slash ? relPath.slice(0, dot) : relPath
  return [`${stripped}.xmp`, `${relPath}.xmp`]
}

/** The name a sidecar is written under. Adobe's spelling, so Lightroom finds it. */
export const sidecarPath = (relPath: string) => sidecarNames(relPath)[0]

/**
 * The sidecar text for a photo, or null.
 *
 * Loose files — imported one at a time through the file picker — have a handle
 * to themselves and no handle to the directory they sit in, and the File System
 * Access API gives no way to walk from one to the other. So they have no
 * siblings to find, and the caller has to say so rather than fail silently.
 */
export async function readSidecarText(photo: Photo): Promise<string | null> {
  const folder = await db.folders.get(photo.folderId)
  if (!folder?.handle) return null
  for (const name of sidecarNames(photo.relPath)) {
    const file = await resolveFile(folder.handle, name)
    if (file) return await file.text()
  }
  return null
}

export interface SidecarApplication {
  /** Develop settings, when the sidecar carried any. */
  edits: boolean
  /** Rating, label, title, caption or keywords. */
  metadata: boolean
}

/**
 * Folds a sidecar's contents into a photo record.
 *
 * Absent fields are left alone rather than reset. A sidecar written by a tool
 * that only cared about ratings should not blank a caption, and one carrying
 * only develop settings should not clear the stars.
 */
export function applySidecarText(xml: string): {
  changes: Partial<Photo>
  applied: SidecarApplication
} | null {
  const changes: Partial<Photo> = {}
  const applied: SidecarApplication = { edits: false, metadata: false }

  const parsed = parseXmp(xml)
  // A preset that happens to be sitting next to a photo is not that photo's
  // settings, and applying it would be an edit nobody asked for.
  if (parsed && !parsed.isPreset && parsed.paths.length > 0) {
    changes.edits = parsed.edits
    applied.edits = true
  }

  const meta = parseSidecarMetadata(xml)
  if (meta.rating !== null && Number.isFinite(meta.rating)) {
    changes.rating = Math.max(0, Math.min(5, Math.round(meta.rating)))
    applied.metadata = true
  }
  if (meta.label !== null) {
    const label = meta.label.toLowerCase()
    if (LABELS.includes(label as ColorLabel)) {
      changes.label = label as ColorLabel
      applied.metadata = true
    }
  }
  if (meta.title !== null) {
    changes.title = meta.title
    applied.metadata = true
  }
  if (meta.caption !== null) {
    changes.caption = meta.caption
    applied.metadata = true
  }
  if (meta.keywords.length) {
    changes.keywords = meta.keywords
    applied.metadata = true
  }

  if (!applied.edits && !applied.metadata) return null
  return { changes, applied }
}

const LABELS: ColorLabel[] = ['red', 'yellow', 'green', 'blue', 'purple', 'none']

/**
 * Reads the sidecars beside a set of photos and applies what they hold.
 *
 * Reported rather than announced: the caller knows whether this was an import
 * sweep or a command the photographer chose, and those deserve different words.
 */
export async function readSidecars(photos: Photo[]): Promise<{
  read: number
  missing: number
  failed: number
}> {
  let read = 0
  let missing = 0
  let failed = 0
  // Parsed first, applied second. The commit has to run inside the save
  // queue's suspension, and holding a whole folder's worth of disk reads open
  // inside it would stall Develop's saves for the length of the sweep.
  const parsed: Array<{ photo: Photo; changes: Partial<Photo> }> = []

  for (const photo of photos) {
    let xml: string | null
    try {
      xml = await readSidecarText(photo)
    } catch {
      failed++
      continue
    }
    if (xml === null) {
      missing++
      continue
    }
    const result = applySidecarText(xml)
    if (!result) {
      missing++
      continue
    }
    parsed.push({ photo, changes: result.changes })
    if (!result.applied.edits) {
      // Ratings and keywords don't collide with the edit save queue, so they
      // are stored straight away and cost the suspension nothing.
      await db.photos.update(photo.id, result.changes)
      parsed.pop()
      read++
    }
  }

  const changed = parsed.map((p) => p.photo.id)
  if (!changed.length) return { read, missing, failed }

  await adoptStoredEdits(changed, async () => {
    for (const { photo, changes } of parsed) {
      await db.photos.update(photo.id, changes)
      read++
    }
  })

  // Everything the Library renders from the old settings has to go too.
  const rows = (await db.photos.bulkGet(changed)).filter((p): p is Photo => !!p)
  await Promise.all(rows.map((p) => invalidateRendered(p.id)))
  const { refreshThumb, resetThumb } = await import('../develop/thumbs')
  for (const p of rows) {
    if (p.edits) refreshThumb(p.id, p.edits)
    else await resetThumb(p.id)
  }

  return { read, missing, failed }
}

/**
 * Writes a photo's settings and metadata to its sidecar.
 *
 * A virtual copy is refused: it has no file of its own, so its sidecar path is
 * the master's, and writing one variant there would silently replace the
 * master's own settings.
 */
export async function writeSidecar(photo: Photo): Promise<boolean> {
  if (photo.masterId) return false
  const folder = await db.folders.get(photo.folderId)
  if (!folder?.handle) return false
  const xml = editsToSidecar(
    photo.edits ?? defaultEdits(editsKind(photo.isRaw), undefined, photo.meta.iso),
    ALL_SECTIONS,
    {
      filename: photo.filename,
      rating: photo.rating,
      label: photo.label === 'none' ? undefined : photo.label,
      title: photo.title || undefined,
      caption: photo.caption || undefined,
      keywords: photo.keywords,
    },
  )
  return writeSibling(folder.handle, sidecarPath(photo.relPath), xml)
}

export async function writeSidecars(
  photos: Photo[],
): Promise<{ written: number; failed: number; skipped: number }> {
  let written = 0
  let failed = 0
  let skipped = 0
  for (const photo of photos) {
    // Virtual copies share their master's sidecar path, so they are passed
    // over rather than counted as a failure the photographer should act on.
    if (photo.masterId) {
      skipped++
      continue
    }
    if (await writeSidecar(photo)) written++
    else failed++
  }
  return { written, failed, skipped }
}
