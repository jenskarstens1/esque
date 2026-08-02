/**
 * The live histogram is produced as a side effect of rendering, so it lives
 * outside React's data flow: the viewport pushes, panels subscribe. Using a
 * plain store (rather than state) keeps a 60fps slider drag from re-rendering
 * the panel tree.
 */
import { useSyncExternalStore } from 'react'
import type { HistogramBins } from '../gpu/renderer'

let current: HistogramBins | null = null
const listeners = new Set<() => void>()

export function setHistogram(bins: HistogramBins | null) {
  current = bins
  for (const l of listeners) l()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useHistogram(): HistogramBins | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  )
}
