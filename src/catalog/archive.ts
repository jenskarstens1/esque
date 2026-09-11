import { db } from './db'
import { isAiGeometry, type CatalogFolder, type Edits, type MaskGeometry, type Photo, type Preset, type Snapshot } from '../core/types'
import {
  CATALOG_ARCHIVE_VERSION,
  MAX_ARCHIVE_BYTES,
  validateCatalogArchive,
  type CatalogArchive,
  type PortableEdits,
  type PortableFolder,
  type PortableGeometry,
  type PortableMask,
  type PortablePhoto,
  type PortablePreset,
  type PortableSnapshot,
} from './schema'

type CatalogTables = Pick<typeof db, 'photos' | 'folders' | 'collections' | 'presets' | 'snapshots' | 'originals'>
export interface CatalogDatabase extends CatalogTables {
  transaction<T>(
    mode: 'r' | 'rw',
    tables: readonly CatalogTables[keyof CatalogTables][],
    scope: () => Promise<T>,
  ): Promise<T>
}

export const catalogTables = (database: CatalogDatabase) =>
  [database.photos, database.folders, database.collections, database.presets, database.snapshots]

/**
 * Strips the cached-alpha pointers on the way into an archive, all the way
 * down through groups: a cache key names local storage on the machine that
 * detected it and means nothing anywhere else.
 */
function portableLayers(layers: Edits['layers']): PortableMask[] {
  return layers.map((layer) => ({
    ...layer,
    components: layer.components.map((component) => {
      if (!isAiGeometry(component.geometry)) return component
      const { cacheKey: _cacheKey, ...geometry } = component.geometry
      return { ...component, geometry }
    }),
    children: layer.children ? portableLayers(layer.children) : null,
  }))
}

export function portableEdits(edits: Edits): PortableEdits {
  return { ...edits, layers: portableLayers(edits.layers) }
}

function localGeometry(geometry: PortableGeometry): MaskGeometry {
  switch (geometry.kind) {
    case 'aiSubject':
    case 'aiSky':
    case 'aiBackground':
    case 'aiPerson':
    case 'aiObjects':
      return { ...geometry, cacheKey: null }
    default:
      return geometry
  }
}

/** The reverse: every detected component comes back needing detection again. */
function localLayers(layers: PortableMask[]): Edits['layers'] {
  return layers.map((layer) => ({
    ...layer,
    components: layer.components.map((component) => ({
      ...component,
      geometry: localGeometry(component.geometry),
    })),
    children: layer.children ? localLayers(layer.children) : null,
  }))
}

export function localEdits(edits: PortableEdits): Edits {
  return { ...edits, layers: localLayers(edits.layers) }
}

export function portablePhoto(photo: Photo): PortablePhoto {
  const meta = photo.meta
  return {
    id: photo.id, folderId: photo.folderId, relPath: photo.relPath,
    filename: photo.filename, ext: photo.ext, isRaw: photo.isRaw, hdr: photo.hdr,
    fileSize: photo.fileSize, modifiedAt: photo.modifiedAt, addedAt: photo.addedAt,
    width: photo.width, height: photo.height,
    meta: {
      cameraMake: meta.cameraMake, cameraModel: meta.cameraModel, lens: meta.lens,
      iso: meta.iso, shutter: meta.shutter, aperture: meta.aperture, focalLength: meta.focalLength,
      captureTime: meta.captureTime, artist: meta.artist, copyright: meta.copyright, gps: meta.gps,
      flip: meta.flip, camMul: meta.camMul, preMul: meta.preMul ?? null, camXyz: meta.camXyz,
      black: meta.black, maximum: meta.maximum, rawCrop: meta.rawCrop,
      embeddedWidth: meta.embeddedWidth, embeddedHeight: meta.embeddedHeight,
    },
    rating: photo.rating, flag: photo.flag, label: photo.label, keywords: photo.keywords,
    title: photo.title, caption: photo.caption, edits: photo.edits ? portableEdits(photo.edits) : null,
    masterId: photo.masterId, copyName: photo.copyName, stackId: photo.stackId,
    stackPosition: photo.stackPosition, stackCollapsed: photo.stackCollapsed,
  }
}

export function portableFolder(folder: CatalogFolder): PortableFolder {
  return {
    id: folder.id, name: folder.name, loose: folder.loose,
    addedAt: folder.addedAt, photoCount: folder.photoCount,
  }
}

export function portablePreset(preset: Preset): PortablePreset {
  const { layers, ...edits } = preset.edits
  return {
    id: preset.id, name: preset.name, group: preset.group, builtin: preset.builtin,
    sections: preset.sections, paths: preset.paths, createdAt: preset.createdAt,
    edits: layers === undefined ? edits : { ...edits, layers: portableLayers(layers) },
  }
}

export function localPreset(preset: PortablePreset): Preset {
  const { layers, ...edits } = preset.edits
  return {
    ...preset,
    edits: layers === undefined ? edits : { ...edits, layers: localLayers(layers) },
  }
}

export function portableSnapshot(snapshot: Snapshot): PortableSnapshot {
  return {
    id: snapshot.id, photoId: snapshot.photoId, name: snapshot.name,
    edits: portableEdits(snapshot.edits), createdAt: snapshot.createdAt,
  }
}

export const MISSING_ORIGINAL = 'Original not connected. Open Settings → Files → Catalog backup → Reconnect originals.'

export function localPhoto(photo: PortablePhoto): Photo {
  return {
    ...photo,
    edits: photo.edits ? localEdits(photo.edits) : null,
    thumbKey: null, proxyKey: null, thumbRev: photo.edits ? 1 : 0, fileHandle: null,
    readError: MISSING_ORIGINAL,
  }
}

export async function flushCatalogEdits(database: CatalogDatabase) {
  if (database === db) {
    const { useDevelop } = await import('../develop/session')
    await useDevelop.getState().flush()
  }
}

/** A consistent, read-only snapshot, taken only after pending edits are durable. */
export async function createCatalogArchive(database: CatalogDatabase = db): Promise<CatalogArchive> {
  await flushCatalogEdits(database)
  return database.transaction('r', catalogTables(database), async () => {
    const [photos, folders, collections, presets, snapshots] = await Promise.all([
      database.photos.toArray(), database.folders.toArray(), database.collections.toArray(),
      database.presets.toArray(), database.snapshots.toArray(),
    ])
    return validateCatalogArchive({
      format: 'esque.catalog', version: CATALOG_ARCHIVE_VERSION, createdAt: Date.now(),
      photos: photos.map(portablePhoto), folders: folders.map(portableFolder),
      collections,
      collectionSetIds: [...new Set(collections.flatMap((collection) => collection.setId ? [collection.setId] : []))],
      presets: presets.filter((preset) => !preset.builtin).map(portablePreset),
      snapshots: snapshots.map(portableSnapshot),
    })
  })
}

export function archiveBlob(archive: CatalogArchive): Blob {
  const blob = new Blob([JSON.stringify(archive)], { type: 'application/json' })
  if (blob.size > MAX_ARCHIVE_BYTES) throw new Error('This catalog exceeds the 64 MB portable backup limit.')
  return blob
}

export function archiveFilename(at = new Date()): string {
  return `esque-catalog-${at.toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z')}.esque.json`
}

/** Counts layers that must be detected again; cache pixels are not catalog data. */
export function archiveDetectionCount(archive: CatalogArchive): number {
  const count = (edits: Partial<PortableEdits> | null) =>
    edits?.layers?.reduce((sum, mask) => sum +
      mask.components.filter((component) => component.geometry.kind.startsWith('ai')).length, 0) ?? 0
  return archive.photos.reduce((sum, photo) => sum + count(photo.edits), 0) +
    archive.snapshots.reduce((sum, snapshot) => sum + count(snapshot.edits), 0) +
    archive.presets.reduce((sum, preset) => sum + count(preset.edits), 0)
}
