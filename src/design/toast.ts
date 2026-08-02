import { nextId } from '../lib/math'

export interface Toast {
  id: string
  message: string
  detail?: string
  /**
   * Only failures are marked. A notice carries no status colour because the
   * sentence already is the status — "Imported 248 photos" needs no green dot.
   */
  tone: 'notice' | 'error'
  /** Set while the toast plays its exit; it leaves the list once that ends. */
  closing?: boolean
}

/** Long enough to read, short enough to ignore. A failure earns extra time. */
const LIFETIME = { notice: 4000, error: 7000 } as const
/** Slightly longer than the exit transition in ToastHost. */
const EXIT_MS = 180
/** Beyond three the stack starts climbing the window rather than informing. */
const MAX_VISIBLE = 3

let toasts: Toast[] = []
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------
/*
 * Each toast owns a pausable countdown so that hovering the stack holds every
 * message open: nothing disappears out from under the sentence being read, and
 * a raw error string stays put for as long as it takes to write it down.
 */
interface Timer {
  remaining: number
  startedAt: number
  handle: number | null
}
const timers = new Map<string, Timer>()
let held = false

function resume(id: string) {
  const t = timers.get(id)
  if (!t || t.handle !== null) return
  t.startedAt = Date.now()
  t.handle = window.setTimeout(() => toast.dismiss(id), t.remaining)
}

function pause(id: string) {
  const t = timers.get(id)
  if (!t || t.handle === null) return
  window.clearTimeout(t.handle)
  t.handle = null
  t.remaining = Math.max(0, t.remaining - (Date.now() - t.startedAt))
}

function arm(id: string, ms: number) {
  pause(id)
  timers.set(id, { remaining: ms, startedAt: Date.now(), handle: null })
  if (!held) resume(id)
}

function disarm(id: string) {
  pause(id)
  timers.delete(id)
}

/** Holds every visible toast open — the host calls this while hovered. */
export function holdToasts() {
  held = true
  for (const id of timers.keys()) pause(id)
}

export function releaseToasts() {
  held = false
  for (const id of timers.keys()) resume(id)
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export const toast = {
  show(message: string, opts: { detail?: string; tone?: Toast['tone'] } = {}) {
    const tone = opts.tone ?? 'notice'
    const live = toasts.filter((t) => !t.closing)

    // Repeating an action — ⌘C twice — should re-arm the notice already on
    // screen instead of stacking an identical copy underneath it.
    const newest = live[live.length - 1]
    if (
      newest &&
      newest.message === message &&
      newest.detail === opts.detail &&
      newest.tone === tone
    ) {
      arm(newest.id, LIFETIME[tone])
      return newest.id
    }

    const id = nextId()
    toasts = [...toasts, { id, message, detail: opts.detail, tone }]
    arm(id, LIFETIME[tone])
    for (const stale of live.slice(0, Math.max(0, live.length + 1 - MAX_VISIBLE)))
      toast.dismiss(stale.id)
    emit()
    return id
  },

  error: (message: string, detail?: string) => toast.show(message, { detail, tone: 'error' }),

  /** Plays the exit first, so the stack closes the gap instead of jumping. */
  dismiss(id: string) {
    const t = toasts.find((x) => x.id === id)
    if (!t || t.closing) return
    disarm(id)
    toasts = toasts.map((x) => (x.id === id ? { ...x, closing: true } : x))
    emit()
    window.setTimeout(() => {
      toasts = toasts.filter((x) => x.id !== id)
      emit()
    }, EXIT_MS)
  },
}

export const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export const snapshot = () => toasts
