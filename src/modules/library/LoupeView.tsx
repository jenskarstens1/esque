import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '../../lib/cn'
import { useCatalog } from '../../state/catalog'
import { usePreviewUrl, useThumbUrl } from '../../catalog/hooks'
import { THUMB_EDGE } from '../../catalog/previews'
import { framedSize, healOrientation, type PixelSize } from '../../catalog/aspect'
import { useDetailRender } from '../../catalog/detail'
import { useElementSize } from '../../lib/useElementSize'
import { useZoomPan } from '../../lib/useZoomPan'
import { mergeRefs } from '../../lib/mergeRefs'
import { ResolvingImage } from '../../design/ResolvingImage'
import { StatusPill } from '../../design/StatusPill'
import { useMenu } from '../../design/useMenu'
import { useCollections } from '../../catalog/hooks'
import { photoMenuItems, retargetSelection } from '../../shell/photoMenu'
import type { Photo } from '../../core/types'

export function LoupeView({ photos }: { photos: Photo[] }) {
  const primaryId = useCatalog((s) => s.primaryId)
  const photo = photos.find((p) => p.id === primaryId) ?? photos[0]
  return <PhotoCanvas photo={photo} />
}

/** The standard preview's long edge; past this the loupe needs a detail render. */
const PREVIEW_EDGE = 1920

function PreviewStatus({
  source,
  pending,
  raw,
}: {
  source: string | null | undefined
  pending: boolean
  raw: boolean
}) {
  if (source && !pending) return null
  let label = 'Loading photo'
  if (source) label = raw ? 'Developing RAW' : 'Decoding'
  return <StatusPill>{label}</StatusPill>
}

function PhotoCanvas({ photo }: { photo: Photo }) {
  const frameRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLDivElement>(null)
  const size = useElementSize(frameRef)
  const source = useCatalog((s) => s.source)
  const collections = useCollections()
  const { menu, open } = useMenu()

  const thumb = useThumbUrl(photo)
  const preview = usePreviewUrl(photo)

  // The frame is laid out from the catalog row, which for a rendered file was
  // read from an EXIF header that describes the photo before its orientation
  // tag is applied. The pixels themselves are the authority, so the first tier
  // to land re-shapes the frame — and puts the row right for everyone else.
  const [landed, setLanded] = useState<(PixelSize & { id: string }) | null>(null)
  // Scoped to the photo it was measured from: moving to the next photo must not
  // lay it out from the last one's shape, even for a frame.
  const measured = landed?.id === photo.id ? landed : null
  const frame = framedSize(photo, measured)
  const noteNatural = useCallback(
    (pixels: PixelSize) => {
      healOrientation(photo, pixels)
      setLanded((current) =>
        current?.id === photo.id &&
        current.width === pixels.width &&
        current.height === pixels.height
          ? current
          : { id: photo.id, ...pixels },
      )
    },
    [photo],
  )

  const zp = useZoomPan(size, { width: frame.width || 1, height: frame.height || 1 })
  useEffect(() => zp.reset(), [photo.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const native = Math.max(frame.width, frame.height) || PREVIEW_EDGE
  const previewEdge = photo.isRaw
    ? Math.max(
        PREVIEW_EDGE,
        photo.meta.embeddedWidth ?? 0,
        photo.meta.embeddedHeight ?? 0,
      )
    : PREVIEW_EDGE
  // RAW previews keep the camera's native embedded JPEG, so a demosaic is only
  // needed when that preview genuinely cannot satisfy the requested zoom.
  const wanted = Math.round(native * Math.min(1, zp.percent / 100))
  const detail = useDetailRender(photo, wanted > previewEdge * 1.02 ? wanted : 0)

  const src = detail.url ?? preview ?? thumb

  // The element is laid out at its fit size and *only* ever transformed from
  // there. Writing width/height per frame — which is what zooming used to do —
  // invalidates layout for an element the size of the photo, every frame; a
  // transform is a composited property and costs the main thread nothing.
  const base = zp.fitScale

  // Until the standard preview lands, the loupe is showing the grid thumbnail:
  // a 512px file carrying a whole screen. Blowing that up sharp is a wall of
  // compression artefacts pretending to be the photograph, so it is softened in
  // proportion to how far it is being stretched, and the preview then arrives
  // as a focus pull. The softness is held with its tier, so what replaces it
  // always comes in clean.
  const standingIn = !detail.url && !preview && !!thumb
  const softness = standingIn
    ? Math.min(6, Math.max(0, ((native * base) / THUMB_EDGE - 1) * 1.1))
    : 0

  const baseRef = useRef(base)
  baseRef.current = base

  const { read, subscribe } = zp
  const place = useCallback(() => {
    const el = imgRef.current
    if (!el) return
    const v = read()
    const k = baseRef.current > 0 ? v.scale / baseRef.current : 1
    el.style.transform = `translate3d(${v.x}px, ${v.y}px, 0) scale(${k})`
  }, [read])

  // Straight from the gesture's own frame, so the image tracks the pointer
  // instead of trailing a React commit behind it.
  useEffect(() => subscribe(place), [place, subscribe])
  // And once more after every render, which is what picks up a resize, a new
  // photo, or a swap to the sharper source.
  useLayoutEffect(place)

  return (
    <div
      {...zp.bind}
      ref={mergeRefs(frameRef, zp.bind.ref)}
      className="relative size-full overflow-hidden"
      style={zp.bind.style}
      onContextMenu={(e) => {
        retargetSelection(photo.id)
        open(
          e,
          photoMenuItems(photo, {
            collections,
            collectionId: source.kind === 'collection' ? source.id : undefined,
          }),
        )
      }}
    >
      <div className="absolute inset-0 flex items-center justify-center">
        <ResolvingImage
          // Tiers of one photo dissolve into each other; a different photo is a
          // different photo, and culling wants it the instant it is asked for.
          key={photo.id}
          ref={imgRef}
          src={src}
          alt={photo.filename}
          softness={softness}
          className="shrink-0 select-none"
          onNatural={noteNatural}
          style={{
            width: frame.width * base || undefined,
            height: frame.height * base || undefined,
          }}
          // Interpolation follows the direction of scaling: crisp only once the
          // view is well past every pixel the loaded render actually has,
          // smooth the rest of the time.
          imageClassName={cn(
            // The frame is sized to the photo's own proportions, so this is
            // ordinarily a no-op — and the guarantee that a tier which somehow
            // disagrees is letterboxed rather than stretched out of shape.
            'object-contain',
            wanted > (detail.url ? native : previewEdge) * 1.6
              ? '[image-rendering:pixelated]'
              : '[image-rendering:auto]',
          )}
        />
      </div>

      <PreviewStatus source={src} pending={detail.pending} raw={photo.isRaw} />

      {menu}
    </div>
  )
}

export { PhotoCanvas }
