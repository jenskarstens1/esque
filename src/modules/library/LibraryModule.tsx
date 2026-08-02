import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../../lib/cn'
import { useUI, setGridColumns } from '../../state/ui'
import { useCatalog } from '../../state/catalog'
import { usePhotos, useCollections } from '../../catalog/hooks'
import { Thumbnail } from './Thumbnail'
import { Scroller } from '../../design/Scroller'
import { LoupeView } from './LoupeView'
import { EmptyLibrary } from './EmptyLibrary'
import { useElementSize } from '../../lib/useElementSize'
import { useMenu } from '../../design/useMenu'
import { photoMenuItems, retargetSelection } from '../../shell/photoMenu'
import { gridBackgroundMenuItems } from '../../shell/appMenus'
import { PAD_TOP, planGrid, windowOf } from './gridPlan'
import type { Photo } from '../../core/types'

/** Rows kept alive beyond the viewport so a flick never lands on a hole. */
const OVERSCAN = 600

export function LibraryModule() {
  const viewMode = useUI((s) => s.viewMode)
  const photos = usePhotos()

  if (!photos.length) return <EmptyLibrary />
  if (viewMode === 'loupe') return <LoupeView photos={photos} />
  return <PhotoGrid photos={photos} />
}

function PhotoGrid({ photos }: { photos: Photo[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { width, height } = useElementSize(scrollRef)
  const thumbSize = useUI((s) => s.thumbSize)
  const gridLayout = useUI((s) => s.gridLayout)
  const showExtras = useUI((s) => s.showGridExtras)
  const setViewMode = useUI((s) => s.setViewMode)

  const selected = useCatalog((s) => s.selected)
  const primaryId = useCatalog((s) => s.primaryId)
  const select = useCatalog((s) => s.select)
  const source = useCatalog((s) => s.source)
  const collections = useCollections()
  const { menu, open } = useMenu()

  const selectedSet = useMemo(() => new Set(selected), [selected])
  const plan = useMemo(
    () => planGrid(photos, width, thumbSize, gridLayout),
    [photos, width, thumbSize, gridLayout],
  )
  // Arrow Up and Down move by a row, which only the laid-out grid knows.
  useEffect(() => setGridColumns(plan.columns), [plan.columns])

  // Scroll drives which cells exist, so it is read straight off the element
  // and coalesced to a frame rather than kept in sync through an effect.
  const [top, setTop] = useState(0)
  const frame = useRef(0)
  const onScroll = useCallback(() => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      setTop(scrollRef.current?.scrollTop ?? 0)
    })
  }, [])
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current)
      frame.current = 0
    },
    [],
  )

  const visible = useMemo(
    () => windowOf(plan, top - OVERSCAN, top + (height || 0) + OVERSCAN),
    [plan, top, height],
  )

  // Keep the active photo on screen when selection moves via the keyboard.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !primaryId) return
    const index = photos.findIndex((p) => p.id === primaryId)
    const item = index >= 0 ? plan.items[index] : undefined
    if (!item) return
    const view = el.clientHeight
    if (item.y < el.scrollTop) el.scrollTo({ top: Math.max(0, item.y - PAD_TOP) })
    else if (item.y + item.height > el.scrollTop + view)
      el.scrollTo({ top: item.y + item.height - view + PAD_TOP })
  }, [primaryId, plan]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative size-full">
      <Scroller
        ref={scrollRef}
        frameClassName="size-full"
        role="listbox"
        aria-label="Photo grid"
        aria-multiselectable
        onScroll={onScroll}
        onClick={(e) => {
          if (e.target === e.currentTarget) useCatalog.getState().clearSelection()
        }}
        onContextMenu={(e) => open(e, gridBackgroundMenuItems())}
      >
        <div style={{ height: plan.height }} className="relative">
          {visible.map((item) => (
            <div
              key={item.photo.id}
              style={{ position: 'absolute', left: item.x, top: item.y }}
              // Cells are placed by the plan, so the browser never has to
              // reflow the field to find out where the next one goes.
            >
              <Thumbnail
                photo={item.photo}
                width={item.width}
                height={item.height}
                selected={selectedSet.has(item.photo.id)}
                primary={item.photo.id === primaryId}
                showExtras={showExtras}
                onSelect={(e) =>
                  select(
                    item.photo.id,
                    e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'replace',
                  )
                }
                onOpen={() => {
                  select(item.photo.id)
                  setViewMode('loupe')
                }}
                onContextMenu={(e) => {
                  retargetSelection(item.photo.id)
                  open(
                    e,
                    photoMenuItems(item.photo, {
                      collections,
                      collectionId: source.kind === 'collection' ? source.id : undefined,
                    }),
                  )
                }}
              />
            </div>
          ))}
        </div>
      </Scroller>
      <GridStatus count={photos.length} selected={selected.length} at={top} />
      {menu}
    </div>
  )
}

/**
 * The photo count, on the same terms as the scrollbar it sits beside.
 *
 * A pill parked permanently over the bottom row would put chrome on top of the
 * one thing this view exists to show. It surfaces while the field is moving or
 * the selection changes, then withdraws — except while a multiple selection is
 * live, which is a state worth keeping in sight.
 */
function GridStatus({ count, selected, at }: { count: number; selected: number; at: number }) {
  const [visible, setVisible] = useState(false)
  const pinned = selected > 1

  useEffect(() => {
    setVisible(true)
    const timer = setTimeout(() => setVisible(false), 1400)
    return () => clearTimeout(timer)
  }, [at, count, selected])

  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-x-0 bottom-3 flex justify-center',
        'text-micro tnum text-label-secondary',
        'transition-opacity duration-[--duration-slow] ease-[--ease-out]',
        visible || pinned ? 'opacity-100' : 'opacity-0',
      )}
    >
      <span className="material rounded-full px-2.5 py-1 shadow-hud">
        {count.toLocaleString()} photo{count === 1 ? '' : 's'}
        {pinned && ` · ${selected.toLocaleString()} selected`}
      </span>
    </div>
  )
}
