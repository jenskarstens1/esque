/**
 * The develop session: the working copy of one photo's edits, its named history
 * stack, and its snapshots.
 *
 * History deliberately follows Lightroom's model rather than a generic undo
 * library — a linear list of labelled steps, each holding the *complete* edit
 * state. Clicking any step restores it; editing after that truncates the
 * future. Consecutive tweaks to the same control coalesce, so dragging a slider
 * produces one entry rather than two hundred.
 */
import { create } from 'zustand'
import { decodedAsShotTempTint } from '../core/color'
import { RENDERED_WHITE_POINT } from '../core/workingImage'
import { defaultEdits, editsKind, SECTION_LABELS, type FileKind } from '../core/defaults'
import type { Edits, EditSection, HistoryStep, Photo, Snapshot } from '../core/types'
import { saveEdits } from '../catalog/actions'
import { produce, setAutoFreeze } from 'immer'
import { db } from '../catalog/db'
import { nextId } from '../lib/math'
import { sameEdits } from './equal'

/** Slider drags within this window fold into the previous history entry. */
const COALESCE_MS = 900
const HISTORY_LIMIT = 250

export interface DevelopSession {
  photoId: string | null
  /**
   * Which baseline this photo's defaults come from. A RAW starts with capture
   * sharpening and colour noise reduction because it has been demosaiced and
   * nothing else has touched it; a JPEG has already been sharpened and
   * denoised in-camera, so the same numbers would be a second pass. Reset,
   * "modified" dots and the compare reference all have to agree on which
   * baseline they mean.
   */
  kind: FileKind
  /** Capture ISO, used by RAW detail defaults and resets. */
  iso: number
  /**
   * The photo's natural pixel size, kept here so anything holding the session
   * can work out the frame's proportions without an async catalog lookup —
   * aspect presets are meaningless without it.
   */
  sourceSize: { width: number; height: number }
  edits: Edits
  /** The state the photo had on entry — the "before" for `\`. */
  original: Edits
  /**
   * The reference the compare views draw as "Before".
   *
   * Starts as `original`, but Lightroom lets you move the goalposts mid-edit:
   * swap the two sides, or promote the current edit to the new before so the
   * next round of work is measured against it. History is untouched either way.
   */
  before: Edits
  /** Bumped whenever `before` changes, so the renderer can cache its graph. */
  beforeRevision: number
  history: HistoryStep[]
  historyIndex: number
  snapshots: Snapshot[]
  /** Bumped on every edit so the viewport knows to redraw. */
  revision: number
  /** Key of the last coalescable change, e.g. `basic.exposure`. */
  lastKey: string | null
  lastAt: number
  clipboard: { edits: Edits; sections: EditSection[] } | null
  /**
   * A transient override shown on the canvas without touching `edits` or
   * history — used for hovering a preset. `null` means "show the real edits".
   */
  previewEdits: Edits | null

  load(photo: Photo | null): Promise<void>
  flush(): Promise<void>
  update(key: string, label: string, mutate: (e: Edits) => void, coalesce?: boolean): void
  replace(label: string, next: Edits): void
  resetSection(section: EditSection): void
  resetAll(): void
  undo(): void
  redo(): void
  jumpTo(index: number): void
  preview(edits: Edits | null): void
  copySettings(sections: EditSection[]): void
  pasteSettings(sections?: EditSection[]): void
  /** Compare: promotes the current edit to the before reference. */
  copyAfterToBefore(): void
  /** Compare: discards the current edit in favour of the before reference. */
  copyBeforeToAfter(): void
  /** Compare: exchanges the two sides in one history step. */
  swapBeforeAfter(): void
  /** Compare: puts the before reference back to the settings on entry. */
  resetBefore(): void
  createSnapshot(name: string): Promise<void>
  applySnapshot(id: string): void
  deleteSnapshot(id: string): Promise<void>
}

// Immer gives structural sharing: an edit to one section leaves every other
// section's object reference untouched, so panels bound to a section only
// re-render when that section actually changed. Auto-freeze stays off because
// edits also travel through the worker and the XMP writer, which mutate copies.
setAutoFreeze(false)

const clone = (e: Edits): Edits => structuredClone(e)

/** `edits` must already be a private, immutable graph — `produce` guarantees it. */
function makeStep(label: string, detail: string, edits: Edits): HistoryStep {
  return { id: nextId(), label, detail, edits, at: Date.now() }
}

/**
 * Drops steps that leave the photo exactly as it already was.
 *
 * Toggles are the reason this exists. Flicking "Enable profile corrections" on
 * and off is a look, not an edit — the second click puts every pixel back where
 * the first one found it, so recording both buries the real work under a pile
 * of steps that cancel each other. Two cases collapse: a step identical to the
 * one before it, and a step that puts the *same control* back where the step
 * before it found it. The same-control rule is what keeps this from quietly
 * eating an unrelated landmark that a later edit happens to coincide with.
 *
 * A step earns its row only if jumping to it shows something different.
 */
function collapseNoOps(history: HistoryStep[]): HistoryStep[] {
  for (;;) {
    const n = history.length
    if (n > 1 && sameEdits(history[n - 1].edits, history[n - 2].edits)) {
      history.pop()
      continue
    }
    if (
      n > 2 &&
      history[n - 1].label === history[n - 2].label &&
      sameEdits(history[n - 1].edits, history[n - 3].edits)
    ) {
      history.splice(n - 2, 2)
      continue
    }
    return history
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let pending: { photoId: string; edits: Edits } | null = null

function scheduleSave(photoId: string, edits: Edits) {
  pending = { photoId, edits }
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    const p = pending
    pending = null
    if (p) void saveEdits(p.photoId, p.edits)
  }, 350)
}

export const useDevelop = create<DevelopSession>()((set, get) => ({
  photoId: null,
  kind: 'raw',
  iso: 0,
  sourceSize: { width: 0, height: 0 },
  edits: defaultEdits(),
  original: defaultEdits(),
  before: defaultEdits(),
  beforeRevision: 0,
  history: [],
  historyIndex: -1,
  snapshots: [],
  previewEdits: null,
  revision: 0,
  lastKey: null,
  lastAt: 0,
  clipboard: null,

  async flush() {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    const p = pending
    pending = null
    if (p) await saveEdits(p.photoId, p.edits)
  },

  async load(photo) {
    if (!photo) {
      set({
        photoId: null,
        kind: 'raw',
        iso: 0,
        sourceSize: { width: 0, height: 0 },
        edits: defaultEdits(),
        original: defaultEdits(),
        before: defaultEdits(),
        beforeRevision: get().beforeRevision + 1,
        history: [],
        historyIndex: -1,
        snapshots: [],
        previewEdits: null,
      })
      return
    }
    if (get().photoId === photo.id) return
    await get().flush()

    const kind = editsKind(photo.isRaw)
    const asShot = photo.isRaw
      ? decodedAsShotTempTint(
          photo.meta.camMul,
          photo.meta.preMul ?? null,
          photo.meta.camXyz,
        )
      : RENDERED_WHITE_POINT
    const edits: Edits = photo.edits
      ? { ...defaultEdits(kind, asShot, photo.meta.iso), ...clone(photo.edits as Edits) }
      : defaultEdits(kind, asShot, photo.meta.iso)

    // "As Shot" should read the camera's actual Kelvin, not the 5500 placeholder,
    // so switching away from it lands somewhere sensible.
    if (edits.basic.wbMode === 'asShot') {
      edits.basic.temp = asShot.temp
      edits.basic.tint = asShot.tint
    }
    const snapshots = await db.snapshots.where('photoId').equals(photo.id).toArray()

    // Before is the photo as it came off the card — the bottom of Lightroom's
    // history stack. Anchoring it to the settings on *open* instead would show
    // an empty comparison for anything already edited, which is precisely the
    // photo you most want to compare.
    const asImported = defaultEdits(kind, asShot, photo.meta.iso)

    set({
      photoId: photo.id,
      kind,
      iso: photo.meta.iso,
      sourceSize: { width: photo.width, height: photo.height },
      edits,
      original: (() => {
        const o = clone(edits)
        o.basic.temp = asShot.temp
        o.basic.tint = asShot.tint
        return o
      })(),
      before: asImported,
      beforeRevision: get().beforeRevision + 1,
      history: [makeStep('Import', '', edits)],
      historyIndex: 0,
      snapshots: snapshots.sort((a, b) => b.createdAt - a.createdAt),
      revision: get().revision + 1,
      lastKey: null,
      lastAt: 0,
      previewEdits: null,
    })
  },

  update(key, label, mutate, coalesce = true) {
    const s = get()
    if (!s.photoId) return
    // Immer treats a returned value as a *replacement* for the whole state, so
    // a mutate written as `(e) => Object.assign(e.crop, x)` would silently swap
    // Edits for a crop rect. Swallow the return rather than corrupt the photo.
    const edits = produce(s.edits, (e) => {
      mutate(e)
    })
    if (edits === s.edits) return

    const now = Date.now()
    const folds = coalesce && s.lastKey === key && now - s.lastAt < COALESCE_MS

    let history = s.history.slice(0, s.historyIndex + 1)
    const entry = makeStep(label, describe(edits, key), edits)
    if (folds && history.length > 1) history[history.length - 1] = entry
    else {
      history.push(entry)
      if (history.length > HISTORY_LIMIT) history = history.slice(history.length - HISTORY_LIMIT)
    }
    history = collapseNoOps(history)
    // Collapsed away: the control is back where an earlier step left it, so
    // there is nothing for a follow-up tweak to fold into. Take that step's
    // own edits so the live state and the selected step stay one object, and
    // section-bound panels keep their memoised references.
    const kept = history[history.length - 1] === entry
    const settled = kept ? edits : history[history.length - 1].edits

    set({
      edits: settled,
      history,
      historyIndex: history.length - 1,
      revision: s.revision + 1,
      lastKey: kept ? key : null,
      lastAt: kept ? now : 0,
    })
    scheduleSave(s.photoId, settled)
  },

  replace(label, next) {
    const s = get()
    if (!s.photoId) return
    const edits = clone(next)
    let history = [...s.history.slice(0, s.historyIndex + 1), makeStep(label, '', edits)]
    if (history.length > HISTORY_LIMIT) history = history.slice(history.length - HISTORY_LIMIT)
    history = collapseNoOps(history)
    const settled = history[history.length - 1].edits
    set({
      edits: settled,
      history,
      historyIndex: history.length - 1,
      revision: s.revision + 1,
      lastKey: null,
      lastAt: 0,
    })
    scheduleSave(s.photoId, settled)
  },

  resetSection(section) {
    const s = get()
    const fresh = defaultEdits(s.kind, undefined, s.iso)
    const defaults = fresh as unknown as Record<string, unknown>
    const next = produce(s.edits, (d) => {
      ;(d as unknown as Record<string, unknown>)[section] = defaults[section]
      if (section === 'basic') {
        d.profile = fresh.profile
        // White balance is a per-photo reading, not a constant — keep as-shot.
        d.basic.temp = s.original.basic.temp
        d.basic.tint = s.original.basic.tint
        d.basic.wbMode = 'asShot'
      }
    })
    get().replace(`Reset ${SECTION_LABELS[section] ?? section}`, next)
  },

  resetAll() {
    const s = get()
    const next = defaultEdits(s.kind, undefined, s.iso)
    next.basic.temp = s.original.basic.temp
    next.basic.tint = s.original.basic.tint
    get().replace('Reset All', next)
  },

  undo() {
    const s = get()
    if (s.historyIndex > 0) get().jumpTo(s.historyIndex - 1)
  },

  redo() {
    const s = get()
    if (s.historyIndex < s.history.length - 1) get().jumpTo(s.historyIndex + 1)
  },

  jumpTo(index) {
    const s = get()
    if (!s.history.length) return
    const i = Math.max(0, Math.min(s.history.length - 1, index))
    const edits = s.history[i].edits
    set({ historyIndex: i, edits, revision: s.revision + 1, lastKey: null, lastAt: 0 })
    if (s.photoId) scheduleSave(s.photoId, edits)
  },

  preview(edits) {
    if (get().previewEdits === edits) return
    set({ previewEdits: edits, revision: get().revision + 1 })
  },

  copySettings(sections) {
    set({ clipboard: { edits: clone(get().edits), sections } })
  },

  pasteSettings(sections) {
    const s = get()
    const clipboard = s.clipboard
    if (!clipboard) return
    const targets = sections
      ? sections.filter((section) => clipboard.sections.includes(section))
      : clipboard.sections
    if (!targets.length) return
    const src = clipboard.edits as unknown as Record<string, unknown>
    const next = produce(s.edits, (d) => {
      const rec = d as unknown as Record<string, unknown>
      for (const section of targets) rec[section] = structuredClone(src[section])
    })
    get().replace('Paste Settings', next)
  },

  copyAfterToBefore() {
    const s = get()
    if (!s.photoId) return
    set({ before: clone(s.edits), beforeRevision: s.beforeRevision + 1 })
  },

  copyBeforeToAfter() {
    const s = get()
    if (!s.photoId) return
    get().replace('Copy Before to After', s.before)
  },

  swapBeforeAfter() {
    const s = get()
    if (!s.photoId) return
    const after = clone(s.edits)
    set({ before: after, beforeRevision: s.beforeRevision + 1 })
    get().replace('Swap Before and After', s.before)
  },

  resetBefore() {
    const s = get()
    if (!s.photoId) return
    const asImported = defaultEdits(s.kind, undefined, s.iso)
    asImported.basic.temp = s.original.basic.temp
    asImported.basic.tint = s.original.basic.tint
    set({ before: asImported, beforeRevision: s.beforeRevision + 1 })
  },

  async createSnapshot(name) {
    const s = get()
    if (!s.photoId) return
    const snap: Snapshot = {
      id: nextId(),
      photoId: s.photoId,
      name,
      edits: clone(s.edits),
      createdAt: Date.now(),
    }
    await db.snapshots.put(snap)
    set({ snapshots: [snap, ...s.snapshots] })
  },

  applySnapshot(id) {
    const snap = get().snapshots.find((x) => x.id === id)
    if (snap) get().replace(`Snapshot: ${snap.name}`, snap.edits)
  },

  async deleteSnapshot(id) {
    await db.snapshots.delete(id)
    set({ snapshots: get().snapshots.filter((s) => s.id !== id) })
  },
}))

/**
 * What Copy Settings offers, in panel order.
 *
 * `profile` and `tone` are in here because both are raw-side settings — the
 * camera profile is the base rendering, and highlight recovery only means
 * anything on undemosaiced sensor data. Leaving them out meant "copy all
 * settings" quietly wasn't. Crop and the retouching lists stay out: they are
 * frame geometry, not a look.
 */
export const ALL_SECTIONS: EditSection[] = [
  'profile',
  'basic',
  'tone',
  'curve',
  'colorMixer',
  'colorGrading',
  'detail',
  'lens',
  'transform',
  'effects',
  'calibration',
]

export { SECTION_LABELS }

/** Renders the current value at a dotted path, for the history detail column. */
function describe(edits: Edits, key: string): string {
  const value = key.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[part]
    return undefined
  }, edits)
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2)
  }
  if (typeof value === 'string') return value
  return ''
}
