import { create } from 'zustand'
import { importFiles, importFolder, syncFolder, type ImportProgress } from '../catalog/import'
import { filePickerSupported, fsSupported, pickFiles, pickFolder } from '../catalog/fs'
import { scheduleEvict } from '../catalog/opfs'
import { useCatalog } from './catalog'
import { toast } from '../design/toast'
import type { CatalogFolder } from '../core/types'

interface ImporterState {
  active: boolean
  cancelling: boolean
  progress: ImportProgress | null
  controller: AbortController | null
  run: (handle?: FileSystemDirectoryHandle | null) => Promise<void>
  /** Imports individually picked files rather than a whole folder. */
  runFiles: (handles?: FileSystemFileHandle[] | null, multiple?: boolean) => Promise<void>
  sync: (folder: CatalogFolder) => Promise<void>
  cancel: () => void
}

interface ImportResult {
  folder: CatalogFolder
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
  const { folder, added, skipped, failed } = result
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
      detail: notes.join(' · ') || folder.name,
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

export const useImporter = create<ImporterState>((set, get) => ({
  active: false,
  cancelling: false,
  progress: null,
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
      showImportResult(result, controller.signal.aborted, 'folder')
    } catch (err) {
      showImportError(err, controller.signal.aborted)
    } finally {
      set({ active: false, cancelling: false, controller: null, progress: null })
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
      showImportResult(result, controller.signal.aborted, 'files')
    } catch (err) {
      showImportError(err, controller.signal.aborted)
    } finally {
      set({ active: false, cancelling: false, controller: null, progress: null })
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
      set({ active: false, cancelling: false, controller: null, progress: null })
    }
  },

  cancel: () => {
    const { controller, cancelling } = get()
    if (!controller || cancelling) return
    set({ cancelling: true })
    controller.abort()
  },
}))
