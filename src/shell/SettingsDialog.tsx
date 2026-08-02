import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Dialog } from '../design/Dialog'
import { Button, Select, Switch } from '../design/Controls'
import { Field } from '../design/Field'
import { Scroller } from '../design/Scroller'
import { Slider } from '../design/Slider'
import { toast } from '../design/toast'
import { CacheIcon, DisplayIcon, InfoIcon, InterfaceIcon, Logo } from '../design/icons'
import { cacheClear, cacheStats, type CacheStats } from '../catalog/opfs'
import { formatBytes } from '../lib/math'
import { useUI } from '../state/ui'
import { hdrReach } from '../core/hdr'
import { useDisplayHdr } from '../lib/useDisplayHdr'
import { cn } from '../lib/cn'
import type { OutputSpace } from '../gpu/colorspace'

/**
 * Settings is a *panel*, not a list.
 *
 * Every row here is a label in a fixed column and a control in the next, and
 * for three groups of settings that grid is the whole vocabulary. About is not
 * a setting though — it is the app's signature — and stacking it under the
 * cache meter as a fourth "group" forced it to borrow a grid it could never
 * satisfy, which is what made the bottom of this dialog read as a pile.
 *
 * So the groups became panes behind a rail, the way Export already splits its
 * presets from its fields. Each pane owns its own state and lands in a frame of
 * fixed size — switching panes never resizes the dialog under the pointer —
 * and About finally gets a stage of its own instead of a leftover row.
 *
 * The frame is sized to the panes, not to a round number: three or four rows do
 * not fill 340px, and the emptiness underneath read as something missing rather
 * than as air. `--field-measure` closes the control column on its right, so a
 * select, a switch and a slider all start and end on the same two verticals.
 */

const PANES = [
  { id: 'display', label: 'Display', icon: DisplayIcon },
  { id: 'interface', label: 'Interface', icon: InterfaceIcon },
  { id: 'cache', label: 'Cache', icon: CacheIcon },
  { id: 'about', label: 'About', icon: InfoIcon },
] as const

type PaneId = (typeof PANES)[number]['id']

const PROOF_SPACES: Array<{ value: OutputSpace; label: string }> = [
  { value: 'srgb', label: 'sRGB' },
  { value: 'display-p3', label: 'Display P3' },
  { value: 'adobe-rgb', label: 'Adobe RGB (1998)' },
  { value: 'prophoto', label: 'ProPhoto RGB' },
  { value: 'rec2020', label: 'Rec. 2020' },
]

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Held above `open` on purpose: the dialog reopens on the pane you left it on.
  const [pane, setPane] = useState<PaneId>('display')

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Settings"
      width={590}
      height={310}
      scrollable={false}
      dividers={false}
      bodyClassName="items-stretch [--field-measure:280px]"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <Rail pane={pane} onSelect={setPane} />
      {/* Panes mount only while shown, so each one's setup — the cache reading
          the disk, say — happens exactly when it is asked for. */}
      <Scroller
        key={pane}
        frameClassName="min-h-0 flex-1"
        className="px-5 pt-3 pb-3"
        role="tabpanel"
        id={`settings-pane-${pane}`}
        aria-labelledby={`settings-tab-${pane}`}
      >
        {pane === 'display' && <DisplayPane />}
        {pane === 'interface' && <InterfacePane />}
        {pane === 'cache' && <CachePane />}
        {pane === 'about' && <AboutPane />}
      </Scroller>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------

/**
 * The pane list. Its items sit on the same left edge as the dialog's own title
 * — the padding is split between the rail and the item so the icons land at
 * 20px, exactly where "Settings" starts.
 */
function Rail({ pane, onSelect }: { pane: PaneId; onSelect: (id: PaneId) => void }) {
  const tabs = useRef<Array<HTMLButtonElement | null>>([])

  // Roving focus: the rail is one tab stop and the arrows walk it, so a
  // keyboard user isn't made to step through four buttons to reach the fields.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    const index = PANES.findIndex((p) => p.id === pane)
    let next = -1
    if (step) next = (index + step + PANES.length) % PANES.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = PANES.length - 1
    if (next < 0) return
    e.preventDefault()
    onSelect(PANES[next].id)
    tabs.current[next]?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label="Settings sections"
      aria-orientation="vertical"
      onKeyDown={onKeyDown}
      // No rule between the rail and the panes: with the header and footer
      // undivided, a hairline spanning only the body dangles short of both
      // edges. The selected chip and the gap carry the separation instead.
      className="flex w-[140px] shrink-0 flex-col gap-px pt-2 pr-3 pb-3 pl-3"
    >
      {PANES.map(({ id, label, icon: Icon }, i) => {
        const active = id === pane
        return (
          <button
            key={id}
            ref={(el) => {
              tabs.current[i] = el
            }}
            type="button"
            role="tab"
            id={`settings-tab-${id}`}
            aria-selected={active}
            aria-controls={`settings-pane-${id}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(id)}
            className={cn(
              'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-ui',
              'transition-colors duration-[--duration-fast] ease-[--ease-out]',
              active
                ? 'bg-accent-soft text-accent'
                : 'text-label-secondary hover:bg-raised hover:text-label',
            )}
          >
            <Icon className={cn('size-3.5 shrink-0', !active && 'text-icon-tertiary')} />
            <span className="min-w-0 flex-1 truncate">{label}</span>
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Panes
// ---------------------------------------------------------------------------

function DisplayPane() {
  const softProof = useUI((s) => s.softProof)
  const setSoftProof = useUI((s) => s.setSoftProof)
  const hdr = useUI((s) => s.hdr)
  const setHdr = useUI((s) => s.setHdr)
  const displayHdr = useDisplayHdr()
  const reach = hdrReach()

  return (
    <>
      <Field label="Proof against">
        <Select value={softProof} onChange={setSoftProof} options={PROOF_SPACES} className="flex-1" />
      </Field>
      <Field
        label="HDR preview"
        hint={
          reach === 'none'
            ? 'Not available in this browser.'
            : !displayHdr
              ? 'This display has no range above white.'
              : reach === 'images'
                ? 'Photos only — the viewport stays SDR behind a Chromium flag.'
                : undefined
        }
      >
        <Switch checked={hdr} onChange={setHdr} disabled={reach === 'none'} label="HDR preview" />
      </Field>
    </>
  )
}

function InterfacePane() {
  const soloPanels = useUI((s) => s.soloPanels)
  const toggleSoloPanels = useUI((s) => s.toggleSoloPanels)
  const showGridExtras = useUI((s) => s.showGridExtras)
  const toggleGridExtras = useUI((s) => s.toggleGridExtras)
  const thumbSize = useUI((s) => s.thumbSize)
  const setThumbSize = useUI((s) => s.setThumbSize)

  return (
    <>
      {/* Every control starts on the column's left edge — select, slider,
          switch alike. A 26px toggle floated out to the right edge instead put
          a hand's width of nothing between a label and the thing it names. */}
      <Field label="Solo panels">
        <Switch checked={soloPanels} onChange={toggleSoloPanels} label="Solo panels" />
      </Field>
      <Field label="Grid badges">
        <Switch checked={showGridExtras} onChange={toggleGridExtras} label="Grid badges" />
      </Field>
      <Field label="Thumbnail size">
        <Slider
          value={thumbSize}
          onChange={setThumbSize}
          min={90}
          max={420}
          step={1}
          origin={90}
          size="S"
          className="min-w-0 flex-1"
          aria-label="Thumbnail size"
        />
        <Readout>{thumbSize} px</Readout>
      </Field>
    </>
  )
}

function CachePane() {
  const [stats, setStats] = useState<CacheStats | null>(null)
  const [clearing, setClearing] = useState(false)

  const refresh = useCallback(() => {
    void cacheStats().then(setStats)
  }, [])

  useEffect(refresh, [refresh])

  const clear = async () => {
    setClearing(true)
    try {
      await cacheClear()
      toast.show('Cache cleared', { detail: 'Previews rebuild as you browse.' })
      refresh()
    } catch (err) {
      toast.error('Could not clear the cache', err instanceof Error ? err.message : String(err))
    } finally {
      setClearing(false)
    }
  }

  const usedShare = stats && stats.quota > 0 ? Math.min(1, stats.bytes / stats.quota) : 0
  const empty = !stats || stats.bytes === 0

  return (
    // With the label gone there is no field grid left to align to, so the pane
    // sits on its own left edge instead of indenting past a 116px gutter that
    // now holds nothing. The readout carries what the label used to say.
    <div className="flex max-w-(--field-measure) flex-col gap-3 pt-1">
      <div className="flex items-center gap-2.5">
        <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-control">
          <div
            className="h-full rounded-full bg-accent/70 transition-[width] duration-[--duration-slow] ease-[--ease-out]"
            style={{ width: `${Math.max(usedShare * 100, stats && stats.bytes ? 1 : 0)}%` }}
          />
        </div>
        <Readout disabled={!stats}>
          {stats && stats.quota > 0
            ? `${formatBytes(stats.bytes)} of ${formatBytes(stats.quota)}`
            : 'Measuring…'}
        </Readout>
      </div>
      <div>
        <Button onClick={() => void clear()} disabled={clearing || empty}>
          {clearing ? 'Clearing…' : 'Clear cache'}
        </Button>
      </div>
    </div>
  )
}

/**
 * The one pane that is not a settings grid: the mark over the name, centred in
 * the frame with nothing else competing for the eye. The line of small print
 * sits on the floor of the pane rather than trailing the tagline, so it reads
 * as a footer and can be set legibly instead of being hidden by its own colour.
 */
function AboutPane() {
  const [credits, setCredits] = useState(false)

  return (
    <div className="flex min-h-full flex-col items-center text-center">
      <div className="my-auto flex flex-col items-center gap-4">
        <div className="flex flex-col items-center gap-2.5">
          <Logo size={40} />
          <div>
            <p className="font-display text-headline font-[590] text-label">esque</p>
            <p className="mt-1 text-ui leading-relaxed text-label-secondary">
              Non-destructive RAW editing in the browser.
            </p>
          </div>
        </div>

        <Button onClick={() => setCredits(true)}>Acknowledgements…</Button>
      </div>

      <AcknowledgementsDialog open={credits} onClose={() => setCredits(false)} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bits
// ---------------------------------------------------------------------------

/** A slider's or meter's value, in the UI face with figures that hold their column. */
function Readout({ children, disabled }: { children: ReactNode; disabled?: boolean }) {
  return (
    <span
      className={cn(
        'shrink-0 text-right text-ui whitespace-nowrap tabular-nums',
        disabled ? 'text-label-tertiary' : 'text-label-secondary',
      )}
    >
      {children}
    </span>
  )
}

/** Package name → the licence it ships under. Grouped so the column reads short. */
const LICENCES: Array<[string, string]> = [
  ['LibRaw', 'LGPL-2.1 / CDDL-1.0'],
  ['React', 'MIT'],
  ['Zustand', 'MIT'],
  ['Immer', 'MIT'],
  ['TanStack Virtual', 'MIT'],
  ['exifr', 'MIT'],
  ['clsx', 'MIT'],
  ['Tailwind CSS', 'MIT'],
  ['Vite', 'MIT'],
  ['Dexie', 'Apache-2.0'],
  ['Comlink', 'Apache-2.0'],
  ['jSquash', 'Apache-2.0'],
  ['Lucide', 'ISC'],
  ['Inter', 'SIL OFL 1.1'],
  ['JetBrains Mono', 'SIL OFL 1.1'],
]

function AcknowledgementsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Acknowledgements" width={400} height={320}>
      <p className="pb-3 text-mini leading-relaxed text-label-secondary">
        esque ships the following open-source components.
      </p>
      <dl className="grid grid-cols-[1fr_auto] gap-x-6 text-ui">
        {LICENCES.map(([name, licence]) => (
          <div key={name} className="col-span-2 grid grid-cols-subgrid py-1.5 [&+&]:hairline-t">
            <dt className="truncate text-label">{name}</dt>
            <dd className="text-label-secondary tabular-nums">{licence}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  )
}
