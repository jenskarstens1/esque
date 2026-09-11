/**
 * Export orchestration.
 *
 * This half runs on the main thread and owns everything that is *not* pixels:
 * catalog lookups, reading the original off disk, output naming, XMP sidecar
 * strings and writing the result back to the destination folder. Every pixel
 * operation — render, resample, sharpen, watermark, encode — happens in the
 * export worker, which is why a 45 MP export no longer freezes the UI.
 *
 * DNG is still the odd one out. A negative is not a rendering, so that path
 * skips the edit graph entirely and writes the decoder's own scene-linear
 * pixels, carrying the develop settings alongside as XMP rather than baking
 * them in. The encoding still happens in the worker; only the decision doesn't.
 */
import { db } from '../catalog/db'
import { loadPhotoFile } from '../catalog/previews'
import { rawPool, rawFailure } from '../raw/pool'
import { decodedAsShotTempTint } from '../core/color'
import { RENDERED_WHITE_POINT } from '../core/workingImage'
import { ALL_SECTIONS, defaultEdits, editsKind } from '../core/defaults'
import { editsToSidecar } from '../develop/xmp'
import type { Photo } from '../core/types'
import { renderExportInWorker, beginExportJob } from './client'
import { exportKeywords } from './metadata'
import { expandTemplate, stem, withExtension } from './naming'
import type { SizeLimitReport } from './pipeline'
import { EXTENSIONS, type ExportSettings } from './types'

export { detectFormats } from './formats'

export interface ExportOutput {
  blob: Blob
  filename: string
  width: number
  height: number
  /** XMP sidecar contents, when the settings ask for one. */
  sidecar: string | null
  /** Present only when `limitSize` was on; see {@link SizeLimitReport}. */
  limit?: SizeLimitReport
}

export interface RenderProgress {
  (stage: 'decoding' | 'rendering' | 'resizing' | 'encoding' | 'writing', fraction: number): void
}

const outputName = (photo: Photo, settings: ExportSettings, sequence: number) =>
  expandTemplate(settings.filenameTemplate, photo, sequence, settings.customText)

function sidecarXmp(photo: Photo, settings: ExportSettings, filename: string): string | null {
  return editsToSidecar(
    photo.edits ?? defaultEdits(editsKind(photo.isRaw), undefined, photo.meta.iso),
    ALL_SECTIONS,
    {
    filename,
    rating: photo.rating,
    label: photo.label === 'none' ? undefined : photo.label,
    title: photo.title || undefined,
    caption: photo.caption || undefined,
    keywords: exportKeywords(photo, settings),
    },
  )
}

/** The `.xmp` companion Lightroom would look for next to the exported file. */
const sidecarFor = (photo: Photo, settings: ExportSettings, filename: string) =>
  settings.writeSidecar ? sidecarXmp(photo, settings, filename) : null

async function exportOriginal(
  photo: Photo,
  settings: ExportSettings,
  name: string,
): Promise<ExportOutput> {
  const file = await loadPhotoFile(photo.masterId ?? photo.id)
  if (!file) throw new Error('The original file could not be found.')
  const filename = withExtension(name, photo.ext, settings.extensionCase)
  return {
    blob: file,
    filename,
    width: photo.width,
    height: photo.height,
    sidecar: sidecarFor(photo, settings, filename),
  }
}

export async function exportPhoto(
  photo: Photo,
  settings: ExportSettings,
  sequence: number,
  onProgress?: RenderProgress,
  signal?: { cancelled: boolean },
): Promise<ExportOutput> {
  const name = outputName(photo, settings, sequence)

  if (settings.format === 'original') {
    return exportOriginal(photo, settings, name)
  }

  // --- decode ---------------------------------------------------------------
  onProgress?.('decoding', 0)
  const file = await loadPhotoFile(photo.masterId ?? photo.id)
  if (!file) throw new Error('The original file could not be found.')
  const buffer = await file.arrayBuffer()

  const linear = await rawPool
    .decodeLinear(buffer, photo.isRaw, 100000, photo.meta.iso, photo.meta.rawCrop, 'full')
    .catch((err: unknown) => {
      throw new Error(rawFailure(err).reason)
    })
  if (!linear) throw new Error("This file couldn't be decoded.")
  if (signal?.cancelled) throw new Error('Export cancelled')
  onProgress?.('decoding', 1)

  const filename = withExtension(name, EXTENSIONS[settings.format], settings.extensionCase)

  // --- pixels (worker) ------------------------------------------------------
  // `linear.data` is transferred, not copied: a full-resolution 45 MP frame is
  // ~360 MB and this buffer has no other owner once the decoder is done.
  await beginExportJob()
  const result = await renderExportInWorker(
    {
      photo,
      settings,
      edits:
        photo.edits ?? defaultEdits(editsKind(photo.isRaw), undefined, photo.meta.iso),
      linear: {
        width: linear.width,
        height: linear.height,
        data: linear.data,
        fromRaw: linear.fromRaw,
        whiteLevel: linear.whiteLevel,
      },
      asShot: linear.fromRaw
        ? decodedAsShotTempTint(
            linear.meta?.camMul ?? null,
            linear.meta?.preMul ?? null,
            linear.meta?.camXyz ?? null,
          )
        : RENDERED_WHITE_POINT,
      dngXmp:
        settings.format === 'dng'
          ? (sidecarXmp(photo, settings, filename) ?? undefined)
          : undefined,
    },
    (stage, fraction) => onProgress?.(stage, fraction),
  )

  return {
    blob: result.blob,
    filename,
    width: result.width,
    height: result.height,
    sidecar: sidecarFor(photo, settings, filename),
    limit: result.limit,
  }
}

/** Resolves name collisions in the destination directory. */
export async function uniqueName(
  dir: FileSystemDirectoryHandle,
  filename: string,
  policy: ExportSettings['overwrite'],
): Promise<string | null> {
  const exists = async (name: string) => {
    try {
      await dir.getFileHandle(name)
      return true
    } catch {
      return false
    }
  }
  if (!(await exists(filename))) return filename
  if (policy === 'overwrite') return filename
  if (policy === 'skip') return null

  const base = stem(filename)
  const ext = filename.slice(base.length)
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}${ext}`
    if (!(await exists(candidate))) return candidate
  }
  return null
}

export async function writeFile(
  dir: FileSystemDirectoryHandle,
  filename: string,
  blob: Blob,
): Promise<void> {
  const handle = await dir.getFileHandle(filename, { create: true })
  const stream = await handle.createWritable()
  await stream.write(blob)
  await stream.close()
}

/** Creates (or reuses) the destination subfolder. */
export async function resolveDestination(
  root: FileSystemDirectoryHandle,
  subfolder: string,
): Promise<FileSystemDirectoryHandle> {
  const clean = subfolder.trim().replace(/^\/+|\/+$/g, '')
  if (!clean) return root
  let dir = root
  for (const part of clean.split('/')) {
    if (!part) continue
    dir = await dir.getDirectoryHandle(part, { create: true })
  }
  return dir
}

export async function loadPhotos(ids: string[]): Promise<Photo[]> {
  const rows = await db.photos.bulkGet(ids)
  return rows.filter((p): p is Photo => !!p)
}
