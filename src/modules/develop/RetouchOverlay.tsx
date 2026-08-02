import { useCallback, useEffect, useRef, useState } from 'react'
import { useDevelop } from '../../develop/session'
import { useRetouch, newRedEye, newSpot } from '../../develop/retouch'
import { useUI } from '../../state/ui'
import type { FrameBox } from './CropOverlay'
import type { Point2 } from '../../core/types'

/**
 * Spot and red-eye handles.
 *
 * Both coordinate systems are the *source* image's, not the framed photo's —
 * a blemish belongs to the thing it sits on, so it must not move when the crop
 * changes. The overlay is therefore only offered when the photo is uncropped
 * and unrotated; anything else would put the circles in the wrong place.
 */

type Drag =
  | { kind: 'newSpot'; id: string; origin: Point2 }
  | { kind: 'spotTarget'; id: string; from: Point2; origin: Point2 }
  | { kind: 'spotSource'; id: string; from: Point2; origin: Point2 }
  | { kind: 'newEye'; id: string; origin: Point2 }
  | { kind: 'eyeMove'; id: string; from: Point2; origin: Point2 }

export function RetouchOverlay({ frame }: { frame: FrameBox }) {
  const tool = useUI((s) => s.developTool)
  const spots = useDevelop((s) => s.edits.spots)
  const redEye = useDevelop((s) => s.edits.redEye)
  const update = useDevelop((s) => s.update)
  const rt = useRetouch()

  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)

  const healing = tool === 'heal'
  const eyeing = tool === 'redeye'

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

  // Radii are normalised to the frame's longer side, so a circle stays a
  // circle regardless of aspect.
  const long = Math.max(frame.width, frame.height)
  const radiusPx = (r: number) => r * long

  const begin = (d: Drag) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    dragRef.current = d
    setDrag(d)
  }

  const onSurfaceDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const p = toNorm(e)

    if (healing) {
      const spot = newSpot(p, {
        radius: rt.spotRadius,
        feather: rt.spotFeather,
        opacity: rt.spotOpacity,
        mode: rt.spotMode,
      })
      update('spot.add', 'Add Spot', (ed) => {
        ed.spots.push(spot)
      }, false)
      rt.selectSpot(spot.id)
      // Dragging out from the click sets the size, exactly like Lightroom.
      begin({ kind: 'newSpot', id: spot.id, origin: p })(e)
      return
    }
    if (eyeing) {
      const eye = newRedEye(p, {
        radius: rt.eyeRadius,
        kind: rt.eyeKind,
        darken: rt.eyeDarken,
      })
      update('eye.add', 'Add Red Eye', (ed) => {
        ed.redEye.push(eye)
      }, false)
      rt.selectEye(eye.id)
      begin({ kind: 'newEye', id: eye.id, origin: p })(e)
    }
  }

  useEffect(() => {
    if (!drag) return

    const move = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const p = toNorm(e)
      // Screen distance divided by the long edge keeps the drag-to-size gesture
      // consistent whatever the zoom.
      const reach = Math.hypot(
        (p.x - ('origin' in d ? d.origin.x : 0)) * frame.width,
        (p.y - ('origin' in d ? d.origin.y : 0)) * frame.height,
      ) / long

      switch (d.kind) {
        case 'newSpot':
          update('spot.radius', 'Spot Size', (ed) => {
            const s = ed.spots.find((x) => x.id === d.id)
            if (!s) return
            s.radius = Math.max(reach, 0.005)
            // The source has to keep clear of a growing target.
            const dx = s.source.x - s.target.x
            const dy = s.source.y - s.target.y
            const dist = Math.hypot(dx, dy)
            const want = s.radius * 2.2
            if (dist > 1e-5 && dist < want) {
              s.source = { x: s.target.x + (dx / dist) * want, y: s.target.y + (dy / dist) * want }
            }
          })
          break
        case 'spotTarget':
          update('spot.move', 'Move Spot', (ed) => {
            const s = ed.spots.find((x) => x.id === d.id)
            if (!s) return
            // The source follows, so the repair stays the same patch.
            const dx = p.x - d.origin.x
            const dy = p.y - d.origin.y
            const offX = s.source.x - s.target.x
            const offY = s.source.y - s.target.y
            s.target = { x: d.from.x + dx, y: d.from.y + dy }
            s.source = { x: s.target.x + offX, y: s.target.y + offY }
          })
          break
        case 'spotSource':
          update('spot.source', 'Move Source', (ed) => {
            const s = ed.spots.find((x) => x.id === d.id)
            if (!s) return
            s.source = { x: d.from.x + (p.x - d.origin.x), y: d.from.y + (p.y - d.origin.y) }
          })
          break
        case 'newEye':
          update('eye.radius', 'Pupil Size', (ed) => {
            const r = ed.redEye.find((x) => x.id === d.id)
            if (r) r.radius = Math.max(reach, 0.005)
          })
          break
        case 'eyeMove':
          update('eye.move', 'Move Red Eye', (ed) => {
            const r = ed.redEye.find((x) => x.id === d.id)
            if (r) r.center = { x: d.from.x + (p.x - d.origin.x), y: d.from.y + (p.y - d.origin.y) }
          })
          break
      }
    }

    const up = () => {
      const d = dragRef.current
      // A click without a drag keeps the size from the panel rather than
      // collapsing to nothing.
      if (d?.kind === 'newSpot' || d?.kind === 'newEye') {
        update('retouch.settle', 'Add', (ed) => {
          if (d.kind === 'newSpot') {
            const s = ed.spots.find((x) => x.id === d.id)
            if (s && s.radius < 0.006) s.radius = useRetouch.getState().spotRadius
          } else {
            const r = ed.redEye.find((x) => x.id === d.id)
            if (r && r.radius < 0.006) r.radius = useRetouch.getState().eyeRadius
          }
        })
        // The next spot inherits whatever size this one ended at.
        const st = useDevelop.getState().edits
        if (d.kind === 'newSpot') {
          const s = st.spots.find((x) => x.id === d.id)
          if (s) useRetouch.getState().setSpot({ spotRadius: s.radius })
        } else {
          const r = st.redEye.find((x) => x.id === d.id)
          if (r) useRetouch.getState().setEye({ eyeRadius: r.radius })
        }
      }
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
  }, [drag, toNorm, update, frame.width, frame.height, long])

  if ((!healing && !eyeing) || frame.width <= 0) return null

  const activeSpot = drag && 'id' in drag ? drag.id : rt.selectedSpotId

  return (
    <div
      ref={hostRef}
      className="absolute inset-0"
      style={{ touchAction: 'none', cursor: 'crosshair' }}
      onPointerDown={onSurfaceDown}
      onPointerMove={(e) => rt.setCursor({ x: e.clientX, y: e.clientY })}
      onPointerLeave={() => rt.setCursor(null)}
    >
      {healing &&
        rt.showSpots &&
        spots.map((s) => {
          const t = px(s.target)
          const src = px(s.source)
          const r = radiusPx(s.radius)
          const on = s.id === activeSpot
          return (
            <div key={s.id}>
              <div
                onPointerDown={(e) =>
                  begin({ kind: 'spotSource', id: s.id, from: s.source, origin: toNorm(e) })(e)
                }
                className={`absolute rounded-full border border-dashed ${
                  on ? 'border-accent' : 'border-white/60'
                }`}
                style={{
                  left: src.left - r,
                  top: src.top - r,
                  width: r * 2,
                  height: r * 2,
                  cursor: 'move',
                  touchAction: 'none',
                }}
              />
              <div
                onPointerDown={(e) =>
                  begin({ kind: 'spotTarget', id: s.id, from: s.target, origin: toNorm(e) })(e)
                }
                onDoubleClick={() =>
                  update('spot.delete', 'Delete Spot', (ed) => {
                    ed.spots = ed.spots.filter((x) => x.id !== s.id)
                  }, false)
                }
                className={`absolute rounded-full border ${
                  on ? 'border-accent' : 'border-white/85'
                }`}
                style={{
                  left: t.left - r,
                  top: t.top - r,
                  width: r * 2,
                  height: r * 2,
                  boxShadow: '0 0 0 1px rgb(0 0 0 / 0.4)',
                  cursor: 'move',
                  touchAction: 'none',
                }}
              />
              {/* The tie-line, so it is obvious which source feeds which spot. */}
              <svg
                className="pointer-events-none absolute inset-0 h-full w-full"
                aria-hidden="true"
              >
                <line
                  x1={t.left}
                  y1={t.top}
                  x2={src.left}
                  y2={src.top}
                  stroke={on ? 'currentColor' : 'rgb(255 255 255 / 0.4)'}
                  strokeWidth="1"
                  strokeDasharray="3 3"
                  className={on ? 'text-accent' : undefined}
                />
              </svg>
            </div>
          )
        })}

      {eyeing &&
        redEye.map((r) => {
          const c = px(r.center)
          const rad = radiusPx(r.radius)
          const on = r.id === rt.selectedEyeId
          return (
            <div
              key={r.id}
              onPointerDown={(e) =>
                begin({ kind: 'eyeMove', id: r.id, from: r.center, origin: toNorm(e) })(e)
              }
              onDoubleClick={() =>
                update('eye.delete', 'Delete Red Eye', (ed) => {
                  ed.redEye = ed.redEye.filter((x) => x.id !== r.id)
                }, false)
              }
              className={`absolute rounded-full border ${on ? 'border-accent' : 'border-white/85'}`}
              style={{
                left: c.left - rad,
                top: c.top - rad,
                width: rad * 2,
                height: rad * 2,
                boxShadow: '0 0 0 1px rgb(0 0 0 / 0.4)',
                cursor: 'move',
                touchAction: 'none',
              }}
            />
          )
        })}

      <Ring
        size={radiusPx(healing ? rt.spotRadius : rt.eyeRadius) * 2}
        host={hostRef}
        hidden={!!drag}
      />
    </div>
  )
}

/** The size the next spot will be, following the pointer. */
function Ring({
  size,
  host,
  hidden,
}: {
  size: number
  host: React.RefObject<HTMLDivElement | null>
  hidden: boolean
}) {
  const cursor = useRetouch((s) => s.cursor)
  if (!cursor || hidden) return null
  const box = host.current?.getBoundingClientRect()
  if (!box) return null
  return (
    <div
      className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/70"
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
