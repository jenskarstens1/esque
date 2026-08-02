import { nextId } from '../lib/math'

/*
 * An imperative ask. Menus are built as plain data, so a "Rename…" item has no
 * component of its own to hang a dialog off — it needs to await an answer the
 * way `window.prompt` does, without stopping the render loop the way that does.
 */

export interface Ask {
  id: string
  kind: 'text' | 'confirm'
  title: string
  description?: string
  placeholder?: string
  initial: string
  confirmLabel: string
  danger: boolean
  resolve: (v: string | null) => void
}

let queue: Ask[] = []
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function push(ask: Omit<Ask, 'id' | 'resolve'>) {
  return new Promise<string | null>((resolve) => {
    queue = [...queue, { ...ask, id: nextId(), resolve }]
    emit()
  })
}

/** Resolves with the trimmed text, or null when dismissed. */
export function promptText(opts: {
  title: string
  description?: string
  placeholder?: string
  initial?: string
  confirmLabel?: string
}) {
  return push({
    kind: 'text',
    title: opts.title,
    description: opts.description,
    placeholder: opts.placeholder,
    initial: opts.initial ?? '',
    confirmLabel: opts.confirmLabel ?? 'Save',
    danger: false,
  })
}

/** Resolves true only on confirmation. */
export async function confirmAction(opts: {
  title: string
  description?: string
  confirmLabel?: string
  danger?: boolean
}) {
  const v = await push({
    kind: 'confirm',
    title: opts.title,
    description: opts.description,
    initial: '',
    confirmLabel: opts.confirmLabel ?? 'Continue',
    danger: opts.danger ?? false,
  })
  return v !== null
}

export const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export const snapshot = () => queue

/** Removes an ask from the queue and hands its answer back to the caller. */
export function settleAsk(id: string, value: string | null) {
  const ask = queue.find((q) => q.id === id)
  if (!ask) return
  queue = queue.filter((q) => q.id !== id)
  emit()
  ask.resolve(value)
}
