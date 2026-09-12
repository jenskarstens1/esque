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
import { detachDetectedAlpha } from './layers'
import { produce, setAutoFreeze } from 'immer'
import { db } from '../catalog/db'
import { nextId } from '../lib/math'
import { toast } from '../design/toast'
import { sameEdits } from './equal'

/** Slider drags within this window fold into the previous history entry. */
const COALESCE_MS = 900
const HISTORY_LIMIT = 250

export interface EditSaveState {
  saveStatus: 'saved' | 'pending' | 'saving' | 'error'
  saveError: string | null
  pendingSaveCount: number
}

export interface DevelopSession extends EditSaveState {
  photoId: string | null
  /**
   * The row whose pixels are on screen: a virtual copy's master, or the photo
   * itself. Two variants of one frame share a detected mask's coverage, so
   * anything reasoning about "the same photograph" means this, not `photoId`.
   */
  imageId: string | null
  /**
   * Which baseline this photo's defaults come from. Sharpening starts off for
   * every kind; RAWs retain ISO-calibrated noise reduction, while a JPEG has
   * already been denoised in-camera. Reset, "modified" dots and the compare
   * reference all have to agree on which baseline they mean.
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
  /**
   * The copied settings, with the identity of the photograph they came from.
   *
   * `imageId` is the row a virtual copy renders through, not the copy's own id:
   * two variants of one frame share their pixels, so a detected mask computed
   * for either is valid for the other.
   */
  clipboard: { edits: Edits; sections: EditSection[]; imageId: string | null } | null
  /**
   * A transient override shown on the canvas without touching `edits` or
   * history — used for hovering a preset. `null` means "show the real edits".
   */
  previewEdits: Edits | null

  load(photo: Photo | null, opts?: { reopen?: boolean }): Promise<void>
  flush(): Promise<void>
  retrySave(): Promise<void>
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
  /** Captures the current settings. Without a name, numbers it for you. */
  createSnapshot(name?: string): Promise<string | undefined>
  applySnapshot(id: string): void
  renameSnapshot(id: string, name: string): Promise<void>
  deleteSnapshot(id: string): Promise<void>
}

// Immer gives structural sharing: an edit to one section leaves every other
// section's object reference untouched, so panels bound to a section only
// re-render when that section actually changed. Auto-freeze stays off because
// edits also travel through the worker and the XMP writer, which mutate copies.
setAutoFreeze(false)

const clone = (e: Edits): Edits => structuredClone(e)

/** Names a new snapshot "Snapshot #n", picking up after the highest one taken. */
function nextSnapshotName(snapshots: Snapshot[]): string {
  const highest = snapshots.reduce((max, s) => {
    const n = Number(/^Snapshot #(\d+)$/.exec(s.name)?.[1])
    return Number.isFinite(n) && n > max ? n : max
  }, 0)
  return `Snapshot #${Math.max(highest, snapshots.length) + 1}`
}

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

/**
 * A queued version belongs to its photo until the catalog acknowledges it.
 * Replacing a queued version during a write must not let that older write
 * acknowledge the replacement. Failed versions stay available for retry/load.
 */
export function createEditSaveQueue(
  write: (photoId: string, edits: Edits) => Promise<void>,
  onChange: (state: EditSaveState) => void,
  delay = 350,
) {
  const pending = new Map<string, { edits: Edits }>()
  // Photos whose settings are being replaced from outside the session. Their
  // queued versions are stale by definition, so the queue neither writes nor
  // accepts them until the replacement has landed. Counted rather than flagged
  // so two overlapping replacements can't have the first to finish release the
  // photo out from under the second.
  const suspended = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  let error: string | null = null

  const notify = () =>
    onChange({
      saveStatus: error ? 'error' : inFlight ? 'saving' : pending.size ? 'pending' : 'saved',
      saveError: error,
      pendingSaveCount: pending.size,
    })

  const nextWritable = (): [string, { edits: Edits }] | null => {
    for (const entry of pending) if (!suspended.has(entry[0])) return entry
    return null
  }

  const flush = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (inFlight) return inFlight.then(() => flush())
    if (!nextWritable()) return Promise.resolve()

    error = null
    inFlight = Promise.resolve()
      .then(async () => {
        for (let next = nextWritable(); next; next = nextWritable()) {
          const [photoId, version] = next
          await write(photoId, version.edits)
          if (pending.get(photoId) === version) pending.delete(photoId)
          notify()
        }
      })
      .catch((err: unknown) => {
        error =
          err instanceof Error && err.name === 'QuotaExceededError'
            ? 'Browser storage is full. Free some space, then retry saving.'
            : err instanceof Error
              ? err.message
              : String(err)
        throw err
      })
      .finally(() => {
        inFlight = null
        notify()
      })
    notify()
    return inFlight
  }

  return {
    peek: (photoId: string) => pending.get(photoId)?.edits,
    /** Abandons a photo's queued edits, for when something replaced them. */
    drop(photoId: string) {
      pending.delete(photoId)
      notify()
    },
    flush,
    /**
     * Hands `photoIds` to a writer outside this queue for the duration of `apply`.
     *
     * Dropping the queued version is not enough on its own. A write already
     * running holds its version on the stack, so it lands *after* the drop and
     * puts the old settings back over whatever the outside writer just stored.
     * Waiting for that write to finish before abandoning the version — and
     * refusing new ones until `apply` returns — is what makes the replacement
     * final rather than merely first.
     */
    async suspend<T>(photoIds: string[], apply: () => Promise<T>): Promise<T> {
      const ids = [...new Set(photoIds)]
      for (const id of ids) suspended.set(id, (suspended.get(id) ?? 0) + 1)
      try {
        // A failed write leaves its version queued for retry; this only needs
        // the write to be over, not to have succeeded.
        while (inFlight) await inFlight.catch(() => {})
        let dropped = false
        for (const id of ids) dropped ||= pending.delete(id)
        if (dropped) notify()
        return await apply()
      } finally {
        for (const id of ids) {
          const depth = (suspended.get(id) ?? 1) - 1
          if (depth > 0) suspended.set(id, depth)
          else suspended.delete(id)
        }
        notify()
      }
    },
    schedule(photoId: string, edits: Edits) {
      // Queueing a suspended photo would race the replacement being written
      // for it, and would lose either way: the version is already superseded.
      if (suspended.has(photoId)) return
      pending.set(photoId, { edits })
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      // A failed write needs an explicit retry, not a failing write per drag.
      if (!error) {
        timer = setTimeout(() => {
          timer = null
          void flush().catch(() => {
            // The queue retains the version and publishes the failure above.
          })
        }, delay)
      }
      notify()
    },
  }
}

const saves = createEditSaveQueue(saveEdits, (state) => {
  const previousError = useDevelop.getState().saveError
  useDevelop.setState(state)
  if (state.saveError && state.saveError !== previousError) {
    toast.error('Edits not saved', `${state.saveError} Your changes are still in this tab.`)
  }
})
let loadRequest = 0

function scheduleSave(photoId: string, edits: Edits) {
  saves.schedule(photoId, edits)
}

export const useDevelop = create<DevelopSession>()((set, get) => ({
  photoId: null,
  imageId: null,
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
  saveStatus: 'saved',
  saveError: null,
  pendingSaveCount: 0,

  flush: () => saves.flush(),
  retrySave: () => saves.flush(),

  async load(photo, opts) {
    const request = ++loadRequest
    if (photo && get().photoId === photo.id && !opts?.reopen) return
    const retained = photo && !opts?.reopen ? saves.peek(photo.id) : undefined
    await get().flush().catch(() => {
      // Navigation can continue: failed edits stay queued per photo, visible
      // in SaveStatus, and are restored if that photo is opened again.
    })
    if (request !== loadRequest) return
    if (!photo) {
      set({
        photoId: null,
        imageId: null,
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

    const kind = editsKind(photo.isRaw)
    const asShot = photo.isRaw
      ? decodedAsShotTempTint(
          photo.meta.camMul,
          photo.meta.preMul ?? null,
          photo.meta.camXyz,
        )
      : RENDERED_WHITE_POINT
    const working = opts?.reopen
      ? photo.edits
      : (saves.peek(photo.id) ?? retained ?? photo.edits)
    const edits: Edits = working
      ? { ...defaultEdits(kind, asShot, photo.meta.iso), ...clone(working) }
      : defaultEdits(kind, asShot, photo.meta.iso)

    // "As Shot" should read the camera's actual Kelvin, not the 5500 placeholder,
    // so switching away from it lands somewhere sensible.
    if (edits.basic.wbMode === 'asShot') {
      edits.basic.temp = asShot.temp
      edits.basic.tint = asShot.tint
    }
    const snapshots = await db.snapshots.where('photoId').equals(photo.id).toArray()
    if (request !== loadRequest) return

    // Before is the photo as it came off the card — the bottom of Lightroom's
    // history stack. Anchoring it to the settings on *open* instead would show
    // an empty comparison for anything already edited, which is precisely the
    // photo you most want to compare.
    const asImported = defaultEdits(kind, asShot, photo.meta.iso)

    set({
      photoId: photo.id,
      imageId: photo.masterId ?? photo.id,
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
    set({ clipboard: { edits: clone(get().edits), sections, imageId: get().imageId } })
  },

  pasteSettings(sections) {
    const s = get()
    const clipboard = s.clipboard
    if (!clipboard) return
    const targets = sections
      ? sections.filter((section) => clipboard.sections.includes(section))
      : clipboard.sections
    if (!targets.length) return
    // A detected mask's cached alpha belongs to the photograph it was computed
    // from, so pasting across photos has to drop the pointer and ask for a
    // fresh detection rather than paint the previous subject onto this one. A
    // virtual copy of the same frame keeps it: the pixels are identical.
    const source =
      clipboard.imageId && clipboard.imageId !== s.imageId
        ? detachDetectedAlpha(clipboard.edits)
        : clipboard.edits
    const src = source as unknown as Record<string, unknown>
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
      name: name?.trim() || nextSnapshotName(s.snapshots),
      edits: clone(s.edits),
      createdAt: Date.now(),
    }
    await db.snapshots.put(snap)
    set({ snapshots: [snap, ...get().snapshots] })
    return snap.id
  },

  applySnapshot(id) {
    const snap = get().snapshots.find((x) => x.id === id)
    if (snap) get().replace(`Snapshot: ${snap.name}`, snap.edits)
  },

  async renameSnapshot(id, name) {
    const trimmed = name.trim()
    const snap = get().snapshots.find((x) => x.id === id)
    if (!snap || !trimmed || trimmed === snap.name) return
    const next = { ...snap, name: trimmed }
    await db.snapshots.put(next)
    set({ snapshots: get().snapshots.map((s) => (s.id === id ? next : s)) })
  },

  async deleteSnapshot(id) {
    await db.snapshots.delete(id)
    set({ snapshots: get().snapshots.filter((s) => s.id !== id) })
  },
}))

/**
 * Replaces stored settings from outside Develop, and makes the session agree.
 *
 * Writing the catalogue is only half of it. The open photo's settings live in
 * this store, and the save queue may still hold a version that was never
 * written — or be in the middle of writing one. Left alone the panels keep
 * showing the old look and the next slider move saves it back over what was
 * just imported. The write therefore happens *inside* the queue's suspension,
 * so no save can be scheduled or land around it, and the photo is re-opened
 * from the row that was actually stored.
 */
export async function adoptStoredEdits(
  photoIds: string[],
  commit: () => Promise<void>,
): Promise<void> {
  await saves.suspend(photoIds, async () => {
    await commit()
    const open = useDevelop.getState().photoId
    if (!open || !photoIds.includes(open)) return
    const photo = await db.photos.get(open)
    if (photo) await useDevelop.getState().load(photo, { reopen: true })
  })
}

/** Install once at the app boundary, not only while Develop is mounted. */
export function installSaveLifecycle() {
  const flush = () => {
    void useDevelop.getState().flush().catch(() => {
      // SaveStatus and the save-error toast already expose this retained work.
    })
  }
  const onHidden = () => {
    if (document.visibilityState === 'hidden') flush()
  }
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!useDevelop.getState().pendingSaveCount) return
    flush()
    event.preventDefault()
    event.returnValue = ''
  }
  let guarding = false
  const guard = () => {
    const dirty = useDevelop.getState().pendingSaveCount > 0
    if (dirty === guarding) return
    guarding = dirty
    if (dirty) window.addEventListener('beforeunload', onBeforeUnload)
    else window.removeEventListener('beforeunload', onBeforeUnload)
  }
  const unsubscribe = useDevelop.subscribe(guard)
  guard()
  document.addEventListener('visibilitychange', onHidden)
  window.addEventListener('pagehide', flush)
  return () => {
    unsubscribe()
    document.removeEventListener('visibilitychange', onHidden)
    window.removeEventListener('pagehide', flush)
    window.removeEventListener('beforeunload', onBeforeUnload)
  }
}

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
