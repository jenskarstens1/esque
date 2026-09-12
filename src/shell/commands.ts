/**
 * Every keyboard command in the app, as data.
 *
 * This was a 200-line `switch`, and a `switch` can answer exactly one question:
 * "what does this key do". It cannot answer "what keys are there", "what is
 * this command bound to", or "is that chord already taken" — which are the
 * three questions a shortcut reference and a remapping pane are made of. Moving
 * the keymap into a table costs one indirection at dispatch and buys all three
 * for free, plus the guarantee that the documentation cannot drift from the
 * behaviour, because it *is* the behaviour.
 *
 * A command carries its own gating (`enabled`) rather than relying on where it
 * sits in a chain of `if`s, so two commands can share a chord and be told apart
 * by context — `\` is before/after in Develop and the filter bar in the
 * Library, and neither has to know the other exists.
 */
import { getGridColumns, useUI, type BeforeAfter } from '../state/ui'
import { useCatalog } from '../state/catalog'
import { setFlag, setLabel, setRating } from '../catalog/actions'
import { useImporter } from '../state/importer'
import { useExport } from '../state/exportStore'
import { ALL_SECTIONS, useDevelop } from '../develop/session'
import { zoomCommands } from '../lib/useZoomPan'
import { useMasking } from '../develop/masking'
import { useRetouch } from '../develop/retouch'
import { toast } from '../design/toast'
import type { ColorLabel } from '../core/types'

export interface CommandContext {
  ui: ReturnType<typeof useUI.getState>
  cat: ReturnType<typeof useCatalog.getState>
  dev: ReturnType<typeof useDevelop.getState>
  /** The photos a command acts on: the selection, or the primary photo. */
  targets: string[]
  event: KeyboardEvent
}

export type CommandGroup =
  | 'view'
  | 'panels'
  | 'navigate'
  | 'rate'
  | 'zoom'
  | 'develop'
  | 'file'

export interface Command {
  id: string
  label: string
  group: CommandGroup
  /**
   * Chords that trigger it. The first is the one the reference shows; the rest
   * are aliases for keyboards and layouts that produce a different `key`.
   */
  keys: string[]
  /** Where it applies, shown beside the shortcut so the list reads honestly. */
  scope?: string
  /** Whether it can fire right now. A false answer lets another command match. */
  enabled?: (c: CommandContext) => boolean
  /** Set when the browser's own handling must survive — Tab is not one of them. */
  passive?: boolean
  /** Commands whose chord is structural and not worth letting people break. */
  fixed?: boolean
  run: (c: CommandContext) => void
}

export const GROUP_LABELS: Record<CommandGroup, string> = {
  view: 'Modules & views',
  panels: 'Panels & chrome',
  navigate: 'Navigation',
  rate: 'Rating & flags',
  zoom: 'Zoom',
  develop: 'Develop',
  file: 'File',
}

export const GROUP_ORDER: CommandGroup[] = [
  'view',
  'panels',
  'navigate',
  'rate',
  'zoom',
  'develop',
  'file',
]

// ---------------------------------------------------------------------------
// Chords
//
// A chord is a lowercase, canonically ordered string: `mod+shift+c`, `alt+y`,
// `arrowleft`, `[`. `mod` is ⌘ on a Mac and Ctrl everywhere else, which is the
// only sane way to write one table for both.
//
// Shifted punctuation is folded back to the unshifted key because the browser
// reports the *character*, not the physical key: pressing ⇧[ gives `{`, so a
// naive `e.key === '[' && e.shiftKey` check can never be true. That is not a
// hypothetical — it is exactly why the mask feather shortcut never worked.
// ---------------------------------------------------------------------------

const UNSHIFT: Record<string, string> = {
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
  '~': '`',
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  _: '-',
  '+': '=',
}

/** The canonical chord for a key event. */
export function chordOf(e: KeyboardEvent): string {
  const raw = e.key
  const key = (UNSHIFT[raw] ?? raw).toLowerCase()
  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push('mod')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  parts.push(key)
  return parts.join('+')
}

const IS_MAC = /mac|iphone|ipad/i.test(
  typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent,
)

const KEY_GLYPHS: Record<string, string> = {
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  enter: '↩',
  escape: 'Esc',
  tab: '⇥',
  backspace: '⌫',
  delete: '⌦',
  ' ': 'Space',
  space: 'Space',
}

/** A chord as a human reads it: `⇧⌘C` on a Mac, `Ctrl+Shift+C` elsewhere. */
export function formatChord(chord: string): string {
  const parts = chord.split('+')
  // A chord ending in `+` (i.e. the plus key itself) splits into a trailing
  // empty string; put it back rather than rendering nothing.
  const key = parts.pop() || '+'
  const mods = new Set(parts)
  const namedKeys: Record<string, string> = IS_MAC
    ? KEY_GLYPHS
    : { ...KEY_GLYPHS, enter: 'Enter', tab: 'Tab', backspace: 'Backspace', delete: 'Delete' }
  const glyph = namedKeys[key] ?? (key.length === 1 ? key.toUpperCase() : titleCase(key))

  if (IS_MAC) {
    return (
      (mods.has('alt') ? '⌥' : '') +
      (mods.has('shift') ? '⇧' : '') +
      (mods.has('mod') ? '⌘' : '') +
      glyph
    )
  }
  return [
    mods.has('mod') && 'Ctrl',
    mods.has('alt') && 'Alt',
    mods.has('shift') && 'Shift',
    glyph,
  ]
    .filter(Boolean)
    .join('+')
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const inDevelop = (c: CommandContext) => c.ui.module === 'develop'
const hasTargets = (c: CommandContext) => c.targets.length > 0
const roundTool = (c: CommandContext) =>
  inDevelop(c) && (c.ui.developTool === 'heal' || c.ui.developTool === 'redeye')

const LABELS: Record<string, ColorLabel> = {
  '6': 'red',
  '7': 'yellow',
  '8': 'green',
  '9': 'blue',
}

/** Sizes whichever round tool is open, multiplicatively so both ends stay usable. */
function resizeRound(c: CommandContext, grow: boolean) {
  const rt = useRetouch.getState()
  const factor = grow ? 1.15 : 1 / 1.15
  const clamp = (v: number) => Math.min(0.4, Math.max(0.005, v))
  if (c.ui.developTool === 'heal') rt.setSpot({ spotRadius: clamp(rt.spotRadius * factor) })
  else rt.setEye({ eyeRadius: clamp(rt.eyeRadius * factor) })
}

const beforeAfter = (id: string, label: string, keys: string[], want: BeforeAfter): Command => ({
  id,
  label,
  group: 'develop',
  keys,
  scope: 'Develop',
  enabled: inDevelop,
  run: ({ ui }) => ui.setBeforeAfter(ui.beforeAfter === want ? 'off' : want),
})

const rating = (n: number): Command => ({
  id: `rate.${n}`,
  label: n === 0 ? 'Remove rating' : `Set ${n} star${n === 1 ? '' : 's'}`,
  group: 'rate',
  keys: [String(n)],
  enabled: hasTargets,
  run: ({ targets }) => void setRating(targets, n),
})

const colorLabel = (key: string): Command => ({
  id: `label.${LABELS[key]}`,
  label: `${titleCase(LABELS[key])} label`,
  group: 'rate',
  keys: [key],
  enabled: hasTargets,
  run: ({ targets }) => void setLabel(targets, LABELS[key]),
})

export const COMMANDS: Command[] = [
  // ---- Modules & views ----
  {
    id: 'view.grid',
    label: 'Library grid',
    group: 'view',
    keys: ['g'],
    run: ({ ui }) => {
      ui.setModule('library')
      ui.setViewMode('grid')
    },
  },
  {
    id: 'view.loupe',
    label: 'Loupe',
    group: 'view',
    keys: ['e'],
    run: ({ ui }) => {
      ui.setModule('library')
      ui.setViewMode('loupe')
    },
  },
  { id: 'view.develop', label: 'Develop', group: 'view', keys: ['d'], run: ({ ui }) => ui.setModule('develop') },

  // ---- Panels & chrome ----
  {
    id: 'panels.sides',
    label: 'Hide side panels',
    group: 'panels',
    keys: ['tab'],
    fixed: true,
    run: ({ ui }) => {
      ui.toggleLeftPanel()
      ui.toggleRightPanel()
    },
  },
  {
    id: 'panels.all',
    label: 'Hide all panels',
    group: 'panels',
    keys: ['shift+tab'],
    fixed: true,
    run: ({ ui }) => ui.togglePanels(),
  },
  { id: 'panels.toolbar', label: 'Toolbar', group: 'panels', keys: ['t'], run: ({ ui }) => ui.toggleToolbar() },
  {
    id: 'panels.filterBar',
    label: 'Filter bar',
    group: 'panels',
    keys: ['\\'],
    scope: 'Library',
    enabled: (c) => !inDevelop(c),
    run: ({ ui }) => ui.toggleFilterBar(),
  },
  {
    id: 'view.hdr',
    label: 'HDR display',
    group: 'panels',
    keys: ['h'],
    enabled: hasTargets,
    run: ({ ui, targets }) => ui.togglePhotoHdr(targets),
  },
  {
    id: 'view.fullscreen',
    label: 'Full screen',
    group: 'panels',
    keys: ['f'],
    run: () => {
      if (document.fullscreenElement) void document.exitFullscreen()
      else void document.documentElement.requestFullscreen().catch(() => {})
    },
  },
  {
    id: 'app.settings',
    label: 'Settings',
    group: 'panels',
    keys: ['mod+,'],
    fixed: true,
    run: () => window.dispatchEvent(new CustomEvent('esque:settings')),
  },

  // ---- Navigation ----
  { id: 'nav.prev', label: 'Previous photo', group: 'navigate', keys: ['arrowleft'], run: ({ cat }) => cat.step(-1) },
  { id: 'nav.next', label: 'Next photo', group: 'navigate', keys: ['arrowright'], run: ({ cat }) => cat.step(1) },
  {
    id: 'nav.up',
    label: 'Row up',
    group: 'navigate',
    keys: ['arrowup'],
    run: ({ ui, cat }) =>
      cat.step(ui.module === 'library' && ui.viewMode === 'grid' ? -getGridColumns() : -1),
  },
  {
    id: 'nav.down',
    label: 'Row down',
    group: 'navigate',
    keys: ['arrowdown'],
    run: ({ ui, cat }) =>
      cat.step(ui.module === 'library' && ui.viewMode === 'grid' ? getGridColumns() : 1),
  },
  { id: 'nav.selectAll', label: 'Select all', group: 'navigate', keys: ['mod+a'], run: ({ cat }) => cat.selectAll() },
  {
    id: 'nav.deselect',
    label: 'Deselect all',
    group: 'navigate',
    keys: ['mod+d'],
    run: ({ cat }) => cat.clearSelection(),
  },
  {
    id: 'nav.confirm',
    label: 'Finish tool',
    group: 'navigate',
    keys: ['enter'],
    scope: 'Develop',
    enabled: (c) => inDevelop(c) && c.ui.developTool !== 'none',
    run: ({ ui }) => ui.setDevelopTool('none'),
  },
  {
    id: 'nav.escape',
    label: 'Close tool or view',
    group: 'navigate',
    keys: ['escape'],
    fixed: true,
    passive: true,
    // A tool is the innermost thing open, so it unwinds first.
    run: ({ ui }) => {
      if (ui.module === 'develop' && ui.developTool !== 'none') ui.setDevelopTool('none')
      // View modes belong to the Library. Pressing Escape in Develop used to
      // set one anyway — invisible at the time, and it threw away the layout
      // the Library was holding for the trip back.
      else if (ui.module === 'library' && ui.viewMode !== 'grid') ui.setViewMode('grid')
    },
  },

  // ---- Rating & flags ----
  {
    id: 'flag.pick',
    label: 'Pick',
    group: 'rate',
    keys: ['p'],
    enabled: hasTargets,
    run: ({ targets }) => void setFlag(targets, 'pick'),
  },
  {
    id: 'flag.reject',
    label: 'Reject',
    group: 'rate',
    keys: ['x'],
    enabled: hasTargets,
    run: ({ targets }) => void setFlag(targets, 'reject'),
  },
  {
    id: 'flag.none',
    label: 'Unflag',
    group: 'rate',
    keys: ['u'],
    enabled: hasTargets,
    run: ({ targets }) => void setFlag(targets, 'unflagged'),
  },
  ...[0, 1, 2, 3, 4, 5].map(rating),
  ...['6', '7', '8', '9'].map(colorLabel),

  // ---- Zoom ----
  { id: 'zoom.toggle', label: 'Toggle zoom', group: 'zoom', keys: ['z'], run: () => zoomCommands()?.toggle() },
  {
    id: 'zoom.in',
    label: 'Zoom in',
    group: 'zoom',
    keys: ['=', 'shift+=', 'mod+=', 'mod+shift+='],
    run: () => zoomCommands()?.zoomIn(),
  },
  {
    id: 'zoom.out',
    label: 'Zoom out',
    group: 'zoom',
    keys: ['-', 'shift+-', 'mod+-', 'mod+shift+-'],
    run: () => zoomCommands()?.zoomOut(),
  },
  { id: 'zoom.fit', label: 'Fit in window', group: 'zoom', keys: ['mod+0'], run: () => zoomCommands()?.fit() },
  { id: 'zoom.actual', label: 'Actual pixels', group: 'zoom', keys: ['mod+1'], run: () => zoomCommands()?.actual() },

  // ---- Develop ----
  { id: 'develop.undo', label: 'Undo', group: 'develop', keys: ['mod+z'], fixed: true, run: ({ dev }) => dev.undo() },
  {
    id: 'develop.redo',
    label: 'Redo',
    group: 'develop',
    keys: ['mod+shift+z'],
    fixed: true,
    run: ({ dev }) => dev.redo(),
  },
  {
    id: 'develop.copy',
    label: 'Copy settings',
    group: 'develop',
    keys: ['mod+shift+c'],
    scope: 'Develop',
    enabled: inDevelop,
    run: ({ dev }) => {
      dev.copySettings(ALL_SECTIONS)
      toast.show('Settings copied')
    },
  },
  {
    id: 'develop.paste',
    label: 'Paste settings',
    group: 'develop',
    keys: ['mod+shift+v'],
    scope: 'Develop',
    enabled: inDevelop,
    run: ({ dev }) => dev.pasteSettings(),
  },
  {
    id: 'develop.reset',
    label: 'Reset all settings',
    group: 'develop',
    keys: ['mod+r'],
    scope: 'Develop',
    enabled: inDevelop,
    run: ({ dev }) => dev.resetAll(),
  },
  {
    id: 'develop.crop',
    label: 'Crop tool',
    group: 'develop',
    keys: ['r'],
    scope: 'Develop',
    enabled: inDevelop,
    run: ({ ui }) => ui.setDevelopTool(ui.developTool === 'crop' ? 'none' : 'crop'),
  },
  {
    id: 'develop.heal',
    label: 'Healing tool',
    group: 'develop',
    keys: ['q'],
    scope: 'Develop',
    enabled: inDevelop,
    run: ({ ui }) => ui.setDevelopTool(ui.developTool === 'heal' ? 'none' : 'heal'),
  },
  {
    // Red eye has no Lightroom shortcut, and E is already the Library loupe.
    id: 'develop.redeye',
    label: 'Red eye tool',
    group: 'develop',
    keys: ['shift+q'],
    scope: 'Develop',
    enabled: inDevelop,
    run: ({ ui }) => ui.setDevelopTool(ui.developTool === 'redeye' ? 'none' : 'redeye'),
  },
  {
    id: 'develop.mask',
    label: 'Masking',
    group: 'develop',
    keys: ['m'],
    scope: 'Develop',
    enabled: inDevelop,
    run: ({ ui }) => ui.setDevelopTool(ui.developTool === 'mask' ? 'none' : 'mask'),
  },
  {
    id: 'develop.maskOverlay',
    label: 'Cycle mask overlay',
    group: 'develop',
    keys: ['o'],
    scope: 'Masking',
    enabled: (c) => inDevelop(c) && c.ui.developTool === 'mask',
    run: () => useMasking.getState().cycleOverlay(),
  },
  {
    id: 'develop.toolSmaller',
    label: 'Smaller brush',
    group: 'develop',
    keys: ['['],
    scope: 'Masking & retouch',
    enabled: (c) => roundTool(c) || (inDevelop(c) && c.ui.developTool === 'mask'),
    run: (c) => {
      if (roundTool(c)) return resizeRound(c, false)
      const mk = useMasking.getState()
      mk.setBrush({ brushSize: Math.min(Math.max(mk.brushSize / 1.15, 0.005), 1) })
    },
  },
  {
    id: 'develop.toolBigger',
    label: 'Larger brush',
    group: 'develop',
    keys: [']'],
    scope: 'Masking & retouch',
    enabled: (c) => roundTool(c) || (inDevelop(c) && c.ui.developTool === 'mask'),
    run: (c) => {
      if (roundTool(c)) return resizeRound(c, true)
      const mk = useMasking.getState()
      mk.setBrush({ brushSize: Math.min(Math.max(mk.brushSize * 1.15, 0.005), 1) })
    },
  },
  {
    id: 'develop.featherLess',
    label: 'Less feather',
    group: 'develop',
    keys: ['shift+['],
    scope: 'Masking',
    enabled: (c) => inDevelop(c) && c.ui.developTool === 'mask',
    run: () => {
      const mk = useMasking.getState()
      mk.setBrush({ brushFeather: Math.max(0, mk.brushFeather - 5) })
    },
  },
  {
    id: 'develop.featherMore',
    label: 'More feather',
    group: 'develop',
    keys: ['shift+]'],
    scope: 'Masking',
    enabled: (c) => inDevelop(c) && c.ui.developTool === 'mask',
    run: () => {
      const mk = useMasking.getState()
      mk.setBrush({ brushFeather: Math.min(100, mk.brushFeather + 5) })
    },
  },
  {
    id: 'develop.clipping',
    label: 'Clipping warnings',
    group: 'develop',
    keys: ['j'],
    scope: 'Develop',
    enabled: inDevelop,
    run: ({ ui }) => {
      ui.toggleClipping('shadows')
      ui.toggleClipping('highlights')
    },
  },
  beforeAfter('develop.before', 'Before', ['\\'], 'before'),
  beforeAfter('develop.sideBySide', 'Before / after side by side', ['y'], 'sideBySide'),
  beforeAfter('develop.topBottom', 'Before / after top and bottom', ['alt+y'], 'topBottom'),
  beforeAfter('develop.splitVertical', 'Before / after split', ['shift+y'], 'splitVertical'),
  beforeAfter(
    'develop.splitHorizontal',
    'Before / after split horizontally',
    ['shift+alt+y'],
    'splitHorizontal',
  ),

  // ---- File ----
  {
    id: 'file.import',
    label: 'Import photos',
    group: 'file',
    keys: ['mod+shift+i'],
    run: () => void useImporter.getState().run(),
  },
  {
    id: 'file.export',
    label: 'Export',
    group: 'file',
    keys: ['mod+shift+e'],
    enabled: hasTargets,
    run: ({ targets }) => useExport.getState().openDialog(targets),
  },
]

export const COMMAND_BY_ID = new Map(COMMANDS.map((c) => [c.id, c]))

/** The chords a command answers to, after any user remapping. */
export function chordsFor(command: Command, overrides: Record<string, string[]>): string[] {
  const custom = overrides[command.id]
  return custom?.length ? custom : command.keys
}

/**
 * Which command a chord would run in a given context, or null.
 *
 * Order in `COMMANDS` is the tie-break, which is why the contextual pairs —
 * `\` in Develop against `\` in the Library — each carry an `enabled` guard
 * rather than trusting their position.
 */
export function resolve(
  chord: string,
  ctx: CommandContext,
  overrides: Record<string, string[]>,
): Command | null {
  for (const command of COMMANDS) {
    if (!chordsFor(command, overrides).includes(chord)) continue
    if (command.enabled && !command.enabled(ctx)) continue
    return command
  }
  return null
}

/**
 * Commands that would also answer to a chord, ignoring context.
 *
 * Used by the remapping UI to warn before a binding is taken. Context-gated
 * overlaps are real conflicts on paper and not in practice, so they are
 * reported rather than refused — the photographer knows whether they ever use
 * both.
 */
export function conflictsFor(
  chord: string,
  exceptId: string,
  overrides: Record<string, string[]>,
): Command[] {
  return COMMANDS.filter(
    (c) => c.id !== exceptId && chordsFor(c, overrides).includes(chord),
  )
}
