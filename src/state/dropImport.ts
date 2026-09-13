import { create } from 'zustand'
import { toast } from '../design/toast'
import { useImporter } from './importer'
import { useUI } from './ui'
import { localFiles, type LocalFile } from '../catalog/fs'

/**
 * Drag-and-drop import, listened for across the whole window.
 *
 * A photographer dragging a folder in is not aiming at a target — they are
 * handing the application their work. So the drop is accepted anywhere: over
 * the grid, over Develop, over a panel, over the empty catalog that used to be
 * the only place that took one. Whatever lands is imported and the Library is
 * brought forward to show it, because that is the only view that can.
 */
interface DropState {
  /** True while a drag carrying files is over the window. */
  over: boolean
}

export const useDropZone = create<DropState>(() => ({ over: false }))

/** Files, rather than a text selection, a URL or a photo dragged within the app. */
const carriesFiles = (transfer: DataTransfer | null) =>
  !!transfer && Array.from(transfer.types).includes('Files')

/**
 * Drops the window has no business taking.
 *
 * A file input is the one place a dropped file already has a destination — the
 * catalog backup picker is one — so the window stays out of its way rather
 * than swallowing the drop and importing a JSON file as a photograph. A modal
 * dialog is the other: it owns the screen while it is open, and an import
 * running behind it is work nobody asked for and cannot see.
 */
function claimed(target: EventTarget | null) {
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return true
  return target instanceof Element && !!target.closest('input[type="file"]')
}

/**
 * Handles have to be asked for while the event is still being dispatched: the
 * item list is emptied the moment the handler returns, so the promises are
 * started here and awaited afterwards.
 */
async function readEntry(entry: FileSystemEntry, prefix = ''): Promise<LocalFile[]> {
  if (entry.name.startsWith('.') || entry.name.endsWith('.lrdata')) return []
  const path = prefix ? `${prefix}/${entry.name}` : entry.name
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject))
    return [{ file, path }]
  }
  if (!entry.isDirectory) throw new Error(`Cannot read dropped item: ${path}`)
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  const files: LocalFile[] = []
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject))
    if (!batch.length) return files
    for (const child of batch) files.push(...await readEntry(child, path))
  }
}

export async function readDropSources(transfer: DataTransfer) {
  const items = Array.from(transfer.items).filter((item) => item.kind === 'file')
  const fallbackFiles = Array.from(transfer.files)
  // Capture every entry/File and start every handle request before returning
  // control to the event loop; browsers clear the drag data store afterwards.
  const captured = items.map((item) => {
    const file = item.getAsFile()
    const entry = item.webkitGetAsEntry?.()
    let handle: Promise<FileSystemHandle | null> | undefined
    try {
      handle = item.getAsFileSystemHandle?.()?.catch((error: unknown) => {
        console.warn('[esque] Native drop access failed; trying the selected file.', error)
        return null
      })
    } catch (error) {
      console.warn('[esque] Native drop access failed; trying the selected file.', error)
    }
    return { file, entry, handle }
  })
  const handles: FileSystemHandle[] = []
  const files: LocalFile[] = []
  for (const item of captured) {
    const handle = await item.handle
    if (handle) handles.push(handle)
    else if (item.entry?.isDirectory) files.push(...await readEntry(item.entry))
    else if (item.file) files.push(...localFiles([item.file]))
    else if (item.entry) files.push(...await readEntry(item.entry))
    else throw new Error('A dropped item could not be read. Use Import Photos or Import Folder instead.')
  }
  if (!items.length) files.push(...localFiles(fallbackFiles))
  return { handles, files }
}

async function accept(transfer: DataTransfer) {
  const { handles, files } = await readDropSources(transfer)
  // Develop has one photograph open and no way to show an import; the Library
  // is where the new photos actually appear, so that is where the drop lands.
  useUI.getState().setModule('library')
  await useImporter.getState().runDropped(handles, files)
}

/** Attaches the window-wide listeners. Returns the teardown. */
export function installDropImport(): () => void {
  /*
   * `dragleave` fires every time the pointer crosses into a child element, so
   * the affordance is held by counting enters against leaves rather than by
   * the last event seen — otherwise it flickers off over every panel edge.
   */
  let depth = 0
  const show = (over: boolean) => {
    if (useDropZone.getState().over !== over) useDropZone.setState({ over })
  }

  const onEnter = (event: DragEvent) => {
    if (!carriesFiles(event.dataTransfer) || claimed(event.target)) return
    depth++
    show(true)
  }

  const onOver = (event: DragEvent) => {
    if (!carriesFiles(event.dataTransfer) || claimed(event.target)) return
    // Without this the window refuses the drop, and the browser then navigates
    // away to the file that was dropped on it.
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    show(true)
  }

  const onLeave = (event: DragEvent) => {
    if (!carriesFiles(event.dataTransfer)) return
    depth = Math.max(0, depth - 1)
    if (!depth) show(false)
  }

  const onDrop = (event: DragEvent) => {
    if (!carriesFiles(event.dataTransfer) || claimed(event.target)) return
    event.preventDefault()
    depth = 0
    show(false)
    void accept(event.dataTransfer!).catch((error: unknown) => {
      toast.error('Drop could not be imported', error instanceof Error ? error.message : String(error))
    })
  }

  const onEnd = () => {
    depth = 0
    show(false)
  }

  window.addEventListener('dragenter', onEnter)
  window.addEventListener('dragover', onOver)
  window.addEventListener('dragleave', onLeave)
  window.addEventListener('drop', onDrop)
  window.addEventListener('dragend', onEnd)
  // A drag that ends outside the window never reports a leave, so the affordance
  // is also cleared the next time the window is looked at.
  window.addEventListener('blur', onEnd)

  return () => {
    window.removeEventListener('dragenter', onEnter)
    window.removeEventListener('dragover', onOver)
    window.removeEventListener('dragleave', onLeave)
    window.removeEventListener('drop', onDrop)
    window.removeEventListener('dragend', onEnd)
    window.removeEventListener('blur', onEnd)
    onEnd()
  }
}
