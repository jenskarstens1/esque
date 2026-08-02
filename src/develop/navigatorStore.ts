/**
 * The Develop canvas's live view, for the Navigator.
 *
 * The viewport owns zoom and pan; the Navigator draws them from another panel
 * entirely. Rather than lift the model into shared state, the canvas pushes and
 * the panel subscribes — the same arrangement as the histogram, and for the
 * same reason: a pan commits on every frame, and no frame of a drag should cost
 * a render of the panel tree.
 *
 * So the payload is split in two. `frame` — everything but the offset — keeps a
 * stable identity while only the pan changes, which is what lets
 * `useNavigatorFrame` bail out of re-rendering; the offset is read imperatively
 * by whatever is drawing.
 */
import { useSyncExternalStore } from 'react'
import { clamp } from '../lib/math'

export interface NavigatorFrame {
  /** Framed image size in image pixels — the canvas's own idea of the photo. */
  width: number
  height: number
  /** The box the image is laid out in, in CSS pixels. */
  paneWidth: number
  paneHeight: number
  /** Image pixels → CSS pixels. */
  scale: number
  /** `null` while fitting, otherwise the explicit zoom level. */
  zoom: number | null
}

/** A frame plus where the view currently sits, in CSS pixels from centred. */
export interface NavigatorView extends NavigatorFrame {
  x: number
  y: number
}

let frame: NavigatorFrame | null = null
let offset = { x: 0, y: 0 }
const listeners = new Set<() => void>()

const same = (a: NavigatorFrame, b: NavigatorView) =>
  a.width === b.width &&
  a.height === b.height &&
  a.paneWidth === b.paneWidth &&
  a.paneHeight === b.paneHeight &&
  a.scale === b.scale &&
  a.zoom === b.zoom

/** Publishes the view. `null` means there's no canvas — no photo, or no module. */
export function setNavigator(next: NavigatorView | null) {
  if (!next) {
    if (!frame) return
    frame = null
    offset = { x: 0, y: 0 }
    emit()
    return
  }
  const moved = offset.x !== next.x || offset.y !== next.y
  const reshaped = !frame || !same(frame, next)
  if (!moved && !reshaped) return
  if (reshaped) {
    const { x: _x, y: _y, ...rest } = next
    frame = rest
  }
  if (moved) offset = { x: next.x, y: next.y }
  emit()
}

function emit() {
  for (const l of listeners) l()
}

export function subscribeNavigator(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** The live view, for readers that draw outside React. */
export const navigatorFrame = () => frame
export const navigatorOffset = () => offset

/** Re-renders only when the view is reshaped — never on a pan. */
export function useNavigatorFrame(): NavigatorFrame | null {
  return useSyncExternalStore(
    subscribeNavigator,
    () => frame,
    () => null,
  )
}

/** True once the image overflows its pane in either axis. */
export function canPan(f: NavigatorFrame): boolean {
  return f.width * f.scale > f.paneWidth + 0.5 || f.height * f.scale > f.paneHeight + 0.5
}

/**
 * The slice of the framed photo the canvas is showing, in 0…1 image space.
 *
 * Normalised rather than in pixels so the Navigator can draw it over a preview
 * of any size, at whatever width the panel has been dragged to.
 */
export function visibleRect(f: NavigatorFrame, x: number, y: number) {
  const drawW = f.width * f.scale
  const drawH = f.height * f.scale
  if (!(drawW > 0) || !(drawH > 0)) return { x: 0, y: 0, width: 1, height: 1 }
  const width = clamp(f.paneWidth / drawW, 0, 1)
  const height = clamp(f.paneHeight / drawH, 0, 1)
  return {
    x: clamp(0.5 - x / drawW - width / 2, 0, 1 - width),
    y: clamp(0.5 - y / drawH - height / 2, 0, 1 - height),
    width,
    height,
  }
}
