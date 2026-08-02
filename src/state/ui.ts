import type { OutputSpace } from '../gpu/colorspace'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  applyDynamicRangeLimit,
  HEADROOM_STOPS_DEFAULT,
} from '../core/hdr'

export type Module = 'library' | 'develop'
export type ViewMode = 'grid' | 'loupe' | 'compare' | 'survey'

/**
 * How the grid shapes its cells.
 *
 * `fill` is a uniform square tile with the photo centre-cropped into it: one
 * rhythm, one target size, which is what culling a shoot wants. `waterfall`
 * gives every frame its true proportions in masonry columns, for when the
 * composition matters more than the scan.
 */
export type GridLayout = 'fill' | 'waterfall'

/**
 * Develop's compare layouts, following Lightroom's Before/After menu.
 *
 * `before` fills the frame with the before state. The two `split` modes cut a
 * single image with a draggable divider; `sideBySide` and `topBottom` draw two
 * complete images in their own halves.
 */
export type BeforeAfter =
  | 'off'
  | 'before'
  | 'splitVertical'
  | 'splitHorizontal'
  | 'sideBySide'
  | 'topBottom'

export const BEFORE_AFTER_LABELS: Record<BeforeAfter, string> = {
  off: 'After Only',
  before: 'Before Only',
  splitVertical: 'Left / Right Split',
  splitHorizontal: 'Top / Bottom Split',
  sideBySide: 'Before / After Left / Right',
  topBottom: 'Before / After Top / Bottom',
}

/** True when the layout draws two complete images rather than one cut one. */
export const isPairedCompare = (b: BeforeAfter) => b === 'sideBySide' || b === 'topBottom'
export const isSplitCompare = (b: BeforeAfter) =>
  b === 'splitVertical' || b === 'splitHorizontal'
export const showsBefore = (b: BeforeAfter) => b !== 'off'

export type DevelopTool = 'none' | 'crop' | 'heal' | 'redeye' | 'mask'

export interface UIState {
  module: Module
  viewMode: ViewMode
  developTool: DevelopTool

  leftPanelOpen: boolean
  rightPanelOpen: boolean
  filmstripOpen: boolean
  toolbarOpen: boolean
  leftPanelWidth: number
  rightPanelWidth: number
  filmstripHeight: number

  beforeAfter: BeforeAfter
  /** Divider position for the split layouts, 0..1 along the cut axis. */
  compareSplit: number
  soloPanels: boolean

  /** Library grid thumbnail edge in px. */
  thumbSize: number
  gridLayout: GridLayout
  showGridExtras: boolean
  showClipping: { shadows: boolean; highlights: boolean }

  /** Display colour space the viewport and histogram are proofed against. */
  softProof: OutputSpace

  /**
   * Preset groups the user has opened, by name.
   *
   * Groups start closed: a preset library is a filing cabinet, and the useful
   * view of one is its drawers, not every folder in every drawer at once.
   * Storing the open ones (rather than the closed ones) means a group that
   * arrives later — a freshly imported pack — is closed without anything
   * having to know it exists.
   */
  expandedPresetGroups: string[]

  /**
   * Extended dynamic range viewing. Off holds every image to SDR, which is the
   * reference the edit is judged against; on lets highlights climb into
   * whatever headroom the display has.
   */
  hdr: boolean
  /**
   * How far above display white HDR viewing reaches, in stops. Fixed at
   * HEADROOM_STOPS_DEFAULT — nothing reports what a panel actually holds, so
   * this is a constant the render path reads, not a preference to tune.
   */
  hdrHeadroom: number

  setModule: (m: Module) => void
  setViewMode: (v: ViewMode) => void
  setDevelopTool: (t: DevelopTool) => void
  openDevelopTool: (t: DevelopTool) => void
  toggleLeftPanel: () => void
  toggleRightPanel: () => void
  toggleFilmstrip: () => void
  toggleToolbar: () => void
  togglePanels: () => void
  setPanelWidth: (side: 'left' | 'right', w: number) => void
  setFilmstripHeight: (h: number) => void
  setBeforeAfter: (b: BeforeAfter) => void
  /** Cycles the compare layouts the way Lightroom's Y button does. */
  cycleBeforeAfter: () => void
  setCompareSplit: (n: number) => void
  setThumbSize: (n: number) => void
  setGridLayout: (l: GridLayout) => void
  toggleGridExtras: () => void
  toggleSoloPanels: () => void
  toggleClipping: (which: 'shadows' | 'highlights') => void
  setSoftProof: (s: OutputSpace) => void
  togglePresetGroup: (group: string) => void
  /** Opens a group without closing the others — used after a save or import. */
  expandPresetGroup: (group: string | string[]) => void
  setPresetGroupsExpanded: (groups: string[]) => void
  setHdr: (on: boolean) => void
  toggleHdr: () => void
}

export const useUI = create<UIState>()(
  persist(
    (set, get) => ({
      module: 'library',
      viewMode: 'grid',
      developTool: 'none',

      leftPanelOpen: true,
      rightPanelOpen: true,
      filmstripOpen: true,
      toolbarOpen: true,
      leftPanelWidth: 240,
      rightPanelWidth: 268,
      filmstripHeight: 92,

      beforeAfter: 'off',
      compareSplit: 0.5,
      soloPanels: false,

      thumbSize: 168,
      gridLayout: 'fill',
      showGridExtras: true,
      showClipping: { shadows: false, highlights: false },
      softProof: 'srgb',
      expandedPresetGroups: [],
      hdr: false,
      hdrHeadroom: HEADROOM_STOPS_DEFAULT,

      setModule: (module) =>
        set((s) => ({
          module,
          // Entering Develop always lands on the single-image view.
          viewMode: module === 'develop' ? 'loupe' : s.viewMode,
          developTool: 'none',
        })),
      setViewMode: (viewMode) => set({ viewMode }),
      setDevelopTool: (developTool) =>
        set((s) => ({ developTool: s.developTool === developTool ? 'none' : developTool })),
      // setDevelopTool toggles, which is what a toolbar button wants but not
      // what "create a mask, then let me place it" wants — that has to end up
      // in the tool whether or not it was already open.
      openDevelopTool: (developTool) => set({ developTool }),

      toggleLeftPanel: () => set((s) => ({ leftPanelOpen: !s.leftPanelOpen })),
      toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
      toggleFilmstrip: () => set((s) => ({ filmstripOpen: !s.filmstripOpen })),
      toggleToolbar: () => set((s) => ({ toolbarOpen: !s.toolbarOpen })),
      togglePanels: () => {
        const { leftPanelOpen, rightPanelOpen } = get()
        const open = !(leftPanelOpen && rightPanelOpen)
        set({ leftPanelOpen: open, rightPanelOpen: open })
      },
      setPanelWidth: (side, w) =>
        set(side === 'left' ? { leftPanelWidth: w } : { rightPanelWidth: w }),
      setFilmstripHeight: (filmstripHeight) => set({ filmstripHeight }),

      setBeforeAfter: (beforeAfter) => set({ beforeAfter }),
      cycleBeforeAfter: () => {
        const order: BeforeAfter[] = ['off', 'sideBySide', 'splitVertical', 'topBottom', 'splitHorizontal']
        const i = order.indexOf(get().beforeAfter)
        set({ beforeAfter: order[(i + 1) % order.length] })
      },
      setCompareSplit: (n) => set({ compareSplit: Math.min(0.92, Math.max(0.08, n)) }),
      setThumbSize: (thumbSize) => set({ thumbSize }),
      setGridLayout: (gridLayout) => set({ gridLayout }),
      toggleGridExtras: () => set((s) => ({ showGridExtras: !s.showGridExtras })),
      toggleSoloPanels: () => set((s) => ({ soloPanels: !s.soloPanels })),

      setSoftProof: (softProof) => set({ softProof }),

      togglePresetGroup: (group) =>
        set((s) => ({
          expandedPresetGroups: s.expandedPresetGroups.includes(group)
            ? s.expandedPresetGroups.filter((g) => g !== group)
            : [...s.expandedPresetGroups, group],
        })),
      expandPresetGroup: (group) =>
        set((s) => ({
          expandedPresetGroups: [
            ...new Set([...s.expandedPresetGroups, ...(Array.isArray(group) ? group : [group])]),
          ],
        })),
      setPresetGroupsExpanded: (expandedPresetGroups) => set({ expandedPresetGroups }),

      setHdr: (hdr) => {
        applyDynamicRangeLimit(hdr)
        // Headroom is no longer exposed as a control, so enabling HDR pins it
        // to the default rather than resuming whatever a past build's slider
        // left persisted.
        set(hdr ? { hdr, hdrHeadroom: HEADROOM_STOPS_DEFAULT } : { hdr })
      },
      toggleHdr: () => get().setHdr(!get().hdr),

      toggleClipping: (which) =>
        set((s) => ({ showClipping: { ...s.showClipping, [which]: !s.showClipping[which] } })),
    }),
    {
      name: 'esque.ui',
      // View state is per-session; layout preferences persist.
      partialize: (s) => ({
        module: s.module,
        leftPanelOpen: s.leftPanelOpen,
        rightPanelOpen: s.rightPanelOpen,
        filmstripOpen: s.filmstripOpen,
        toolbarOpen: s.toolbarOpen,
        leftPanelWidth: s.leftPanelWidth,
        rightPanelWidth: s.rightPanelWidth,
        filmstripHeight: s.filmstripHeight,
        thumbSize: s.thumbSize,
        gridLayout: s.gridLayout,
        showGridExtras: s.showGridExtras,
        soloPanels: s.soloPanels,
        compareSplit: s.compareSplit,
        expandedPresetGroups: s.expandedPresetGroups,
        hdr: s.hdr,
        hdrHeadroom: s.hdrHeadroom,
      }),
    },
  ),
)

// The property's own initial value is `no-limit`, so an HDR photo shows its
// full range until something says otherwise. Claim it as soon as the store
// exists — an effect would let the first frame paint under the wrong limit.
applyDynamicRangeLimit(useUI.getState().hdr)

/**
 * The grid's current column count, published by the view for keyboard
 * navigation.
 *
 * Arrow Up and Down have to move by exactly one row, which only the laid-out
 * grid knows. It sits beside the store rather than in it because nothing
 * paints the number: putting it in the store would re-render every subscriber
 * on a panel drag.
 */
let gridColumns = 1
export const setGridColumns = (n: number) => {
  gridColumns = Math.max(1, n)
}
export const getGridColumns = () => gridColumns
