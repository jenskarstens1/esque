import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clamp } from './math'
import { useDevicePixelRatio } from './useDevicePixelRatio'

/** The zoom ladder, in image pixels per device pixel. `1` is a true 1:1 view. */
export const ZOOM_STOPS = [0.06, 0.11, 0.16, 0.25, 0.33, 0.5, 0.66, 1, 1.5, 2, 3, 4, 8, 11, 16]
const MAX_ZOOM = ZOOM_STOPS[ZOOM_STOPS.length - 1]

const TWEEN_MS = 190
/** Below this a flick is a click with a wobble, not a throw. */
const FLING_MIN = 0.08
/** ~4000 px/s. Erratic pointer sampling can report far more than a hand means. */
const FLING_MAX = 4
const FLING_DECAY = 0.9955
const GESTURES = ['gesturestart', 'gesturechange', 'gestureend']

export interface Focus {
  /** Offset from the centre of the host, in CSS pixels. */
  x: number
  y: number
}

/**
 * A point in the image to settle on, in 0…1 of its framed size.
 *
 * Where a `Focus` pins a point under the cursor, a `Centre` brings one to the
 * middle of the pane. That's what the Navigator needs: its cursor is over a map
 * of the photo, not over the photo itself, so the spot you point at is the spot
 * you want to be looking at.
 */
export interface Centre {
  nx: number
  ny: number
}

/** The live view, as the canvas needs it. See `ZoomPan.read`. */
export interface ViewState {
  /** Effective scale: image pixels → CSS pixels. */
  scale: number
  zoom: number | null
  x: number
  y: number
}

export interface ZoomPan {
  /** Effective scale: image pixels → CSS pixels. */
  scale: number
  /** `null` while fitting, otherwise the explicit zoom level. */
  zoom: number | null
  fitScale: number
  /** Image pixels per device pixel, as a percentage — what the badge shows. */
  percent: number
  offset: { x: number; y: number }
  isFit: boolean
  isPanning: boolean
  canPan: boolean
  canZoomIn: boolean
  canZoomOut: boolean
  cursor: string
  /**
   * The view as it stands right now, which during a gesture is ahead of the
   * rendered props: React commits land a frame later at best.
   */
  read: () => ViewState
  /**
   * Called synchronously whenever the view moves, inside the frame that moved
   * it. A canvas that repaints from here is never waiting on a React commit,
   * which is the difference between tracking the pointer and lagging behind it.
   */
  subscribe: (fn: () => void) => () => void
  setZoom: (z: number | null, focus?: Focus) => void
  toggleZoom: (focus?: Focus, centre?: Centre) => void
  zoomBy: (factor: number, focus?: Focus, centre?: Centre) => void
  /** Steps to the next/previous stop on the ladder. */
  zoomIn: () => void
  zoomOut: () => void
  fit: () => void
  fill: () => void
  /** 1:1 — one image pixel per device pixel. */
  actual: () => void
  /**
   * Centres the view on a point in the image, given in 0…1 of its framed size.
   * This is how the Navigator drives the canvas.
   */
  panTo: (nx: number, ny: number) => void
  reset: () => void
  bind: {
    /**
     * Must be spread onto the host. Wheel and gesture handlers are attached
     * natively rather than through React, because React registers them
     * passively at the root — `preventDefault()` there is a no-op and the
     * browser zooms the whole page instead of the image.
     */
    ref: (el: HTMLElement | null) => void
    onPointerDown: (e: React.PointerEvent) => void
    onDoubleClick: (e: React.MouseEvent) => void
    onDragStart: (e: React.DragEvent) => void
    style: React.CSSProperties
  }
}

/**
 * The subset driven from outside the viewport — the global keymap, the View
 * menu, and the Navigator — on whichever surface is mounted.
 */
export interface ZoomCommands {
  zoomIn: () => void
  zoomOut: () => void
  fit: () => void
  fill: () => void
  actual: () => void
  toggle: () => void
  /** An explicit zoom level, or `null` for fit — how the Navigator's menu picks a stop. */
  setZoom: (z: number | null) => void
  /**
   * Relative, unanimated, clamped to fit…max — what a scrub on the Navigator's
   * readout emits, frame by frame.
   */
  zoomBy: (factor: number) => void
  panTo: (nx: number, ny: number) => void
  /** One rung of the ladder, landing on a point in the image. */
  zoomAt: (dir: 1 | -1, nx: number, ny: number) => void
  /** Continuous, for a pinch over the Navigator. */
  zoomByAt: (factor: number, nx: number, ny: number) => void
  toggleAt: (nx: number, ny: number) => void
}

let mounted: ZoomCommands | null = null
/** The zoom/pan surface currently on screen, or `null` in the grid. */
export const zoomCommands = (): ZoomCommands | null => mounted

interface View {
  zoom: number | null
  x: number
  y: number
}

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

const isFormField = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/**
 * Zoom/pan model shared by the Library loupe and the Develop canvas.
 *
 * Zoom is expressed in image pixels per *device* pixel, so `1` is a true 1:1
 * view at any display density. Pan and continuous zoom commit at most once per
 * animation frame: a trackpad emits far more events than there are frames, and
 * the Develop canvas repaints on every committed change.
 */
export function useZoomPan(
  container: { width: number; height: number },
  image: { width: number; height: number },
  opts: { fillOnFit?: boolean; active?: boolean } = {},
): ZoomPan {
  const { fillOnFit = false, active = true } = opts
  const dpr = useDevicePixelRatio()

  const [view, setView] = useState<View>({ zoom: null, x: 0, y: 0 })
  const [isPanning, setPanning] = useState(false)
  const [spaceDown, setSpaceDown] = useState(false)

  const fitScale = useMemo(() => {
    if (!image.width || !image.height || !container.width || !container.height) return 1
    const sx = container.width / image.width
    const sy = container.height / image.height
    return fillOnFit ? Math.max(sx, sy) : Math.min(sx, sy)
  }, [container.width, container.height, image.width, image.height, fillOnFit])

  const fitZoom = fitScale * dpr
  const scale = view.zoom === null ? fitScale : view.zoom / dpr
  const canPan =
    image.width * scale > container.width + 0.5 || image.height * scale > container.height + 0.5

  // Everything the imperative handlers need, mirrored so they never go stale
  // and never have to be re-attached mid-gesture.
  const g = useRef({ cw: 0, ch: 0, iw: 0, ih: 0, fitScale: 1, fitZoom: 1, dpr: 1, canPan: false })
  g.current = {
    cw: container.width,
    ch: container.height,
    iw: image.width,
    ih: image.height,
    fitScale,
    fitZoom,
    dpr,
    canPan,
  }

  const viewRef = useRef(view)
  const commitFrame = useRef(0)

  // Subscribers are told the moment the view moves, in the same frame, so the
  // canvas can be repainted before the browser draws — React state follows for
  // whatever else is on screen, and is allowed to be a frame behind.
  const listeners = useRef(new Set<() => void>())
  const subscribe = useCallback((fn: () => void) => {
    listeners.current.add(fn)
    return () => {
      listeners.current.delete(fn)
    }
  }, [])
  const emit = useCallback(() => {
    for (const fn of listeners.current) fn()
  }, [])

  const scaleOf = useCallback(
    (z: number | null) => (z === null ? g.current.fitScale : z / g.current.dpr),
    [],
  )

  const read = useCallback((): ViewState => {
    const v = viewRef.current
    return { scale: scaleOf(v.zoom), zoom: v.zoom, x: v.x, y: v.y }
  }, [scaleOf])

  const clampXY = useCallback((x: number, y: number, s: number) => {
    const mx = Math.max(0, (g.current.iw * s - g.current.cw) / 2)
    const my = Math.max(0, (g.current.ih * s - g.current.ch) / 2)
    return { x: clamp(x, -mx, mx), y: clamp(y, -my, my) }
  }, [])

  /**
   * `sync` is for callers already running inside a frame — a tween, a fling —
   * and draws immediately; everyone else lets the batch land on the next one.
   * Subscribers are notified from whichever frame the move lands in, before
   * React is told, so nothing that draws is waiting on a commit.
   */
  const commit = useCallback(
    (next: View, sync = false) => {
      const prev = viewRef.current
      if (prev.zoom === next.zoom && prev.x === next.x && prev.y === next.y) return
      viewRef.current = next
      if (sync) {
        if (commitFrame.current) cancelAnimationFrame(commitFrame.current)
        commitFrame.current = 0
        emit()
        setView(next)
        return
      }
      if (commitFrame.current) return
      commitFrame.current = requestAnimationFrame(() => {
        commitFrame.current = 0
        emit()
        setView(viewRef.current)
      })
    },
    [emit],
  )

  // -- animation ------------------------------------------------------------
  const tweenFrame = useRef(0)
  const glideFrame = useRef(0)
  /** Where a running tween is headed, so rapid steps compound instead of crawl. */
  const tweenTo = useRef<number | null>(null)

  const stopTween = useCallback(() => {
    if (tweenFrame.current) cancelAnimationFrame(tweenFrame.current)
    tweenFrame.current = 0
  }, [])

  const stopGlide = useCallback(() => {
    if (glideFrame.current) cancelAnimationFrame(glideFrame.current)
    glideFrame.current = 0
  }, [])

  /**
   * Moves to `target`, keeping `focus` pinned under the cursor. Without a focus
   * the offset simply scales with the image, which holds the centre still.
   * A `centre` overrides both and lands on that point in the image instead.
   */
  const applyZoom = useCallback(
    (target: number | null, focus?: Focus, animated = false, centre?: Centre) => {
      stopTween()
      stopGlide()
      const from = viewRef.current
      const s0 = scaleOf(from.zoom)
      const s1 = scaleOf(target)

      const at = (s: number) => {
        if (centre) {
          const { iw, ih } = g.current
          return clampXY((0.5 - centre.nx) * iw * s, (0.5 - centre.ny) * ih * s, s)
        }
        const k = s / s0
        const fx = focus?.x ?? 0
        const fy = focus?.y ?? 0
        return clampXY(fx - (fx - from.x) * k, fy - (fy - from.y) * k, s)
      }

      if (!animated || reducedMotion() || Math.abs(s1 / s0 - 1) < 1e-4) {
        tweenTo.current = null
        commit({ zoom: target, ...at(s1) })
        return
      }

      tweenTo.current = target
      const t0 = performance.now()
      const loop = (now: number) => {
        const t = Math.min(1, (now - t0) / TWEEN_MS)
        const e = 1 - (1 - t) ** 4
        // Geometric interpolation — zoom is perceptually multiplicative, so a
        // linear ramp would crawl at the start and lurch at the end.
        const s = s0 * (s1 / s0) ** e
        if (t < 1) {
          commit({ zoom: s * g.current.dpr, ...at(s) }, true)
          tweenFrame.current = requestAnimationFrame(loop)
        } else {
          tweenFrame.current = 0
          tweenTo.current = null
          commit({ zoom: target, ...at(s1) }, true)
        }
      }
      tweenFrame.current = requestAnimationFrame(loop)
    },
    [clampXY, commit, scaleOf, stopGlide, stopTween],
  )

  /** The zoom a new gesture should build on: a tween's destination, not its current frame. */
  const liveZoom = () =>
    (tweenFrame.current ? tweenTo.current : viewRef.current.zoom) ?? g.current.fitZoom

  const setZoom = useCallback(
    (z: number | null, focus?: Focus) => applyZoom(z, focus, true),
    [applyZoom],
  )

  /**
   * Continuous zoom, for pinch. Fit is the floor: an editor has no use for a
   * view smaller than its window, and landing exactly on fit is what lets the
   * view snap back to tracking the window instead of a frozen scale.
   */
  const zoomBy = useCallback(
    (factor: number, focus?: Focus, centre?: Centre) => {
      const floor = g.current.fitZoom
      const next = clamp(liveZoom() * factor, floor, MAX_ZOOM)
      applyZoom(next <= floor * 1.0005 ? null : next, focus, false, centre)
    },
    [applyZoom],
  )

  /** One rung of the ladder, so 100% is always reachable by wheel or button. */
  const stepZoom = useCallback(
    (dir: 1 | -1, focus?: Focus, centre?: Centre) => {
      const floor = g.current.fitZoom
      const cur = liveZoom()
      if (dir > 0) {
        applyZoom(
          ZOOM_STOPS.find((s) => s > cur * 1.001 && s > floor) ?? MAX_ZOOM,
          focus,
          true,
          centre,
        )
        return
      }
      const prev = [...ZOOM_STOPS].reverse().find((s) => s < cur * 0.999)
      applyZoom(prev === undefined || prev <= floor * 1.02 ? null : prev, focus, true, centre)
    },
    [applyZoom],
  )

  const zoomIn = useCallback(() => stepZoom(1), [stepZoom])
  const zoomOut = useCallback(() => stepZoom(-1), [stepZoom])
  const fit = useCallback(() => applyZoom(null, undefined, true), [applyZoom])
  const actual = useCallback(() => applyZoom(1, undefined, true), [applyZoom])

  const fill = useCallback(() => {
    const { cw, ch, iw, ih, dpr: d } = g.current
    if (!iw || !ih || !cw || !ch) return
    applyZoom(Math.max(cw / iw, ch / ih) * d, undefined, true)
  }, [applyZoom])

  /** Fit ⇄ the last explicit zoom, so toggling returns you to where you were. */
  const lastZoom = useRef(1)
  useEffect(() => {
    if (view.zoom !== null && !tweenFrame.current) lastZoom.current = view.zoom
  }, [view.zoom])

  const toggleZoom = useCallback(
    (focus?: Focus, centre?: Centre) => {
      const zoomed = viewRef.current.zoom !== null
      applyZoom(
        zoomed ? null : Math.max(lastZoom.current, g.current.fitZoom * 1.05),
        focus,
        true,
        centre,
      )
    },
    [applyZoom],
  )

  /**
   * Centres the view on a point in the image, in 0…1 of its framed size.
   *
   * Clamped like every other move, so dragging the Navigator past a corner
   * parks the view against the edge instead of pulling the photo off screen.
   */
  const panTo = useCallback(
    (nx: number, ny: number) => {
      stopTween()
      stopGlide()
      const { iw, ih } = g.current
      if (!iw || !ih) return
      const v = viewRef.current
      const s = scaleOf(v.zoom)
      commit({ ...v, ...clampXY((0.5 - nx) * iw * s, (0.5 - ny) * ih * s, s) }, true)
    },
    [clampXY, commit, scaleOf, stopGlide, stopTween],
  )

  /** The Navigator's gestures: zoom about a point on its map of the photo. */
  const zoomAt = useCallback(
    (dir: 1 | -1, nx: number, ny: number) => stepZoom(dir, undefined, { nx, ny }),
    [stepZoom],
  )
  const zoomByAt = useCallback(
    (factor: number, nx: number, ny: number) => zoomBy(factor, undefined, { nx, ny }),
    [zoomBy],
  )
  const toggleAt = useCallback(
    (nx: number, ny: number) => toggleZoom(undefined, { nx, ny }),
    [toggleZoom],
  )

  const reset = useCallback(() => {
    stopTween()
    stopGlide()
    tweenTo.current = null
    lastZoom.current = 1
    commit({ zoom: null, x: 0, y: 0 }, true)
  }, [commit, stopGlide, stopTween])

  // Re-clamp whenever the frame or the image changes so nothing drifts off screen.
  useEffect(() => {
    const v = viewRef.current
    const next = clampXY(v.x, v.y, scaleOf(v.zoom))
    if (next.x !== v.x || next.y !== v.y) commit({ ...v, ...next }, true)
  }, [clampXY, commit, scaleOf, container.width, container.height, image.width, image.height, dpr])

  // -- pointer gestures -----------------------------------------------------
  const hostRef = useRef<HTMLElement | null>(null)
  /**
   * The host's box, held for the length of a gesture.
   *
   * Reading it per event forces a synchronous layout, and during a gesture the
   * layout is always dirty — React has just moved the overlays — so every wheel
   * tick would pay for a full recalc. It cannot move mid-gesture without a
   * resize or a scroll, both of which drop it.
   */
  const rectRef = useRef<DOMRect | null>(null)
  const dropRect = useCallback(() => {
    rectRef.current = null
  }, [])
  const hostRect = useCallback(() => {
    if (!rectRef.current) rectRef.current = hostRef.current?.getBoundingClientRect() ?? null
    return rectRef.current
  }, [])

  useEffect(() => {
    const opts = { capture: true, passive: true } as const
    window.addEventListener('resize', dropRect, opts)
    window.addEventListener('scroll', dropRect, opts)
    return () => {
      window.removeEventListener('resize', dropRect, opts)
      window.removeEventListener('scroll', dropRect, opts)
    }
  }, [dropRect])

  // A pane that changed shape has moved every box inside it.
  useEffect(dropRect, [dropRect, container.width, container.height])

  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const drag = useRef<{
    id: number
    x: number
    y: number
    ox: number
    oy: number
    trail: Array<{ t: number; x: number; y: number }>
  } | null>(null)
  const pinch = useRef<{ dist: number; mx: number; my: number } | null>(null)

  const focusOf = useCallback(
    (clientX: number, clientY: number): Focus => {
      const rect = hostRect()
      if (!rect) return { x: 0, y: 0 }
      return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 }
    },
    [hostRect],
  )

  const fling = useCallback(
    (vx: number, vy: number) => {
      let last = performance.now()
      const loop = (now: number) => {
        const dt = Math.min(32, now - last)
        last = now
        const decay = FLING_DECAY ** dt
        vx *= decay
        vy *= decay
        const v = viewRef.current
        const next = clampXY(v.x + vx * dt, v.y + vy * dt, scaleOf(v.zoom))
        const stuck = next.x === v.x && next.y === v.y
        commit({ ...v, ...next }, true)
        glideFrame.current = Math.hypot(vx, vy) < 0.02 || stuck ? 0 : requestAnimationFrame(loop)
      }
      glideFrame.current = requestAnimationFrame(loop)
    },
    [clampXY, commit, scaleOf],
  )

  const beginDrag = useCallback((id: number, x: number, y: number) => {
    const v = viewRef.current
    drag.current = { id, x, y, ox: v.x, oy: v.y, trail: [{ t: performance.now(), x, y }] }
  }, [])

  // Window listeners are attached once per gesture through stable trampolines,
  // so the handlers can close over fresh values without being re-registered.
  const moveRef = useRef<(e: PointerEvent) => void>(() => {})
  const upRef = useRef<(e: PointerEvent) => void>(() => {})
  const listening = useRef(false)
  const onMove = useMemo(() => (e: PointerEvent) => moveRef.current(e), [])
  const onUp = useMemo(() => (e: PointerEvent) => upRef.current(e), [])

  const attach = useCallback(() => {
    if (listening.current) return
    listening.current = true
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [onMove, onUp])

  const detach = useCallback(() => {
    if (!listening.current) return
    listening.current = false
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
  }, [onMove, onUp])

  moveRef.current = (e: PointerEvent) => {
    const map = pointers.current
    if (!map.has(e.pointerId)) return
    map.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (map.size >= 2 && pinch.current) {
      const [a, b] = [...map.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      const prev = pinch.current
      zoomBy(dist / prev.dist, focusOf(mx, my))
      // A travelling midpoint is a two-finger drag riding along with the pinch.
      const v = viewRef.current
      commit({ ...v, ...clampXY(v.x + (mx - prev.mx), v.y + (my - prev.my), scaleOf(v.zoom)) })
      pinch.current = { dist, mx, my }
      return
    }

    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const v = viewRef.current
    commit({
      ...v,
      ...clampXY(d.ox + (e.clientX - d.x), d.oy + (e.clientY - d.y), scaleOf(v.zoom)),
    })
    d.trail.push({ t: performance.now(), x: e.clientX, y: e.clientY })
    if (d.trail.length > 6) d.trail.shift()
  }

  upRef.current = (e: PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null

    const d = drag.current
    if (d && d.id === e.pointerId) {
      drag.current = null
      setPanning(false)
      // Velocity from the tail of the trail; the final sample alone is noise.
      const head = d.trail[Math.max(0, d.trail.length - 4)]
      const tail = d.trail[d.trail.length - 1]
      const dt = head && tail ? tail.t - head.t : 0
      // Holding still before letting go means you meant to stop there.
      const quiet = tail ? performance.now() - tail.t > 60 : true
      if (dt > 8 && !quiet) {
        const speed = Math.hypot(tail.x - head.x, tail.y - head.y) / dt
        if (speed > FLING_MIN) {
          const trim = Math.min(1, FLING_MAX / speed) / dt
          fling((tail.x - head.x) * trim, (tail.y - head.y) * trim)
        }
      }
    }

    // A finger lifted from a pinch hands the gesture back to the other one.
    if (pointers.current.size === 1 && !drag.current && g.current.canPan) {
      const [[id, pt]] = [...pointers.current.entries()]
      beginDrag(id, pt.x, pt.y)
      setPanning(true)
    }
    if (pointers.current.size === 0) detach()
  }

  const spaceRef = useRef(false)
  spaceRef.current = spaceDown

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Left and middle drags pan; middle also has to lose Chrome's autoscroll.
      if (e.button !== 0 && e.button !== 1) return
      if (e.button === 1) e.preventDefault()

      stopTween()
      stopGlide()
      // One layout read at the top of the gesture, not one per move.
      dropRect()
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      attach()

      if (pointers.current.size === 2) {
        drag.current = null
        setPanning(false)
        const [a, b] = [...pointers.current.values()]
        pinch.current = {
          dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          mx: (a.x + b.x) / 2,
          my: (a.y + b.y) / 2,
        }
        return
      }
      if (pointers.current.size > 2) return

      // Space and the middle button pan regardless, so a tool that owns the
      // left drag can never strand the user in a corner of the image.
      if (g.current.canPan || e.button === 1 || spaceRef.current) {
        beginDrag(e.pointerId, e.clientX, e.clientY)
        setPanning(true)
      }
    },
    [attach, beginDrag, dropRect, stopGlide, stopTween],
  )

  // -- wheel, trackpad and Safari pinch -------------------------------------
  const wheel = useRef({ zoomBy, stepZoom, clampXY, scaleOf, commit, stopGlide, focusOf })
  wheel.current = { zoomBy, stepZoom, clampXY, scaleOf, commit, stopGlide, focusOf }

  const onWheelNative = useMemo(() => {
    // Trackpads announce themselves through sub-pixel or two-axis deltas. Once
    // one has been seen the rest of the gesture is assumed to come from it,
    // since a fast flick degenerates into the round numbers a mouse emits.
    let trackpadAt = -Infinity

    return (e: WheelEvent) => {
      if (!hostRef.current) return
      const s = wheel.current
      // Only the zoom branches need the host's box, and only they should pay
      // for it: a two-finger pan reads no layout at all.
      const focus = () => s.focusOf(e.clientX, e.clientY)

      // A trackpad pinch arrives as ctrl+wheel. So does the browser's own page
      // zoom, which is exactly what we're intercepting.
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        s.stopGlide()
        trackpadAt = e.timeStamp
        s.zoomBy(Math.exp(-e.deltaY * 0.01), focus())
        return
      }

      if (e.deltaMode === 0 && (e.deltaX !== 0 || !Number.isInteger(e.deltaY))) {
        trackpadAt = e.timeStamp
      }
      const trackpad = e.deltaMode === 0 && e.timeStamp - trackpadAt < 800

      // On a mouse the wheel is the only way to zoom, so it zooms.
      if (!trackpad) {
        if (!e.deltaY) return
        e.preventDefault()
        s.stopGlide()
        s.stepZoom(e.deltaY < 0 ? 1 : -1, focus())
        return
      }

      if (!g.current.canPan) return
      e.preventDefault()
      s.stopGlide()
      const v = viewRef.current
      s.commit({ ...v, ...s.clampXY(v.x - e.deltaX, v.y - e.deltaY, s.scaleOf(v.zoom)) })
    }
  }, [])

  /** Safari reports trackpad pinches as gesture events, not as ctrl+wheel. */
  const onGestureNative = useMemo(() => {
    let last = 1
    return (e: Event) => {
      const ge = e as Event & { scale?: number; clientX?: number; clientY?: number }
      e.preventDefault()
      if (e.type === 'gesturestart') {
        last = ge.scale ?? 1
        dropRect()
        return
      }
      if (e.type === 'gestureend') return
      const next = ge.scale ?? 1
      if (!next || !last) return
      wheel.current.stopGlide()
      wheel.current.zoomBy(next / last, focusOf(ge.clientX ?? 0, ge.clientY ?? 0))
      last = next
    }
  }, [dropRect, focusOf])

  const attachHost = useCallback(
    (el: HTMLElement | null) => {
      if (hostRef.current === el) return
      const prev = hostRef.current
      if (prev) {
        prev.removeEventListener('wheel', onWheelNative)
        for (const t of GESTURES) prev.removeEventListener(t, onGestureNative)
      }
      hostRef.current = el
      dropRect()
      // `passive: false` is the whole point: it's what lets us stop the browser
      // from turning a pinch into a page zoom.
      if (el) {
        el.addEventListener('wheel', onWheelNative, { passive: false })
        for (const t of GESTURES) el.addEventListener(t, onGestureNative, { passive: false })
      }
    },
    [dropRect, onWheelNative, onGestureNative],
  )

  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => toggleZoom(focusOf(e.clientX, e.clientY)),
    [focusOf, toggleZoom],
  )

  // -- space to pan ---------------------------------------------------------
  useEffect(() => {
    if (!active) return
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !isFormField(e.target)) setSpaceDown(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false)
    }
    const blur = () => setSpaceDown(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [active])

  // -- expose to the global keymap ------------------------------------------
  const commands = useRef<ZoomCommands>({
    zoomIn: () => {},
    zoomOut: () => {},
    fit: () => {},
    fill: () => {},
    actual: () => {},
    toggle: () => {},
    setZoom: () => {},
    zoomBy: () => {},
    panTo: () => {},
    zoomAt: () => {},
    zoomByAt: () => {},
    toggleAt: () => {},
  })
  commands.current.zoomIn = zoomIn
  commands.current.zoomOut = zoomOut
  commands.current.fit = fit
  commands.current.fill = fill
  commands.current.actual = actual
  commands.current.toggle = () => toggleZoom()
  commands.current.setZoom = (z) => setZoom(z)
  commands.current.zoomBy = (factor) => zoomBy(factor)
  commands.current.panTo = panTo
  commands.current.zoomAt = zoomAt
  commands.current.zoomByAt = zoomByAt
  commands.current.toggleAt = toggleAt

  useEffect(() => {
    if (!active) return
    const self = commands.current
    mounted = self
    return () => {
      if (mounted === self) mounted = null
    }
  }, [active])

  // -- teardown -------------------------------------------------------------
  useEffect(
    () => () => {
      stopTween()
      stopGlide()
      detach()
      if (commitFrame.current) cancelAnimationFrame(commitFrame.current)
      const el = hostRef.current
      if (el) {
        el.removeEventListener('wheel', onWheelNative)
        for (const t of GESTURES) el.removeEventListener(t, onGestureNative)
      }
    },
    [detach, onGestureNative, onWheelNative, stopGlide, stopTween],
  )

  const cursor = isPanning
    ? 'grabbing'
    : spaceDown || canPan
      ? 'grab'
      : view.zoom === null
        ? 'zoom-in'
        : 'default'

  return {
    scale,
    zoom: view.zoom,
    fitScale,
    percent: (view.zoom ?? fitZoom) * 100,
    offset: { x: view.x, y: view.y },
    isFit: view.zoom === null,
    isPanning,
    canPan,
    canZoomIn: (view.zoom ?? fitZoom) < MAX_ZOOM * 0.999,
    canZoomOut: view.zoom !== null,
    cursor,
    read,
    subscribe,
    setZoom,
    toggleZoom,
    zoomBy,
    zoomIn,
    zoomOut,
    fit,
    fill,
    actual,
    panTo,
    reset,
    bind: {
      ref: attachHost,
      onPointerDown,
      onDoubleClick,
      onDragStart: (e: React.DragEvent) => e.preventDefault(),
      style: {
        cursor,
        // Stops the OS/browser from claiming pinch and swipe gestures first.
        touchAction: 'none',
        overscrollBehavior: 'contain',
        userSelect: 'none',
        WebkitUserSelect: 'none',
      },
    },
  }
}
