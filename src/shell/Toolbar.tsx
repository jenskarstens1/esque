import { cn } from '../lib/cn'
import { Slider } from '../design/Slider'
import { SegmentedControl, Select } from '../design/Controls'
import {
  FlagIcon,
  GridIcon,
  LoupeIcon,
  RejectIcon,
  SortAscIcon,
  SortDescIcon,
  StarIcon,
  TileFillIcon,
  WaterfallIcon,
} from '../design/icons'
import { photosHdr, useUI, type GridLayout, type ViewMode } from '../state/ui'
import { useCatalog, type SortKey } from '../state/catalog'
import { setFlag, setRating } from '../catalog/actions'
import { usePhoto, usePhotoSelection } from '../catalog/hooks'
import type { PickFlag } from '../core/types'
import { hdrReach } from '../core/hdr'
import { photoIsHdr } from '../core/hdrContent'
import { useDisplayHdr } from '../lib/useDisplayHdr'
import { useIsCompact } from '../lib/useViewport'
import { CompareControl } from './CompareControl'

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'capture', label: 'Capture Time' },
  { value: 'filename', label: 'File Name' },
  { value: 'rating', label: 'Rating' },
  { value: 'added', label: 'Added Order' },
  { value: 'modified', label: 'Edit Date' },
  { value: 'iso', label: 'ISO' },
]

export function Toolbar() {
  const module = useUI((s) => s.module)
  const viewMode = useUI((s) => s.viewMode)
  const setViewMode = useUI((s) => s.setViewMode)
  const thumbSize = useUI((s) => s.thumbSize)
  const setThumbSize = useUI((s) => s.setThumbSize)
  const gridLayout = useUI((s) => s.gridLayout)
  const setGridLayout = useUI((s) => s.setGridLayout)

  /*
   * The toolbar carries four clusters and a filename, which needs ~700px to lay
   * out. Below the desktop break the two that are duplicated elsewhere step
   * aside: the sort control lives in the Library's filter row, and the thumbnail
   * size slider is a refinement rather than a way in. What is left — view mode,
   * flags and stars — is the culling loop, which is the reason to have a toolbar
   * on a tablet at all.
   */
  const roomy = !useIsCompact()

  const sortKey = useCatalog((s) => s.sortKey)
  const sortAsc = useCatalog((s) => s.sortAsc)
  const setSort = useCatalog((s) => s.setSort)
  const primaryId = useCatalog((s) => s.primaryId)
  const photo = usePhoto(primaryId)
  const selection = usePhotoSelection()

  // Extended range is only offered over a photo that has any: a gain-map JPEG,
  // a PQ/HLG file, or a RAW. Over an ordinary sRGB frame the toggle would
  // change nothing on screen, so it isn't there to be pressed.
  const hdrContent = !!photo && photoIsHdr(photo)

  const viewOptions: { value: ViewMode; label: React.ReactNode; title: string }[] = [
    { value: 'grid', label: <GridIcon size={13} />, title: 'Grid  (G)' },
    { value: 'loupe', label: <LoupeIcon size={13} />, title: 'Loupe  (E)' },
  ]

  const layoutOptions: { value: GridLayout; label: React.ReactNode; title: string }[] = [
    {
      value: 'fill',
      label: <TileFillIcon size={13} />,
      title: 'Fill: even tiles, photos cropped to fit',
    },
    {
      value: 'waterfall',
      label: <WaterfallIcon size={13} />,
      title: 'Waterfall: every frame at its own proportions',
    },
  ]

  const gridControls = module === 'library' && viewMode === 'grid'

  return (
    <div data-photo-toolbar className="hairline-t esq-safe-px-3 esq-safe-b flex h-10 shrink-0 items-center gap-3 bg-panel">
      {module === 'library' && (
        <SegmentedControl
          size="sm"
          options={viewOptions}
          value={viewMode}
          onChange={setViewMode}
        />
      )}

      {module === 'develop' && <CompareControl />}

      <div className="flex shrink-0 items-center gap-2">
        <FlagCluster
          disabled={!selection.ready}
          flag={selection.values.flag}
          onSet={(f) => setFlag(selection.ids, f)}
        />
        <span className="h-3.5 w-px bg-hairline" />
        <RatingCluster
          disabled={!selection.ready}
          rating={selection.values.rating}
          onSet={(r) => setRating(selection.ids, r)}
        />
      </div>

      <div className="min-w-0 flex-1 truncate text-center text-mini text-label-tertiary">
        {photo?.filename}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {hdrContent && (
          <>
            <HdrToggle ids={selection.ids} />
            {roomy && <span className="h-3.5 w-px bg-hairline" />}
          </>
        )}
        {roomy && (
          <>
            <button
              type="button"
              title={sortAsc ? 'Ascending' : 'Descending'}
              onClick={() => setSort(sortKey, !sortAsc)}
              className="esq-tap text-icon-tertiary transition-colors hover:text-icon"
            >
              {sortAsc ? <SortAscIcon size={12} /> : <SortDescIcon size={12} />}
            </button>
            <Select
              size="sm"
              value={sortKey}
              options={SORT_OPTIONS}
              onChange={(v) => setSort(v, sortAsc)}
              className="w-[116px]"
            />
          </>
        )}
        {gridControls && (
          <>
            <SegmentedControl
              size="sm"
              options={layoutOptions}
              value={gridLayout}
              onChange={setGridLayout}
            />
            {roomy && (
              <Slider
                value={thumbSize}
                min={96}
                max={360}
                step={4}
                origin={96}
                size="S"
                onChange={setThumbSize}
                aria-label="Thumbnail size"
                className="w-[92px]"
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}

function FlagCluster({
  flag,
  disabled,
  onSet,
}: {
  flag: PickFlag | null
  disabled: boolean
  onSet: (f: 'pick' | 'unflagged' | 'reject') => void
}) {
  return (
    <div
      role="group"
      aria-label={flag === null ? 'Flag: mixed values' : 'Flag'}
      className="flex items-center gap-1"
    >
      <ToolbarToggle
        title="Pick  (P)"
        active={flag === 'pick'}
        disabled={disabled}
        onClick={() => onSet(flag === 'pick' ? 'unflagged' : 'pick')}
      >
        <FlagIcon size={12} filled={flag === 'pick'} />
      </ToolbarToggle>
      <ToolbarToggle
        title="Reject  (X)"
        active={flag === 'reject'}
        disabled={disabled}
        onClick={() => onSet(flag === 'reject' ? 'unflagged' : 'reject')}
      >
        <RejectIcon size={12} />
      </ToolbarToggle>
      {flag === null && (
        <span aria-hidden title="Mixed flags" className="text-micro text-label-secondary">—</span>
      )}
    </div>
  )
}

function RatingCluster({
  rating,
  disabled,
  onSet,
}: {
  rating: number | null
  disabled: boolean
  onSet: (r: number) => void
}) {
  return (
    <div
      role="group"
      aria-label={rating === null ? 'Rating: mixed values' : 'Rating'}
      className="flex items-center gap-0.5"
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          title={`${n} star${n === 1 ? '' : 's'}`}
          aria-label={`${n} star${n === 1 ? '' : 's'}`}
          aria-pressed={rating === n}
          disabled={disabled}
          onClick={() => onSet(rating === n ? 0 : n)}
          className={cn(
            'esq-tap p-0.5 transition-colors duration-[--duration-fast] disabled:opacity-25',
            rating !== null && n <= rating ? 'text-icon' : 'text-icon-quaternary hover:text-icon-tertiary',
          )}
        >
          <StarIcon size={11} filled={rating !== null && n <= rating} />
        </button>
      ))}
      {rating === null && (
        <span aria-hidden className="ml-1 text-micro text-label-secondary">Mixed</span>
      )}
    </div>
  )
}

function ToolbarToggle({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active: boolean
  disabled: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'esq-tap grid size-[22px] place-items-center rounded-[5px]',
        'transition-[background-color,color] duration-[--duration-fast] ease-[--ease-out]',
        'disabled:pointer-events-none disabled:opacity-25',
        active ? 'bg-control text-icon' : 'text-icon-tertiary hover:bg-raised hover:text-icon',
      )}
    >
      {children}
    </button>
  )
}

/**
 * Extended-range viewing, on or off.
/**
 * Extended range for the photo on screen.
 *
 * Set in letters rather than a glyph because there is no icon for a range: the
 * label is the only honest way to say which of the two states this picture is
 * currently in. It lights up only when the display really has headroom, so the
 * button never claims an effect it isn't having.
 */
function HdrToggle({ ids }: { ids: string[] }) {
  const hdr = useUI(photosHdr(ids))
  const togglePhotoHdr = useUI((s) => s.togglePhotoHdr)
  const module = useUI((s) => s.module)
  const displayHdr = useDisplayHdr()
  const reach = hdrReach()

  const scope = ids.length > 1 ? ` (${ids.length} photos)` : ''
  const title =
    reach === 'none'
      ? 'HDR viewing is not available in this browser'
      : !displayHdr
        ? `HDR Preview: this display reports no range above white  (H)${scope}`
        : reach === 'images'
          ? `HDR Preview: photos only; this browser shows the editor viewport in SDR  (H)${scope}`
          : `HDR Preview  (H)${scope}`

  // Half a toggle is still worth having in the Library, where the photos are
  // the whole view. In Develop it would light nothing up, so it says so.
  const partial = reach === 'images' && module === 'develop'

  return (
    <button
      type="button"
      title={title}
      disabled={reach === 'none'}
      aria-pressed={hdr}
      onClick={() => togglePhotoHdr(ids)}
      className={cn(
        'esq-tap h-[22px] rounded-[5px] px-1.5 text-micro font-medium tracking-[0.06em]',
        'transition-[background-color,color] duration-[--duration-fast] ease-[--ease-out]',
        'disabled:pointer-events-none disabled:opacity-25',
        !hdr && 'text-label-tertiary hover:bg-raised hover:text-label',
        hdr && (!displayHdr || partial) && 'bg-control text-label',
        hdr && displayHdr && !partial && 'bg-accent-soft text-accent',
      )}
    >
      HDR
    </button>
  )
}