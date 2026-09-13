import { db } from "./db";
import { cacheDelete, cacheWrite, thumbKey } from "./opfs";
import {
  extOf,
  isRawFile,
  isSupported,
  scanFolder,
  type ScannedFile,
  type LocalFile,
} from "./fs";
import { prepareOriginal } from "./originals";
import {
  rawPool,
  rawFailure,
  failureReason,
  RAW_POOL_SIZE,
  type DecodedMeta,
} from "../raw/pool";
import { nextId } from "../lib/math";
import { detectHdrContent } from "../core/hdrContent";
import { applySidecarText, sidecarNames } from "./sidecar";
import { useUI } from "../state/ui";
import type { CatalogFolder, Photo, PhotoMetadata } from "../core/types";

export interface ImportProgress {
  phase: "scanning" | "reading" | "developing" | "done" | "cancelled";
  total: number;
  done: number;
  skipped: number;
  current: string;
}

const emptyMeta = (): PhotoMetadata => ({
  cameraMake: "",
  cameraModel: "",
  lens: "",
  iso: 0,
  shutter: 0,
  aperture: 0,
  focalLength: 0,
  captureTime: null,
  artist: "",
  copyright: "",
  gps: null,
  flip: 0,
  camMul: null,
  preMul: null,
  camXyz: null,
  black: null,
  maximum: null,
});

/**
 * EXIF orientations 5–8 store the frame a quarter turn from how it displays.
 * Every decoder here asks the browser for `from-image`, so the pixels arrive
 * already turned and the catalog has to describe them that way round.
 */
const TURNED = new Set([5, 6, 7, 8]);

/** Metadata for rendered files, where LibRaw isn't involved. */
async function readExif(
  file: File,
): Promise<Partial<PhotoMetadata> & { width?: number; height?: number }> {
  try {
    // exifr is ~120 kB and only needed for non-RAW files, so it stays out of
    // the initial bundle and loads on the first rendered-file import.
    const { default: exifr } = await import("exifr");
    const e = await exifr.parse(file, {
      tiff: true,
      exif: true,
      gps: true,
      // Orientation is wanted as the number, not as exifr's prose for it.
      // Nothing else picked here is an enumeration.
      translateValues: false,
      pick: [
        "Make",
        "Model",
        "LensModel",
        "ISO",
        "ExposureTime",
        "FNumber",
        "FocalLength",
        "DateTimeOriginal",
        "CreateDate",
        "Artist",
        "Copyright",
        "Orientation",
        "ExifImageWidth",
        "ExifImageHeight",
        "latitude",
        "longitude",
      ],
    });
    if (!e) return {};
    const date = e.DateTimeOriginal ?? e.CreateDate;
    // `ExifImageWidth`/`Height` are the stored frame, before the orientation
    // tag is applied. Taking them at face value catalogues a portrait photo as
    // landscape, and every box laid out from that row then stretches it.
    const turned = TURNED.has(Number(e.Orientation));
    return {
      cameraMake: e.Make ?? "",
      cameraModel: e.Model ?? "",
      lens: e.LensModel ?? "",
      iso: e.ISO ?? 0,
      shutter: e.ExposureTime ?? 0,
      aperture: e.FNumber ?? 0,
      focalLength: e.FocalLength ?? 0,
      captureTime: date instanceof Date ? date.getTime() : null,
      artist: e.Artist ?? "",
      copyright: e.Copyright ?? "",
      gps:
        typeof e.latitude === "number" && typeof e.longitude === "number"
          ? { lat: e.latitude, lon: e.longitude, alt: 0 }
          : null,
      width: turned ? e.ExifImageHeight : e.ExifImageWidth,
      height: turned ? e.ExifImageWidth : e.ExifImageHeight,
    };
  } catch {
    return {};
  }
}

async function bitmapSize(
  file: File,
): Promise<{ width: number; height: number }> {
  try {
    // Same orientation the previews and the loupe will decode with, spelled out
    // rather than left to the browser's default.
    const bmp = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    return size;
  } catch {
    return { width: 0, height: 0 };
  }
}

function assignDecodedMetadata(meta: PhotoMetadata, decoded: DecodedMeta | null) {
  if (!decoded) return { width: 0, height: 0 };
  Object.assign(meta, {
    cameraMake: decoded.cameraMake,
    cameraModel: decoded.cameraModel,
    lens: decoded.lens,
    iso: decoded.iso,
    shutter: decoded.shutter,
    aperture: decoded.aperture,
    focalLength: decoded.focalLength,
    captureTime: decoded.captureTime,
    artist: decoded.artist,
    gps: decoded.gps,
    flip: decoded.flip,
    camMul: decoded.camMul,
    preMul: decoded.preMul,
    camXyz: decoded.camXyz,
    black: decoded.black,
    maximum: decoded.maximum,
    rawCrop: decoded.rawCrop,
    embeddedWidth: decoded.thumbWidth,
    embeddedHeight: decoded.thumbHeight,
  });
  return { width: decoded.width, height: decoded.height };
}

async function assignRenderedMetadata(file: File, meta: PhotoMetadata) {
  const exif = await readExif(file);
  Object.assign(meta, exif);
  let width = exif.width ?? 0;
  let height = exif.height ?? 0;
  if (!width || !height) {
    const bitmap = await bitmapSize(file);
    width = bitmap.width;
    height = bitmap.height;
  }
  return { width, height };
}

async function readImportSidecar(scanned: ScannedFile) {
  if (!scanned.sidecar || !useUI.getState().importSidecars) return null;
  if (scanned.sidecar instanceof File) return scanned.sidecar.text();
  return scanned.sidecar
    .getFile()
    .then((file) => file.text())
    .catch(() => null);
}

/** Reads one file into a catalog record and caches its thumbnail. */
async function ingest(
  folderId: string,
  scanned: ScannedFile,
  now: number,
  signal?: AbortSignal,
  loose = false,
  id = nextId(),
): Promise<Photo | null> {
  const file = scanned.handle ? await scanned.handle.getFile() : scanned.file;
  const isRaw = isRawFile(scanned.name);
  const meta = emptyMeta();
  let failure: string | null = null;

  // Read before the decoder gets the file: `ingest` detaches the buffer it is
  // handed, so anything derived from the bytes has to be taken first.
  const hdr = await detectHdrContent(file, isRaw);

  // One read, one transfer, one LibRaw open. The buffer is detached into the
  // worker, so anything that needs it afterwards has to be derived from the
  // result rather than from a second copy.
  const result = await rawPool
    .ingest(await file.arrayBuffer(), isRaw, 512, signal)
    .catch((err: unknown) => {
      if (signal?.aborted) throw err;
      failure = rawFailure(err).reason;
      return null;
    });

  let { width, height } = assignDecodedMetadata(meta, result?.meta ?? null);

  if (!isRaw) {
    ({ width, height } = await assignRenderedMetadata(file, meta));
  }

  // A file whose metadata failed usually still has a readable embedded preview,
  // so it stays in the catalog with a reason rather than vanishing silently.
  if (!failure && result?.failure) failure = failureReason(result.failure);

  let thumbCacheKey: string | null = null;
  if (result?.thumb) {
    thumbCacheKey = thumbKey(id);
    await cacheWrite(thumbCacheKey, result.thumb);
  } else if (!failure) {
    failure = "This file couldn't be read";
  }

  // A sidecar beside the file is the photograph's history in another
  // application — the stars it was given, the keywords it was filed under, the
  // develop settings it already carries. Reading it at import is what makes a
  // Lightroom library arrive here looking like itself rather than like a folder
  // of untouched originals.
  const sidecarXml = await readImportSidecar(scanned);
  const fromSidecar = sidecarXml ? applySidecarText(sidecarXml) : null;

  return {
    id,
    folderId,
    relPath: scanned.relPath,
    filename: scanned.name,
    ext: extOf(scanned.name),
    isRaw,
    hdr,
    fileSize: scanned.size,
    modifiedAt: scanned.modifiedAt,
    addedAt: now,
    width,
    height,
    meta,
    rating: 0,
    flag: "unflagged",
    label: "none",
    keywords: [],
    title: "",
    caption: "",
    edits: null,
    ...(fromSidecar?.changes ?? {}),
    thumbKey: thumbCacheKey,
    proxyKey: null,
    masterId: null,
    copyName: null,
    stackId: null,
    stackPosition: 0,
    stackCollapsed: false,
    readError: failure,
    fileHandle: loose ? scanned.handle ?? null : null,
  };
}

function validateImportPath(path: string) {
  if (!path || path.startsWith("/") || path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid import path: ${path}`);
  }
}

function uniqueImportPath(path: string, used: Set<string>) {
  const dot = path.lastIndexOf(".");
  let candidate = path;
  for (let n = 2; used.has(candidate); n++) {
    candidate = dot > path.lastIndexOf("/")
      ? `${path.slice(0, dot)} (${n})${path.slice(dot)}`
      : `${path} (${n})`;
  }
  return candidate;
}

/**
 * Files selected without native handles are copied into durable catalog storage.
 * The source and photo commit together; cache eviction never owns originals.
 */
export async function importLocalFiles(
  sources: LocalFile[],
  opts: {
    signal?: AbortSignal;
    onProgress?: (p: ImportProgress) => void;
  } = {},
) {
  const { signal, onProgress } = opts;
  const picked = sources.filter(({ file }) => isSupported(file.name));
  const sidecars = new Map(sources
    .filter(({ file }) => file.name.toLowerCase().endsWith(".xmp"))
    .map(({ file, path }) => [path.toLowerCase(), file]));
  const folder = await looseFolder();
  const used = new Set(await db.photos.where("folderId").equals(folder.id)
    .toArray().then((photos) => photos.map((photo) => photo.relPath)));
  const imported: string[] = [];
  let skipped = 0;
  let failed = 0;
  let done = 0;
  let storageFull = false;
  const report = (patch: Partial<ImportProgress> = {}) => onProgress?.({
    phase: "reading", total: picked.length, done, skipped, current: "", ...patch,
  });
  for (const { file, path } of picked) {
    if (signal?.aborted) break;
    report({ current: path });
    const id = nextId();
    try {
      validateImportPath(path);
      const sidecar = sidecarNames(path).map((name) => sidecars.get(name.toLowerCase())).find(Boolean);
      const original = await prepareOriginal(id, file, path, sidecar);
      signal?.throwIfAborted();
      const prior = await db.originals.where("identity").equals(original.identity).primaryKeys();
      if ((await db.photos.bulkGet(prior)).some(Boolean)) {
        skipped++;
        done++;
        report();
        continue;
      }
      const relPath = uniqueImportPath(path, used);
      const photo = await ingest(folder.id, {
        file, relPath, name: file.name, size: file.size,
        modifiedAt: file.lastModified, sidecar,
      }, Date.now(), signal, true, id);
      signal?.throwIfAborted();
      if (photo) {
        await db.transaction("rw", [db.photos, db.originals], async () => {
          await db.originals.put(original);
          await db.photos.put(photo);
        });
        used.add(relPath);
        imported.push(photo.id);
      }
    } catch (error) {
      await cacheDelete(thumbKey(id));
      if (signal?.aborted) break;
      console.error(`[esque] Could not import ${path}.`, error);
      failed++;
      // Continuing after exhausted storage would fail every remaining photo.
      if (error instanceof Error && error.name === "QuotaExceededError") {
        storageFull = true;
        break;
      }
    }
    done++;
    report();
  }
  const photoCount = await db.photos.where("folderId").equals(folder.id).count();
  await db.folders.update(folder.id, { photoCount });
  if (storageFull) {
    throw new Error(`Browser storage is full. ${imported.length} photos were imported before stopping. Free space or use a browser with native folder access.`);
  }
  await runImportDefaults(imported, signal, report, skipped);
  report({ phase: signal?.aborted ? "cancelled" : "done" });
  return { folder: { ...folder, photoCount }, added: imported.length, skipped, failed };
}

/**
 * Imports a folder into the catalog.
 *
 * Files already present (same folder + relative path) are skipped, so
 * re-importing a folder to pick up new shots is cheap and non-destructive —
 * existing ratings and edits survive.
 */
export async function importFolder(
  handle: FileSystemDirectoryHandle,
  opts: {
    recursive?: boolean;
    signal?: AbortSignal;
    onProgress?: (p: ImportProgress) => void;
  } = {},
): Promise<{
  folder: CatalogFolder;
  added: number;
  skipped: number;
  failed: number;
}> {
  const { signal, onProgress, recursive = true } = opts;
  const report = (p: Partial<ImportProgress>) =>
    onProgress?.({
      phase: "reading",
      total: 0,
      done: 0,
      skipped: 0,
      current: "",
      ...p,
    } as ImportProgress);

  report({ phase: "scanning" });
  const files = await scanFolder(handle, {
    recursive,
    signal,
    onProgress: (found, current) =>
      report({ phase: "scanning", total: found, done: 0, current }),
  });

  // Reuse the folder record if this directory was imported before.
  const existingFolders = await db.folders.toArray();
  let folder: CatalogFolder | undefined;
  for (const f of existingFolders) {
    if (!f.handle) continue;
    if (await f.handle.isSameEntry?.(handle)) {
      folder = f;
      break;
    }
  }
  if (!folder) {
    folder = {
      id: nextId(),
      name: handle.name,
      handle,
      addedAt: Date.now(),
      photoCount: 0,
    };
    await db.folders.add(folder);
  } else {
    // Refresh the stored handle so permissions attach to the newly granted one.
    await db.folders.update(folder.id, { handle });
  }

  const known = new Set(
    (await db.photos.where("folderId").equals(folder.id).toArray()).map(
      (p) => p.relPath,
    ),
  );
  const fresh = files.filter((f) => !known.has(f.relPath));
  const skipped = files.length - fresh.length;

  const now = Date.now();
  let done = 0;
  let added = 0;
  // Every in-flight ingest holds a whole file in memory while it waits for a
  // decoder, so there's no point queueing more of them than there are workers
  // to consume them — a folder of 100 MB raws would just pile up heap.
  // Leave one decoder slot available for a foreground Develop request. Import
  // jobs are cheap embedded-preview reads, but a queue of them should never make
  // opening the selected photo wait behind the whole batch.
  const CONCURRENCY = Math.max(1, RAW_POOL_SIZE - 1);
  const queue = [...fresh];
  const imported: string[] = [];

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, queue.length) },
    async () => {
      while (queue.length) {
        if (signal?.aborted) return;
        const item = queue.shift()!;
        report({
          phase: "reading",
          total: fresh.length,
          done,
          skipped,
          current: item.name,
        });
        try {
          const photo = await ingest(folder!.id, item, now, signal);
          if (photo) {
            await db.photos.put(photo);
            imported.push(photo.id);
            added++;
          }
        } catch {
          if (signal?.aborted) return;
          /* one unreadable file shouldn't abort the whole import */
        }
        done++;
        report({
          phase: "reading",
          total: fresh.length,
          done,
          skipped,
          current: item.name,
        });
      }
    },
  );

  await Promise.all(workers);

  const photoCount = await db.photos
    .where("folderId")
    .equals(folder.id)
    .count();
  await db.folders.update(folder.id, { photoCount });

  await runImportDefaults(imported, signal, report, skipped);

  report({
    phase: signal?.aborted ? "cancelled" : "done",
    total: fresh.length,
    done,
    skipped,
    current: "",
  });

  return {
    folder: { ...folder, photoCount },
    added,
    skipped,
    failed: done - added,
  };
}

/** Re-scans a known folder for files added since the last import. */
export async function syncFolder(
  folder: CatalogFolder,
  opts: {
    signal?: AbortSignal;
    onProgress?: (p: ImportProgress) => void;
  } = {},
) {
  if (!folder.handle) {
    // Loose files have no directory to re-scan.
    return { folder, added: 0, skipped: 0, failed: 0 };
  }
  return importFolder(folder.handle, opts);
}

export const LOOSE_FOLDER_NAME = "Imported Files";

/**
 * The optional second pass — applying a look, finding a tone, building
 * previews — reported as its own phase.
 *
 * It runs after the folder count is written and before "done", so the grid is
 * already populated and navigable while it works. Aborting an import stops it
 * the same way it stops reading: the photographs already handled keep what they
 * were given, because a half-developed import is still a real import.
 */
async function runImportDefaults(
  ids: string[],
  signal: AbortSignal | undefined,
  report: (p: Partial<ImportProgress>) => void,
  skipped: number,
) {
  if (signal?.aborted || !ids.length) return;
  const { hasImportDefaults, applyImportDefaults } = await import(
    "./importDefaults"
  );
  if (!hasImportDefaults()) return;

  report({
    phase: "developing",
    total: ids.length,
    done: 0,
    skipped,
    current: "",
  });
  await applyImportDefaults(ids, {
    signal,
    onProgress: (p) =>
      report({
        phase: "developing",
        total: p.total,
        done: p.done,
        skipped,
        current: p.current,
      }),
  });
}

/** Finds or creates the synthetic folder that holds individually picked files. */
async function looseFolder(): Promise<CatalogFolder> {
  const existing = (await db.folders.toArray()).find((f) => f.loose);
  if (existing) return existing;
  const folder: CatalogFolder = {
    id: nextId(),
    name: LOOSE_FOLDER_NAME,
    handle: null,
    loose: true,
    addedAt: Date.now(),
    photoCount: 0,
  };
  await db.folders.add(folder);
  return folder;
}

/**
 * Imports individually picked files. They land in one synthetic folder and
 * keep their own file handles, so Develop can re-read them later without a
 * directory to resolve against.
 */
export async function importFiles(
  handles: FileSystemFileHandle[],
  opts: {
    signal?: AbortSignal;
    onProgress?: (p: ImportProgress) => void;
  } = {},
): Promise<{
  folder: CatalogFolder;
  added: number;
  skipped: number;
  failed: number;
}> {
  const { signal, onProgress } = opts;
  const report = (p: Partial<ImportProgress>) =>
    onProgress?.({
      phase: "reading",
      total: 0,
      done: 0,
      skipped: 0,
      current: "",
      ...p,
    } as ImportProgress);

  report({ phase: "scanning" });
  const picked = handles.filter((h) => isSupported(h.name));

  const folder = await looseFolder();
  const existing = await db.photos
    .where("folderId")
    .equals(folder.id)
    .toArray();
  const known = new Map(existing.map((p) => [p.relPath, p]));
  const used = new Set(known.keys());

  const scanned: ScannedFile[] = [];
  let skipped = 0;
  for (const handle of picked) {
    if (signal?.aborted) break;
    const file = await handle.getFile();
    // The same filename can arrive from different directories, so identical
    // name + size + timestamp counts as a duplicate and anything else gets a
    // unique path rather than silently overwriting.
    const prior = known.get(handle.name);
    if (
      prior &&
      prior.fileSize === file.size &&
      prior.modifiedAt === file.lastModified
    ) {
      skipped++;
      continue;
    }
    const relPath = uniqueImportPath(handle.name, used);
    const item = {
      handle,
      relPath,
      name: handle.name,
      size: file.size,
      modifiedAt: file.lastModified,
    };
    used.add(relPath);
    scanned.push(item);
    report({
      phase: "scanning",
      total: scanned.length,
      skipped,
      current: handle.name,
    });
  }

  const now = Date.now();
  let done = 0;
  let added = 0;
  const CONCURRENCY = Math.max(1, RAW_POOL_SIZE - 1);
  const queue = [...scanned];
  const imported: string[] = [];

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, queue.length) },
    async () => {
      while (queue.length) {
        if (signal?.aborted) return;
        const item = queue.shift()!;
        report({
          phase: "reading",
          total: scanned.length,
          done,
          skipped,
          current: item.name,
        });
        try {
          const photo = await ingest(folder.id, item, now, signal, true);
          if (photo) {
            await db.photos.put(photo);
            imported.push(photo.id);
            added++;
          }
        } catch {
          if (signal?.aborted) return;
        }
        done++;
        report({
          phase: "reading",
          total: scanned.length,
          done,
          skipped,
          current: item.name,
        });
      }
    },
  );

  await Promise.all(workers);

  const photoCount = await db.photos
    .where("folderId")
    .equals(folder.id)
    .count();
  await db.folders.update(folder.id, { photoCount });

  await runImportDefaults(imported, signal, report, skipped);

  report({
    phase: signal?.aborted ? "cancelled" : "done",
    total: scanned.length,
    done,
    skipped,
    current: "",
  });

  return {
    folder: { ...folder, photoCount },
    added,
    skipped,
    failed: done - added,
  };
}
