import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../../lib/cn'
import { useUI } from '../../state/ui'
import { useCatalog } from '../../state/catalog'
import { usePhotos, useThumbUrl, useCollections } from '../../catalog/hooks'
import { useElementSize } from '../../lib/useElementSize'
import { FlagIcon, RejectIcon, StarIcon } from '../../design/icons'
import { Scroller } from '../../design/Scroller'
import { useMenu } from '../../design/useMenu'
import { gridBackgroundMenuItems } from '../../shell/appMenus'
import { photoMenuItems, retargetSelection } from '../../shell/photoMenu'
import { ThumbImage } from './ThumbImage'
import type { Photo } from '../../core/types'

const GAP = 6
/** Horizontal inset at the ends of the strip. */
const PAD = 10
/** Vertical inset above and below each slot. */
const PAD_Y = 8
/** Slots kept alive past each end of the strip. */
const OVERSCAN = 400
/**
 * How far a slot may stray from square.
 *
 * Unclamped, a 21:9 panorama would be four portraits wide and own the strip
 * while a stitched vertical would be a splinter. Held within a stop and a half
 * either way, every frame still arrives as its own shape.
 */
const MIN_ASPECT = 0.62
const MAX_ASPECT = 2.4

const aspectOf = (p: Photo) =>
  Math.min(
    MAX_ASPECT,
    Math.max(MIN_ASPECT, p.width > 0 && p.height > 0 ? p.width / p.height : 3 / 2),
  )

/**
 * The strip's geometry.
 *
 * Slots are cut to their own photo, so a run of frames has the rhythm the
 * shoot had — nothing is letterboxed into an identical grey pocket. Widths
 * therefore differ per photo and the offsets are a prefix sum, computed once
 * per height change and binary-searched to find what is on screen.
 */
function planStrip(photos: Photo[], slotHeight: number) {
  const offsets = new Float64Array(photos.length + 1)
  let x = PAD
  for (let i = 0; i < photos.length; i++) {
    offsets[i] = x
    x += Math.round(slotHeight * aspectOf(photos[i])) + GAP
  }
  offsets[photos.length] = x
  return { offsets, width: Math.max(0, x - GAP) + PAD }
}

/** First slot whose right edge is past `x`. */
function firstAfter(offsets: Float64Array, count: number, x: number) {
  let lo = 0
  let hi = count
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid + 1] - GAP <= x) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function Filmstrip() {
  const photos = usePhotos()
  const scrollRef = useRef<HTMLDivElement>(null)
  const { width: viewWidth, height } = useElementSize(scrollRef)
  const selected = useCatalog((s) => s.selected)
  const primaryId = useCatalog((s) => s.primaryId)
  const select = useCatalog((s) => s.select)
  const setViewMode = useUI((s) => s.setViewMode)
  const module = useUI((s) => s.module)
  const source = useCatalog((s) => s.source)
  const collections = useCollections()
  const { menu, open } = useMenu()

  const selectedSet = useMemo(() => new Set(selected), [selected])
  const slotHeight = Math.max(40, height - PAD_Y * 2)
  const plan = useMemo(() => planStrip(photos, slotHeight), [photos, slotHeight])

  const [left, setLeft] = useState(0)
  const frame = useRef(0)
  const onScroll = useCallback(() => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      setLeft(scrollRef.current?.scrollLeft ?? 0)
    })
  }, [])
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current)
      frame.current = 0
    },
    [],
  )

  const visible = useMemo(() => {
    const from = firstAfter(plan.offsets, photos.length, left - OVERSCAN)
    const until = left + (viewWidth || 0) + OVERSCAN
    const out: { photo: Photo; index: number; x: number; width: number }[] = []
    for (let i = from; i < photos.length && plan.offsets[i] < until; i++) {
      out.push({
        photo: photos[i],
        index: i,
        x: plan.offsets[i],
        width: plan.offsets[i + 1] - plan.offsets[i] - GAP,
      })
    }
    return out
  }, [plan, photos, left, viewWidth])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !primaryId) return
    const i = photos.findIndex((p) => p.id === primaryId)
    if (i < 0) return
    const start = plan.offsets[i]
    const end = plan.offsets[i + 1] - GAP
    const view = el.clientWidth
    if (start < el.scrollLeft + PAD) el.scrollTo({ left: Math.max(0, start - PAD) })
    else if (end > el.scrollLeft + view - PAD) el.scrollTo({ left: end - view + PAD })
  }, [primaryId, plan]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!photos.length) {
    return (
      <div className="grid size-full place-items-center text-micro text-label-quaternary">
        No photos in this view
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col" onContextMenu={(e) => open(e, gridBackgroundMenuItems())}>
      <Scroller
        ref={scrollRef}
        axis="x"
        thumb={false}
        frameClassName="min-h-0 flex-1"
        onScroll={onScroll}
        onWheel={(e) => {
          // A vertical wheel over a horizontal strip should still scroll it.
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && scrollRef.current) {
            scrollRef.current.scrollLeft += e.deltaY
          }
        }}
      >
        <div style={{ width: plan.width, height: '100%' }} className="relative">
          {visible.map((slot) => (
            <FilmstripCell
              key={slot.photo.id}
              photo={slot.photo}
              x={slot.x}
              width={slot.width}
              height={slotHeight}
              selected={selectedSet.has(slot.photo.id)}
              primary={slot.photo.id === primaryId}
              onSelect={(e) =>
                select(
                  slot.photo.id,
                  e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'replace',
                )
              }
              onOpen={() => module === 'library' && setViewMode('loupe')}
              onContextMenu={(e) => {
                retargetSelection(slot.photo.id)
                open(
                  e,
                  photoMenuItems(slot.photo, {
                    collections,
                    collectionId: source.kind === 'collection' ? source.id : undefined,
                  }),
                )
              }}
            />
          ))}
        </div>
      </Scroller>
      {menu}
    </div>
  )
}

function FilmstripCell({
  photo,
  x,
  width,
  height,
  selected,
  primary,
  onSelect,
  onOpen,
  onContextMenu,
}: {
  photo: Photo
  x: number
  width: number
  height: number
  selected: boolean
  primary: boolean
  onSelect: (e: React.MouseEvent) => void
  onOpen: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const url = useThumbUrl(photo)
  const rejected = photo.flag === 'reject'
  const marked = photo.rating > 0 || photo.label !== 'none' || photo.flag !== 'unflagged'

  return (
    <button
      type="button"
      title={photo.filename}
      aria-pressed={selected}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      style={{ position: 'absolute', left: x, top: PAD_Y, width, height, borderRadius: 4 }}
      className="group/fs isolate overflow-hidden bg-raised/35"
    >
      <ThumbImage photo={photo} url={url} dim={rejected} />

      {marked && (
        <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/80 to-transparent px-1 pt-3 pb-0.5 text-white">
          {photo.flag === 'pick' && <FlagIcon size={8} filled className="shrink-0" />}
          {rejected && <RejectIcon size={8} className="shrink-0" />}
          {photo.rating > 0 && (
            <span className="flex items-center">
              {Array.from({ length: photo.rating }, (_, i) => (
                <StarIcon key={i} size={7} filled />
              ))}
            </span>
          )}
          <span className="min-w-0 flex-1" />
          {photo.label !== 'none' && (
            <span
              className="size-1.5 shrink-0 rounded-full ring-1 ring-black/40"
              style={{ background: `var(--color-label-${photo.label})` }}
            />
          )}
        </span>
      )}

      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0 rounded-[inherit]',
          'transition-shadow duration-[--duration-fast] ease-[--ease-out]',
          primary
            ? 'shadow-[inset_0_0_0_2px_var(--color-accent)]'
            : selected
              ? 'shadow-[inset_0_0_0_2px_color-mix(in_srgb,var(--color-accent)_55%,transparent)]'
              : 'shadow-[inset_0_0_0_0.5px_rgb(255_255_255/0.1)] group-hover/fs:shadow-[inset_0_0_0_1.5px_rgb(255_255_255/0.35)]',
        )}
      />
    </button>
  )
}
