import { useCallback, useEffect, useRef, useState } from 'react'
import { useDevelop } from '../../develop/session'
import { useMasking } from '../../develop/masking'
import { useUI } from '../../state/ui'
import type { FrameBox } from './CropOverlay'
import type { BrushDab, Mask, MaskComponent, Point2 } from '../../core/types'
import { activeRenderer } from './activeRenderer'
import { SRGB_D65_TO_PROPHOTO_D50 } from '../../core/color'

/**
 * The mask handles, drawn over the photo.
 *
 * A linear gradient is two parallel lines you drag apart; a radial is an
 * ellipse with four handles and a centre; a brush is painted by dragging.
 * Everything is stored in normalised 0..1 coordinates over the framed photo,
 * so the overlay converts to CSS pixels at the boundary and nowhere else —
 * a mask stays put when you zoom.
 */

type Drag =
  | { kind: 'linearStart' }
  | { kind: 'linearEnd' }
  | { kind: 'linearMove'; from: { start: Point2; end: Point2 }; origin: Point2 }
  | { kind: 'radialCenter'; from: Point2; origin: Point2 }
  | { kind: 'radialX'; from: number }
  | { kind: 'radialY'; from: number }
  | { kind: 'paint'; last: Point2 | null }
  | { kind: 'placeLinear'; origin: Point2 }
  | { kind: 'placeRadial'; origin: Point2 }

/** Dabs are laid along a stroke at this fraction of the radius. */
const DAB_SPACING = 0.25

function PlacementHint({
  pendingKind,
  dragging,
}: {
  pendingKind: ReturnType<typeof useMasking.getState>['pendingKind']
  dragging: boolean
}) {
  if (!pendingKind || dragging) return null
  return (
    <div className="material pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full px-2.5 py-1 text-mini text-label-secondary shadow-hud">
      {pendingKind === 'brush' ? 'Paint on the photo' : 'Drag on the photo to place'}
    </div>
  )
}

function MaskPicker({
  masks,
  selectedMaskId,
  select,
}: {
  masks: Mask[]
  selectedMaskId: string | null
  select: (maskId: string | null, componentId: string | null) => void
}) {
  if (masks.length <= 1) return null
  return (
    <div className="absolute left-3 top-3 flex flex-col gap-1">
      {masks.map((mask) => (
        <button
          key={mask.id}
          type="button"
          onClick={() => select(mask.id, mask.components[0]?.id ?? null)}
          className={`rounded-full px-2 py-0.5 text-mini shadow-hud transition-colors duration-[--duration-fast] ${
            mask.id === selectedMaskId
              ? 'bg-accent text-(--accent-ink)'
              : 'material text-label-secondary hover:text-label'
          }`}
        >
          {mask.name}
        </button>
      ))}
    </div>
  )
}

export function MaskOverlay({ frame }: { frame: FrameBox }) {
  const tool = useUI((s) => s.developTool)
  const masks = useDevelop((s) => s.edits.masks)
  const update = useDevelop((s) => s.update)
  const {
    selectedMaskId,
    selectedComponentId,
    pendingKind,
    brushSize,
    brushFeather,
    brushFlow,
    brushErase,
    select,
    setPending,
    setCursor,
  } = useMasking()

  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)

  const mask = masks.find((m) => m.id === selectedMaskId) ?? null
  const comp: MaskComponent | null =
    mask?.components.find((c) => c.id === selectedComponentId) ?? mask?.components[0] ?? null

  /** Pointer position as a normalised point in the frame. */
  const toNorm = useCallback(
    (e: { clientX: number; clientY: number }): Point2 => {
      const host = hostRef.current?.getBoundingClientRect()
      if (!host || frame.width <= 0 || frame.height <= 0) return { x: 0.5, y: 0.5 }
      return {
        x: (e.clientX - host.left - frame.x) / frame.width,
        y: (e.clientY - host.top - frame.y) / frame.height,
      }
    },
    [frame.x, frame.y, frame.width, frame.height],
  )

  const px = useCallback(
    (p: Point2) => ({ left: frame.x + p.x * frame.width, top: frame.y + p.y * frame.height }),
    [frame.x, frame.y, frame.width, frame.height],
  )

  const editComp = useCallback(
    (label: string, fn: (c: MaskComponent) => void, coalesce = true) => {
      if (!mask || !comp) return
      update(`masks.geom.${comp.id}`, label, (e) => {
        const m = e.masks.find((x) => x.id === mask.id)
        const c = m?.components.find((x) => x.id === comp.id)
        if (c) fn(c)
      }, coalesce)
    },
    [mask, comp, update],
  )

  // -- painting -------------------------------------------------------------

  /**
   * Lays dabs from `from` to `to`.
   *
   * A pointer sampled at 60 Hz skips a long way during a fast stroke, so the
   * gap is filled in rather than left as a dotted line.
   */
  const strokeTo = useCallback(
    (from: Point2 | null, to: Point2) => {
      if (!comp || comp.geometry.kind !== 'brush') return
      const radius = brushSize / 2
      const step = Math.max(radius * DAB_SPACING, 0.002)
      const dabs: BrushDab[] = []
      const push = (p: Point2) =>
        dabs.push({ x: p.x, y: p.y, radius, flow: brushFlow, erase: brushErase })

      if (!from) push(to)
      else {
        const dx = to.x - from.x
        const dy = to.y - from.y
        const dist = Math.hypot(dx, dy)
        const n = Math.max(1, Math.ceil(dist / step))
        for (let i = 1; i <= n; i++) push({ x: from.x + (dx * i) / n, y: from.y + (dy * i) / n })
      }
      editComp('Paint', (c) => {
        if (c.geometry.kind !== 'brush') return
        c.geometry.dabs.push(...dabs)
        c.geometry.feather = brushFeather
      })
    },
    [comp, brushSize, brushFlow, brushErase, brushFeather, editComp],
  )

  // -- pointer plumbing -----------------------------------------------------

  const begin = (d: Drag) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    dragRef.current = d
    setDrag(d)
  }

  const onSurfaceDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !mask || !comp) return
    const p = toNorm(e)

    if (pendingKind === 'linear' || (comp.geometry.kind === 'linear' && pendingKind)) {
      e.preventDefault()
      editComp('Place Gradient', (c) => {
        if (c.geometry.kind === 'linear') {
          c.geometry.start = { ...p }
          c.geometry.end = { ...p }
        }
      }, false)
      begin({ kind: 'placeLinear', origin: p })(e)
      return
    }
    if (pendingKind === 'radial') {
      e.preventDefault()
      editComp('Place Radial', (c) => {
        if (c.geometry.kind === 'radial') {
          c.geometry.center = { ...p }
          c.geometry.radiusX = 0.005
          c.geometry.radiusY = 0.005
        }
      }, false)
      begin({ kind: 'placeRadial', origin: p })(e)
      return
    }
    if (comp.geometry.kind === 'brush') {
      e.preventDefault()
      strokeTo(null, p)
      begin({ kind: 'paint', last: p })(e)
      return
    }
    if (comp.geometry.kind === 'colorRange') {
      // Clicking samples the colour under the pointer. The sample is taken from
      // the *edited* pixels, which is what the shader compares against.
      e.preventDefault()
      const shift = e.shiftKey
      void samplePixel(p).then((rgb) => {
        if (!rgb) return
        editComp('Sample Colour', (c) => {
          if (c.geometry.kind === 'colorRange') {
            if (shift) c.geometry.samples.push(rgb)
            else c.geometry.samples = [rgb]
          }
        }, false)
      })
    }
  }

  useEffect(() => {
    if (!drag) return

    const move = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const p = toNorm(e)

      switch (d.kind) {
        case 'placeLinear':
          editComp('Place Gradient', (c) => {
            if (c.geometry.kind === 'linear') {
              c.geometry.start = { ...d.origin }
              c.geometry.end = { ...p }
            }
          })
          break
        case 'placeRadial': {
          const rx = Math.abs(p.x - d.origin.x)
          const ry = Math.abs(p.y - d.origin.y)
          editComp('Place Radial', (c) => {
            if (c.geometry.kind === 'radial') {
              // Shift keeps it circular, in frame units so it looks circular.
              const r = Math.max(rx, ry)
              c.geometry.radiusX = Math.max(e.shiftKey ? r : rx, 0.005)
              c.geometry.radiusY = Math.max(e.shiftKey ? r : ry, 0.005)
            }
          })
          break
        }
        case 'linearStart':
          editComp('Move Gradient', (c) => {
            if (c.geometry.kind === 'linear') c.geometry.start = { ...p }
          })
          break
        case 'linearEnd':
          editComp('Move Gradient', (c) => {
            if (c.geometry.kind === 'linear') c.geometry.end = { ...p }
          })
          break
        case 'linearMove': {
          const dx = p.x - d.origin.x
          const dy = p.y - d.origin.y
          editComp('Move Gradient', (c) => {
            if (c.geometry.kind === 'linear') {
              c.geometry.start = { x: d.from.start.x + dx, y: d.from.start.y + dy }
              c.geometry.end = { x: d.from.end.x + dx, y: d.from.end.y + dy }
            }
          })
          break
        }
        case 'radialCenter': {
          const dx = p.x - d.origin.x
          const dy = p.y - d.origin.y
          editComp('Move Mask', (c) => {
            if (c.geometry.kind === 'radial')
              c.geometry.center = { x: d.from.x + dx, y: d.from.y + dy }
          })
          break
        }
        case 'radialX':
          editComp('Resize Mask', (c) => {
            if (c.geometry.kind === 'radial')
              c.geometry.radiusX = Math.max(Math.abs(p.x - c.geometry.center.x), 0.005)
          })
          break
        case 'radialY':
          editComp('Resize Mask', (c) => {
            if (c.geometry.kind === 'radial')
              c.geometry.radiusY = Math.max(Math.abs(p.y - c.geometry.center.y), 0.005)
          })
          break
        case 'paint':
          strokeTo(d.last, p)
          dragRef.current = { kind: 'paint', last: p }
          break
      }
    }

    const up = () => {
      const d = dragRef.current
      // Placing finishes the moment the pointer lifts, so the next drag edits
      // the shape rather than replacing it.
      if (d && (d.kind === 'placeLinear' || d.kind === 'placeRadial')) setPending(null)
      dragRef.current = null
      setDrag(null)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [drag, toNorm, editComp, strokeTo, setPending])

  if (tool !== 'mask' || !mask || !comp || frame.width <= 0) return null

  const g = comp.geometry
  const brushing = g.kind === 'brush'
  const painting = brushing || g.kind === 'colorRange'

  return (
    <div
      ref={hostRef}
      className="absolute inset-0"
      style={{ touchAction: 'none', cursor: painting || pendingKind ? 'crosshair' : 'default' }}
      onPointerDown={onSurfaceDown}
      onPointerMove={(e) => {
        if (brushing) setCursor({ x: e.clientX, y: e.clientY })
      }}
      onPointerLeave={() => setCursor(null)}
    >
      {/* While a shape is armed for placement the handles must not swallow the
          pointer: the first press has to land on the surface, not on whatever
          the default geometry happens to sit under. */}
      {g.kind === 'linear' && !pendingKind && (
        <LinearHandles
          start={px(g.start)}
          end={px(g.end)}
          onStart={begin({ kind: 'linearStart' })}
          onEnd={begin({ kind: 'linearEnd' })}
          onMove={(e) =>
            begin({
              kind: 'linearMove',
              from: { start: g.start, end: g.end },
              origin: toNorm(e),
            })(e)
          }
        />
      )}

      {g.kind === 'radial' && !pendingKind && (
        <RadialHandles
          center={px(g.center)}
          rx={g.radiusX * frame.width}
          ry={g.radiusY * frame.height}
          onCenter={(e) =>
            begin({ kind: 'radialCenter', from: g.center, origin: toNorm(e) })(e)
          }
          onX={begin({ kind: 'radialX', from: g.radiusX })}
          onY={begin({ kind: 'radialY', from: g.radiusY })}
        />
      )}

      {/* The dab radius is a fraction of the frame's *long* edge, which is the
          height on a portrait photo. Scaling the ring by the width there draws a
          cursor smaller than the stroke it promises. */}
      {brushing && (
        <BrushRing
          size={brushSize * Math.max(frame.width, frame.height)}
          erase={brushErase}
          host={hostRef}
        />
      )}

      <PlacementHint pendingKind={pendingKind} dragging={!!drag} />
      <MaskPicker masks={masks} selectedMaskId={selectedMaskId} select={select} />
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * Reads one rendered pixel, in linear light.
 *
 * Colour-range masks are picked off what is on screen, so the sample has to
 * come from the same place the eye did — but it cannot come from the canvas.
 * A WebGPU surface releases its presented texture at the end of the task that
 * submitted the frame, and this runs from a pointer handler one task later, so
 * `drawImage` would sample a blank one. The renderer reads back its own output
 * texture instead, which survives.
 *
 * That also fixes a quiet coordinate bug the canvas read had: `p` is normalised
 * over the *image*, not the canvas, and the two only agree when the image
 * happens to fill the viewport exactly. Sampling the output texture is in image
 * space by construction, so zoom, pan and letterboxing stop mattering.
 *
 * The read is of the picture *before* the mask overlay, since the pixel under
 * the cursor is usually one the mask already covers and is therefore tinted.
 * Sampling that would store the tint as the target colour and shrink the
 * selection towards nothing with every re-pick.
 */
async function samplePixel(p: Point2): Promise<{ r: number; g: number; b: number } | null> {
  if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return null
  const renderer = activeRenderer()
  const size = renderer?.outputSize
  if (!renderer || !size) return null

  const x = Math.min(size.width - 1, Math.max(0, Math.round(p.x * (size.width - 1))))
  // Both `p` and the output texture count y downward, so nothing is flipped.
  const y = Math.min(size.height - 1, Math.max(0, Math.round(p.y * (size.height - 1))))
  const out = await renderer.readPixels('srgb', 8, { x, y, width: 1, height: 1 }, true)
  if (!out) return null

  const buf = out.data as Uint8ClampedArray
  // Back to linear light, and then back to the working space. The readback is
  // display sRGB; the shader compares against the working image, which is
  // ProPhoto. Skipping the second step leaves the sample under the wrong
  // primaries, so clicking a saturated colour selects a noticeably different
  // one — and the more saturated the pick, the further off it lands.
  const lin = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const r = lin(buf[0])
  const g = lin(buf[1])
  const b = lin(buf[2])
  const m = SRGB_D65_TO_PROPHOTO_D50
  return {
    r: m[0] * r + m[1] * g + m[2] * b,
    g: m[3] * r + m[4] * g + m[5] * b,
    b: m[6] * r + m[7] * g + m[8] * b,
  }
}

function LinearHandles({
  start,
  end,
  onStart,
  onEnd,
  onMove,
}: {
  start: { left: number; top: number }
  end: { left: number; top: number }
  onStart: (e: React.PointerEvent) => void
  onEnd: (e: React.PointerEvent) => void
  onMove: (e: React.PointerEvent) => void
}) {
  const dx = end.left - start.left
  const dy = end.top - start.top
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI
  const mid = { left: (start.left + end.left) / 2, top: (start.top + end.top) / 2 }

  // The two edge lines run *across* the gradient, so they are perpendicular to
  // the drag — which is the direction people expect to grab.
  const line = (at: { left: number; top: number }, dashed: boolean, onPointerDown: (e: React.PointerEvent) => void) => (
    <div
      onPointerDown={onPointerDown}
      className="absolute"
      style={{
        left: at.left,
        top: at.top,
        width: 4000,
        height: 14,
        marginLeft: -2000,
        marginTop: -7,
        transform: `rotate(${angle + 90}deg)`,
        transformOrigin: '50% 50%',
        cursor: 'move',
        touchAction: 'none',
      }}
    >
      <div
        className="absolute left-0 right-0 top-1/2 -translate-y-1/2 bg-white/80"
        style={{ height: 1, borderTop: dashed ? '1px dashed rgb(255 255 255 / 0.8)' : undefined, background: dashed ? 'none' : undefined }}
      />
    </div>
  )

  return (
    <>
      {line(start, false, onStart)}
      {line(mid, true, onMove)}
      {line(end, false, onEnd)}
      <div
        onPointerDown={onMove}
        className="absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/40 bg-white/95 shadow-[0_0_3px_rgb(0_0_0/0.5)]"
        style={{ left: mid.left, top: mid.top, cursor: 'move', touchAction: 'none' }}
      />
    </>
  )
}

function RadialHandles({
  center,
  rx,
  ry,
  onCenter,
  onX,
  onY,
}: {
  center: { left: number; top: number }
  rx: number
  ry: number
  onCenter: (e: React.PointerEvent) => void
  onX: (e: React.PointerEvent) => void
  onY: (e: React.PointerEvent) => void
}) {
  const dot = (left: number, top: number, cursor: string, onPointerDown: (e: React.PointerEvent) => void) => (
    <div
      onPointerDown={onPointerDown}
      className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/40 bg-white/95 shadow-[0_0_3px_rgb(0_0_0/0.5)]"
      style={{ left, top, cursor, touchAction: 'none' }}
    />
  )
  return (
    <>
      <div
        onPointerDown={onCenter}
        className="absolute rounded-[50%] border border-white/85"
        style={{
          left: center.left - rx,
          top: center.top - ry,
          width: rx * 2,
          height: ry * 2,
          cursor: 'move',
          touchAction: 'none',
        }}
      />
      {dot(center.left, center.top, 'move', onCenter)}
      {dot(center.left + rx, center.top, 'ew-resize', onX)}
      {dot(center.left, center.top + ry, 'ns-resize', onY)}
    </>
  )
}

/** A ring that follows the pointer, so brush size is visible before you paint. */
function BrushRing({
  size,
  erase,
  host,
}: {
  size: number
  erase: boolean
  host: React.RefObject<HTMLDivElement | null>
}) {
  const cursor = useMasking((s) => s.cursor)
  if (!cursor) return null
  const box = host.current?.getBoundingClientRect()
  if (!box) return null
  return (
    <div
      className={`pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border ${
        erase ? 'border-white/90 border-dashed' : 'border-white/90'
      }`}
      style={{
        left: cursor.x - box.left,
        top: cursor.y - box.top,
        width: Math.max(size, 6),
        height: Math.max(size, 6),
        boxShadow: '0 0 0 1px rgb(0 0 0 / 0.35) inset',
      }}
    />
  )
}
