import { create } from 'zustand'
import { toast } from '../design/toast'
import { useImporter } from './importer'
import { useUI } from './ui'

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
function handlesFrom(transfer: DataTransfer) {
  const pending: Promise<FileSystemHandle | null>[] = []
  let files = 0
  for (const item of Array.from(transfer.items)) {
    if (item.kind !== 'file') continue
    files++
    const handle = item.getAsFileSystemHandle?.()
    if (handle) pending.push(handle)
  }
  return { pending, files }
}

async function accept(transfer: DataTransfer) {
  const { pending, files } = handlesFrom(transfer)
  if (!pending.length) {
    // Every other browser hands back a `File` with no handle behind it, which
    // the catalog cannot re-read later. Saying so beats importing photographs
    // that break on the next launch.
    if (files) {
      toast.error(
        'Drag and drop unavailable',
        'esque needs a Chromium browser to read dropped files.',
      )
    }
    return
  }
  const handles = (await Promise.all(pending.map((p) => p.catch(() => null)))).filter(
    (h): h is FileSystemHandle => !!h,
  )
  if (!handles.length) return
  // Develop has one photograph open and no way to show an import; the Library
  // is where the new photos actually appear, so that is where the drop lands.
  useUI.getState().setModule('library')
  await useImporter.getState().runDropped(handles)
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
    void accept(event.dataTransfer!)
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
