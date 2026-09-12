import { useEffect, useRef, useState } from 'react'
import { useDevelop } from '../../develop/session'
import { pickWhiteBalanceAt, pickerImage, readAt, whiteBalanceFromPatch } from '../../develop/wbPicker'
import { useUI } from '../../state/ui'
import { PROPHOTO_D50_TO_SRGB_D65, apply3 } from '../../core/color'
import type { FrameBox } from './CropOverlay'
import type { SourceImage } from '../../core/workingImage'
import type { Point2 } from '../../core/types'
import { Badge } from '../../design/Badge'

/**
 * The white-balance dropper's half of the viewport.
 *
 * A dropper that only reports after the click asks the photographer to guess
 * which of two nearly identical greys is the neutral one, so the loupe answers
 * first: it carries the colour under the crosshair and the Kelvin that colour
 * would produce, live, before anything is committed. Choosing a white balance
 * becomes a matter of moving until the number settles rather than clicking and
 * undoing.
 */

/** Kept clear of the crosshair, and mirrored near an edge so it stays on screen. */
const LOUPE_OFFSET = 18
const LOUPE_W = 116
const LOUPE_H = 54

/** Puts the panel's button back. Read off the store, so it never changes identity. */
const disarm = () => useUI.getState().setWbPicking(false)

export function WbDropperOverlay({ frame }: { frame: FrameBox }) {
  const photoId = useDevelop((s) => s.photoId)
  const hostRef = useRef<HTMLDivElement>(null)
  const [image, setImage] = useState<SourceImage | null>(null)
  const [at, setAt] = useState<{ x: number; y: number; uv: Point2 } | null>(null)

  // The proxy is normally already resident from Develop's own load; this only
  // does real work if the dropper is armed before the decode lands.
  useEffect(() => {
    let live = true
    setImage(null)
    if (!photoId) return
    void pickerImage(photoId).then((img) => {
      if (live) setImage(img)
    })
    return () => {
      live = false
    }
  }, [photoId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        disarm()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const track = (e: React.PointerEvent) => {
    const host = hostRef.current?.getBoundingClientRect()
    if (!host || frame.width <= 0 || frame.height <= 0) return
    const x = e.clientX - host.left
    const y = e.clientY - host.top
    setAt({
      x,
      y,
      uv: { x: (x - frame.x) / frame.width, y: (y - frame.y) / frame.height },
    })
  }

  const inFrame = !!at && at.uv.x >= 0 && at.uv.x <= 1 && at.uv.y >= 0 && at.uv.y <= 1
  const edits = useDevelop((s) => s.edits)
  const rgb = image && at && inFrame ? readAt(image, edits, at.uv) : null
  const white = image && rgb ? whiteBalanceFromPatch(image, rgb) : null

  return (
    <div
      ref={hostRef}
      data-wb-dropper=""
      className="absolute inset-0 cursor-crosshair"
      onPointerMove={track}
      onPointerLeave={() => setAt(null)}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const host = hostRef.current?.getBoundingClientRect()
        if (!host || !image) return
        const uv = {
          x: (e.clientX - host.left - frame.x) / frame.width,
          y: (e.clientY - host.top - frame.y) / frame.height,
        }
        if (uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) return
        // Stays armed on a miss, so a bad pick costs one more click rather
        // than a trip back to the panel.
        if (pickWhiteBalanceAt(image, uv)) disarm()
      }}
    >
      {at && inFrame && (
        <>
          <Crosshair x={at.x} y={at.y} />
          <Loupe
            x={at.x}
            y={at.y}
            host={hostRef.current}
            swatch={rgb ? swatchCss(rgb) : null}
            white={white}
          />
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

/** Two hairlines and a gap, so the pixel being measured is never covered up. */
function Crosshair({ x, y }: { x: number; y: number }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute"
      style={{ left: x, top: y, width: 0, height: 0 }}
    >
      {[
        { left: -13, top: -0.5, width: 9, height: 1 },
        { left: 4, top: -0.5, width: 9, height: 1 },
        { left: -0.5, top: -13, width: 1, height: 9 },
        { left: -0.5, top: 4, width: 1, height: 9 },
      ].map((s, i) => (
        <span
          key={i}
          className="absolute bg-white mix-blend-difference"
          style={{ ...s, position: 'absolute' }}
        />
      ))}
    </div>
  )
}

function Loupe({
  x,
  y,
  host,
  swatch,
  white,
}: {
  x: number
  y: number
  host: HTMLElement | null
  swatch: string | null
  white: { temp: number; tint: number } | null
}) {
  const w = host?.clientWidth ?? 0
  const h = host?.clientHeight ?? 0
  const left = x + LOUPE_OFFSET + LOUPE_W > w ? x - LOUPE_OFFSET - LOUPE_W : x + LOUPE_OFFSET
  const top = y + LOUPE_OFFSET + LOUPE_H > h ? y - LOUPE_OFFSET - LOUPE_H : y + LOUPE_OFFSET

  return (
    <Badge
      aria-hidden
      className="pointer-events-none absolute"
      style={{ left, top, width: LOUPE_W }}
    >
      <span
        className="size-7 shrink-0 rounded-md ring-1 ring-hairline-strong"
        style={{ background: swatch ?? 'transparent' }}
      />
      <span className="flex min-w-0 flex-col">
        <span className="text-mini tnum text-label">
          {white ? `${white.temp.toLocaleString()} K` : '—'}
        </span>
        <span className="text-micro tnum text-label-tertiary">
          {white ? `Tint ${white.tint > 0 ? '+' : ''}${white.tint}` : 'Not neutral'}
        </span>
      </span>
    </Badge>
  )
}

/**
 * The patch as it would appear on screen.
 *
 * Scene-linear values run past 1 on a RAW, so the swatch is normalised on its
 * own brightest channel: the point of it is the *cast*, and a highlight drawn
 * as flat white would hide exactly the tint being judged.
 */
function swatchCss(rgb: [number, number, number]): string {
  const peak = Math.max(rgb[0], rgb[1], rgb[2], 1e-6)
  const norm: [number, number, number] = [rgb[0] / peak, rgb[1] / peak, rgb[2] / peak]
  const srgb = apply3(PROPHOTO_D50_TO_SRGB_D65, norm)
  const ch = (v: number) => {
    const c = Math.min(1, Math.max(0, v))
    const e = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
    return Math.round(e * 255)
  }
  return `rgb(${ch(srgb[0])} ${ch(srgb[1])} ${ch(srgb[2])})`
}
