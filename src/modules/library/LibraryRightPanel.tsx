import { useMemo, useState } from 'react'
import { cn } from '../../lib/cn'
import { PanelSection } from '../../design/Panel'
import { Scroller } from '../../design/Scroller'
import { Histogram } from './Histogram'
import { useCatalog } from '../../state/catalog'
import { usePhoto, usePreviewUrl, useSelectedPhotos, useThumbUrl } from '../../catalog/hooks'
import { addKeywords, removeKeyword, setLabel, setRating } from '../../catalog/actions'
import {
  formatAperture,
  formatBytes,
  formatDimensions,
  formatFocal,
  formatShutter,
} from '../../lib/math'
import { CloseIcon, StarIcon } from '../../design/icons'
import { LocationMap } from './LocationMap'
import type { ColorLabel, Photo } from '../../core/types'

const LABELS: { value: ColorLabel; color: string; name: string }[] = [
  { value: 'red', color: 'var(--color-label-red)', name: 'Red' },
  { value: 'yellow', color: 'var(--color-label-yellow)', name: 'Yellow' },
  { value: 'green', color: 'var(--color-label-green)', name: 'Green' },
  { value: 'blue', color: 'var(--color-label-blue)', name: 'Blue' },
  { value: 'purple', color: 'var(--color-label-purple)', name: 'Purple' },
]

export function LibraryRightPanel() {
  const primaryId = useCatalog((s) => s.primaryId)
  const photo = usePhoto(primaryId)
  const selected = useSelectedPhotos()
  const preview = usePreviewUrl(photo)
  const thumb = useThumbUrl(photo)

  return (
    <Scroller frameClassName="h-full" className="flex flex-col pb-6">
      <Histogram url={preview ?? thumb} hasPhoto={!!photo} />
      <CaptureLine photo={photo} />

      <PanelSection title="Quick Actions" defaultOpen>
        <div className="flex flex-col gap-2 px-3 pt-1 pb-3">
          <RatingRow photo={photo} targets={selected.map((p) => p.id)} />
          <LabelRow photo={photo} targets={selected.map((p) => p.id)} />
        </div>
      </PanelSection>

      <PanelSection title="Keywording" defaultOpen={false}>
        <Keywording photos={selected.length ? selected : photo ? [photo] : []} />
      </PanelSection>

      <PanelSection title="Metadata" defaultOpen>
        <Metadata photo={photo} count={selected.length} />
      </PanelSection>
    </Scroller>
  )
}

function CaptureLine({ photo }: { photo?: Photo }) {
  if (!photo) return <div className="h-4" />
  const m = photo.meta
  return (
    <div className="flex items-baseline justify-between gap-2 px-3 pb-2 text-mini tnum text-label-secondary">
      <span className="truncate">{m.cameraModel || photo.ext.toUpperCase()}</span>
      <span className="shrink-0 whitespace-nowrap text-label-tertiary">
        {[
          m.focalLength ? formatFocal(m.focalLength) : null,
          m.aperture ? formatAperture(m.aperture) : null,
          m.shutter ? formatShutter(m.shutter) : null,
          m.iso ? `ISO ${m.iso}` : null,
        ]
          .filter(Boolean)
          .join('  ')}
      </span>
    </div>
  )
}

function RatingRow({ photo, targets }: { photo?: Photo; targets: string[] }) {
  const rating = photo?.rating ?? 0
  const ids = targets.length ? targets : photo ? [photo.id] : []
  return (
    <Field label="Rating">
      <div className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            disabled={!ids.length}
            onClick={() => setRating(ids, rating === n ? 0 : n)}
            className={cn(
              'transition-colors duration-[--duration-fast] disabled:opacity-30',
              n <= rating ? 'text-icon' : 'text-icon-quaternary hover:text-icon-tertiary',
            )}
          >
            <StarIcon size={12} filled={n <= rating} />
          </button>
        ))}
      </div>
    </Field>
  )
}

function LabelRow({ photo, targets }: { photo?: Photo; targets: string[] }) {
  const current = photo?.label ?? 'none'
  const ids = targets.length ? targets : photo ? [photo.id] : []
  return (
    <Field label="Label">
      <div className="flex items-center gap-1.5">
        {LABELS.map((l) => (
          <button
            key={l.value}
            type="button"
            title={l.name}
            disabled={!ids.length}
            onClick={() => setLabel(ids, current === l.value ? 'none' : l.value)}
            style={{ background: l.color }}
            className={cn(
              'size-3 rounded-[3px] transition-[transform,box-shadow] duration-[--duration-fast] ease-[--ease-out]',
              'disabled:opacity-30',
              current === l.value
                ? 'scale-110 shadow-[0_0_0_1.5px_var(--color-panel),0_0_0_2.5px_currentColor]'
                : 'opacity-45 hover:opacity-100',
            )}
          />
        ))}
      </div>
    </Field>
  )
}

function Keywording({ photos }: { photos: Photo[] }) {
  const [draft, setDraft] = useState('')
  const shared = useMemo(() => {
    if (!photos.length) return []
    return photos
      .reduce<string[]>(
        (acc, p) => acc.filter((k) => p.keywords.includes(k)),
        [...photos[0].keywords],
      )
      .sort()
  }, [photos])

  const ids = photos.map((p) => p.id)

  function commit() {
    const words = draft
      .split(',')
      .map((w) => w.trim())
      .filter(Boolean)
    if (words.length && ids.length) addKeywords(ids, words)
    setDraft('')
  }

  return (
    <div className="flex flex-col gap-2 px-3 pt-1 pb-3">
      <div className="flex flex-wrap gap-1">
        {shared.map((k) => (
          <span
            key={k}
            className="group/kw flex h-[19px] items-center gap-1 rounded-sm bg-raised pr-1 pl-1.5 text-mini text-label-secondary"
          >
            {k}
            <button
              type="button"
              onClick={() => removeKeyword(ids, k)}
              className="text-icon-quaternary transition-colors hover:text-red"
            >
              <CloseIcon size={9} />
            </button>
          </span>
        ))}
        {!shared.length && (
          <span className="text-mini text-label-quaternary">No shared keywords</span>
        )}
      </div>
      <input
        value={draft}
        disabled={!ids.length}
        placeholder="Add keywords, comma separated"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          e.stopPropagation()
        }}
        data-size="sm"
        className="esq-field w-full"
      />
    </div>
  )
}

function Metadata({ photo, count }: { photo?: Photo; count: number }) {
  if (!photo) {
    return <div className="px-3 pb-3 text-mini text-label-quaternary">Nothing selected</div>
  }
  const m = photo.meta
  const date = m.captureTime
    ? new Date(m.captureTime).toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—'

  const rows: [string, string][] = [
    ['File', count > 1 ? `${count} photos selected` : photo.filename],
    ['Type', `${photo.ext.toUpperCase()}${photo.isRaw ? ' · RAW' : ''}`],
    ['Size', formatBytes(photo.fileSize)],
    ['Dimensions', formatDimensions(photo.width, photo.height)],
    ['Captured', date],
    ['Camera', [m.cameraMake, m.cameraModel].filter(Boolean).join(' ') || '—'],
    ['Lens', m.lens || '—'],
    ['Focal length', m.focalLength ? formatFocal(m.focalLength) : '—'],
    ['Aperture', m.aperture ? formatAperture(m.aperture) : '—'],
    ['Shutter', m.shutter ? formatShutter(m.shutter) : '—'],
    ['ISO', m.iso ? String(m.iso) : '—'],
    ['Artist', m.artist || '—'],
  ]

  return (
    <div className="flex flex-col gap-2.5 px-3 pt-1 pb-3">
      <dl className="flex flex-col gap-1">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline gap-2">
            <dt className="w-[86px] shrink-0 text-mini text-label-tertiary">{k}</dt>
            <dd className="min-w-0 flex-1 truncate text-mini tnum text-label-secondary" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <Location gps={m.gps} />
    </div>
  )
}

/** The GPS block. Absent coordinates get a line, not a hole in the panel. */
function Location({ gps }: { gps: Photo['meta']['gps'] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-mini text-label-tertiary">Location</div>
      {gps ? (
        <LocationMap gps={gps} />
      ) : (
        <span className="text-mini text-label-quaternary">No GPS data</span>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[86px] shrink-0 text-mini text-label-tertiary">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
