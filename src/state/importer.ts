import { create } from 'zustand'
import { importFiles, importFolder, syncFolder, type ImportProgress } from '../catalog/import'
import { filePickerSupported, fsSupported, isSupported, pickFiles, pickFolder } from '../catalog/fs'
import { scheduleEvict } from '../catalog/opfs'
import { useCatalog } from './catalog'
import { toast } from '../design/toast'
import type { CatalogFolder } from '../core/types'

/**
 * Where a job is in a run made of several sources.
 *
 * A drop can carry three folders and a handful of loose files, and each of
 * those is a separate scan with its own file count. Without this the HUD would
 * restart at zero four times with nothing to say why.
 */
export interface ImportBatch {
  /** Sources finished so far, so the one in progress is `done + 1`. */
  done: number
  total: number
}

interface ImporterState {
  active: boolean
  cancelling: boolean
  progress: ImportProgress | null
  /** Set only while a run covers more than one source. */
  batch: ImportBatch | null
  controller: AbortController | null
  run: (handle?: FileSystemDirectoryHandle | null) => Promise<void>
  /** Imports individually picked files rather than a whole folder. */
  runFiles: (handles?: FileSystemFileHandle[] | null, multiple?: boolean) => Promise<void>
  /** Imports a dropped mix of folders and files as one job. */
  runDropped: (handles: FileSystemHandle[]) => Promise<void>
  sync: (folder: CatalogFolder) => Promise<void>
  cancel: () => void
}

interface ImportResult {
  /** What the summary calls this import: a folder name, or how many there were. */
  name: string
  added: number
  skipped: number
  failed: number
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm
}

function showImportResult(
  result: ImportResult,
  cancelled: boolean,
  source: 'folder' | 'files',
) {
  const { name, added, skipped, failed } = result
  if (cancelled) {
    toast.show('Import cancelled', {
      detail: `${added} ${plural(added, 'photo')} added before stopping`,
    })
    return
  }
  if (added > 0) {
    const notes = [
      skipped ? `${skipped} already in the catalog` : '',
      failed ? `${failed} could not be read` : '',
    ].filter(Boolean)
    toast.show(`Imported ${added} ${plural(added, 'photo')}`, {
      detail: notes.join(' · ') || name,
    })
    return
  }
  if (failed > 0) {
    const title = source === 'folder' ? 'No photos could be imported' : 'Nothing could be imported'
    toast.error(title, `${failed} ${plural(failed, 'file')} could not be read.`)
    return
  }
  if (skipped > 0) {
    const title = source === 'folder' ? 'Already up to date' : 'Already in the catalog'
    const detail = source === 'folder'
      ? `${skipped} ${plural(skipped, 'photo')} already in the catalog`
      : `${skipped} ${plural(skipped, 'file')} skipped`
    toast.show(title, { detail })
    return
  }
  const detail = source === 'folder'
    ? 'No supported photos were found in that folder.'
    : 'No supported photos were selected.'
  toast.show('Nothing to import', { detail })
}

function showImportError(error: unknown, cancelled: boolean) {
  if (cancelled) {
    toast.show('Import cancelled')
    return
  }
  toast.error('Import failed', error instanceof Error ? error.message : String(error))
}

/**
 * What a summary calls a drop.
 *
 * One folder is its own name, because that is what was dragged. Several are
 * counted rather than listed — a toast that names four directories is a list,
 * not a sentence — and loose files are counted beside them, since "Imported
 * Files" is an implementation detail of where they went, not of what was
 * dropped.
 */
function droppedName(
  folders: number,
  files: number,
  landed: CatalogFolder | null,
): string {
  const parts = [
    folders ? `${folders} ${plural(folders, 'folder')}` : '',
    files ? `${files} ${plural(files, 'file')}` : '',
  ].filter(Boolean)
  if (folders === 1 && !files) return landed?.name ?? parts.join(' and ')
  return parts.join(' and ')
}

export const useImporter = create<ImporterState>((set, get) => ({
  active: false,
  cancelling: false,
  progress: null,
  batch: null,
  controller: null,

  run: async (given) => {
    if (get().active) return
    if (!fsSupported()) {
      toast.error('Folder access unavailable', 'esque needs a Chromium browser to read folders.')
      return
    }
    const handle = given ?? (await pickFolder())
    if (!handle) return

    const controller = new AbortController()
    set({
      active: true,
      cancelling: false,
      controller,
      progress: { phase: 'scanning', total: 0, done: 0, skipped: 0, current: '' },
    })

    try {
      const result = await importFolder(handle, {
        signal: controller.signal,
        onProgress: (progress) => set({ progress }),
      })
      const { folder } = result
      useCatalog.getState().setSource({ kind: 'folder', id: folder.id })
      scheduleEvict(true)
      showImportResult({ ...result, name: folder.name }, controller.signal.aborted, 'folder')
    } catch (err) {
      showImportError(err, controller.signal.aborted)
    } finally {
      set({ active: false, cancelling: false, controller: null, progress: null, batch: null })
    }
  },

  runFiles: async (given, multiple = false) => {
    if (get().active) return
    if (!filePickerSupported()) {
      toast.error('File access unavailable', 'esque needs a Chromium browser to read files.')
      return
    }
    const handles = given?.length ? given : await pickFiles(multiple)
    if (!handles.length) return

    const controller = new AbortController()
    set({
      active: true,
      cancelling: false,
      controller,
      progress: { phase: 'scanning', total: 0, done: 0, skipped: 0, current: '' },
    })

    try {
      const result = await importFiles(handles, {
        signal: controller.signal,
        onProgress: (progress) => set({ progress }),
      })
      const { folder } = result
      useCatalog.getState().setSource({ kind: 'folder', id: folder.id })
      scheduleEvict(true)
      showImportResult({ ...result, name: folder.name }, controller.signal.aborted, 'files')
    } catch (err) {
      showImportError(err, controller.signal.aborted)
    } finally {
      set({ active: false, cancelling: false, controller: null, progress: null, batch: null })
    }
  },

  /**
   * Imports what was dropped on the window: any number of folders, any number
   * of loose files, in whatever mixture the photographer dragged.
   *
   * Each source is imported the way it would have been had it been picked —
   * folders keep their directory handle and their structure, loose files go to
   * the synthetic folder that can re-read them — but the run is one job. One
   * cancel button stops the lot, and one summary reports it, because dropping
   * four folders was one action and four toasts would read as four mistakes.
   */
  runDropped: async (handles) => {
    if (get().active) {
      toast.show('Import already running', {
        detail: 'Wait for it to finish, then drop these in.',
      })
      return
    }
    const folders = handles.filter(
      (h): h is FileSystemDirectoryHandle => h.kind === 'directory',
    )
    const files = handles.filter((h): h is FileSystemFileHandle => h.kind === 'file')
    const loose = files.filter((h) => isSupported(h.name))
    if (!folders.length && !loose.length) {
      toast.show('Nothing to import', {
        detail: files.length
          ? 'None of those files are photos esque can read.'
          : 'Drop a folder or a photo.',
      })
      return
    }

    const controller = new AbortController()
    // The loose files are one source however many of them there are: they are
    // scanned, counted and reported together.
    const total = folders.length + (loose.length ? 1 : 0)
    const batch = (done: number) => (total > 1 ? { done, total } : null)
    set({
      active: true,
      cancelling: false,
      controller,
      batch: batch(0),
      progress: { phase: 'scanning', total: 0, done: 0, skipped: 0, current: '' },
    })

    const opts = {
      signal: controller.signal,
      onProgress: (progress: ImportProgress) => set({ progress }),
    }
    const totals = { added: 0, skipped: 0, failed: 0 }
    let landed: CatalogFolder | null = null
    let done = 0

    try {
      for (const handle of folders) {
        if (controller.signal.aborted) break
        set({ batch: batch(done) })
        const result = await importFolder(handle, opts)
        totals.added += result.added
        totals.skipped += result.skipped
        totals.failed += result.failed
        landed = result.folder
        done++
      }
      if (loose.length && !controller.signal.aborted) {
        set({ batch: batch(done) })
        const result = await importFiles(loose, opts)
        totals.added += result.added
        totals.skipped += result.skipped
        totals.failed += result.failed
        landed = result.folder
      }

      if (landed) {
        // The last source imported is the one the Library opens on, which for a
        // single drop is the only one and for several is the one that finished.
        useCatalog.getState().setSource({ kind: 'folder', id: landed.id })
        scheduleEvict(true)
      }
      showImportResult(
        { ...totals, name: droppedName(folders.length, loose.length, landed) },
        controller.signal.aborted,
        folders.length ? 'folder' : 'files',
      )
    } catch (err) {
      showImportError(err, controller.signal.aborted)
    } finally {
      set({ active: false, cancelling: false, controller: null, progress: null, batch: null })
    }
  },

  sync: async (folder) => {
    if (get().active) return
    const controller = new AbortController()
    set({
      active: true,
      cancelling: false,
      controller,
      progress: { phase: 'scanning', total: 0, done: 0, skipped: 0, current: '' },
    })
    try {
      const { added, failed } = await syncFolder(folder, {
        signal: controller.signal,
        onProgress: (progress) => set({ progress }),
      })
      if (controller.signal.aborted) {
        toast.show('Sync cancelled', {
          detail: added ? `${added} new photo${added === 1 ? '' : 's'} added before stopping` : folder.name,
        })
      } else if (!added && failed) {
        toast.error(
          'Folder could not be synced',
          `${failed} file${failed === 1 ? '' : 's'} could not be read.`,
        )
      } else {
        toast.show(added ? `Found ${added} new photo${added === 1 ? '' : 's'}` : 'Folder is up to date', {
          detail: folder.name,
        })
      }
    } catch (err) {
      if (controller.signal.aborted) {
        toast.show('Sync cancelled', { detail: folder.name })
      } else {
        toast.error('Sync failed', err instanceof Error ? err.message : String(err))
      }
    } finally {
      set({ active: false, cancelling: false, controller: null, progress: null, batch: null })
    }
  },

  cancel: () => {
    const { controller, cancelling } = get()
    if (!controller || cancelling) return
    set({ cancelling: true })
    controller.abort()
  },
}))
