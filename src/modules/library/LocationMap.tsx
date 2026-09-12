import { useEffect, useMemo, useState } from 'react'
import { cn } from '../../lib/cn'
import { clamp, formatAltitude, formatDMS } from '../../lib/math'
import { CopyIcon, MinusIcon, PlusIcon } from '../../design/icons'
import { toast } from '../../design/toast'

/**
 * Where the frame was taken, drawn from OpenStreetMap raster tiles.
 *
 * A slippy map library would be several hundred kilobytes for what is, at this
 * size, a still image with a pin in it — so the tiles are placed by hand. Web
 * Mercator is two lines of arithmetic, and the panel only ever needs the tiles
 * that fall inside a 112px-tall strip.
 *
 * Tiles come from Esri's Dark Gray Canvas rather than the standard osm.org
 * layer, for two reasons that both matter here: osm.org's tiles are a light
 * basemap that would have to be inverted to sit in this chrome, and its tile
 * policy asks apps to stay off it. Esri also serves the headers this app needs
 * — the document is cross-origin isolated for LibRaw's SharedArrayBuffer, so
 * every cross-origin image has to be fetched in CORS mode (`crossOrigin`)
 * against an `Access-Control-Allow-Origin` that permits it. An image element
 * pointed at a host without that header is blocked outright under COEP:
 * require-corp.
 *
 * This layer replaced CARTO's `dark_all`, which now burns an "API KEY REQUIRED"
 * watermark into the tile bitmap itself — the request still returns 200, so
 * nothing here could detect it. Esri's canvas needs no key, and unlike the
 * keyed services it has no quota to exhaust or token to leak in a client build.
 *
 * Its quirks, all of which this file works around below: tiles are addressed
 * row-before-column (`/{z}/{y}/{x}`, not the usual `/{z}/{x}/{y}`), the service
 * publishes nothing past zoom 16, and it offers no `@2x` variant.
 */

const TILE = 256
/** Half-extents of the tile field, in CSS px: wide enough for any panel width. */
const HALF_W = 480
const HALF_H = 96
const HEIGHT = 112
const MIN_ZOOM = 3
/** Esri's canvas stops here; deeper requests 404 rather than render. */
const MAX_ZOOM = 16
const DEFAULT_ZOOM = 13
/** Two aliases for the same tile service, to widen the HTTP/1.1 socket pool. */
const HOSTS = ['services', 'server']
const LAYER = 'ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile'

interface Gps {
  lat: number
  lon: number
  alt: number
}

/** Web Mercator, in whole pixels at the given zoom. */
function project(lat: number, lon: number, zoom: number) {
  const scale = 2 ** zoom * TILE
  const rad = (clamp(lat, -85.05112878, 85.05112878) * Math.PI) / 180
  return {
    x: ((lon + 180) / 360) * scale,
    y: ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * scale,
  }
}

interface Tile {
  key: string
  url: string
  left: number
  top: number
}

function tilesAround(gps: Gps, zoom: number, retina: boolean) {
  // A 2× display needs twice the pixels per CSS px, and this service has no
  // `@2x` variant to ask for. The detail comes from one zoom level deeper drawn
  // at half size instead: same ground, four tiles, double the resolution. The
  // deepest level has nothing below it to borrow from, so it renders 1:1.
  const tileZoom = Math.min(retina ? zoom + 1 : zoom, MAX_ZOOM)
  const scale = 2 ** (zoom - tileZoom)
  const size = TILE * scale

  const centre = project(gps.lat, gps.lon, tileZoom)
  const count = 2 ** tileZoom

  // The strip is measured in CSS px, so it spans more tiles as they shrink.
  const first = Math.floor((centre.x - HALF_W / scale) / TILE)
  const last = Math.floor((centre.x + HALF_W / scale) / TILE)
  const top = Math.floor((centre.y - HALF_H / scale) / TILE)
  const bottom = Math.floor((centre.y + HALF_H / scale) / TILE)

  const out: Tile[] = []
  for (let ty = top; ty <= bottom; ty++) {
    if (ty < 0 || ty >= count) continue
    for (let tx = first; tx <= last; tx++) {
      // Longitude wraps, so a viewport straddling the antimeridian borrows
      // tiles from the far side of the world while keeping its own position.
      const wrapped = ((tx % count) + count) % count
      const host = HOSTS[(wrapped + ty) % HOSTS.length]
      out.push({
        key: `${tileZoom}/${tx}/${ty}`,
        // Row before column, and `blankTile=false` so a gap 404s into the
        // offline tally rather than returning a pale "map data not yet
        // available" placeholder that would glare out of this dark panel.
        url: `https://${host}.arcgisonline.com/${LAYER}/${tileZoom}/${ty}/${wrapped}?blankTile=false`,
        left: (tx * TILE - centre.x) * scale,
        top: (ty * TILE - centre.y) * scale,
      })
    }
  }
  return { tiles: out, size }
}

export function LocationMap({ gps, className }: { gps: Gps; className?: string }) {
  const [zoom, setZoom] = useState(DEFAULT_ZOOM)
  // Keyed by view, so a zoom or a new photo starts the tally over rather than
  // inheriting the last view's failures and flashing the offline message.
  const [failed, setFailed] = useState({ view: '', count: 0 })

  const retina = typeof window !== 'undefined' && window.devicePixelRatio > 1.5
  const { tiles, size } = useMemo(() => tilesAround(gps, zoom, retina), [gps, zoom, retina])
  const view = `${gps.lat},${gps.lon},${zoom}`

  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  // Every tile in the view failed. Two very different causes share that symptom:
  // no network, or open water — Esri publishes nothing where there is nothing to
  // draw, and those tiles 404 by design. Empty sea should just render as empty
  // sea, so only a browser that reports itself offline gets the message.
  const blank = failed.view === view && tiles.length > 0 && failed.count >= tiles.length
  const offline = blank && !online
  const decimal = `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}`
  const href = `https://www.openstreetmap.org/?mlat=${gps.lat}&mlon=${gps.lon}#map=${zoom}/${gps.lat}/${gps.lon}`

  const noteFailure = () =>
    setFailed((f) => (f.view === view ? { view, count: f.count + 1 } : { view, count: 1 }))

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div
        className="group/map relative overflow-hidden rounded-md bg-raised shadow-[inset_0_0_0_0.5px_var(--color-hairline)]"
        style={{ height: HEIGHT }}
      >
        {!blank && (
          <div className="absolute top-1/2 left-1/2 size-0" aria-hidden>
            {tiles.map((t) => (
              <img
                key={t.key}
                src={t.url}
                alt=""
                draggable={false}
                decoding="async"
                crossOrigin="anonymous"
                onError={noteFailure}
                className="absolute max-w-none select-none [filter:saturate(0.75)_brightness(0.68)_contrast(1.02)]"
                style={{ left: t.left, top: t.top, width: size, height: size }}
              />
            ))}
          </div>
        )}

        {offline && (
          <div className="absolute inset-0 flex items-center justify-center text-mini text-label-quaternary">
            Map unavailable offline
          </div>
        )}

        <Pin />

        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          title="Open in OpenStreetMap"
          aria-label={`Open ${decimal} in OpenStreetMap`}
          className="absolute inset-0 rounded-md focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        />

        <div
          className={cn(
            'absolute top-1 right-1 flex flex-col overflow-hidden rounded-xs bg-black/55 backdrop-blur-sm',
            'opacity-0 transition-opacity duration-[--duration-fast] group-hover/map:opacity-100 focus-within:opacity-100',
          )}
        >
          <ZoomButton
            label="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => setZoom((z) => clamp(z + 1, MIN_ZOOM, MAX_ZOOM))}
          >
            <PlusIcon size={10} />
          </ZoomButton>
          <ZoomButton
            label="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => setZoom((z) => clamp(z - 1, MIN_ZOOM, MAX_ZOOM))}
          >
            <MinusIcon size={10} />
          </ZoomButton>
        </div>

        {!blank && (
          <span
            title="Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community"
            className="pointer-events-none absolute right-1.5 bottom-1 text-[9px] leading-none text-white/32"
          >
            © OpenStreetMap · Esri
          </span>
        )}
      </div>

      <div className="flex items-baseline gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-mini tnum text-label-secondary" title={decimal}>
            {formatDMS(gps.lat, 'lat')}
          </div>
          <div className="truncate text-mini tnum text-label-secondary" title={decimal}>
            {formatDMS(gps.lon, 'lon')}
            {gps.alt ? (
              <span className="text-label-tertiary">{`  ·  ${formatAltitude(gps.alt)}`}</span>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          title="Copy coordinates"
          aria-label="Copy coordinates"
          onClick={() => {
            navigator.clipboard
              .writeText(decimal)
              .then(() => toast.show('Coordinates copied', { detail: decimal }))
              .catch(() => toast.show('Could not copy coordinates', { tone: 'error' }))
          }}
          className="shrink-0 rounded-xs p-1 text-icon-tertiary transition-colors duration-[--duration-fast] hover:bg-raised hover:text-icon"
        >
          <CopyIcon size={11} />
        </button>
      </div>
    </div>
  )
}

/** The point itself: a pin reads as a place in a way a plain dot doesn't. */
function Pin() {
  return (
    <span className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-full">
      <svg viewBox="0 0 12 16" className="size-[16px] drop-shadow-[0_1px_2px_rgb(0_0_0/0.55)]" aria-hidden>
        <path
          d="M6 15.2C6 15.2 11 9.6 11 6A5 5 0 0 0 1 6C1 9.6 6 15.2 6 15.2Z"
          fill="var(--color-accent)"
          stroke="white"
          strokeOpacity="0.85"
          strokeWidth="1"
        />
        <circle cx="6" cy="6" r="1.7" fill="white" fillOpacity="0.92" />
      </svg>
    </span>
  )
}

function ZoomButton({
  children,
  label,
  onClick,
  disabled,
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex size-[18px] items-center justify-center text-white/70',
        'transition-colors duration-[--duration-fast] hover:bg-white/15 hover:text-white',
        'disabled:pointer-events-none disabled:opacity-30',
      )}
    >
      {children}
    </button>
  )
}
