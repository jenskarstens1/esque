import { useMemo } from 'react'
import { cn } from '../../lib/cn'
import { TextField } from '../../design/Controls'
import { useMenu } from '../../design/useMenu'
import type { MenuItem } from '../../design/Menu'
import {
  ChevronDownIcon,
  CloseIcon,
  FlagIcon,
  RejectIcon,
  SearchIcon,
  StarIcon,
} from '../../design/icons'
import { useSourcePhotos } from '../../catalog/hooks'
import { filtersActive, useCatalog, type Filters } from '../../state/catalog'
import type { ColorLabel, Photo, PickFlag } from '../../core/types'

/**
 * The Library's filter row.
 *
 * Everything here writes into `Filters`, which the photo query already applies;
 * this is the surface for it. Attributes read left to right the way a sentence
 * about a selection does — what it is, how it's marked, how good it is — and
 * every control is a toggle, so a second click on the thing you just chose puts
 * it back rather than making you find a "clear" for it.
 */

const LABEL_SWATCHES: { value: ColorLabel; color: string; name: string }[] = [
  { value: 'red', color: 'var(--color-label-red)', name: 'Red' },
  { value: 'yellow', color: 'var(--color-label-yellow)', name: 'Yellow' },
  { value: 'green', color: 'var(--color-label-green)', name: 'Green' },
  { value: 'blue', color: 'var(--color-label-blue)', name: 'Blue' },
  { value: 'purple', color: 'var(--color-label-purple)', name: 'Purple' },
  { value: 'none', color: 'transparent', name: 'No label' },
]

const RATING_OPS: Record<Filters['ratingOp'], string> = {
  gte: '≥',
  eq: '=',
  lte: '≤',
}

export function FilterBar() {
  const filters = useCatalog((s) => s.filters)
  const setFilters = useCatalog((s) => s.setFilters)
  const clearFilters = useCatalog((s) => s.clearFilters)
  const photos = useSourcePhotos()
  const { menu, openAt } = useMenu()

  const active = filtersActive(filters)

  // Facet lists come from the unfiltered source, so choosing a camera never
  // empties the menu you chose it from.
  const cameras = useFacet(photos, (p) => p.meta.cameraModel)
  const lenses = useFacet(photos, (p) => p.meta.lens)
  const keywords = useFacet(photos, (p) => p.keywords)

  const toggleIn = <T extends string>(list: T[], v: T): T[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v]

  const facetMenu = (
    e: React.MouseEvent,
    entries: Facet[],
    chosen: string[],
    onChange: (next: string[]) => void,
  ) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const items: MenuItem[] = entries.length
      ? entries.map((f) => ({
          label: `${f.value}   ${f.count.toLocaleString()}`,
          checked: chosen.includes(f.value),
          onSelect: () => onChange(toggleIn(chosen, f.value)),
        }))
      : [{ label: 'Nothing recorded', disabled: true }]
    openAt(rect.left, rect.bottom + 4, [
      ...(chosen.length
        ? [
            { label: 'Any', onSelect: () => onChange([]) } as MenuItem,
            { kind: 'separator' } as MenuItem,
          ]
        : []),
      ...items,
    ])
  }

  return (
    <div className="hairline-b flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 bg-panel px-3 py-1">
      {/* Text */}
      <div className="relative flex min-w-[132px] flex-1 items-center">
        <span className="pointer-events-none absolute left-2 text-icon-quaternary">
          <SearchIcon size={11} />
        </span>
        <TextField
          size="sm"
          value={filters.text}
          onChange={(text) => setFilters({ text })}
          placeholder="Search filenames, keywords, gear"
          aria-label="Search photos"
          className="w-full pl-[26px]"
        />
      </div>

      <Divider />

      {/* Flags */}
      <Cluster label="Flag">
        <Chip
          title="Picked"
          active={filters.flags.includes('pick')}
          onClick={() => setFilters({ flags: toggleIn(filters.flags, 'pick' as PickFlag) })}
        >
          <FlagIcon size={11} filled={filters.flags.includes('pick')} />
        </Chip>
        <Chip
          title="Unflagged"
          active={filters.flags.includes('unflagged')}
          onClick={() => setFilters({ flags: toggleIn(filters.flags, 'unflagged' as PickFlag) })}
        >
          <FlagIcon size={11} />
        </Chip>
        <Chip
          title="Rejected"
          active={filters.flags.includes('reject')}
          onClick={() => setFilters({ flags: toggleIn(filters.flags, 'reject' as PickFlag) })}
        >
          <RejectIcon size={11} />
        </Chip>
      </Cluster>

      <Divider />

      {/* Rating */}
      <Cluster label="Rating">
        <button
          type="button"
          title="Rating comparison"
          onClick={() =>
            setFilters({
              ratingOp:
                filters.ratingOp === 'gte' ? 'eq' : filters.ratingOp === 'eq' ? 'lte' : 'gte',
            })
          }
          className="w-3.5 text-center text-mini text-label-tertiary transition-colors hover:text-label"
        >
          {RATING_OPS[filters.ratingOp]}
        </button>
        <div className="flex items-center gap-0.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              title={`${RATING_OPS[filters.ratingOp]} ${n}`}
              onClick={() => setFilters({ rating: filters.rating === n ? 0 : n })}
              className={cn(
                'p-px transition-colors duration-[--duration-fast]',
                n <= filters.rating
                  ? 'text-icon'
                  : 'text-icon-quaternary hover:text-icon-tertiary',
              )}
            >
              <StarIcon size={11} filled={n <= filters.rating} />
            </button>
          ))}
        </div>
      </Cluster>

      <Divider />

      {/* Colour labels */}
      <Cluster label="Label">
        {LABEL_SWATCHES.map((l) => {
          const on = filters.labels.includes(l.value)
          return (
            <button
              key={l.value}
              type="button"
              title={l.name}
              onClick={() => setFilters({ labels: toggleIn(filters.labels, l.value) })}
              style={l.value === 'none' ? undefined : { background: l.color }}
              className={cn(
                'size-[11px] rounded-[3px]',
                'transition-[transform,box-shadow,opacity] duration-[--duration-fast] ease-[--ease-out]',
                l.value === 'none' &&
                  'shadow-[inset_0_0_0_1px_var(--color-icon-quaternary)] hover:shadow-[inset_0_0_0_1px_var(--color-icon-tertiary)]',
                on
                  ? 'scale-110 shadow-[0_0_0_1.5px_var(--color-panel),0_0_0_2.5px_currentColor]'
                  : 'opacity-45 hover:opacity-100',
              )}
            />
          )
        })}
      </Cluster>

      <Divider />

      {/* Facets */}
      <Cluster>
        <Dropdown
          label="Camera"
          chosen={filters.cameras}
          onClick={(e) => facetMenu(e, cameras, filters.cameras, (cameras) => setFilters({ cameras }))}
        />
        <Dropdown
          label="Lens"
          chosen={filters.lenses}
          onClick={(e) => facetMenu(e, lenses, filters.lenses, (lenses) => setFilters({ lenses }))}
        />
        <Dropdown
          label="Keyword"
          chosen={filters.keywords}
          onClick={(e) =>
            facetMenu(e, keywords, filters.keywords, (keywords) => setFilters({ keywords }))
          }
        />
        <Dropdown
          label="File"
          chosen={filters.fileType === 'all' ? [] : [filters.fileType === 'raw' ? 'RAW' : 'Rendered']}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            openAt(rect.left, rect.bottom + 4, [
              {
                label: 'Any file type',
                checked: filters.fileType === 'all',
                onSelect: () => setFilters({ fileType: 'all' }),
              },
              {
                label: 'RAW only',
                checked: filters.fileType === 'raw',
                onSelect: () => setFilters({ fileType: 'raw' }),
              },
              {
                label: 'JPEG and friends',
                checked: filters.fileType === 'rendered',
                onSelect: () => setFilters({ fileType: 'rendered' }),
              },
              { kind: 'separator' },
              {
                label: 'Any edit state',
                checked: filters.edited === 'all',
                onSelect: () => setFilters({ edited: 'all' }),
              },
              {
                label: 'Edited',
                checked: filters.edited === 'edited',
                onSelect: () => setFilters({ edited: 'edited' }),
              },
              {
                label: 'Untouched',
                checked: filters.edited === 'unedited',
                onSelect: () => setFilters({ edited: 'unedited' }),
              },
            ])
          }}
        />
        {filters.edited !== 'all' && (
          <Pill onClear={() => setFilters({ edited: 'all' })}>
            {filters.edited === 'edited' ? 'Edited' : 'Untouched'}
          </Pill>
        )}
      </Cluster>

      <button
        type="button"
        onClick={clearFilters}
        disabled={!active}
        className={cn(
          'ml-auto shrink-0 rounded-sm px-1.5 py-0.5 text-micro',
          'transition-[color,background-color,opacity] duration-[--duration-fast]',
          active
            ? 'text-label-tertiary hover:bg-raised hover:text-label'
            : 'pointer-events-none opacity-0',
        )}
      >
        Clear
      </button>
      {menu}
    </div>
  )
}

// ---------------------------------------------------------------------------

interface Facet {
  value: string
  count: number
}

/** Distinct values of one field across the source, most common first. */
function useFacet(photos: Photo[], pick: (p: Photo) => string | string[]): Facet[] {
  return useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of photos) {
      const v = pick(p)
      for (const one of Array.isArray(v) ? v : [v]) {
        const key = one?.trim()
        if (!key) continue
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
    return [...counts]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    // `pick` is a literal at every call site, so the photo list is the only
    // thing that can change the answer.
  }, [photos]) // eslint-disable-line react-hooks/exhaustive-deps
}

const Divider = () => <span className="h-3.5 w-px shrink-0 bg-hairline" />

function Cluster({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {label && <span className="text-micro text-label-quaternary">{label}</span>}
      {children}
    </div>
  )
}

function Chip({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'grid size-[19px] place-items-center rounded-[5px]',
        'transition-[background-color,color] duration-[--duration-fast] ease-[--ease-out]',
        active ? 'bg-control text-icon' : 'text-icon-tertiary hover:bg-raised hover:text-icon',
      )}
    >
      {children}
    </button>
  )
}

/**
 * A facet button. It carries its own selection rather than opening onto a
 * separate list of chips, so the row's height never changes as filters go on
 * and off and the grid below it doesn't jump.
 */
function Dropdown({
  label,
  chosen,
  onClick,
}: {
  label: string
  chosen: string[]
  onClick: (e: React.MouseEvent) => void
}) {
  const on = chosen.length > 0
  const text = !on ? label : chosen.length === 1 ? chosen[0] : `${label} · ${chosen.length}`
  return (
    <button
      type="button"
      title={on ? chosen.join(', ') : label}
      onClick={onClick}
      className={cn(
        'flex h-[19px] max-w-[150px] items-center gap-1 rounded-[5px] px-1.5 text-micro',
        'transition-[background-color,color] duration-[--duration-fast] ease-[--ease-out]',
        on ? 'bg-control text-label' : 'text-label-tertiary hover:bg-raised hover:text-label',
      )}
    >
      <span className="truncate">{text}</span>
      <ChevronDownIcon size={9} className="shrink-0 text-icon-quaternary" />
    </button>
  )
}

function Pill({ children, onClear }: { children: React.ReactNode; onClear: () => void }) {
  return (
    <span className="flex h-[19px] items-center gap-1 rounded-[5px] bg-control px-1.5 text-micro text-label">
      {children}
      <button
        type="button"
        aria-label="Remove filter"
        onClick={onClear}
        className="text-icon-tertiary transition-colors hover:text-red"
      >
        <CloseIcon size={9} />
      </button>
    </span>
  )
}
