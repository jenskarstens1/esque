import { cn } from '../lib/cn'
import { Slider } from '../design/Slider'
import { SegmentedControl, Select } from '../design/Controls'
import {
  CompareIcon,
  FlagIcon,
  GridIcon,
  LoupeIcon,
  RejectIcon,
  SortAscIcon,
  SortDescIcon,
  StarIcon,
  SurveyIcon,
  TileFillIcon,
  WaterfallIcon,
} from '../design/icons'
import { useUI, type GridLayout, type ViewMode } from '../state/ui'
import { useCatalog, type SortKey } from '../state/catalog'
import { setFlag, setRating } from '../catalog/actions'
import { usePhoto } from '../catalog/hooks'
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
  const selected = useCatalog((s) => s.selected)
  const primaryId = useCatalog((s) => s.primaryId)
  const photo = usePhoto(primaryId)

  const targets = selected.length ? selected : primaryId ? [primaryId] : []

  // Extended range is only offered over a photo that has any: a gain-map JPEG,
  // a PQ/HLG file, or a RAW. Over an ordinary sRGB frame the toggle would
  // change nothing on screen, so it isn't there to be pressed.
  const hdrContent = !!photo && photoIsHdr(photo)

  const viewOptions: { value: ViewMode; label: React.ReactNode; title: string }[] = [
    { value: 'grid', label: <GridIcon size={13} />, title: 'Grid  (G)' },
    { value: 'loupe', label: <LoupeIcon size={13} />, title: 'Loupe  (E)' },
    { value: 'compare', label: <CompareIcon size={13} />, title: 'Compare  (C)' },
    { value: 'survey', label: <SurveyIcon size={13} />, title: 'Survey  (N)' },
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
    <div className="hairline-t esq-safe-px-3 esq-safe-b flex h-10 shrink-0 items-center gap-3 bg-panel">
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
          disabled={!targets.length}
          flag={photo?.flag ?? 'unflagged'}
          onSet={(f) => setFlag(targets, f)}
        />
        <span className="h-3.5 w-px bg-hairline" />
        <RatingCluster
          disabled={!targets.length}
          rating={photo?.rating ?? 0}
          onSet={(r) => setRating(targets, r)}
        />
      </div>

      <div className="min-w-0 flex-1 truncate text-center text-mini text-label-tertiary">
        {photo?.filename}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {hdrContent && (
          <>
            <HdrToggle />
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
              <div className="flex w-[110px] items-center gap-2">
                <span className="text-micro text-label-quaternary">Size</span>
                <Slider
                  value={thumbSize}
                  min={96}
                  max={360}
                  step={4}
                  origin={96}
                  size="S"
                  onChange={setThumbSize}
                  aria-label="Thumbnail size"
                />
              </div>
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
  flag: string
  disabled: boolean
  onSet: (f: 'pick' | 'unflagged' | 'reject') => void
}) {
  return (
    <div className="flex items-center gap-1">
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
    </div>
  )
}

function RatingCluster({
  rating,
  disabled,
  onSet,
}: {
  rating: number
  disabled: boolean
  onSet: (r: number) => void
}) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          title={`${n}`}
          disabled={disabled}
          onClick={() => onSet(rating === n ? 0 : n)}
          className={cn(
            'esq-tap p-0.5 transition-colors duration-[--duration-fast] disabled:opacity-25',
            n <= rating ? 'text-icon' : 'text-icon-quaternary hover:text-icon-tertiary',
          )}
        >
          <StarIcon size={11} filled={n <= rating} />
        </button>
      ))}
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
 *
 * Set in letters rather than a glyph because HDR is a mode the whole app enters,
 * not a tool: the label is the only honest way to say which of the two states
 * the pictures on screen are currently in. It lights up only when the display
 * really has headroom, so the button never claims an effect it isn't having.
 */
function HdrToggle() {
  const hdr = useUI((s) => s.hdr)
  const toggleHdr = useUI((s) => s.toggleHdr)
  const module = useUI((s) => s.module)
  const displayHdr = useDisplayHdr()
  const reach = hdrReach()

  const title =
    reach === 'none'
      ? 'HDR viewing is not available in this browser'
      : !displayHdr
        ? 'HDR Preview: this display reports no range above white  (H)'
        : reach === 'images'
          ? 'HDR Preview: photos only; this browser shows the editor viewport in SDR  (H)'
          : 'HDR Preview  (H)'

  // Half a toggle is still worth having in the Library, where the photos are
  // the whole view. In Develop it would light nothing up, so it says so.
  const partial = reach === 'images' && module === 'develop'

  return (
    <button
      type="button"
      title={title}
      disabled={reach === 'none'}
      aria-pressed={hdr}
      onClick={toggleHdr}
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