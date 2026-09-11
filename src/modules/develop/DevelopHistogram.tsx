import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useHistogram } from '../../develop/histogramStore'
import { useDevelop } from '../../develop/session'
import { useUI } from '../../state/ui'
import { usePhoto } from '../../catalog/hooks'
import { useElementSize } from '../../lib/useElementSize'
import { clamp, formatAperture, formatFocal, formatShutter, quantize } from '../../lib/math'
import { cn } from '../../lib/cn'
import { useMenu } from '../../design/useMenu'
import { histogramMenuItems } from '../../shell/appMenus'
import { Badge } from '../../design/Badge'

const H = 78

type ToneField = 'blacks' | 'shadows' | 'exposure' | 'highlights' | 'whites'

interface Zone {
  field: ToneField
  label: string
  /** Horizontal extent of the region as a fraction of the axis. */
  from: number
  to: number
  min: number
  max: number
  step: number
  /** Value swept by dragging the full width of the graph. */
  travel: number
  precision: number
}

/*
 * Lightroom's five tonal regions. The extremes are a little wider than the
 * tones they nominally cover so Blacks and Whites stay grabbable in a 240px
 * panel — once the pointer is captured the exact boundary stops mattering.
 */
const ZONES: Zone[] = [
  { field: 'blacks', label: 'Blacks', from: 0, to: 0.08, min: -100, max: 100, step: 1, travel: 200, precision: 0 },
  { field: 'shadows', label: 'Shadows', from: 0.08, to: 0.28, min: -100, max: 100, step: 1, travel: 200, precision: 0 },
  { field: 'exposure', label: 'Exposure', from: 0.28, to: 0.72, min: -5, max: 5, step: 0.01, travel: 4, precision: 2 },
  { field: 'highlights', label: 'Highlights', from: 0.72, to: 0.92, min: -100, max: 100, step: 1, travel: 200, precision: 0 },
  { field: 'whites', label: 'Whites', from: 0.92, to: 1, min: -100, max: 100, step: 1, travel: 200, precision: 0 },
]

const zoneAt = (t: number) => ZONES.find((z) => t >= z.from && t < z.to) ?? ZONES[ZONES.length - 1]

/** The two colours the output shader paints clipped pixels with. */
const SHADOW_CLIP = '#2966ff'
const HIGHLIGHT_CLIP = '#ff291c'

/** Below this the "clipping" is dither noise, not blown pixels. */
const CLIP_EPSILON = 0.0005

/*
 * An 11-tap binomial blur (σ ≈ 1.6 bins). The readback is a 256-bin count off a
 * downsampled proxy, which is noisy enough that the raw trace reads as a torn
 * edge rather than a distribution; this settles it into a curve without
 * flattening a real spike.
 */
const SMOOTH = [1, 10, 45, 120, 210, 252, 210, 120, 45, 10, 1]
const SMOOTH_SUM = 1024
const SMOOTH_RADIUS = 5

/** Channel colours are theme tokens; resolve them once instead of duplicating. */
let channelColors: { r: string; g: string; b: string } | null = null
function channels() {
  if (!channelColors) {
    const s = getComputedStyle(document.documentElement)
    const read = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback
    channelColors = {
      r: read('--color-hist-mix-r', '#8d0c0c'),
      g: read('--color-hist-mix-g', '#12832a'),
      b: read('--color-hist-mix-b', '#123f8d'),
    }
  }
  return channelColors
}

/**
 * The live histogram, fed straight from the render pipeline's readback so it
 * always reflects exactly what is on screen — including the output transform.
 *
 * Channels are drawn additively in screen blend mode, the way Lightroom does
 * it: overlapping reds and greens read as yellow, all three as grey. Dragging
 * horizontally across a tonal region edits that region's Basic slider, so the
 * graph is a control and not just a chart.
 */
export function DevelopHistogram() {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { width } = useElementSize(hostRef)
  const bins = useHistogram()

  const clipping = useUI((s) => s.showClipping)
  const toggleClipping = useUI((s) => s.toggleClipping)

  const update = useDevelop((s) => s.update)
  const photoId = useDevelop((s) => s.photoId)

  const [pointer, setPointer] = useState<number | null>(null)
  const [dragField, setDragField] = useState<ToneField | null>(null)
  // Kept rather than nulled on release so a double-click can tell a real reset
  // from the tail of a drag, the same way the sliders do.
  const drag = useRef({ zone: ZONES[0], x: 0, start: 0, active: false, moved: false })

  // While dragging the region stays pinned even if the pointer wanders out of it.
  const zone = dragField
    ? ZONES.find((z) => z.field === dragField)!
    : pointer != null
      ? zoneAt(pointer)
      : null

  // -- painting --------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width <= 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const w = width
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(H * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, H)

    // Quarter-tone guides, barely there.
    ctx.strokeStyle = 'rgba(255,255,255,.06)'
    ctx.lineWidth = 0.5
    for (let i = 1; i < 4; i++) {
      const x = Math.round((i / 4) * w) + 0.25
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, H)
      ctx.stroke()
    }

    if (bins) {
      const n = bins.r.length
      const peak = Math.max(1, bins.max)

      /*
       * A log-ish curve keeps a single spike from flattening everything else.
       * Smoothing happens once per channel rather than per sample, so the whole
       * graph costs a few thousand multiply-adds however wide the panel is.
       */
      const curve = (data: Uint32Array) => {
        const out = new Float32Array(n)
        for (let i = 0; i < n; i++) {
          let acc = 0
          for (let k = -SMOOTH_RADIUS; k <= SMOOTH_RADIUS; k++) {
            acc += data[clamp(i + k, 0, n - 1)] * SMOOTH[k + SMOOTH_RADIUS]
          }
          out[i] = Math.min(1, Math.pow(acc / SMOOTH_SUM / peak, 0.42))
        }
        return out
      }

      const top = (c: Float32Array, i: number) => H - c[i] * (H - 3)
      const area = (c: Float32Array) => {
        ctx.beginPath()
        ctx.moveTo(0, H)
        for (let i = 0; i < n; i++) ctx.lineTo((i / (n - 1)) * w, top(c, i))
        ctx.lineTo(w, H)
        ctx.closePath()
      }

      /*
       * Screen, not additive alpha. Opaque near-pure primaries screen together
       * into exactly the mixtures the eye expects — red over green is gold,
       * green over blue is cyan, all three are a neutral grey — where dimmed
       * additive fills turn every overlap into a variation on olive.
       */
      const c = channels()
      const curves = [curve(bins.r), curve(bins.g), curve(bins.b)]
      ctx.globalCompositeOperation = 'screen'
      for (const [data, color] of [
        [curves[0], c.r],
        [curves[1], c.g],
        [curves[2], c.b],
      ] as const) {
        area(data)
        ctx.fillStyle = color
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'

      // A rim along the silhouette, so the shape stays crisp where it meets the
      // dark. It traces whichever channel is highest, never a curve of its own.
      ctx.beginPath()
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w
        const y = Math.min(top(curves[0], i), top(curves[1], i), top(curves[2], i))
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = 'rgba(255,255,255,.2)'
      ctx.lineWidth = 1
      ctx.lineJoin = 'round'
      ctx.stroke()
    }

    // A floor for the graph to stand on, so the fills end rather than fade.
    ctx.fillStyle = 'rgba(255,255,255,.10)'
    ctx.fillRect(0, H - 0.5, w, 0.5)

    /*
     * The band a drag would hit is shown by shading everything it would not,
     * rather than by tinting the band itself: the numbers in a histogram are
     * colours, and anything laid over them changes what they say. Dimming the
     * rest also draws its own edges, so the region needs no hairlines and the
     * graph none of the inverted markers they used to need to stay legible.
     */
    if (zone) {
      ctx.fillStyle = 'rgba(0,0,0,.46)'
      ctx.fillRect(0, 0, zone.from * w, H)
      ctx.fillRect(zone.to * w, 0, w - zone.to * w, H)
    }
  }, [bins, width, zone])

  // -- interaction -----------------------------------------------------------
  const posOf = useCallback((clientX: number) => {
    const host = hostRef.current
    if (!host) return 0
    const r = host.getBoundingClientRect()
    return clamp((clientX - r.left) / r.width, 0, 1)
  }, [])

  const setField = useCallback(
    (z: Zone, value: number) => {
      // Routed through the session so a histogram drag lands in history as one
      // named step, exactly like dragging the slider it stands in for.
      update(`basic.${z.field}`, z.label, (e) => {
        e.basic[z.field] = value
      })
    },
    [update],
  )

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !photoId) return
    const zoneUnder = zoneAt(posOf(e.clientX))
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = {
      zone: zoneUnder,
      x: e.clientX,
      start: useDevelop.getState().edits.basic[zoneUnder.field],
      active: true,
      moved: false,
    }
    setDragField(zoneUnder.field)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    setPointer(posOf(e.clientX))
    const d = drag.current
    if (!d.active) return
    const dx = e.clientX - d.x
    if (!d.moved && Math.abs(dx) < 2) return
    d.moved = true
    // Shift slows the drag, matching the sliders this is a shortcut for.
    const scale = ((e.shiftKey ? 0.125 : 1) * d.zone.travel) / Math.max(1, width)
    setField(d.zone, quantize(clamp(d.start + dx * scale, d.zone.min, d.zone.max), d.zone.step))
  }

  const endDrag = (e: React.PointerEvent) => {
    if (!drag.current.active) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    drag.current.active = false
    setDragField(null)
    // Capture suppresses pointerleave, so releasing outside the graph has to
    // clear the hover state here or the scrub line sticks around.
    const r = hostRef.current?.getBoundingClientRect()
    if (r && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) {
      setPointer(null)
    }
  }

  const { menu, open: openMenu } = useMenu()

  const onDoubleClick = (e: React.MouseEvent) => {
    if (!photoId || drag.current.moved) return
    setField(zoneAt(posOf(e.clientX)), 0)
  }

  return (
    <div className="px-3 pt-2.5 pb-2" onContextMenu={(e) => openMenu(e, histogramMenuItems())}>
      <div
        ref={hostRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => setPointer(null)}
        onDoubleClick={onDoubleClick}
        title={photoId ? 'Drag a region to adjust it · double-click to reset' : undefined}
        className={cn(
          'relative touch-none overflow-hidden rounded-md bg-black/45 select-none',
          'shadow-[inset_0_0_0_0.5px_var(--color-hairline)]',
          photoId && 'cursor-ew-resize',
        )}
        style={{ height: H }}
      >
        <canvas ref={canvasRef} style={{ height: H }} className="block w-full" />

        {/* Rides the band it belongs to, so what a drag will hit is unambiguous. */}
        <ZoneTag zone={zone} width={width} />
      </div>

      <Readout
        shadow={bins?.clipShadow ?? 0}
        highlight={bins?.clipHighlight ?? 0}
        clipping={clipping}
        onToggle={toggleClipping}
      />
      {menu}
    </div>
  )
}

/**
 * The region label and its live value, parked over the band the pointer is in.
 * It carries the number so your eyes never have to leave the graph mid-drag,
 * and it is opaque because the data underneath can be any brightness.
 */
function ZoneTag({ zone, width }: { zone: Zone | null; width: number }) {
  const value = useDevelop((s) => (zone ? s.edits.basic[zone.field] : 0))
  const ref = useRef<HTMLSpanElement>(null)
  const [half, setHalf] = useState(0)

  // Held so the tag fades out with its own text rather than blanking first.
  const last = useRef<Zone | null>(null)
  if (zone) last.current = zone
  const shown = zone ?? last.current

  // The label sets the width, so it is measured rather than guessed — otherwise
  // "Whites" runs off the end of the graph it is supposed to be pointing at.
  useLayoutEffect(() => {
    if (ref.current) setHalf(ref.current.offsetWidth / 2 + 3)
  }, [shown])

  if (!shown || width <= 0) return null

  // Pinned inside the graph, so a wide label on a narrow band still reads.
  const inset = Math.min(half, width / 2)

  return (
    <Badge
      ref={ref}
      aria-hidden
      surface="image"
      size="sm"
      className={cn(
        'pointer-events-none absolute top-1.5 -translate-x-1/2',
        'transition-opacity duration-[--duration-fast] ease-[--ease-out]',
        zone ? 'opacity-100' : 'opacity-0',
      )}
      style={{ left: clamp(((shown.from + shown.to) / 2) * width, inset, width - inset) }}
    >
      <span>{shown.label}</span>
      <span className="w-[30px] text-right font-mono">
        {value > 0 ? '+' : ''}
        {value.toFixed(shown.precision)}
      </span>
    </Badge>
  )
}

/** Tooltip copy only: four characters at most, enough to be honest about a trace. */
function formatPct(v: number): string {
  if (v < CLIP_EPSILON) return '0%'
  const pct = v * 100
  return pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`
}

/**
 * Clipping controls flanking the capture data, which is exactly where Lightroom
 * puts it. Nothing here swaps out on hover, so the row is a fixed anchor and
 * the panel below never shifts.
 */
function Readout({
  shadow,
  highlight,
  clipping,
  onToggle,
}: {
  shadow: number
  highlight: number
  clipping: { shadows: boolean; highlights: boolean }
  onToggle: (which: 'shadows' | 'highlights') => void
}) {
  const photoId = useDevelop((s) => s.photoId)
  const m = usePhoto(photoId)?.meta

  return (
    <div className="mt-1.5 flex h-4 items-center gap-2">
      <ClipChip
        side="shadows"
        active={clipping.shadows}
        amount={shadow}
        onClick={() => onToggle('shadows')}
      />

      {/* Proportional, not mono: nothing here scrubs, and the extra width would
          cost the shutter speed its place on a narrow panel. An en space
          because the browser eats the second of two ordinary ones. */}
      <span className="min-w-0 flex-1 truncate text-center text-micro tnum text-label-tertiary">
        {m
          ? [
              m.focalLength ? formatFocal(m.focalLength) : null,
              m.aperture ? formatAperture(m.aperture) : null,
              m.shutter ? formatShutter(m.shutter) : null,
              m.iso ? `ISO ${m.iso}` : null,
            ]
              .filter(Boolean)
              .join('\u2002')
          : null}
      </span>

      <ClipChip
        side="highlights"
        active={clipping.highlights}
        amount={highlight}
        onClick={() => onToggle('highlights')}
      />
    </div>
  )
}

/**
 * A small block at each end of the row, lit when that end of the axis is
 * clipping and filled in when its overlay is on.
 *
 * A block rather than a wedge: a triangle sitting loose in a row reads as an
 * arrow pointing somewhere, and the only thing these have ever pointed at is
 * the end of the graph they already sit under.
 *
 * The exact percentage lives in the tooltip. On screen it was two permanent
 * zeroes bracketing the only reading in the row that ever changes, and the
 * fixed slots they needed cost the capture line its ISO.
 */
function ClipChip({
  side,
  active,
  amount,
  onClick,
}: {
  side: 'shadows' | 'highlights'
  active: boolean
  amount: number
  onClick: () => void
}) {
  const shadows = side === 'shadows'
  const color = shadows ? SHADOW_CLIP : HIGHLIGHT_CLIP
  const hot = amount >= CLIP_EPSILON

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={`${shadows ? 'Shadow' : 'Highlight'} clipping`}
      title={`${shadows ? 'Shadow' : 'Highlight'} clipping: ${formatPct(amount)} of pixels (J)`}
      className={cn(
        'esq-tap relative grid size-4 shrink-0 place-items-center rounded-xs',
        // A transparent pseudo-element widens the target without fattening the ink.
        "after:absolute after:-inset-1 after:content-['']",
        'transition-[background-color] duration-[--duration-fast] ease-[--ease-out]',
        active ? 'bg-white/14' : 'hover:bg-white/8',
      )}
    >
      <span
        aria-hidden
        className="size-[7px] rounded-[1.5px] transition-[background-color] duration-[--duration-fast] ease-[--ease-out]"
        style={{ backgroundColor: active || hot ? color : 'rgb(255 255 255 / 0.2)' }}
      />
    </button>
  )
}
