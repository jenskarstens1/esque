import { memo } from 'react'
import { cn } from '../../lib/cn'
import { useThumbUrl } from '../../catalog/hooks'
import { setFlag, setRating } from '../../catalog/actions'
import { FlagIcon, PencilIcon, RejectIcon, StackIcon, StarIcon, WarningIcon } from '../../design/icons'
import { ThumbImage } from './ThumbImage'
import type { Photo } from '../../core/types'

const LABEL_COLOR: Record<string, string> = {
  red: 'var(--color-label-red)',
  yellow: 'var(--color-label-yellow)',
  green: 'var(--color-label-green)',
  blue: 'var(--color-label-blue)',
  purple: 'var(--color-label-purple)',
}

/** Below this the caption stops fitting and the marks have to carry the cell. */
const DENSE = 132

/** Radius grows with the tile so a 96px cell isn't a lozenge and a 360px one isn't a slab. */
const radiusFor = (w: number) => Math.round(Math.max(4, Math.min(10, w * 0.05)))

/**
 * One photo in the grid.
 *
 * The cell is the picture: no plate around it, no row reserved under it. Every
 * mark a photo carries — its flag, its stars, its colour label, whether it has
 * been edited — rides on a scrim at the foot of the image, which is also where
 * the controls for setting them live. A photo with nothing on it shows nothing
 * until the pointer arrives, so an unculled shoot is a clean wall of images
 * and a culled one wears its verdicts on its face.
 */
export const Thumbnail = memo(function Thumbnail({
  photo,
  width,
  height,
  selected,
  primary,
  showExtras,
  onSelect,
  onOpen,
  onContextMenu,
}: {
  photo: Photo
  width: number
  height: number
  selected: boolean
  primary: boolean
  showExtras: boolean
  onSelect: (e: React.MouseEvent) => void
  onOpen?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
}) {
  const url = useThumbUrl(photo)
  const rejected = photo.flag === 'reject'
  const dense = width < DENSE || height < 96
  const caption = showExtras && !dense
  // The fade is a share of the picture, not a fixed band: 32px over a tall
  // portrait is a footnote, over a letterbox pano it is half the photograph.
  const scrim = Math.round(Math.max(12, Math.min(34, height * 0.3)))

  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={photo.filename}
      tabIndex={-1}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      style={{ width, height, borderRadius: radiusFor(width) }}
      className="group/th relative isolate overflow-hidden bg-raised/35"
    >
      {photo.readError ? (
        <div className="absolute inset-0 grid place-items-center bg-white/[0.03] text-icon-quaternary">
          <WarningIcon size={Math.min(20, Math.max(12, width * 0.11))} />
        </div>
      ) : (
        <ThumbImage photo={photo} url={url} dim={rejected} />
      )}

      {/* Marks and controls. Extras off means off — approach still reaches them. */}
      <div
        style={{ paddingTop: scrim }}
        className={cn(
          'absolute inset-x-0 bottom-0 flex flex-col justify-end',
          'bg-gradient-to-t from-black/85 via-black/40 to-transparent',
          'transition-opacity duration-[--duration-fast] ease-[--ease-out]',
          dense ? 'gap-0 px-1 pb-1' : 'gap-px px-2 pb-1.5',
          showExtras ? 'opacity-100' : 'esq-reveal opacity-0 group-hover/th:opacity-100',
        )}
      >
        {caption && (
          <div className="truncate text-mini text-white/85 [text-shadow:0_1px_2px_rgb(0_0_0/0.6)]">
            {photo.filename}
          </div>
        )}

        <div className="flex items-center gap-1">
          <button
            type="button"
            title={photo.flag === 'pick' ? 'Picked  (U to clear)' : 'Flag as pick  (P)'}
            onClick={(e) => {
              e.stopPropagation()
              setFlag(photo.id, photo.flag === 'pick' ? 'unflagged' : 'pick')
            }}
            className={cn(
              'esq-tap shrink-0 transition-[opacity,color] duration-[--duration-fast]',
              photo.flag === 'unflagged'
                ? 'esq-reveal text-white/45 opacity-0 group-hover/th:opacity-100 hover:text-white'
                : 'text-white opacity-100',
            )}
          >
            {rejected ? (
              <RejectIcon size={dense ? 10 : 12} />
            ) : (
              <FlagIcon size={dense ? 10 : 12} filled={photo.flag === 'pick'} />
            )}
          </button>

          <Stars photoId={photo.id} rating={photo.rating} size={dense ? 8 : 10} />

          <span className="min-w-0 flex-1" />

          {photo.edits && (
            <span title="Edited" className="shrink-0 text-white/70">
              <PencilIcon size={dense ? 9 : 10} />
            </span>
          )}
          {photo.label !== 'none' && (
            <span
              title={photo.label}
              className={cn('shrink-0 rounded-full ring-1 ring-black/35', dense ? 'size-1.5' : 'size-2')}
              style={{ background: LABEL_COLOR[photo.label] }}
            />
          )}
        </div>
      </div>

      {/* File-level facts, out of the way of the marks. A read error is not an
          extra — it stays visible however the badges are set. */}
      {((showExtras && (photo.stackId || photo.masterId)) || photo.readError) && (
        <div className="absolute top-1.5 left-1.5 flex items-center gap-1">
          {showExtras && photo.stackId && (
            <span
              title="Stacked"
              className="grid size-4 place-items-center rounded-full bg-black/55 text-white/85 backdrop-blur-sm"
            >
              <StackIcon size={9} />
            </span>
          )}
          {showExtras && photo.masterId && (
            <span
              title="Virtual copy"
              className="rounded-full bg-black/55 px-1 text-micro leading-4 text-white/85 backdrop-blur-sm"
            >
              VC
            </span>
          )}
          {photo.readError && (
            <span
              title={photo.readError}
              className="grid size-4 place-items-center rounded-full bg-black/55 text-orange backdrop-blur-sm"
            >
              <WarningIcon size={9} />
            </span>
          )}
        </div>
      )}

      {/*
       * Selection sits on the picture's own edge. An inset ring on the parent
       * would paint under the image; this layer is the only way it reads as a
       * frame around the photo rather than a border behind it.
       */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0 rounded-[inherit]',
          'transition-shadow duration-[--duration-fast] ease-[--ease-out]',
          primary
            ? 'shadow-[inset_0_0_0_2px_var(--color-accent)]'
            : selected
              ? 'shadow-[inset_0_0_0_2px_color-mix(in_srgb,var(--color-accent)_55%,transparent)]'
              : 'shadow-[inset_0_0_0_0.5px_rgb(255_255_255/0.1)] group-hover/th:shadow-[inset_0_0_0_1.5px_rgb(255_255_255/0.35)]',
        )}
      />
    </div>
  )
})

function Stars({ photoId, rating, size }: { photoId: string; rating: number; size: number }) {
  return (
    <div className="flex shrink-0 items-center gap-px">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          title={`${n} star${n > 1 ? 's' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            // Clicking the current rating clears it, like Lightroom.
            setRating(photoId, rating === n ? 0 : n)
          }}
          className={cn(
            'esq-tap transition-[opacity,color] duration-[--duration-fast]',
            n <= rating
              ? 'text-white opacity-100'
              : 'esq-reveal text-white/45 opacity-0 group-hover/th:opacity-100 hover:text-white',
          )}
        >
          <StarIcon size={size} filled={n <= rating} />
        </button>
      ))}
    </div>
  )
}
