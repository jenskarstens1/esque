import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { splineLut, parametricLut, composeLut, LUT_SIZE } from '../../gpu/curves'
import { useHistogram } from '../../develop/histogramStore'
import type { CurvePoint, ParametricCurve } from '../../core/types'
import { cn } from '../../lib/cn'
import { clamp } from '../../lib/math'
import { Badge } from '../../design/Badge'

export type CurveChannel = 'rgb' | 'red' | 'green' | 'blue'

/**
 * The plot is inset from the canvas edge so a control point parked on 0,0 or
 * 1,1 is a whole dot you can see and grab, not a quarter of one buried in the
 * corner radius. Everything below works in plot space and converts on the way
 * out.
 */
const PAD = 6

const CHANNEL_STROKE: Record<CurveChannel, string> = {
  rgb: 'rgba(255,255,255,.92)',
  red: 'rgba(255,86,86,.95)',
  green: 'rgba(86,224,120,.95)',
  blue: 'rgba(96,148,255,.95)',
}

interface Props {
  mode: 'parametric' | 'point'
  channel: CurveChannel
  points: CurvePoint[]
  parametric: ParametricCurve
  onPointsChange: (points: CurvePoint[], commit: boolean) => void
  onSplitsChange: (splits: Pick<ParametricCurve, 'shadowSplit' | 'midtoneSplit' | 'highlightSplit'>) => void
  /** Region the pointer is hovering over the image, 0..1, for the target marker. */
  probe?: number | null
}

/**
 * The tone curve. Point mode is a draggable spline; parametric mode shows the
 * resulting curve with three draggable split markers underneath.
 *
 * Drawn on a canvas rather than SVG because it re-renders on every pointer move
 * along with a live histogram underlay, and canvas makes that free.
 */
export function CurveEditor({
  mode,
  channel,
  points,
  parametric,
  onPointsChange,
  onSplitsChange,
  probe,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const bins = useHistogram()

  const lut = useMemo(() => {
    const spline = splineLut(points)
    return channel === 'rgb' ? composeLut(parametricLut(parametric), spline) : spline
  }, [points, parametric, channel])

  const parametricOnly = mode === 'parametric' && channel === 'rgb'

  // -- painting --------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (canvas.width !== Math.round(w * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const pw = w - PAD * 2
    const ph = h - PAD * 2
    const px = (t: number) => PAD + t * pw
    const py = (v: number) => PAD + (1 - v) * ph
    const bottom = PAD + ph

    // Histogram underlay — the same 3-tap smoothing and gamma the main
    // histogram uses, so the two graphs describe the image identically. It is
    // a reference, not the subject: a faint fill with a defined top edge reads
    // as data, where a bare fill this dim reads as a smudge.
    if (bins) {
      const data = channel === 'rgb' ? bins.l : channel === 'red' ? bins.r : channel === 'green' ? bins.g : bins.b
      const n = data.length
      const peak = Math.max(1, bins.max)
      const norm = (i: number) => {
        const a = data[Math.max(0, i - 1)]
        const c = data[Math.min(n - 1, i + 1)]
        return Math.min(1, Math.pow((a + data[i] * 2 + c) / 4 / peak, 0.42))
      }
      ctx.beginPath()
      ctx.moveTo(PAD, bottom)
      for (let i = 0; i < n; i++) ctx.lineTo(px(i / (n - 1)), bottom - norm(i) * ph * 0.92)
      ctx.lineTo(PAD + pw, bottom)
      ctx.closePath()
      ctx.fillStyle = 'rgba(255,255,255,.05)'
      ctx.fill()
      // Only the profile is stroked — closing the path would draw a box around
      // the plot that reads as a frame rather than as data.
      ctx.beginPath()
      for (let i = 0; i < n; i++) {
        const x = px(i / (n - 1))
        const y = bottom - norm(i) * ph * 0.92
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = 'rgba(255,255,255,.09)'
      ctx.lineWidth = 1
      ctx.stroke()
    }

    // Grid — quarters, matching Lightroom's reading of the tonal ranges.
    ctx.strokeStyle = 'rgba(255,255,255,.07)'
    ctx.lineWidth = 0.5
    for (let i = 1; i < 4; i++) {
      const gx = Math.round(px(i / 4)) + 0.25
      ctx.beginPath()
      ctx.moveTo(gx, PAD)
      ctx.lineTo(gx, bottom)
      ctx.stroke()
      const gy = Math.round(py(i / 4)) + 0.25
      ctx.beginPath()
      ctx.moveTo(PAD, gy)
      ctx.lineTo(PAD + pw, gy)
      ctx.stroke()
    }

    // Identity reference
    ctx.strokeStyle = 'rgba(255,255,255,.16)'
    ctx.setLineDash([2, 3])
    ctx.beginPath()
    ctx.moveTo(px(0), py(0))
    ctx.lineTo(px(1), py(1))
    ctx.stroke()
    ctx.setLineDash([])

    // The curve, laid over its own shadow so it stays legible where it crosses
    // the bright part of the histogram.
    ctx.beginPath()
    for (let i = 0; i < LUT_SIZE; i++) {
      const x = px(i / (LUT_SIZE - 1))
      const y = py(clamp(lut[i], 0, 1))
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.strokeStyle = 'rgba(0,0,0,.5)'
    ctx.lineWidth = 3.5
    ctx.stroke()
    ctx.strokeStyle = CHANNEL_STROKE[channel]
    ctx.lineWidth = 1.5
    ctx.stroke()

    // Control points
    if (!parametricOnly) {
      points.forEach((p, i) => {
        const x = px(p.x)
        const y = py(p.y)
        const live = i === dragIndex || i === hover
        if (live) {
          ctx.beginPath()
          ctx.arc(x, y, 8, 0, Math.PI * 2)
          ctx.fillStyle = 'rgba(255,255,255,.14)'
          ctx.fill()
        }
        ctx.beginPath()
        ctx.arc(x, y, live ? 4 : 3, 0, Math.PI * 2)
        ctx.fillStyle = live ? '#fff' : 'rgba(255,255,255,.8)'
        ctx.fill()
        ctx.strokeStyle = 'rgba(0,0,0,.6)'
        ctx.lineWidth = 1
        ctx.stroke()
      })
    }

    // Live probe from the image
    if (probe != null) {
      const x = px(clamp(probe, 0, 1))
      ctx.strokeStyle = 'rgba(255,255,255,.35)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x, PAD)
      ctx.lineTo(x, bottom)
      ctx.stroke()
    }
  }, [lut, points, bins, channel, dragIndex, hover, parametricOnly, probe])

  // -- interaction -----------------------------------------------------------
  const toLocal = useCallback((e: { clientX: number; clientY: number }) => {
    const host = hostRef.current
    if (!host) return { x: 0, y: 0 }
    const r = host.getBoundingClientRect()
    return {
      x: clamp((e.clientX - r.left - PAD) / (r.width - PAD * 2), 0, 1),
      y: clamp(1 - (e.clientY - r.top - PAD) / (r.height - PAD * 2), 0, 1),
    }
  }, [])

  const hitTest = useCallback(
    (x: number, y: number) => {
      const host = hostRef.current
      if (!host) return -1
      const r = host.getBoundingClientRect()
      const tolX = 9 / (r.width - PAD * 2)
      const tolY = 9 / (r.height - PAD * 2)
      return points.findIndex((p) => Math.abs(p.x - x) < tolX && Math.abs(p.y - y) < tolY)
    },
    [points],
  )

  const onPointerDown = (e: React.PointerEvent) => {
    if (parametricOnly) return
    const { x, y } = toLocal(e)
    let index = hitTest(x, y)

    if (e.altKey || e.button === 2) {
      // Alt-click removes, but the endpoints are permanent.
      if (index > 0 && index < points.length - 1) {
        const next = points.filter((_, i) => i !== index)
        onPointsChange(next, true)
      }
      return
    }

    let working = points
    if (index === -1) {
      working = [...points, { x, y }].sort((a, b) => a.x - b.x)
      index = working.findIndex((p) => p.x === x && p.y === y)
      onPointsChange(working, false)
    }

    setDragIndex(index)
    e.currentTarget.setPointerCapture(e.pointerId)

    const move = (ev: PointerEvent) => {
      const pos = toLocal(ev)
      const next = working.map((p, i) => {
        if (i !== index) return p
        // Endpoints stay pinned horizontally; interior points can't cross.
        const lo = i === 0 ? 0 : working[i - 1].x + 0.004
        const hi = i === working.length - 1 ? 1 : working[i + 1].x - 0.004
        const nx = i === 0 ? 0 : i === working.length - 1 ? 1 : clamp(pos.x, lo, hi)
        return { x: nx, y: pos.y }
      })
      working = next
      onPointsChange(next, false)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDragIndex(null)
      onPointsChange(working, true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const active = dragIndex ?? hover
  const activePoint = !parametricOnly && active != null ? points[active] : undefined

  return (
    <div className="select-none">
      <div className="overflow-hidden rounded-md bg-black/45 shadow-[inset_0_0_0_0.5px_var(--color-hairline)]">
        <div
          ref={hostRef}
          onPointerDown={onPointerDown}
          onContextMenu={(e) => e.preventDefault()}
          onPointerMove={(e) => {
            if (parametricOnly || dragIndex !== null) return
            const { x, y } = toLocal(e)
            const i = hitTest(x, y)
            setHover(i === -1 ? null : i)
          }}
          onPointerLeave={() => setHover(null)}
          title={
            parametricOnly
              ? undefined
              : 'Click to add a point · alt-click to remove'
          }
          className={cn(
            'relative aspect-square w-full touch-none',
            !parametricOnly && (active !== null ? 'cursor-grab' : 'cursor-crosshair'),
          )}
        >
          <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

          {activePoint && (
            <PointTag
              input={activePoint.x}
              output={activePoint.y}
              // Home is the top-left; the tag only moves when the point it
              // reports on would be underneath it. Bottom-right, not top-right
              // — the 1,1 endpoint lives there and is always on screen.
              corner={
                activePoint.x < 0.42 && activePoint.y > 0.86 ? 'bottom-right' : 'top-left'
              }
            />
          )}
        </div>

        <ToneAxis
          splits={{
            shadowSplit: parametric.shadowSplit,
            midtoneSplit: parametric.midtoneSplit,
            highlightSplit: parametric.highlightSplit,
          }}
          onChange={onSplitsChange}
          draggable={parametricOnly}
        />
      </div>
    </div>
  )
}

/** Input and output of the point under the pointer, in percent of full tone. */
function PointTag({
  input,
  output,
  corner,
}: {
  input: number
  output: number
  corner: 'top-left' | 'bottom-right'
}) {
  return (
    <Badge
      aria-hidden
      surface="image"
      size="sm"
      className={cn(
        'pointer-events-none absolute',
        corner === 'top-left' ? 'top-1.5 left-1.5' : 'right-1.5 bottom-1.5',
      )}
    >
      <span>In</span>
      <span className="w-[22px] text-right font-mono">
        {Math.round(input * 100)}
      </span>
      <span>Out</span>
      <span className="w-[22px] text-right font-mono">
        {Math.round(output * 100)}
      </span>
    </Badge>
  )
}

type Splits = Pick<ParametricCurve, 'shadowSplit' | 'midtoneSplit' | 'highlightSplit'>

const SPLIT_KEYS: Array<keyof Splits> = ['shadowSplit', 'midtoneSplit', 'highlightSplit']

const SPLIT_LABELS: Record<keyof Splits, string> = {
  shadowSplit: 'Shadows / Darks split',
  midtoneSplit: 'Darks / Lights split',
  highlightSplit: 'Lights / Highlights split',
}

/**
 * The tone axis, joined to the bottom of the graph: a luminance ramp that says
 * what the horizontal axis is, carrying the three region splits in parametric
 * mode. Keeping the ramp in both modes means switching between them doesn't
 * resize the panel under the pointer.
 */
function ToneAxis({
  splits,
  onChange,
  draggable,
}: {
  splits: Splits
  onChange: (s: Splits) => void
  draggable: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<keyof Splits | null>(null)

  const start = (key: keyof Splits) => (e: React.PointerEvent) => {
    e.preventDefault()
    setDragging(key)
    const move = (ev: PointerEvent) => {
      const host = ref.current
      if (!host) return
      const r = host.getBoundingClientRect()
      const x = clamp((ev.clientX - r.left) / r.width, 0.04, 0.96)
      const next = { ...splits, [key]: x }
      // Keep the splits ordered so the regions never invert.
      const ordered: Splits = {
        shadowSplit: next.shadowSplit,
        midtoneSplit: next.midtoneSplit,
        highlightSplit: next.highlightSplit,
      }
      if (key === 'shadowSplit') ordered.shadowSplit = Math.min(x, next.midtoneSplit - 0.04)
      if (key === 'midtoneSplit')
        ordered.midtoneSplit = clamp(x, next.shadowSplit + 0.04, next.highlightSplit - 0.04)
      if (key === 'highlightSplit') ordered.highlightSplit = Math.max(x, next.midtoneSplit + 0.04)
      onChange(ordered)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDragging(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      aria-hidden={!draggable}
      className="w-full"
      style={{ paddingInline: PAD, paddingBottom: PAD }}
    >
      {/* Aligned to the plot, not the well, so a split sits under the tone it
          actually splits. */}
      <div
        ref={ref}
        className="relative h-[11px] coarse:h-6 w-full rounded-[1.5px] shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.5)]"
        style={{ background: 'linear-gradient(90deg,#0a0a0c,#a4a4a9)' }}
      >
        {draggable &&
          SPLIT_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              onPointerDown={start(key)}
              aria-label={SPLIT_LABELS[key]}
              title={SPLIT_LABELS[key]}
              className="group/split absolute inset-y-0 w-3 coarse:w-11 -translate-x-1/2 cursor-ew-resize"
              style={{ left: `${splits[key] * 100}%` }}
            >
              {/* A dark ring keeps the grip readable at both ends of the ramp. */}
              <span
                className={cn(
                  'absolute inset-y-[2px] left-1/2 w-[3px] -translate-x-1/2 rounded-full',
                  'shadow-[0_0_0_0.5px_rgb(0_0_0/0.7)]',
                  'transition-colors duration-[--duration-fast]',
                  dragging === key ? 'bg-white' : 'bg-label-secondary group-hover/split:bg-white',
                )}
              />
            </button>
          ))}
      </div>
    </div>
  )
}
