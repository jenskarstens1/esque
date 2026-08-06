import { useMemo, useState } from 'react'
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
 * Tiles come from CARTO's dark rendering of OSM data rather than the standard
 * osm.org layer, for two reasons that both matter here: osm.org's tiles are a
 * light basemap that would have to be inverted to sit in this chrome, and its
 * tile policy asks apps to stay off it. CARTO also serves the headers this app
 * needs — the document is cross-origin isolated for LibRaw's SharedArrayBuffer,
 * so every cross-origin image has to be fetched in CORS mode (`crossOrigin`)
 * against an `Access-Control-Allow-Origin` that permits it. An image element
 * pointed at a host without that header is blocked outright under COEP:
 * require-corp.
 */

const TILE = 256
/** Half-extents of the tile field, in CSS px: wide enough for any panel width. */
const HALF_W = 480
const HALF_H = 96
const HEIGHT = 112
const MIN_ZOOM = 3
const MAX_ZOOM = 18
const DEFAULT_ZOOM = 13
const SUBDOMAINS = ['a', 'b', 'c', 'd']

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

function tilesAround(gps: Gps, zoom: number, retina: boolean): Tile[] {
  const centre = project(gps.lat, gps.lon, zoom)
  const count = 2 ** zoom

  const first = Math.floor((centre.x - HALF_W) / TILE)
  const last = Math.floor((centre.x + HALF_W) / TILE)
  const top = Math.floor((centre.y - HALF_H) / TILE)
  const bottom = Math.floor((centre.y + HALF_H) / TILE)

  const out: Tile[] = []
  for (let ty = top; ty <= bottom; ty++) {
    if (ty < 0 || ty >= count) continue
    for (let tx = first; tx <= last; tx++) {
      // Longitude wraps, so a viewport straddling the antimeridian borrows
      // tiles from the far side of the world while keeping its own position.
      const wrapped = ((tx % count) + count) % count
      const host = SUBDOMAINS[(wrapped + ty) % SUBDOMAINS.length]
      out.push({
        key: `${zoom}/${tx}/${ty}`,
        // `@2x` is the same frame at twice the pixels — the only way raster
        // cartography stays sharp on a 2× display.
        url: `https://${host}.basemaps.cartocdn.com/dark_all/${zoom}/${wrapped}/${ty}${retina ? '@2x' : ''}.png`,
        left: tx * TILE - centre.x,
        top: ty * TILE - centre.y,
      })
    }
  }
  return out
}

export function LocationMap({ gps, className }: { gps: Gps; className?: string }) {
  const [zoom, setZoom] = useState(DEFAULT_ZOOM)
  // Keyed by view, so a zoom or a new photo starts the tally over rather than
  // inheriting the last view's failures and flashing the offline message.
  const [failed, setFailed] = useState({ view: '', count: 0 })

  const retina = typeof window !== 'undefined' && window.devicePixelRatio > 1.5
  const tiles = useMemo(() => tilesAround(gps, zoom, retina), [gps, zoom, retina])
  const view = `${gps.lat},${gps.lon},${zoom}`

  const offline = failed.view === view && tiles.length > 0 && failed.count >= tiles.length
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
        {!offline && (
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
                className="absolute max-w-none select-none [filter:saturate(0.7)_brightness(1.18)_contrast(1.04)]"
                style={{ left: t.left, top: t.top, width: TILE, height: TILE }}
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

        {!offline && (
          <span className="pointer-events-none absolute right-1.5 bottom-1 text-[9px] leading-none text-white/32">
            © OpenStreetMap · CARTO
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
