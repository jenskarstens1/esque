import { useCallback, useEffect, useRef, useState } from 'react'
import { useDevelop } from '../../develop/session'
import { useUI } from '../../state/ui'
import { ASPECT_RATIOS } from '../../gpu/geometry'
import type { CropEdits } from '../../core/types'

/**
 * The crop rectangle, drawn over the uncropped photo.
 *
 * While the crop tool is open the viewport shows the whole frame so you can see
 * what you are cutting away, and this sits on top of it: a bright rectangle,
 * eight handles, a thirds grid and a dimmed surround.
 *
 * All the arithmetic happens in the crop's own normalised 0..1 frame space and
 * is converted to CSS pixels only at the edges, so the overlay stays correct at
 * any zoom and never accumulates rounding drift.
 */

type Handle =
  | 'move'
  | 'n'
  | 's'
  | 'e'
  | 'w'
  | 'nw'
  | 'ne'
  | 'sw'
  | 'se'
  | 'rotate'

/** The photo's on-screen box, in CSS pixels relative to the viewport. */
export interface FrameBox {
  x: number
  y: number
  width: number
  height: number
}

const MIN_SIZE = 0.02

const CURSORS: Record<Handle, string> = {
  move: 'move',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  rotate: 'grabbing',
}

/** The aspect a drag has to hold, or null when the crop is free. */
function lockedRatio(crop: CropEdits, frameAspect: number): number | null {
  if (!crop.aspectLocked || crop.aspect === 'free') return null
  if (crop.aspect === 'original') return frameAspect
  const r = ASPECT_RATIOS[crop.aspect]
  return r ? r[0] / r[1] : null
}

export function CropOverlay({ frame }: { frame: FrameBox }) {
  const tool = useUI((s) => s.developTool)
  const crop = useDevelop((s) => s.edits.crop)
  const update = useDevelop((s) => s.update)
  const hostRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<Handle | null>(null)

  // The live rect during a drag, so React state updates never lag the pointer.
  const drag = useRef<{
    handle: Handle
    startX: number
    startY: number
    from: CropEdits
  } | null>(null)

  const frameAspect = frame.height > 0 ? frame.width / frame.height : 1

  const apply = useCallback(
    (next: Partial<CropEdits>, label: string, coalesce = true) => {
      update(
        'crop.rect',
        label,
        (e) => {
          Object.assign(e.crop, next)
        },
        coalesce,
      )
    },
    [update],
  )

  const onPointerDown = (handle: Handle) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    drag.current = { handle, startX: e.clientX, startY: e.clientY, from: { ...crop } }
    setDragging(handle)
  }

  useEffect(() => {
    if (!dragging) return

    const move = (e: PointerEvent) => {
      const d = drag.current
      if (!d || frame.width <= 0 || frame.height <= 0) return
      const dx = (e.clientX - d.startX) / frame.width
      const dy = (e.clientY - d.startY) / frame.height
      const f = d.from

      if (d.handle === 'rotate') {
        // Straightening by dragging reads the horizontal sweep, which is what
        // the eye is doing anyway: line the horizon up with the grid.
        const angle = Math.max(-45, Math.min(45, f.angle + dx * 60))
        apply({ angle }, 'Straighten')
        return
      }

      if (d.handle === 'move') {
        const w = f.right - f.left
        const h = f.bottom - f.top
        const left = Math.min(Math.max(f.left + dx, 0), 1 - w)
        const top = Math.min(Math.max(f.top + dy, 0), 1 - h)
        apply({ left, top, right: left + w, bottom: top + h }, 'Move Crop')
        return
      }

      let { left, top, right, bottom } = f
      if (d.handle.includes('w')) left = Math.min(Math.max(f.left + dx, 0), f.right - MIN_SIZE)
      if (d.handle.includes('e')) right = Math.max(Math.min(f.right + dx, 1), f.left + MIN_SIZE)
      if (d.handle.includes('n')) top = Math.min(Math.max(f.top + dy, 0), f.bottom - MIN_SIZE)
      if (d.handle.includes('s')) bottom = Math.max(Math.min(f.bottom + dy, 1), f.top + MIN_SIZE)

      const ratio = lockedRatio(f, frameAspect)
      if (ratio) {
        // Hold the ratio by driving the other axis from the one being dragged,
        // anchored on the corner opposite the handle so it stays put.
        const wantW = ((bottom - top) * ratio) / frameAspect
        const wantH = ((right - left) * frameAspect) / ratio
        const horizontal =
          d.handle === 'e' || d.handle === 'w'
            ? true
            : d.handle === 'n' || d.handle === 's'
              ? false
              : Math.abs(dx) * frameAspect >= Math.abs(dy)
        if (horizontal) {
          if (d.handle.includes('n')) top = bottom - wantH
          else bottom = top + wantH
        } else {
          if (d.handle.includes('w')) left = right - wantW
          else right = left + wantW
        }
        // A ratio drag can push past an edge; slide it back rather than
        // silently changing the shape the user asked for.
        if (left < 0) {
          right -= left
          left = 0
        }
        if (top < 0) {
          bottom -= top
          top = 0
        }
        if (right > 1) {
          left -= right - 1
          right = 1
        }
        if (bottom > 1) {
          top -= bottom - 1
          bottom = 1
        }
      }

      apply(
        {
          left: Math.max(0, left),
          top: Math.max(0, top),
          right: Math.min(1, right),
          bottom: Math.min(1, bottom),
        },
        'Crop',
      )
    }

    const up = () => {
      drag.current = null
      setDragging(null)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [dragging, frame.width, frame.height, frameAspect, apply])

  if (tool !== 'crop' || frame.width <= 0) return null

  const box = {
    left: frame.x + crop.left * frame.width,
    top: frame.y + crop.top * frame.height,
    width: (crop.right - crop.left) * frame.width,
    height: (crop.bottom - crop.top) * frame.height,
  }

  const handle = (h: Handle, style: React.CSSProperties, size = 14) => (
    <div
      key={h}
      onPointerDown={onPointerDown(h)}
      className="absolute"
      style={{ width: size, height: size, ...style, cursor: CURSORS[h], touchAction: 'none' }}
    />
  )

  const corner = (h: Handle, style: React.CSSProperties) => (
    <div
      key={h}
      onPointerDown={onPointerDown(h)}
      className="absolute"
      style={{ ...style, width: 26, height: 26, cursor: CURSORS[h], touchAction: 'none' }}
    >
      <div
        className="absolute bg-white/90 shadow-[0_0_2px_rgb(0_0_0/0.6)]"
        style={{
          [h.includes('n') ? 'top' : 'bottom']: 6,
          [h.includes('w') ? 'left' : 'right']: 6,
          width: 14,
          height: 3,
        }}
      />
      <div
        className="absolute bg-white/90 shadow-[0_0_2px_rgb(0_0_0/0.6)]"
        style={{
          [h.includes('n') ? 'top' : 'bottom']: 6,
          [h.includes('w') ? 'left' : 'right']: 6,
          width: 3,
          height: 14,
        }}
      />
    </div>
  )

  return (
    <div ref={hostRef} className="absolute inset-0" style={{ touchAction: 'none' }}>
      {/* The surround, as four panels rather than one big box-shadow, so the
          bright rectangle keeps crisp edges at any zoom. */}
      <div
        className="pointer-events-none absolute bg-black/55"
        style={{ left: 0, top: 0, right: 0, height: Math.max(0, box.top) }}
      />
      <div
        className="pointer-events-none absolute bg-black/55"
        style={{ left: 0, top: box.top + box.height, right: 0, bottom: 0 }}
      />
      <div
        className="pointer-events-none absolute bg-black/55"
        style={{ left: 0, top: box.top, width: Math.max(0, box.left), height: box.height }}
      />
      <div
        className="pointer-events-none absolute bg-black/55"
        style={{ left: box.left + box.width, top: box.top, right: 0, height: box.height }}
      />

      {/* Drag anywhere outside the rectangle to straighten. */}
      <div
        className="absolute inset-0"
        onPointerDown={onPointerDown('rotate')}
        style={{ cursor: dragging === 'rotate' ? 'grabbing' : 'grab', touchAction: 'none' }}
      />

      <div
        data-crop-frame=""
        className="absolute outline outline-1 outline-white/85"
        style={{ ...box, cursor: 'move', touchAction: 'none' }}
        onPointerDown={onPointerDown('move')}
      >
        {/* Thirds while idle, a finer grid while straightening — the same
            progression Lightroom uses, and for the same reason: you need more
            reference lines when you are lining up an edge. */}
        {(dragging === 'rotate' ? [1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6] : [1 / 3, 2 / 3]).map(
          (t) => (
            <div key={`v${t}`} className="pointer-events-none absolute bg-white/25"
              style={{ left: `${t * 100}%`, top: 0, bottom: 0, width: 1 }} />
          ),
        )}
        {(dragging === 'rotate' ? [1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6] : [1 / 3, 2 / 3]).map(
          (t) => (
            <div key={`h${t}`} className="pointer-events-none absolute bg-white/25"
              style={{ top: `${t * 100}%`, left: 0, right: 0, height: 1 }} />
          ),
        )}
      </div>

      {handle('n', { left: box.left + 14, top: box.top - 7, width: Math.max(0, box.width - 28) })}
      {handle('s', {
        left: box.left + 14,
        top: box.top + box.height - 7,
        width: Math.max(0, box.width - 28),
      })}
      {handle('w', { left: box.left - 7, top: box.top + 14, height: Math.max(0, box.height - 28) })}
      {handle('e', {
        left: box.left + box.width - 7,
        top: box.top + 14,
        height: Math.max(0, box.height - 28),
      })}

      {corner('nw', { left: box.left - 13, top: box.top - 13 })}
      {corner('ne', { left: box.left + box.width - 13, top: box.top - 13 })}
      {corner('sw', { left: box.left - 13, top: box.top + box.height - 13 })}
      {corner('se', { left: box.left + box.width - 13, top: box.top + box.height - 13 })}

      {dragging === 'rotate' && (
        <div className="material pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full px-2.5 py-1 text-mini tabular-nums text-label-secondary shadow-hud">
          {crop.angle > 0 ? '+' : ''}
          {crop.angle.toFixed(1)}°
        </div>
      )}
    </div>
  )
}
