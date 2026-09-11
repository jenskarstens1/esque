import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { PanelSection, MiniAction, Chevron } from '../../design/Panel'
import { useDevelop } from '../../develop/session'
import { useCatalog } from '../../state/catalog'
import { usePhoto, useThumbUrl } from '../../catalog/hooks'
import { cn } from '../../lib/cn'
import { clamp } from '../../lib/math'
import { useElementSize } from '../../lib/useElementSize'
import { useDevicePixelRatio } from '../../lib/useDevicePixelRatio'
import { zoomCommands } from '../../lib/useZoomPan'
import {
  canPan,
  navigatorFrame,
  navigatorOffset,
  subscribeNavigator,
  useNavigatorFrame,
  visibleRect,
  type NavigatorFrame,
} from '../../develop/navigatorStore'
import { Dialog } from '../../design/Dialog'
import { Scroller } from '../../design/Scroller'
import { Button, Checkbox } from '../../design/Controls'
import { applyPreset, DEFAULT_PRESET_SCOPES, PRESET_SCOPES } from '../../develop/presets'
import {
  createPreset,
  deletePreset,
  exportPreset,
  exportPresets,
  groupPresets,
  pickAndImportPresetFolder,
  pickAndImportPresets,
  renamePreset,
  type ImportResult,
} from '../../develop/presetStore'
import { db } from '../../catalog/db'
import { useMenu } from '../../design/useMenu'
import { toast } from '../../design/toast'
import { confirmAction, promptText } from '../../design/prompt'
import { useUI } from '../../state/ui'
import {
  ChevronDownIcon,
  CloseIcon,
  CollapseAllIcon,
  ExpandAllIcon,
  ExportIcon,
  ImportIcon,
  FolderIcon,
  MoreHorizontalIcon,
  MoveIcon,
  PencilIcon,
  PlusIcon,
  PresetIcon,
  SaveIcon,
  TrashIcon,
} from '../../design/icons'
import { MENU_ICON, type MenuItem } from '../../design/Menu'
import type { Preset } from '../../core/types'

/** Stable identity so the `useMemo` below doesn't re-group on every render. */
const NO_PRESETS: Preset[] = []

/**
 * The panel's list rows — preset groups, presets, snapshots, history steps —
 * are one row shape wearing four labels, so they share their geometry and
 * their resting/hover colours rather than each redeclaring them and drifting.
 */
const ROW =
  'esq-tap rounded-[4px] px-1.5 py-[3px] coarse:py-2.5 text-left transition-colors duration-[--duration-fast]'
const ROW_QUIET = 'text-label-secondary hover:bg-raised hover:text-label'

/** Pixels of banked wheel delta that buy one rung of the zoom ladder. */
const WHEEL_RUNG = 100
/** A line-mode wheel notch, in those same pixels. */
const WHEEL_LINE = 16

export function DevelopLeftPanel() {
  return (
    <div className="flex h-full flex-col">
      {/* The Navigator is a fixed point of reference — it tells you where you
          are in the frame, which it can't do from somewhere off the top of a
          scrolled list. So the preset tree is the only thing that moves, and
          it scrolls under its own header rather than taking it along. */}
      <Navigator />
      <PresetsSection />
      {/* Snapshots and History dock to the bottom edge: they're the lists you
          reach for mid-edit, so a long preset tree must never push them out of
          view. Both cap their own height, keeping the dock off the scroll area. */}
      <div className="hairline-t shrink-0">
        <SnapshotsSection />
        <HistorySection />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Navigator
// ---------------------------------------------------------------------------

function Navigator() {
  const primaryId = useCatalog((s) => s.primaryId)
  const photo = usePhoto(primaryId)
  // The rendered thumbnail, not the import preview: it carries the edits and
  // the crop, so the Navigator shows the photo the canvas is actually showing.
  const url = useThumbUrl(photo)
  const frame = useNavigatorFrame()

  const hostRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const rectRef = useRef<HTMLDivElement>(null)
  const host = useElementSize(hostRef)
  const [dragging, setDragging] = useState(false)

  // The canvas frames a crop; the photo's own dimensions are the fallback for
  // the moment before the first publish lands.
  const aspect =
    frame && frame.width > 0
      ? frame.width / frame.height
      : photo && photo.width > 0
        ? photo.width / photo.height
        : 3 / 2

  // Laid out in JS rather than by `aspect-ratio` so the same box drives the
  // overlay and the hit test — a letterbox the pointer maths doesn't know about
  // is a Navigator that pans to the wrong place.
  const box = useMemo(() => {
    if (!host.width || !host.height) return { width: 0, height: 0 }
    const s = Math.min(host.width / aspect, host.height)
    return { width: Math.round(s * aspect), height: Math.round(s) }
  }, [host.width, host.height, aspect])

  const pannable = !!frame && canPan(frame)

  // The rect is written straight to the DOM: a pan commits on every frame, and
  // a React render per frame to move one box is a render too many.
  useEffect(() => {
    const draw = () => {
      const el = rectRef.current
      if (!el) return
      const f = navigatorFrame()
      if (!f || !canPan(f)) {
        el.style.opacity = '0'
        return
      }
      const { x, y, width, height } = visibleRect(f, navigatorOffset().x, navigatorOffset().y)
      el.style.opacity = '1'
      el.style.left = `${x * 100}%`
      el.style.top = `${y * 100}%`
      el.style.width = `${width * 100}%`
      el.style.height = `${height * 100}%`
    }
    draw()
    return subscribeNavigator(draw)
  }, [])

  const panTo = (e: React.PointerEvent) => {
    const at = pointAt(boxRef.current, e.clientX, e.clientY)
    if (at) zoomCommands()?.panTo(at.nx, at.ny)
  }

  // Wheel is attached natively, and for the reason React makes it necessary:
  // React registers wheel passively at the root, where `preventDefault` is a
  // no-op and the browser zooms the whole page instead of the photo.
  const hasBox = !!url && box.width > 0
  const spent = useRef(0)
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const at = pointAt(el, e.clientX, e.clientY)
      const zoom = zoomCommands()
      if (!at || !zoom) return
      e.preventDefault()
      // A trackpad pinch arrives as ctrl+wheel, and wants to be continuous.
      if (e.ctrlKey || e.metaKey) {
        spent.current = 0
        zoom.zoomByAt(Math.exp(-e.deltaY * 0.01), at.nx, at.ny)
        return
      }
      // A mouse spends a notch at a time; a trackpad spends a dozen slivers
      // where a mouse spends one, so its deltas are banked until they add up to
      // a rung. Reversing direction spends the bank rather than fighting it.
      const dy = e.deltaMode === 0 ? e.deltaY : e.deltaY * WHEEL_LINE
      if (!dy) return
      if (dy * spent.current < 0) spent.current = 0
      spent.current += dy
      if (e.deltaMode === 0 && Math.abs(spent.current) < WHEEL_RUNG) return
      spent.current = 0
      zoom.zoomAt(dy < 0 ? 1 : -1, at.nx, at.ny)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [hasBox])

  return (
    <div className="shrink-0 pb-3">
      <div className="flex h-8 items-center gap-1 px-3">
        <span className="esq-panel-title min-w-0 flex-1 truncate">Navigator</span>
        <ZoomMenu frame={frame} />
      </div>
      <div ref={hostRef} className="relative h-[120px] overflow-hidden bg-black">
        {hasBox && (
          <div
            ref={boxRef}
            style={{
              width: box.width,
              height: box.height,
              // Mirrors the canvas: a grab when there's somewhere to go, and an
              // invitation to zoom when the whole photo is already on screen.
              cursor: pannable ? 'grab' : frame?.zoom === null ? 'zoom-in' : 'default',
            }}
            onPointerDown={(e) => {
              if (e.button !== 0 || !pannable) return
              e.currentTarget.setPointerCapture(e.pointerId)
              setDragging(true)
              panTo(e)
            }}
            onPointerMove={(e) => dragging && panTo(e)}
            onPointerUp={() => setDragging(false)}
            onPointerCancel={() => setDragging(false)}
            onDoubleClick={(e) => {
              const at = pointAt(boxRef.current, e.clientX, e.clientY)
              if (at) zoomCommands()?.toggleAt(at.nx, at.ny)
            }}
            className={cn(
              'absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 overflow-hidden',
              dragging && 'cursor-grabbing!',
            )}
          >
            <img
              src={url}
              alt=""
              draggable={false}
              className="absolute inset-0 h-full w-full object-contain"
            />
            {/* One element does both jobs: the border marks the visible slice,
                and the vast spread shadow dims everything outside it. */}
            <div
              ref={rectRef}
              aria-hidden
              className="pointer-events-none absolute border border-white/85 opacity-0 shadow-[0_0_0_9999px_rgba(0,0,0,0.5)] transition-opacity duration-[--duration-fast]"
            />
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The zoom control: what the canvas is set to, and every way to change it.
 *
 * Fit, Fill and 1:1 used to sit in the header as three lit buttons. They cost
 * the whole width of the row to say one thing at a time, and left nowhere for
 * the number — so they fold into one button labelled with wherever the canvas
 * stands, with the percentage read out beside it.
 */
function ZoomMenu({ frame }: { frame: NavigatorFrame | null }) {
  const { menu, openAt } = useMenu()
  const dpr = useDevicePixelRatio()
  const scrub = useRef({ x: 0, active: false })

  // Zoom is image pixels per *device* pixel; `scale` is the CSS-pixel version
  // of the same number, and the only one published while fitting.
  const zoom = frame ? (frame.zoom ?? frame.scale * dpr) : null

  const mode =
    !frame || frame.zoom === null
      ? 'Fit'
      : isFill(frame)
        ? 'Fill'
        : near(frame.zoom, 1)
          ? '1:1'
          : 'Custom'

  const openMenu = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    const items: MenuItem[] = [
      {
        label: 'Fit in Window',
        commandId: 'zoom.fit',
        checked: mode === 'Fit',
        onSelect: () => zoomCommands()?.fit(),
      },
      { label: 'Fill Window', checked: mode === 'Fill', onSelect: () => zoomCommands()?.fill() },
      {
        label: '1:1',
        commandId: 'zoom.actual',
        checked: mode === '1:1',
        onSelect: () => zoomCommands()?.actual(),
      },
      { kind: 'separator' },
      ...ZOOM_STOPS.map<MenuItem>((z) => ({
        label: `${formatPercent(z * 100)}%`,
        checked: mode !== 'Fit' && zoom !== null && near(zoom, z),
        onSelect: () => zoomCommands()?.setZoom(z),
      })),
    ]
    // Hung under its own left edge, so the menu never drifts out over the
    // percentage it was opened next to.
    openAt(r.left, r.bottom + 4, items)
  }

  return (
    <div className="flex items-center">
      <button
        type="button"
        title="Zoom level"
        aria-haspopup="menu"
        disabled={!frame}
        onClick={(e) => {
          e.stopPropagation()
          openMenu(e.currentTarget)
        }}
        className={cn(
          'esq-tap flex items-center gap-0.5 rounded-xs py-0.5 pr-0.5 pl-1.5',
          'text-micro font-medium tracking-[0.05em] uppercase',
          'text-icon-tertiary transition-colors duration-[--duration-fast]',
          'hover:bg-raised hover:text-icon',
          !frame && 'pointer-events-none opacity-30',
        )}
      >
        {mode}
        <ChevronDownIcon size={11} className="opacity-70" />
      </button>
      {/*
       * The same numeric readout as a slider's, and it scrubs like one: drag to
       * zoom, shift to slow down. Drag-only on purpose — every zoom you'd click
       * for is one button to the left, and a readout that also opened a menu
       * would put two ways to the same place a few pixels apart.
       */}
      <span
        role="img"
        aria-label={`Zoom: ${zoom === null ? 'unknown' : `${formatPercent(zoom * 100)}%`}`}
        title="Zoom: drag to scrub"
        className={cn(
          'esq-num min-w-[2.625rem] select-none',
          !frame && 'pointer-events-none opacity-30',
        )}
        onPointerDown={(e) => {
          if (!frame || e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          scrub.current = { x: e.clientX, active: true }
        }}
        onPointerMove={(e) => {
          const s = scrub.current
          if (!s.active) return
          const dx = e.clientX - s.x
          if (!dx) return
          s.x = e.clientX
          // Zoom is multiplicative, so the drag is too: ~100px per doubling,
          // which puts the whole range inside one comfortable sweep. Spent a
          // frame at a time rather than measured from the origin, so holding
          // shift partway through slows the rest of the drag without a jump.
          zoomCommands()?.zoomBy(2 ** (dx * (e.shiftKey ? SCRUB_SLOW : SCRUB)))
        }}
        onPointerUp={(e) => {
          if (!scrub.current.active) return
          e.currentTarget.releasePointerCapture(e.pointerId)
          scrub.current.active = false
        }}
        onPointerCancel={() => {
          scrub.current.active = false
        }}
      >
        {zoom === null ? '—' : `${formatPercent(zoom * 100)}%`}
      </span>
      {menu}
    </div>
  )
}

/** Doublings per pixel of drag, and the same with shift held. */
const SCRUB = 1 / 100
const SCRUB_SLOW = 1 / 400

/** Percentages worth a menu entry — the full ladder is too long to scan. */
const ZOOM_STOPS = [0.25, 0.5, 2, 4, 8, 16]

const near = (a: number, b: number) => Math.abs(a - b) < Math.max(0.005, b * 0.005)

/** 100%, 66.7%, 6.25% — enough precision to be honest, never enough to jitter. */
function formatPercent(p: number): string {
  if (p >= 100) return String(Math.round(p))
  if (p >= 10) return (Math.round(p * 10) / 10).toString()
  return (Math.round(p * 100) / 100).toString()
}

/** Fill sizes the image to cover the pane, so its scale is the larger of the two. */
function isFill(f: NavigatorFrame): boolean {
  if (!f.width || !f.height) return false
  const fill = Math.max(f.paneWidth / f.width, f.paneHeight / f.height)
  return Math.abs(f.scale - fill) < fill * 0.005
}

/** Where a pointer landed on the map, in 0…1 of the framed photo. */
function pointAt(el: HTMLElement | null, clientX: number, clientY: number) {
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (!r.width || !r.height) return null
  return {
    nx: clamp((clientX - r.left) / r.width, 0, 1),
    ny: clamp((clientY - r.top) / r.height, 0, 1),
  }
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

function PresetsSection() {
  const replace = useDevelop((s) => s.replace)
  const edits = useDevelop((s) => s.edits)
  const photoId = useDevelop((s) => s.photoId)
  const preview = useDevelop((s) => s.preview)
  const userPresets = useLiveQuery(() => db.presets.toArray(), []) ?? NO_PRESETS
  const groups = useMemo(() => groupPresets(userPresets), [userPresets])
  const expanded = useUI((s) => s.expandedPresetGroups)
  const toggleGroup = useUI((s) => s.togglePresetGroup)
  const setGroupsExpanded = useUI((s) => s.setPresetGroupsExpanded)
  const { menu, open } = useMenu()
  const [saving, setSaving] = useState(false)

  // Hovering a preset shows it on the canvas without committing to history —
  // the same trick Lightroom uses, and the reason browsing feels fast.
  const hovering = useRef<string | null>(null)
  useEffect(() => () => preview(null), [preview])

  // A rule appears under the header only once something is hidden behind it,
  // so a short list has no line to explain and a long one never looks as if a
  // preset name has been sliced off by the title.
  const viewRef = useRef<HTMLDivElement>(null)
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const el = viewRef.current
    if (!el) return
    const read = () => setScrolled(el.scrollTop > 1)
    read()
    el.addEventListener('scroll', read, { passive: true })
    return () => el.removeEventListener('scroll', read)
  }, [])

  const enter = (preset: Preset) => {
    if (!photoId) return
    hovering.current = preset.id
    preview(applyPreset(edits, preset))
  }
  const leave = (preset: Preset) => {
    if (hovering.current !== preset.id) return
    hovering.current = null
    preview(null)
  }
  const apply = (preset: Preset) => {
    hovering.current = null
    preview(null)
    replace(preset.name, applyPreset(edits, preset))
  }

  const allOpen = expanded.length >= groups.length && groups.length > 0

  const libraryMenu = (): MenuItem[] => [
    {
      label: 'Save Current Settings as Preset…',
      icon: <SaveIcon size={MENU_ICON} />,
      disabled: !photoId,
      onSelect: () => setSaving(true),
    },
    { kind: 'separator' },
    {
      label: 'Import Presets…',
      icon: <ImportIcon size={MENU_ICON} />,
      onSelect: () => void pickAndImportPresets().then(reportImport),
    },
    {
      label: 'Import Preset Folder…',
      icon: <FolderIcon size={MENU_ICON} />,
      onSelect: () => void pickAndImportPresetFolder().then(reportImport),
    },
    { kind: 'separator' },
    {
      label: allOpen ? 'Collapse All' : 'Expand All',
      icon: allOpen ? <CollapseAllIcon size={MENU_ICON} /> : <ExpandAllIcon size={MENU_ICON} />,
      onSelect: () => setGroupsExpanded(allOpen ? [] : groups.map((g) => g.group)),
    },
  ]

  const presetMenu = (e: React.MouseEvent, preset: Preset) => {
    open(e, [
      {
        label: 'Apply',
        icon: <PresetIcon size={MENU_ICON} />,
        disabled: !photoId,
        onSelect: () => apply(preset),
      },
      { kind: 'separator' },
      ...(preset.builtin
        ? []
        : ([
            {
              label: 'Rename…',
              icon: <PencilIcon size={MENU_ICON} />,
              onSelect: () =>
                void promptText({
                  title: 'Rename Preset',
                  initial: preset.name,
                  confirmLabel: 'Rename',
                }).then((name) => {
                  if (name) void renamePreset(preset.id, name, preset.group)
                }),
            },
            {
              label: 'Move to Group…',
              icon: <MoveIcon size={MENU_ICON} />,
              onSelect: () =>
                void promptText({
                  title: 'Move Preset',
                  description: 'Name an existing group to file it there, or a new one to make one.',
                  initial: preset.group,
                  confirmLabel: 'Move',
                }).then((group) => {
                  if (!group) return
                  void renamePreset(preset.id, preset.name, group)
                  useUI.getState().expandPresetGroup(group)
                }),
            },
          ] as MenuItem[])),
      {
        label: 'Export as .xmp…',
        icon: <ExportIcon size={MENU_ICON} />,
        onSelect: () => exportPreset(preset),
      },
      ...(preset.builtin
        ? []
        : ([
            { kind: 'separator' },
            {
              label: 'Delete',
              icon: <TrashIcon size={MENU_ICON} />,
              danger: true,
              onSelect: () =>
                void confirmAction({
                  title: `Delete “${preset.name}”?`,
                  description: 'This preset is removed from the catalog. Photos keep their edits.',
                  confirmLabel: 'Delete',
                  danger: true,
                }).then((ok) => ok && void deletePreset(preset.id)),
            },
          ] as MenuItem[])),
    ])
  }

  const groupMenu = (e: React.MouseEvent, group: string, presets: Preset[]) => {
    open(e, [
      {
        label: expanded.includes(group) ? 'Collapse' : 'Expand',
        icon: expanded.includes(group) ? (
          <CollapseAllIcon size={MENU_ICON} />
        ) : (
          <ExpandAllIcon size={MENU_ICON} />
        ),
        onSelect: () => toggleGroup(group),
      },
      { kind: 'separator' },
      {
        label: 'Export Group…',
        icon: <ExportIcon size={MENU_ICON} />,
        onSelect: () =>
          void exportPresets(presets).then((n) => {
            if (n) toast.show(`Exported ${n} preset${n === 1 ? '' : 's'}`)
          }),
      },
      { kind: 'separator' },
      {
        label: allOpen ? 'Collapse All' : 'Expand All',
        icon: allOpen ? <CollapseAllIcon size={MENU_ICON} /> : <ExpandAllIcon size={MENU_ICON} />,
        onSelect: () => setGroupsExpanded(allOpen ? [] : groups.map((g) => g.group)),
      },
    ])
  }

  return (
    <>
      <PanelSection
        title="Presets"
        collapsible={false}
        fill
        // The dock below draws the boundary; a second hairline on this edge
        // would stack with it into a line twice as heavy as every other one.
        hairline={false}
        menuItems={libraryMenu}
        // The ⋯ is the whole interaction layer for the library, so it can't be
        // waiting behind a hover — a hidden control reads as a missing one.
        revealActions="always"
        actions={
          <MiniAction title="Preset actions" onClick={(e) => open(e, libraryMenu())}>
            <MoreHorizontalIcon size={10} />
          </MiniAction>
        }
      >
        {/* Pulled out by exactly the rows' own padding, so preset text lines up
            with the section titles while hover pills still bleed to the edge.
            The right gutter is the overlay scrollbar's: a truncated preset name
            must not disappear under the thumb. */}
        <div
          className={cn('-mx-3 flex min-h-0 flex-1 flex-col', scrolled && 'hairline-t')}
        >
          <Scroller ref={viewRef} frameClassName="mx-1.5 min-h-0 flex-1" className="pr-2">
            {groups.map(({ group, presets }) => (
              <PresetGroup
                key={group}
                group={group}
                presets={presets}
                open={expanded.includes(group)}
                onToggle={() => toggleGroup(group)}
                disabled={!photoId}
                onEnter={enter}
                onLeave={leave}
                onApply={apply}
                onContextMenu={presetMenu}
                onGroupContextMenu={groupMenu}
              />
            ))}
          </Scroller>
        </div>
      </PanelSection>

      <SavePresetDialog open={saving} onClose={() => setSaving(false)} />
      {menu}
    </>
  )
}

/** Turns an import into one sentence, and opens whatever it landed in. */
function reportImport(res: ImportResult | null) {
  if (!res) return
  const broken = res.failed.length
  if (res.added) {
    useUI.getState().expandPresetGroup(res.groups)
    toast.show(`Imported ${res.added} preset${res.added === 1 ? '' : 's'}`, {
      detail: broken ? `${broken} file${broken === 1 ? '' : 's'} couldn't be read` : undefined,
    })
  } else if (broken) {
    toast.error(`Couldn't read ${broken} file${broken === 1 ? '' : 's'}`, res.failed.join(', '))
  } else {
    toast.show('Nothing new to import')
  }
}

function PresetGroup({
  group,
  presets,
  open,
  onToggle,
  disabled,
  onEnter,
  onLeave,
  onApply,
  onContextMenu,
  onGroupContextMenu,
}: {
  group: string
  presets: Preset[]
  open: boolean
  onToggle: () => void
  disabled: boolean
  onEnter: (p: Preset) => void
  onLeave: (p: Preset) => void
  onApply: (p: Preset) => void
  onContextMenu: (e: React.MouseEvent, p: Preset) => void
  onGroupContextMenu: (e: React.MouseEvent, group: string, presets: Preset[]) => void
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        onContextMenu={(e) => onGroupContextMenu(e, group, presets)}
        className={cn(ROW, 'group/head flex w-full items-center gap-1.5 hover:bg-white/[0.028]')}
      >
        <Chevron open={open} />
        {/* The app's eyebrow, not a brighter one of its own: a group header that
            matched its presets in colour made the tree read as one flat list. */}
        <span className="esq-section-title min-w-0 flex-1 truncate transition-colors duration-[--duration-fast] group-hover/head:text-label-secondary">
          {group}
        </span>
      </button>
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-[--duration-base] ease-[--ease-out]',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        {/* `inert` rather than `disabled`: a closing group must not answer a
            pointer that is passing over it, but it also must not repaint itself
            in the disabled colour on the way out. */}
        <div className="overflow-hidden" inert={!open}>
          {/* Indented to the group label's text, so the tree reads as a tree. */}
          <div className="mb-1.5 pl-4">
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                disabled={disabled}
                onPointerEnter={() => onEnter(preset)}
                onPointerLeave={() => onLeave(preset)}
                onClick={() => onApply(preset)}
                onContextMenu={(e) => onContextMenu(e, preset)}
                title={(preset as Preset & { note?: string }).note}
                className={cn(
                  ROW,
                  'block w-full truncate text-mini',
                  disabled ? 'text-label-quaternary' : ROW_QUIET,
                )}
              >
                {preset.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function SavePresetDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const edits = useDevelop((s) => s.edits)
  const kind = useDevelop((s) => s.kind)
  const expandGroup = useUI((s) => s.expandPresetGroup)
  const userPresets = useLiveQuery(() => db.presets.toArray(), []) ?? NO_PRESETS
  const userGroups = useMemo(
    () => [...new Set(userPresets.map((p) => p.group))].sort((a, b) => a.localeCompare(b)),
    [userPresets],
  )
  const [name, setName] = useState('')
  const [group, setGroup] = useState('User Presets')
  const [scopes, setScopes] = useState<string[]>(() => [...DEFAULT_PRESET_SCOPES])

  useEffect(() => {
    if (open) setName('')
  }, [open])

  const toggle = (id: string) =>
    setScopes((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))

  const save = () => {
    void createPreset(name, group, edits, scopes, kind).then((preset) => {
      // Open the group it landed in, so a save you just made is a save you can see.
      expandGroup(preset.group)
      toast.show('Preset created', { detail: `${preset.group} · ${preset.name}` })
    })
    onClose()
  }

  return (
    <Dialog
      open={open}
      title="Create Preset"
      description="Only the settings you tick are stored, and only those are applied, so the preset layers over each photo's own white balance, crop and noise reduction."
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={!scopes.length} onClick={save}>
            Create
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        <label className="flex flex-col gap-1">
          <span className="text-mini text-label-tertiary">Name</span>
          <input
            autoFocus
            value={name}
            placeholder="Untitled"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && scopes.length && save()}
            className="esq-field w-full"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-mini text-label-tertiary">Group</span>
          <input
            value={group}
            list="esq-preset-groups"
            onChange={(e) => setGroup(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && scopes.length && save()}
            className="esq-field w-full"
          />
          <datalist id="esq-preset-groups">
            {userGroups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </label>

        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between">
            <span className="text-mini text-label-tertiary">Include</span>
            <button
              type="button"
              onClick={() =>
                setScopes((cur) =>
                  cur.length === PRESET_SCOPES.length ? [] : PRESET_SCOPES.map((s) => s.id),
                )
              }
              className="text-mini text-label-tertiary transition-colors hover:text-label"
            >
              {scopes.length === PRESET_SCOPES.length ? 'None' : 'All'}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {PRESET_SCOPES.map((s) => (
              <Checkbox
                key={s.id}
                checked={scopes.includes(s.id)}
                onChange={() => toggle(s.id)}
                label={<span className="text-mini">{s.label}</span>}
              />
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

function SnapshotsSection() {
  const snapshots = useDevelop((s) => s.snapshots)
  const create = useDevelop((s) => s.createSnapshot)
  const apply = useDevelop((s) => s.applySnapshot)
  const remove = useDevelop((s) => s.deleteSnapshot)
  const photoId = useDevelop((s) => s.photoId)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')

  const commit = () => {
    void create(name.trim() || 'Snapshot')
    setNaming(false)
  }

  return (
    <PanelSection
      title="Snapshots"
      defaultOpen={false}
      actions={
        <MiniAction
          disabled={!photoId}
          onClick={() => {
            setName(`Snapshot ${snapshots.length + 1}`)
            setNaming(true)
          }}
        >
          <PlusIcon size={10} />
        </MiniAction>
      }
    >
      {snapshots.length === 0 ? (
        <p className="px-1 py-1 text-mini text-label-quaternary">
          Capture the current settings to come back to later.
        </p>
      ) : (
        <Scroller frameClassName="-mx-1 max-h-[min(168px,18vh)]">
          {snapshots.map((s) => (
            <div key={s.id} className="group/snap flex items-center gap-1">
              <button
                type="button"
                onClick={() => apply(s.id)}
                className={cn(ROW, ROW_QUIET, 'min-w-0 flex-1 truncate text-mini')}
              >
                {s.name}
              </button>
              <button
                type="button"
                onClick={() => void remove(s.id)}
                aria-label={`Delete ${s.name}`}
                className="esq-tap esq-reveal shrink-0 px-1 text-icon-quaternary opacity-0 transition-opacity duration-[--duration-fast] group-hover/snap:opacity-100 hover:text-icon"
              >
                <CloseIcon size={9} />
              </button>
            </div>
          ))}
        </Scroller>
      )}

      <Dialog
        open={naming}
        title="New Snapshot"
        onClose={() => setNaming(false)}
        footer={
          <>
            <Button size="sm" variant="secondary" onClick={() => setNaming(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={commit}>
              Create
            </Button>
          </>
        }
      >
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
          className="esq-field w-full"
        />
      </Dialog>
    </PanelSection>
  )
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function HistorySection() {
  const history = useDevelop((s) => s.history)
  const index = useDevelop((s) => s.historyIndex)
  const jumpTo = useDevelop((s) => s.jumpTo)

  return (
    <PanelSection title="History" defaultOpen hairline={false}>
      <Scroller frameClassName="-mx-1 max-h-[min(280px,32vh)]">
        {history
          .map((step, i) => ({ step, i }))
          .reverse()
          .map(({ step, i }) => (
            <button
              key={step.id}
              type="button"
              onClick={() => jumpTo(i)}
              className={cn(
                ROW,
                'flex w-full items-baseline gap-2',
                i === index
                  ? 'bg-control text-label'
                  : i > index
                    ? 'text-label-quaternary'
                    : ROW_QUIET,
              )}
            >
              <span className="min-w-0 flex-1 truncate text-mini">{step.label}</span>
              {step.detail && (
                <span className="shrink-0 font-mono text-micro text-label-quaternary tabular-nums">
                  {step.detail}
                </span>
              )}
            </button>
          ))}
      </Scroller>
    </PanelSection>
  )
}
