import { create } from 'zustand'
import type { MaskGeometry } from '../core/types'

/**
 * What the masking UI is currently doing.
 *
 * Deliberately separate from `Edits`: which mask is selected, whether the
 * overlay is showing and what the brush size is are all *view* state. They must
 * not land in history, travel to XMP, or make a photo look different when
 * someone else opens it.
 */
export type OverlayMode = 'tint' | 'coverage' | 'off'

interface MaskingState {
  /** The mask being edited, or null when the list is showing. */
  selectedMaskId: string | null
  /** The component being dragged within that mask. */
  selectedComponentId: string | null
  /** Set while placing a brand new component, so the next canvas drag creates it. */
  pendingKind: MaskGeometry['kind'] | null
  /** Whether the pending component joins the selected mask or starts a new one. */
  pendingTarget: 'new' | 'add' | 'subtract' | 'intersect'
  overlay: OverlayMode
  /** Held down to show the overlay temporarily, the way `O` works in Lightroom. */
  brushSize: number
  brushFeather: number
  brushFlow: number
  brushErase: boolean
  /** Live pointer position over the canvas, for the brush ring. */
  cursor: { x: number; y: number } | null

  select: (maskId: string | null, componentId?: string | null) => void
  setPending: (kind: MaskGeometry['kind'] | null, target?: MaskingState['pendingTarget']) => void
  setOverlay: (overlay: OverlayMode) => void
  cycleOverlay: () => void
  setBrush: (patch: Partial<Pick<MaskingState, 'brushSize' | 'brushFeather' | 'brushFlow' | 'brushErase'>>) => void
  setCursor: (cursor: { x: number; y: number } | null) => void
  reset: () => void
}

export const useMasking = create<MaskingState>((set, get) => ({
  selectedMaskId: null,
  selectedComponentId: null,
  pendingKind: null,
  pendingTarget: 'new',
  overlay: 'tint',
  brushSize: 0.08,
  brushFeather: 50,
  brushFlow: 0.6,
  brushErase: false,
  cursor: null,

  select: (selectedMaskId, selectedComponentId = null) =>
    set({ selectedMaskId, selectedComponentId, pendingKind: null }),
  setPending: (pendingKind, pendingTarget = 'new') => set({ pendingKind, pendingTarget }),
  setOverlay: (overlay) => set({ overlay }),
  cycleOverlay: () => {
    const order: OverlayMode[] = ['tint', 'coverage', 'off']
    const i = order.indexOf(get().overlay)
    set({ overlay: order[(i + 1) % order.length] })
  },
  setBrush: (patch) => set(patch),
  setCursor: (cursor) => set({ cursor }),
  reset: () =>
    set({ selectedMaskId: null, selectedComponentId: null, pendingKind: null, cursor: null }),
}))
