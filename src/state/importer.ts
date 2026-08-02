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
      const { folder, added, skipped, failed } = await importFolder(handle, {
        signal: controller.signal,
        onProgress: (progress) => set({ progress }),
      })
      useCatalog.getState().setSource({ kind: 'folder', id: folder.id })
      scheduleEvict(true)
      if (controller.signal.aborted) {
        toast.show('Import cancelled', {
          detail: `${added} photo${added === 1 ? '' : 's'} added before stopping`,
        })
      } else if (added === 0 && failed > 0) {
        toast.error(
          'No photos could be imported',
          `${failed} file${failed === 1 ? '' : 's'} could not be read.`,
        )
      } else if (added === 0 && skipped > 0) {
        toast.show('Already up to date', {
          detail: `${skipped} photo${skipped === 1 ? '' : 's'} already in the catalog`,
        })
      } else if (added === 0) {
        toast.show('Nothing to import', {
          detail: 'No supported photos were found in that folder.',
        })
      } else {
        const notes = [
          skipped ? `${skipped} already in the catalog` : '',
          failed ? `${failed} could not be read` : '',
        ].filter(Boolean)
        toast.show(`Imported ${added} photo${added === 1 ? '' : 's'}`, {
          detail: notes.join(' · ') || folder.name,
        })
      }
    } catch (err) {
      if (controller.signal.aborted) {
        toast.show('Import cancelled')
      } else {
        toast.error('Import failed', err instanceof Error ? err.message : String(err))
      }
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
      const { folder, added, skipped, failed } = await importFiles(handles, {
        signal: controller.signal,
        onProgress: (progress) => set({ progress }),
      })
      useCatalog.getState().setSource({ kind: 'folder', id: folder.id })
      scheduleEvict(true)
      if (controller.signal.aborted) {
        toast.show('Import cancelled', {
          detail: `${added} photo${added === 1 ? '' : 's'} added before stopping`,
        })
      } else if (added === 0 && failed > 0) {
        toast.error(
          'Nothing could be imported',
          `${failed} file${failed === 1 ? '' : 's'} could not be read.`,
        )
      } else if (added === 0 && skipped > 0) {
        toast.show('Already in the catalog', {
          detail: `${skipped} file${skipped === 1 ? '' : 's'} skipped`,
        })
      } else if (added === 0) {
        toast.show('Nothing to import', { detail: 'No supported photos were selected.' })
      } else {
        const notes = [
          skipped ? `${skipped} already in the catalog` : '',
          failed ? `${failed} could not be read` : '',
        ].filter(Boolean)
        toast.show(`Imported ${added} photo${added === 1 ? '' : 's'}`, {
          detail: notes.join(' \u00b7 ') || folder.name,
        })
      }
    } catch (err) {
      if (controller.signal.aborted) {
        toast.show('Import cancelled')
      } else {
        toast.error('Import failed', err instanceof Error ? err.message : String(err))
      }
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
