/**
 * Keeping a catalog row's shape honest.
 *
 * A rendered file's dimensions come out of its EXIF header, and EXIF describes
 * the frame as *stored*: a portrait shot from a landscape sensor is written as
 * 7360×4912 plus a tag saying "turn this a quarter turn". Every pixel esque
 * ever decodes is already turned — the decoders all ask for `from-image` — so a
 * row that took the header at its word describes a photo lying on its side, and
 * anything laying out a box from it hands portrait pixels a landscape frame.
 *
 * Import folds the tag in now. Catalogs written before it did not, and there is
 * no cheap way to re-read thousands of headers, so the pixels correct the row
 * instead: whichever tier lands first already carries the true shape, and a row
 * that disagrees with it by exactly a quarter turn is quietly turned back.
 */
import { db } from './db'
import type { Photo } from '../core/types'

export interface PixelSize {
  width: number
  height: number
}

/** Every tier is a resize, and resizes round to whole pixels. */
const TOLERANCE = 0.02

/**
 * Whether the pixels that landed are the row's own frame on its side.
 *
 * Deliberately narrow. A frame within a couple of percent of square is its own
 * transpose and says nothing either way, and an embedded preview that merely
 * crops differently is not a quarter turn. Only an unambiguous swap counts.
 */
export function isTurned(photo: Photo, landed: PixelSize): boolean {
  const { width, height } = photo
  if (width <= 0 || height <= 0 || landed.width <= 0 || landed.height <= 0) return false
  const row = width / height
  if (Math.abs(row - 1) <= TOLERANCE) return false
  const turned = 1 / row
  return Math.abs(landed.width / landed.height - turned) <= turned * TOLERANCE
}

/**
 * The row's dimensions as the pixels that arrived say they should be.
 *
 * Derived per render rather than latched, so the moment {@link healOrientation}
 * puts the row right the correction stops being applied instead of turning the
 * photo a second time.
 */
export function framedSize(photo: Photo, landed: PixelSize | null): PixelSize {
  return landed && isTurned(photo, landed)
    ? { width: photo.height, height: photo.width }
    : { width: photo.width, height: photo.height }
}

/** Rows already put right this session; the write only needs to happen once. */
const healed = new Set<string>()

/**
 * Writes the correction back, so the grid, Develop and the next session all
 * agree with what is already on screen.
 *
 * RAW rows are left alone: LibRaw reports oriented dimensions, Develop repairs
 * them from a real decode, and a camera's embedded preview is too unreliable a
 * witness to argue with either.
 */
export function healOrientation(photo: Photo, landed: PixelSize): void {
  if (photo.isRaw || healed.has(photo.id) || !isTurned(photo, landed)) return
  healed.add(photo.id)
  void db.photos.update(photo.id, { width: photo.height, height: photo.width })
}
