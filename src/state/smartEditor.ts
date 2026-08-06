import { create } from 'zustand'
import type { Collection } from '../core/types'

/*
 * Which smart collection the rule editor is on, if any.
 *
 * It lives beside the store rather than in the dialog because the things that
 * open it — a sidebar button, a context menu built as plain data — have no
 * component of their own to reach into.
 */

interface SmartEditorState {
  /** An existing collection, `'new'` for a blank one, or null when closed. */
  target: Collection | 'new' | null
  open: (t: Collection | 'new') => void
  close: () => void
}

export const useSmartEditor = create<SmartEditorState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}))

/** Opens the rule editor on an existing smart collection, or on a blank one. */
export const editSmartCollection = (c?: Collection) => useSmartEditor.getState().open(c ?? 'new')
