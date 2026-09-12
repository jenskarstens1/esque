import type { OutputSpace } from "../gpu/colorspace";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { applyDynamicRangeLimit, HEADROOM_STOPS_DEFAULT } from "../core/hdr";
import {
  applyAppearance,
  type Appearance,
  type AppearanceSettings,
  type Surround,
  type TextSize,
} from "../design/appearance";

export type Module = "library" | "develop";
export type ViewMode = "grid" | "loupe";

/**
 * How large the working proxy is decoded, and therefore how far into a photo
 * you can zoom before Develop has to go back to the file.
 *
 * Not a quality setting in the sense of *interpolation* — every tier gets the
 * same full-quality demosaic. It trades memory and decode time for the size of
 * the buffer that survives it: `standard` keeps a laptop responsive on a large
 * catalogue, `full` is for a machine with headroom that would rather never wait
 * for a re-decode at 1:1.
 */
export type PreviewQuality = "standard" | "high" | "full";

/**
 * What, if anything, is applied to a photograph as it is imported.
 *
 * `none` is the honest default: an import that silently develops a shoot has
 * made a judgement nobody asked it to make, and the photographer has no way to
 * tell what the camera gave them from what the app decided. The rest exist
 * because the opposite is also true — someone who always runs Auto on a
 * thousand frames should not have to press it a thousand times.
 */
export type ImportDevelop = "none" | "auto" | "tone" | "preset";


/**
 * How the grid shapes its cells.
 *
 * `fill` is a uniform square tile with the photo centre-cropped into it: one
 * rhythm, one target size, which is what culling a shoot wants. `waterfall`
 * gives every frame its true proportions in masonry columns, for when the
 * composition matters more than the scan.
 */
export type GridLayout = "fill" | "waterfall";

/**
 * Develop's compare layouts, following Lightroom's Before/After menu.
 *
 * `before` fills the frame with the before state. The two `split` modes cut a
 * single image with a draggable divider; `sideBySide` and `topBottom` draw two
 * complete images in their own halves.
 */
export type BeforeAfter =
  | "off"
  | "before"
  | "splitVertical"
  | "splitHorizontal"
  | "sideBySide"
  | "topBottom";

export const BEFORE_AFTER_LABELS: Record<BeforeAfter, string> = {
  off: "After Only",
  before: "Before Only",
  splitVertical: "Left / Right Split",
  splitHorizontal: "Top / Bottom Split",
  sideBySide: "Before / After Left / Right",
  topBottom: "Before / After Top / Bottom",
};

/** True when the layout draws two complete images rather than one cut one. */
export const isPairedCompare = (b: BeforeAfter) =>
  b === "sideBySide" || b === "topBottom";
export const isSplitCompare = (b: BeforeAfter) =>
  b === "splitVertical" || b === "splitHorizontal";
export const showsBefore = (b: BeforeAfter) => b !== "off";

export type DevelopTool = "none" | "crop" | "heal" | "redeye" | "mask";

export interface UIState {
  module: Module;
  viewMode: ViewMode;
  /**
   * The Library's own layout, held while Develop is open.
   *
   * Develop is a single photograph by definition, so entering it puts
   * `viewMode` in the loupe. Writing that over the Library's layout means a
   * grid you spent the morning culling in comes back as a loupe you never
   * asked for, and a Compare you set up is simply gone. So the Library's
   * choice is kept here and handed back on the way in.
   */
  libraryView: ViewMode;
  developTool: DevelopTool;
  /**
   * Whether the white-balance dropper is armed.
   *
   * Not a `DevelopTool`: it measures rather than edits, it disarms on the first
   * click, and it is allowed to sit over whatever tool is already open. But it
   * is a *mode*, and it lives here for the same reason the tools do — a mode
   * that outlives the module it belongs to leaves the panel's button lit over a
   * viewport that is no longer listening, and `setModule` is the one place that
   * already knows the module changed.
   */
  wbPicking: boolean;

  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  filmstripOpen: boolean;
  toolbarOpen: boolean;
  leftPanelWidth: number;
  rightPanelWidth: number;
  filmstripHeight: number;

  /**
   * True below the desktop break, published by the shell from `useIsCompact()`.
   *
   * The store has to know, rather than each component deciding for itself,
   * because the panel toggles are reached from everywhere — the keymap, the
   * menu bar, the toolbar, the mobile bar — and all of them have to mean
   * "open the drawer" on a phone and "widen the layout" on a desktop.
   */
  compact: boolean;
  /**
   * Which panel is showing as an overlay, when compact. Only ever one: they
   * float over the photo, and two would leave none of it visible.
   *
   * Deliberately separate from `leftPanelOpen` / `rightPanelOpen` so a session
   * on a phone doesn't overwrite the layout someone set up on their desktop.
   * Not persisted — an overlay is a thing you opened, not a preference.
   */
  overlayPanel: "left" | "right" | null;

  beforeAfter: BeforeAfter;
  /** Divider position for the split layouts, 0..1 along the cut axis. */
  compareSplit: number;
  soloPanels: boolean;

  /** Library grid thumbnail edge in px. */
  thumbSize: number;
  gridLayout: GridLayout;
  showGridExtras: boolean;
  showClipping: { shadows: boolean; highlights: boolean };

  /**
   * Where the clipping overlays start calling a pixel lost, as display values.
   *
   * Both were fixed at the edge of the encodable range, which answers "is this
   * clipped" and nothing else. A photographer checking whether a highlight will
   * survive a print, or whether a shadow will block up on a press, is asking a
   * looser question, and the only way to ask it is to move the threshold in.
   */
  clipHighlight: number;
  clipShadow: number;

  /** ---- Appearance ------------------------------------------------------ */
  appearance: Appearance;
  surround: Surround;
  textSize: TextSize;

  /** ---- Files ----------------------------------------------------------- */
  /** The Library's filter row, above the grid. */
  filterBarOpen: boolean;

  /**
   * Whether importing a photo also reads a matching `.xmp` beside it. On by
   * default, as Lightroom is: a sidecar is normally the record of work done
   * elsewhere, so honouring it is what a photographer expects. Off is for
   * people who keep stale sidecars around and want the catalog to win.
   */
  importSidecars: boolean;

  /**
   * Whether an edit is also written back to the photograph's `.xmp`.
   *
   * Off by default, and that is not timidity. Writing a sidecar touches the
   * photographer's own disk, next to originals esque otherwise never modifies,
   * and it does it on every slider move — so it is a promise about their
   * filesystem that has to be made deliberately. Made deliberately, it is the
   * setting that turns the catalogue from somewhere work is kept into somewhere
   * work passes through: edits land beside the raw file and Lightroom, Capture
   * One or Bridge see them without an export.
   *
   * Writes are debounced and coalesced per photo; see `catalog/autoSidecar.ts`.
   */
  autoWriteSidecars: boolean;

  /** What import applies to a photograph, if anything. */
  importDevelop: ImportDevelop;
  /** Which preset `importDevelop: 'preset'` applies, by id. */
  importPresetId: string | null;
  /**
   * Whether import builds the standard preview as well as the thumbnail.
   *
   * Import already writes a thumbnail, which is all the grid needs. A standard
   * preview is what the loupe and the filmstrip want, and building it up front
   * costs one slow import in exchange for a catalogue that never stalls on the
   * first full-screen look at a frame. Off is right for a machine that is
   * short of disk, or for an import you only intend to cull.
   */
  previewOnImport: boolean;
  /**
   * Whether the export destination is remembered between sessions.
   *
   * A directory handle survives in IndexedDB, but the permission attached to it
   * does not always: the browser may ask again on the next visit. That prompt
   * is the whole cost, and it is worth it for the far more common case of
   * exporting to the same folder every time.
   */
  rememberDestination: boolean;

  /** ---- Cache ----------------------------------------------------------- */
  /**
   * Ceiling for the on-disk preview cache in bytes, or 0 for automatic.
   *
   * Automatic follows a share of whatever quota the browser hands the origin,
   * which is the right answer when nothing else is competing for the disk. A
   * fixed ceiling is for when something is.
   */
  cacheLimit: number;
  /**
   * Days after which an untouched cache entry is dropped, or 0 for never.
   *
   * Size alone is a poor policy for a catalogue that is browsed in bursts: a
   * shoot culled in March holds its previews against a shoot being worked on in
   * November purely by being under the ceiling. Age is what clears them.
   */
  cacheMaxAgeDays: number;

  /**
   * Bindings the user has changed, as command id → key spec. Only the changes
   * are stored, so a default that is re-tuned in a later release reaches
   * everyone who never overrode it.
   */
  keyBindings: Record<string, string[]>;

  /** Display colour space the viewport and histogram are proofed against. */
  softProof: OutputSpace;

  /** How large Develop's working proxy is decoded. */
  previewQuality: PreviewQuality;

  /**
   * Preset groups the user has opened, by name.
   *
   * Groups start closed: a preset library is a filing cabinet, and the useful
   * view of one is its drawers, not every folder in every drawer at once.
   * Storing the open ones (rather than the closed ones) means a group that
   * arrives later — a freshly imported pack — is closed without anything
   * having to know it exists.
   */
  expandedPresetGroups: string[];

  /**
   * Extended dynamic range viewing, for photos that haven't been told
   * otherwise. Off holds every image to SDR, which is the reference the edit is
   * judged against; on lets highlights climb into whatever headroom the display
   * has.
   */
  hdr: boolean;
  /**
   * Photos the viewer has decided about individually, against
   * {@link UIState.hdr} as the default.
   *
   * Dynamic range is a property of the photograph, not of the session. One
   * frame's blown highlights are the point and want the room; the next one's
   * are a mistake, and opening them up only makes the mistake brighter. A
   * single app-wide switch forces the same answer on both, so the decision is
   * recorded per photo — and only for photos actually decided about, so
   * changing the default still moves everything nobody has ruled on.
   */
  hdrByPhoto: Record<string, boolean>;
  /**
   * How far above display white HDR viewing reaches, in stops. Fixed at
   * HEADROOM_STOPS_DEFAULT — nothing reports what a panel actually holds, so
   * this is a constant the render path reads, not a preference to tune.
   */
  hdrHeadroom: number;

  /**
   * The release whose notes have been read, or null on a machine that has never
   * run esque.
   *
   * Stored rather than a boolean because the welcome dialog has two jobs: an
   * unset value means nobody here has met the app, and a value behind the
   * current one means someone has, but not this release. That is the whole
   * decision of which face it opens on.
   */
  seenVersion: string | null;

  setModule: (m: Module) => void;
  setViewMode: (v: ViewMode) => void;
  setDevelopTool: (t: DevelopTool) => void;
  setWbPicking: (v: boolean) => void;
  toggleWbPicking: () => void;
  openDevelopTool: (t: DevelopTool) => void;
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  toggleFilmstrip: () => void;
  toggleToolbar: () => void;
  togglePanels: () => void;
  setCompact: (compact: boolean) => void;
  setOverlayPanel: (panel: "left" | "right" | null) => void;
  setPanelWidth: (side: "left" | "right", w: number) => void;
  setFilmstripHeight: (h: number) => void;
  setBeforeAfter: (b: BeforeAfter) => void;
  /** Cycles the compare layouts the way Lightroom's Y button does. */
  cycleBeforeAfter: () => void;
  setCompareSplit: (n: number) => void;
  setThumbSize: (n: number) => void;
  setGridLayout: (l: GridLayout) => void;
  toggleGridExtras: () => void;
  toggleSoloPanels: () => void;
  toggleFilterBar: () => void;
  setFilterBarOpen: (open: boolean) => void;
  setImportSidecars: (on: boolean) => void;
  toggleClipping: (which: "shadows" | "highlights") => void;
  setClipThreshold: (which: "shadows" | "highlights", v: number) => void;
  setSoftProof: (s: OutputSpace) => void;
  setPreviewQuality: (q: PreviewQuality) => void;
  setAppearance: (a: Appearance) => void;
  setSurround: (s: Surround) => void;
  setTextSize: (t: TextSize) => void;
  setAutoWriteSidecars: (on: boolean) => void;
  setImportDevelop: (m: ImportDevelop) => void;
  setImportPresetId: (id: string | null) => void;
  setPreviewOnImport: (on: boolean) => void;
  setRememberDestination: (on: boolean) => void;
  setCacheLimit: (bytes: number) => void;
  setCacheMaxAgeDays: (days: number) => void;
  setKeyBinding: (command: string, keys: string[] | null) => void;
  resetKeyBindings: () => void;
  togglePresetGroup: (group: string) => void;
  /** Opens a group without closing the others — used after a save or import. */
  expandPresetGroup: (group: string | string[]) => void;
  setPresetGroupsExpanded: (groups: string[]) => void;
  setHdr: (on: boolean) => void;
  setPhotoHdr: (ids: string[], on: boolean) => void;
  togglePhotoHdr: (ids: string[]) => void;
  setSeenVersion: (v: string) => void;
}

/**
 * Folds one appearance change into the other two and writes the result to the
 * document.
 *
 * The three settings are one decision as far as the cascade is concerned — they
 * are written together or the document ends up describing a state the store was
 * never in — so every setter goes through here rather than each remembering to
 * re-apply the rest.
 */
const withAppearance =
  (patch: Partial<AppearanceSettings>) =>
  (s: UIState): Partial<UIState> => {
    const next: AppearanceSettings = {
      appearance: s.appearance,
      surround: s.surround,
      textSize: s.textSize,
      ...patch,
    };
    applyAppearance(next);
    return next;
  };

export const useUI = create<UIState>()(
  persist(
    (set, get) => ({      module: "library",
      viewMode: "grid",
      libraryView: "grid",
      developTool: "none",
      wbPicking: false,

      leftPanelOpen: true,
      rightPanelOpen: true,
      filmstripOpen: true,
      toolbarOpen: true,
      leftPanelWidth: 240,
      rightPanelWidth: 268,
      filmstripHeight: 92,

      compact: false,
      overlayPanel: null,

      beforeAfter: "off",
      compareSplit: 0.5,
      soloPanels: false,

      thumbSize: 168,
      gridLayout: "fill",
      showGridExtras: true,
      showClipping: { shadows: false, highlights: false },
      clipHighlight: 0.995,
      clipShadow: 0.0025,

      appearance: "dark",
      surround: "match",
      textSize: "default",

      filterBarOpen: false,
      importSidecars: true,
      autoWriteSidecars: false,
      importDevelop: "none",
      importPresetId: null,
      previewOnImport: false,
      rememberDestination: true,
      cacheLimit: 0,
      cacheMaxAgeDays: 0,
      keyBindings: {},
      softProof: "srgb",
      previewQuality: "high",
      expandedPresetGroups: [],
      hdr: false,
      hdrByPhoto: {},
      hdrHeadroom: HEADROOM_STOPS_DEFAULT,
      seenVersion: null,

      setModule: (module) =>
        set((s) => ({
          module,
          // Entering Develop always lands on the single-image view; leaving it
          // gives the Library back the layout it was in, rather than stranding
          // the photographer in a loupe Develop chose for them.
          viewMode: module === "develop" ? "loupe" : s.libraryView,
          developTool: "none",
          wbPicking: false,
          // A drawer belongs to the module that opened it — carrying the Library's
          // catalog tree into Develop would show a panel nothing in view uses.
          overlayPanel: null,
        })),
      // Every control that sets a view mode is a Library control, so choosing
      // one is also choosing what the Library goes back to.
      setViewMode: (viewMode) => set({ viewMode, libraryView: viewMode }),
      setDevelopTool: (developTool) =>
        set((s) => ({
          developTool: s.developTool === developTool ? "none" : developTool,
        })),
      setWbPicking: (wbPicking) => set({ wbPicking }),
      toggleWbPicking: () => set((s) => ({ wbPicking: !s.wbPicking })),
      // setDevelopTool toggles, which is what a toolbar button wants but not
      // what "create a mask, then let me place it" wants — that has to end up
      // in the tool whether or not it was already open.
      openDevelopTool: (developTool) => set({ developTool }),

      toggleLeftPanel: () =>
        set((s) =>
          s.compact
            ? { overlayPanel: s.overlayPanel === "left" ? null : "left" }
            : { leftPanelOpen: !s.leftPanelOpen },
        ),
      toggleRightPanel: () =>
        set((s) =>
          s.compact
            ? { overlayPanel: s.overlayPanel === "right" ? null : "right" }
            : { rightPanelOpen: !s.rightPanelOpen },
        ),
      toggleFilmstrip: () => set((s) => ({ filmstripOpen: !s.filmstripOpen })),
      toggleToolbar: () => set((s) => ({ toolbarOpen: !s.toolbarOpen })),
      togglePanels: () => {
        const { leftPanelOpen, rightPanelOpen, compact, overlayPanel } = get();
        // Compact has no "both panels" state to toggle into, so Tab means the
        // one thing it can mean there: clear whatever is covering the photo.
        if (compact) return set({ overlayPanel: overlayPanel ? null : "left" });
        const open = !(leftPanelOpen && rightPanelOpen);
        set({ leftPanelOpen: open, rightPanelOpen: open });
      },
      setCompact: (compact) =>
        // Leaving compact retires the overlay rather than leaving a drawer
        // stranded over a layout that now has room for it as a column.
        set((s) => ({ compact, overlayPanel: compact ? s.overlayPanel : null })),
      setOverlayPanel: (overlayPanel) => set({ overlayPanel }),
      setPanelWidth: (side, w) =>
        set(side === "left" ? { leftPanelWidth: w } : { rightPanelWidth: w }),
      setFilmstripHeight: (filmstripHeight) => set({ filmstripHeight }),

      setBeforeAfter: (beforeAfter) => set({ beforeAfter }),
      cycleBeforeAfter: () => {
        const order: BeforeAfter[] = [
          "off",
          "sideBySide",
          "splitVertical",
          "topBottom",
          "splitHorizontal",
        ];
        const i = order.indexOf(get().beforeAfter);
        set({ beforeAfter: order[(i + 1) % order.length] });
      },
      setCompareSplit: (n) =>
        set({ compareSplit: Math.min(0.92, Math.max(0.08, n)) }),
      setThumbSize: (thumbSize) => set({ thumbSize }),
      setGridLayout: (gridLayout) => set({ gridLayout }),
      toggleGridExtras: () =>
        set((s) => ({ showGridExtras: !s.showGridExtras })),
      toggleSoloPanels: () => set((s) => ({ soloPanels: !s.soloPanels })),
      toggleFilterBar: () => set((s) => ({ filterBarOpen: !s.filterBarOpen })),
      setFilterBarOpen: (filterBarOpen) => set({ filterBarOpen }),
      setImportSidecars: (importSidecars) => set({ importSidecars }),

      setSoftProof: (softProof) => set({ softProof }),
      setPreviewQuality: (previewQuality) => set({ previewQuality }),

      // Each writes the document as well as the store: the cascade owns the
      // appearance, and the store is only where the choice is remembered.
      setAppearance: (appearance) => set(withAppearance({ appearance })),
      setSurround: (surround) => set(withAppearance({ surround })),
      setTextSize: (textSize) => set(withAppearance({ textSize })),

      setAutoWriteSidecars: (autoWriteSidecars) => set({ autoWriteSidecars }),
      setImportDevelop: (importDevelop) => set({ importDevelop }),
      setImportPresetId: (importPresetId) => set({ importPresetId }),
      setPreviewOnImport: (previewOnImport) => set({ previewOnImport }),
      setRememberDestination: (rememberDestination) =>
        set({ rememberDestination }),
      setCacheLimit: (cacheLimit) => set({ cacheLimit: Math.max(0, cacheLimit) }),
      setCacheMaxAgeDays: (cacheMaxAgeDays) =>
        set({ cacheMaxAgeDays: Math.max(0, Math.round(cacheMaxAgeDays)) }),

      // A binding cleared back to its default is *removed* rather than stored as
      // the default's value, so it stays subject to whatever the default becomes.
      setKeyBinding: (command, keys) =>
        set((s) => {
          const next = { ...s.keyBindings };
          if (keys === null || !keys.length) delete next[command];
          else next[command] = keys;
          return { keyBindings: next };
        }),
      resetKeyBindings: () => set({ keyBindings: {} }),

      togglePresetGroup: (group) =>
        set((s) => ({
          expandedPresetGroups: s.expandedPresetGroups.includes(group)
            ? s.expandedPresetGroups.filter((g) => g !== group)
            : [...s.expandedPresetGroups, group],
        })),
      expandPresetGroup: (group) =>
        set((s) => ({
          expandedPresetGroups: [
            ...new Set([
              ...s.expandedPresetGroups,
              ...(Array.isArray(group) ? group : [group]),
            ]),
          ],
        })),
      setPresetGroupsExpanded: (expandedPresetGroups) =>
        set({ expandedPresetGroups }),

      setHdr: (hdr) => {
        applyDynamicRangeLimit(hdr);
        // Headroom is no longer exposed as a control, so enabling HDR pins it
        // to the default rather than resuming whatever a past build's slider
        // left persisted.
        set(hdr ? { hdr, hdrHeadroom: HEADROOM_STOPS_DEFAULT } : { hdr });
      },

      setPhotoHdr: (ids, on) =>
        set((s) => {
          const hdrByPhoto = { ...s.hdrByPhoto };
          for (const id of ids) {
            // Agreeing with the default is recorded as having no opinion, so a
            // later change of default still carries the photo with it.
            if (on === s.hdr) delete hdrByPhoto[id];
            else hdrByPhoto[id] = on;
          }
          // The per-photo button must restore usable headroom just like setHdr.
          return on
            ? { hdrByPhoto, hdrHeadroom: HEADROOM_STOPS_DEFAULT }
            : { hdrByPhoto };
        }),

      // A selection is one thing to the viewer, so it gets one answer: the key
      // opens the range unless everything in it is already open. Toggling each
      // photo against its own state would scatter a mixed selection further
      // with every press.
      togglePhotoHdr: (ids) => {
        if (!ids.length) return;
        const s = get();
        s.setPhotoHdr(ids, !ids.every((id) => s.hdrByPhoto[id] ?? s.hdr));
      },

      setSeenVersion: (seenVersion) => set({ seenVersion }),

      toggleClipping: (which) =>
        set((s) => ({
          showClipping: { ...s.showClipping, [which]: !s.showClipping[which] },
        })),

      setClipThreshold: (which, v) =>
        set(
          which === "shadows"
            ? { clipShadow: Math.min(0.05, Math.max(0, v)) }
            : { clipHighlight: Math.min(1, Math.max(0.9, v)) },
        ),
    }),
    {
      name: "esque.ui",
      // Retire saved accent choices without resetting the rest of the workspace.
      merge: (persisted, current) => {
        if (!persisted || typeof persisted !== "object") return current;
        const saved = { ...persisted };
        if ("accent" in saved) delete saved.accent;
        return { ...current, ...saved };
      },
      // View state is per-session; layout preferences persist.
      partialize: (s) => ({
        module: s.module,
        // Restored alongside `module` so a reload comes back to the same view
        // rather than dropping a loupe session into the grid.
        viewMode: s.viewMode,
        libraryView: s.libraryView,
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
        filterBarOpen: s.filterBarOpen,
        importSidecars: s.importSidecars,
        autoWriteSidecars: s.autoWriteSidecars,
        importDevelop: s.importDevelop,
        importPresetId: s.importPresetId,
        previewOnImport: s.previewOnImport,
        rememberDestination: s.rememberDestination,
        cacheLimit: s.cacheLimit,
        cacheMaxAgeDays: s.cacheMaxAgeDays,
        keyBindings: s.keyBindings,
        softProof: s.softProof,
        previewQuality: s.previewQuality,
        clipHighlight: s.clipHighlight,
        clipShadow: s.clipShadow,
        appearance: s.appearance,
        surround: s.surround,
        textSize: s.textSize,
        soloPanels: s.soloPanels,
        compareSplit: s.compareSplit,
        expandedPresetGroups: s.expandedPresetGroups,
        hdr: s.hdr,
        hdrByPhoto: s.hdrByPhoto,
        hdrHeadroom: s.hdrHeadroom,
        seenVersion: s.seenVersion,
      }),
    },
  ),
);

// The property's own initial value is `no-limit`, so an HDR photo shows its
// full range until something says otherwise. Claim it as soon as the store
// exists — an effect would let the first frame paint under the wrong limit.
applyDynamicRangeLimit(useUI.getState().hdr);

/**
 * Whether a given photo shows its extended range.
 *
 * A selector rather than a stored flag because the answer is two facts — what
 * the viewer said about this photo, and what they said about photos in general
 * — and only the first is worth writing down.
 */
export const photoHdr =
  (id: string | null | undefined) =>
  (s: UIState): boolean =>
    !!id && (s.hdrByPhoto[id] ?? s.hdr);

/** The same question of a selection, which is open only when all of it is. */
export const photosHdr =
  (ids: string[]) =>
  (s: UIState): boolean =>
    ids.length > 0 && ids.every((id) => s.hdrByPhoto[id] ?? s.hdr);

// Same reasoning, and the same moment. `persist` rehydrates from localStorage
// synchronously, so by the time this runs the store already holds the
// appearance the user left the app in, and the first paint is that appearance
// rather than the default followed by a flash of it.
applyAppearance(useUI.getState());

/**
 * The grid's current column count, published by the view for keyboard
 * navigation.
 *
 * Arrow Up and Down have to move by exactly one row, which only the laid-out
 * grid knows. It sits beside the store rather than in it because nothing
 * paints the number: putting it in the store would re-render every subscriber
 * on a panel drag.
 */
let gridColumns = 1;
export const setGridColumns = (n: number) => {
  gridColumns = Math.max(1, n);
};
export const getGridColumns = () => gridColumns;
