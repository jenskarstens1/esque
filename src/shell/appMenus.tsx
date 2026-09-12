import type { ReactNode } from 'react'
import { MENU_ICON, type MenuItem } from '../design/Menu'
import {
  AspectIcon,
  BeforeAfterIcon,
  ClearFilterIcon,
  CollectionIcon,
  CompareIcon,
  ContrastIcon,
  CopyIcon,
  CropIcon,
  EmptyIcon,
  ExportIcon,
  ExposureIcon,
  EyeIcon,
  FilePlusIcon,
  FilterIcon,
  FlipHorizontalIcon,
  FlipVerticalIcon,
  FolderIcon,
  GridIcon,
  HealIcon,
  ImportIcon,
  ListIcon,
  LoupeIcon,
  MaskIcon,
  MinusIcon,
  PasteIcon,
  PencilIcon,
  PlusIcon,
  RedEyeIcon,
  RedoIcon,
  ResetIcon,
  RotateLeftIcon,
  RotateRightIcon,
  SelectAllIcon,
  SelectNoneIcon,
  SmartCollectionIcon,
  SoloIcon,
  SortAscIcon,
  StarIcon,
  SyncIcon,
  TileFillIcon,
  TrashIcon,
  UndoIcon,
  WarningIcon,
  WaterfallIcon,
  ZoomIcon,
} from '../design/icons'
import { filtersActive, useCatalog, type SortKey } from '../state/catalog'
import { useUI, BEFORE_AFTER_LABELS, type BeforeAfter } from '../state/ui'
import { useDevelop, ALL_SECTIONS } from '../develop/session'
import { useImporter } from '../state/importer'
import { useExport } from '../state/exportStore'
import { SECTION_LABELS } from '../core/defaults'
import { hdrSupported } from '../core/hdr'
import { ASPECT_LABELS, fitCropToAspect, frameAspect } from '../gpu/geometry'
import { isSectionModified } from '../develop/modified'
import type { CropAspect } from '../core/types'
import { toast } from '../design/toast'
import { confirmAction, promptText } from '../design/prompt'
import { db } from '../catalog/db'
import { addToCollection, createCollection, removeFolder } from '../catalog/actions'
import { editSmartCollection } from '../state/smartEditor'
import { zoomCommands } from '../lib/useZoomPan'
import { useMasking } from '../develop/masking'
import { useRetouch } from '../develop/retouch'
import {
  DETECTED_KINDS,
  MASK_KINDS,
  MASK_KIND_LABELS,
  duplicateLayer,
  newMaskLayer,
} from '../develop/layers'
import { aiSupportNow, type AiSupport } from '../ai/models'
import type {
  CatalogFolder,
  Collection,
  EditSection,
  MaskGeometry,
} from '../core/types'

type MaskGeometryKind = MaskGeometry['kind']

const SORTS: Array<{ value: SortKey; label: string }> = [
  { value: 'capture', label: 'Capture Time' },
  { value: 'filename', label: 'File Name' },
  { value: 'rating', label: 'Rating' },
  { value: 'added', label: 'Date Added' },
  { value: 'modified', label: 'Date Modified' },
  { value: 'iso', label: 'ISO' },
]

const THUMB_SIZES = [96, 128, 160, 200, 260, 340]

/**
 * The menu for empty space in the grid — view options rather than photo
 * commands, because there is no photo under the pointer to act on.
 */
export function gridBackgroundMenuItems(): MenuItem[] {
  const ui = useUI.getState()
  const cat = useCatalog.getState()

  return [
    {
      label: 'Select All',
      icon: <SelectAllIcon size={MENU_ICON} />,
      commandId: 'nav.selectAll',
      disabled: !cat.visibleIds.length,
      onSelect: () => cat.selectAll(),
    },
    {
      label: 'Deselect All',
      icon: <SelectNoneIcon size={MENU_ICON} />,
      commandId: 'nav.deselect',
      disabled: !cat.selected.length,
      onSelect: () => cat.clearSelection(),
    },
    { kind: 'separator' },
    {
      label: 'Sort By',
      icon: <SortAscIcon size={MENU_ICON} />,
      submenu: [
        ...SORTS.map<MenuItem>((s) => ({
          label: s.label,
          checked: cat.sortKey === s.value,
          onSelect: () => cat.setSort(s.value, cat.sortAsc),
        })),
        { kind: 'separator' },
        {
          label: 'Ascending',
          checked: cat.sortAsc,
          onSelect: () => cat.setSort(cat.sortKey, true),
        },
        {
          label: 'Descending',
          checked: !cat.sortAsc,
          onSelect: () => cat.setSort(cat.sortKey, false),
        },
      ],
    },
    {
      label: 'Grid Layout',
      icon: <TileFillIcon size={MENU_ICON} />,
      submenu: [
        {
          label: 'Fill',
          icon: <TileFillIcon size={MENU_ICON} />,
          checked: ui.gridLayout === 'fill',
          onSelect: () => ui.setGridLayout('fill'),
        },
        {
          label: 'Waterfall',
          icon: <WaterfallIcon size={MENU_ICON} />,
          checked: ui.gridLayout === 'waterfall',
          onSelect: () => ui.setGridLayout('waterfall'),
        },
      ],
    },
    {
      label: 'Thumbnail Size',
      icon: <GridIcon size={MENU_ICON} />,
      submenu: THUMB_SIZES.map<MenuItem>((n) => ({
        label: `${n} px`,
        checked: ui.thumbSize === n,
        onSelect: () => ui.setThumbSize(n),
      })),
    },
    {
      label: 'Show Badges and Ratings',
      icon: <StarIcon size={MENU_ICON} />,
      checked: ui.showGridExtras,
      onSelect: () => ui.toggleGridExtras(),
    },
    { kind: 'separator' },
    {
      label: 'Loupe View',
      icon: <LoupeIcon size={MENU_ICON} />,
      commandId: 'view.loupe',
      onSelect: () => {
        ui.setModule('library')
        ui.setViewMode('loupe')
      },
    },
    {
      label: 'Filter Bar',
      icon: <FilterIcon size={MENU_ICON} />,
      commandId: ui.module === 'library' ? 'panels.filterBar' : undefined,
      checked: ui.filterBarOpen,
      onSelect: () => ui.toggleFilterBar(),
    },
    {
      label: 'Clear Filters',
      icon: <ClearFilterIcon size={MENU_ICON} />,
      disabled: !filtersActive(cat.filters),
      onSelect: () => cat.clearFilters(),
    },
    { kind: 'separator' },
    {
      label: 'Import Photos…',
      icon: <ImportIcon size={MENU_ICON} />,
      commandId: 'file.import',
      onSelect: () => void useImporter.getState().run(),
    },
    {
      label: 'Import Files…',
      icon: <FilePlusIcon size={MENU_ICON} />,
      onSelect: () => void useImporter.getState().runFiles(null, true),
    },
    {
      label: 'Export Selected…',
      icon: <ExportIcon size={MENU_ICON} />,
      commandId: 'file.export',
      disabled: !cat.selected.length,
      onSelect: () => useExport.getState().openDialog(cat.selected),
    },
  ]
}

const COMPARE_MODES: BeforeAfter[] = [
  'off',
  'before',
  'splitVertical',
  'splitHorizontal',
  'sideBySide',
  'topBottom',
]

/**
 * Crop, straighten and orientation, shared by the canvas menu and the panel.
 *
 * Turning and flipping are the two edits people reach for without opening a
 * panel at all, so they belong on the image itself.
 */
export function cropMenuItems(includeReset = true): MenuItem[] {
  const ui = useUI.getState()
  const dev = useDevelop.getState()
  const crop = dev.edits.crop

  const turn = (by: number) =>
    dev.update(
      'crop.quarterTurns',
      by > 0 ? 'Rotate Right' : 'Rotate Left',
      (e) => {
        e.crop.quarterTurns = (((e.crop.quarterTurns + by) % 4) + 4) % 4
      },
      false,
    )

  const setAspect = (aspect: CropAspect) => {
    const fa = frameAspect(dev.sourceSize.width, dev.sourceSize.height, dev.edits)
    dev.update(
      'crop.aspect',
      'Crop Aspect',
      (e) => {
        e.crop.aspect = aspect
        e.crop.aspectLocked = aspect !== 'free'
        if (aspect !== 'free') Object.assign(e.crop, fitCropToAspect(e.crop, aspect, fa))
      },
      false,
    )
  }

  return [
    {
      // The check mark is the state. Swapping the label to "Close Crop" as well
      // says the same thing twice, in the one column that has to stay scannable.
      label: 'Crop',
      icon: <CropIcon size={MENU_ICON} />,
      commandId: 'develop.crop',
      checked: ui.developTool === 'crop',
      onSelect: () => ui.setDevelopTool(ui.developTool === 'crop' ? 'none' : 'crop'),
    },
    {
      label: 'Aspect',
      icon: <AspectIcon size={MENU_ICON} />,
      submenu: (Object.keys(ASPECT_LABELS) as CropAspect[]).map<MenuItem>((a) => ({
        label: ASPECT_LABELS[a],
        checked: crop.aspect === a,
        onSelect: () => setAspect(a),
      })),
    },
    { kind: 'separator' },
    {
      label: 'Rotate Left',
      icon: <RotateLeftIcon size={MENU_ICON} />,
      onSelect: () => turn(-1),
    },
    {
      label: 'Rotate Right',
      icon: <RotateRightIcon size={MENU_ICON} />,
      onSelect: () => turn(1),
    },
    {
      label: 'Flip Horizontal',
      icon: <FlipHorizontalIcon size={MENU_ICON} />,
      checked: crop.flipH,
      onSelect: () =>
        dev.update('crop.flipH', 'Flip Horizontal', (e) => {
          e.crop.flipH = !e.crop.flipH
        }, false),
    },
    {
      label: 'Flip Vertical',
      icon: <FlipVerticalIcon size={MENU_ICON} />,
      checked: crop.flipV,
      onSelect: () =>
        dev.update('crop.flipV', 'Flip Vertical', (e) => {
          e.crop.flipV = !e.crop.flipV
        }, false),
    },
    ...(includeReset
      ? [
          { kind: 'separator' } as MenuItem,
          {
            label: 'Reset Crop',
            icon: <ResetIcon size={MENU_ICON} />,
            disabled: !isSectionModified(dev.edits, 'crop', dev.kind),
            onSelect: () => dev.resetSection('crop'),
          },
        ]
      : []),
  ]
}

/** The develop canvas menu: what you can do to the image you are looking at. */
/**
 * The mask-kind menu, with the detected kinds gated on what the browser can do.
 *
 * An unsupported kind states its reason rather than being hidden. Hiding it
 * would be the tidier design and the wrong one: "Subject" missing from a menu
 * reads as a feature esque does not have, rather than one this browser cannot
 * run, and the user has no way to tell those apart or to know that switching
 * browsers would fix it. The reason is a wrapped note under the group, not a
 * suffix on every label — one sentence said once, at a width that can hold it.
 */
export function maskKindItems(
  support: AiSupport | null,
  onSelect: (kind: MaskGeometryKind) => void,
): MenuItem[] {
  // Only a known refusal disables anything. While the probe is still out,
  // `support` is null and the kind stays available: a capable browser briefly
  // shown a greyed-out "Subject" with no explanation is a worse outcome than an
  // incapable one being told why in the panel a moment later.
  const blocked = support ? !support.ok : false
  const items: MenuItem[] = []

  for (const kind of MASK_KINDS) {
    const detected = (DETECTED_KINDS as readonly MaskGeometryKind[]).includes(kind)
    if (detected && kind === DETECTED_KINDS[0]) items.push({ kind: 'separator' })
    items.push({
      label: MASK_KIND_LABELS[kind],
      disabled: detected && blocked,
      onSelect: () => onSelect(kind),
    })
  }
  if (blocked && support?.reason) items.push({ kind: 'note', label: support.reason })
  return items
}

/** Layer creation, selection and overlay — the viewport's masking submenu. */
export function maskMenuItems(): MenuItem[] {
  const ui = useUI.getState()
  const dev = useDevelop.getState()
  const mk = useMasking.getState()
  const layers = dev.edits.layers
  const selected = layers.find((m) => m.id === mk.selectedMaskId) ?? null

  const create = (kind: MaskGeometryKind) => {
    const mask = newMaskLayer(layers, kind)
    dev.update('layers.add', 'Add Mask', (e) => {
      e.layers.push(mask)
    }, false)
    mk.select(mask.id, mask.components[0].id)
    ui.openDevelopTool('mask')
    if (kind === 'linear' || kind === 'radial' || kind === 'brush') mk.setPending(kind, 'new')
  }

  const items: MenuItem[] = [
    {
      label: 'Masking',
      icon: <MaskIcon size={MENU_ICON} />,
      commandId: 'develop.mask',
      checked: ui.developTool === 'mask',
      onSelect: () => ui.setDevelopTool(ui.developTool === 'mask' ? 'none' : 'mask'),
    },
    {
      label: 'Create Mask',
      icon: <PlusIcon size={MENU_ICON} />,
      submenu: maskKindItems(aiSupportNow(), create),
    },
  ]

  if (layers.length) {
    items.push({
      label: 'Select Mask',
      icon: <ListIcon size={MENU_ICON} />,
      submenu: layers.map((m) => ({
        label: m.name,
        checked: m.id === mk.selectedMaskId,
        onSelect: () => {
          mk.select(m.id, m.components[0]?.id ?? null)
          ui.openDevelopTool('mask')
        },
      })),
    })
    items.push({
      label: 'Show Overlay',
      icon: <EyeIcon size={MENU_ICON} off={mk.overlay === 'off'} />,
      submenu: (['tint', 'coverage', 'off'] as const).map((o) => ({
        label: o === 'tint' ? 'Overlay' : o === 'coverage' ? 'Mask Only' : 'Off',
        checked: mk.overlay === o,
        onSelect: () => mk.setOverlay(o),
      })),
    })
  }

  if (selected) {
    items.push({ kind: 'separator' })
    items.push({
      label: 'Invert Mask',
      icon: <ContrastIcon size={MENU_ICON} />,
      checked: selected.inverted,
      onSelect: () =>
        dev.update('layers.invert', 'Invert Mask', (e) => {
          const m = e.layers.find((x) => x.id === selected.id)
          if (m) m.inverted = !m.inverted
        }),
    })
    items.push({
      label: 'Show Mask',
      icon: <EyeIcon size={MENU_ICON} off={!selected.visible} />,
      checked: selected.visible,
      onSelect: () =>
        dev.update('layers.visible', 'Toggle Mask', (e) => {
          const m = e.layers.find((x) => x.id === selected.id)
          if (m) m.visible = !m.visible
        }),
    })
    items.push({
      label: 'Duplicate Mask',
      icon: <CopyIcon size={MENU_ICON} />,
      onSelect: () => {
        const copy = duplicateLayer(selected, dev.edits.layers)
        dev.update('layers.add', 'Duplicate Mask', (e) => {
          e.layers.push(copy)
        }, false)
        mk.select(copy.id)
      },
    })
    items.push({ kind: 'separator' })
    items.push({
      label: 'Delete Mask',
      icon: <TrashIcon size={MENU_ICON} />,
      danger: true,
      onSelect: () => {
        dev.update('layers.delete', 'Delete Mask', (e) => {
          e.layers = e.layers.filter((x) => x.id !== selected.id)
        }, false)
        mk.select(null)
      },
    })
  }

  if (layers.length) {
    if (!selected) items.push({ kind: 'separator' })
    items.push({
      label: 'Delete All Masks',
      icon: <TrashIcon size={MENU_ICON} />,
      danger: true,
      onSelect: () => {
        dev.update('layers.clear', 'Delete All Masks', (e) => {
          e.layers = []
        }, false)
        mk.select(null)
      },
    })
  }

  return items
}

/** Spot removal and red-eye — the viewport's retouch submenu. */
export function retouchMenuItems(): MenuItem[] {
  const ui = useUI.getState()
  const dev = useDevelop.getState()
  const rt = useRetouch.getState()
  const { spots, redEye } = dev.edits

  const items: MenuItem[] = [
    {
      label: 'Spot Removal',
      icon: <HealIcon size={MENU_ICON} />,
      commandId: 'develop.heal',
      checked: ui.developTool === 'heal',
      onSelect: () => ui.setDevelopTool(ui.developTool === 'heal' ? 'none' : 'heal'),
    },
    {
      label: 'Red Eye',
      icon: <RedEyeIcon size={MENU_ICON} />,
      commandId: 'develop.redeye',
      checked: ui.developTool === 'redeye',
      onSelect: () => ui.setDevelopTool(ui.developTool === 'redeye' ? 'none' : 'redeye'),
    },
    { kind: 'separator' },
    {
      label: 'New Spot Mode',
      icon: <HealIcon size={MENU_ICON} />,
      submenu: [
        {
          label: 'Heal',
          checked: rt.spotMode === 'heal',
          onSelect: () => rt.setSpot({ spotMode: 'heal' }),
        },
        {
          label: 'Clone',
          checked: rt.spotMode === 'clone',
          onSelect: () => rt.setSpot({ spotMode: 'clone' }),
        },
      ],
    },
  ]

  if (spots.length) {
    items.push({ kind: 'separator' })
    items.push({
      label: 'Show Spot Outlines',
      icon: <EyeIcon size={MENU_ICON} off={!rt.showSpots} />,
      checked: rt.showSpots,
      onSelect: () => rt.toggleSpots(),
    })
    items.push({
      label: 'Heal All Spots',
      icon: <HealIcon size={MENU_ICON} />,
      onSelect: () =>
        dev.update('spot.mode', 'Heal All Spots', (e) => {
          for (const s of e.spots) s.mode = 'heal'
        }, false),
    })
    items.push({ kind: 'separator' })
    items.push({
      label: `Delete ${spots.length} Spot${spots.length === 1 ? '' : 's'}`,
      icon: <TrashIcon size={MENU_ICON} />,
      danger: true,
      onSelect: () => {
        dev.update('spot.delete', 'Delete Spots', (e) => {
          e.spots = []
        }, false)
        rt.selectSpot(null)
      },
    })
  }

  if (redEye.length) {
    if (!spots.length) items.push({ kind: 'separator' })
    items.push({
      label: `Delete ${redEye.length} Red Eye Fix${redEye.length === 1 ? '' : 'es'}`,
      icon: <TrashIcon size={MENU_ICON} />,
      danger: true,
      onSelect: () => {
        dev.update('eye.delete', 'Delete Red Eye', (e) => {
          e.redEye = []
        }, false)
        rt.selectEye(null)
      },
    })
  }

  return items
}

/**
 * Swapping and promoting the two sides of a comparison. Shared, so the overflow
 * menu on the Before / After cluster and the develop canvas can never drift
 * into offering different moves under the same names.
 *
 * `root` because the same list appears at both levels: on its own it is a menu
 * and takes the icon column every root menu has, but under the canvas menu's
 * "Compare Settings" it is a submenu, where the parent row's icon already
 * stands for the whole group.
 */
export function compareMenuItems(root = false): MenuItem[] {
  const dev = useDevelop.getState()
  const icon = (node: ReactNode) => (root ? node : undefined)
  return [
    {
      label: 'Swap Before and After',
      icon: icon(<SyncIcon size={MENU_ICON} />),
      onSelect: () => {
        dev.swapBeforeAfter()
        toast.show('Swapped before and after')
      },
    },
    { kind: 'separator' },
    {
      label: 'Copy After to Before',
      icon: icon(<CopyIcon size={MENU_ICON} />),
      onSelect: () => {
        dev.copyAfterToBefore()
        toast.show('Before updated to the current edit')
      },
    },
    {
      label: 'Copy Before to After',
      icon: icon(<CopyIcon size={MENU_ICON} />),
      onSelect: () => dev.copyBeforeToAfter(),
    },
    { kind: 'separator' },
    {
      label: 'Reset Before to Import',
      icon: icon(<ResetIcon size={MENU_ICON} />),
      onSelect: () => {
        dev.resetBefore()
        toast.show('Before reset to the imported settings')
      },
    },
  ]
}

export function viewportMenuItems(): MenuItem[] {
  const ui = useUI.getState()
  const dev = useDevelop.getState()
  const zoom = zoomCommands()

  return [
    { label: 'Crop & Straighten', icon: <CropIcon size={MENU_ICON} />, submenu: cropMenuItems() },
    { label: 'Masking', icon: <MaskIcon size={MENU_ICON} />, submenu: maskMenuItems() },
    { label: 'Retouch', icon: <HealIcon size={MENU_ICON} />, submenu: retouchMenuItems() },
    {
      label: 'Zoom',
      icon: <ZoomIcon size={MENU_ICON} />,
      submenu: [
        { label: 'Fit in Window', commandId: 'zoom.fit', onSelect: () => zoom?.fit() },
        { label: '1:1', commandId: 'zoom.actual', onSelect: () => zoom?.actual() },
        { label: 'Toggle Zoom', commandId: 'zoom.toggle', onSelect: () => zoom?.toggle() },
        { kind: 'separator' },
        { label: 'Zoom In', commandId: 'zoom.in', onSelect: () => zoom?.zoomIn() },
        { label: 'Zoom Out', commandId: 'zoom.out', onSelect: () => zoom?.zoomOut() },
      ],
    },
    {
      label: 'Before / After',
      icon: <BeforeAfterIcon size={MENU_ICON} />,
      submenu: COMPARE_MODES.map<MenuItem>((m) => ({
        label: BEFORE_AFTER_LABELS[m],
        checked: ui.beforeAfter === m,
        commandId: m !== 'off' && ui.beforeAfter !== m ? `develop.${m}` : undefined,
        onSelect: () => ui.setBeforeAfter(m),
      })),
    },
    {
      label: 'Compare Settings',
      icon: <CompareIcon size={MENU_ICON} />,
      disabled: ui.beforeAfter === 'off',
      submenu: compareMenuItems(),
    },
    { kind: 'separator' },
    {
      label: 'Show Clipping',
      icon: <WarningIcon size={MENU_ICON} />,
      submenu: [
        {
          label: 'Shadows',
          checked: ui.showClipping.shadows,
          onSelect: () => ui.toggleClipping('shadows'),
        },
        {
          label: 'Highlights',
          checked: ui.showClipping.highlights,
          onSelect: () => ui.toggleClipping('highlights'),
        },
        {
          label: 'Toggle Both',
          commandId: 'develop.clipping',
          onSelect: () => {
            ui.toggleClipping('shadows')
            ui.toggleClipping('highlights')
          },
        },
      ],
    },
    {
      label: 'HDR Preview',
      icon: <ExposureIcon size={MENU_ICON} />,
      commandId: 'view.hdr',
      checked: ui.hdr,
      disabled: !hdrSupported(),
      onSelect: () => ui.toggleHdr(),
    },
    { kind: 'separator' },
    {
      label: 'Undo',
      icon: <UndoIcon size={MENU_ICON} />,
      commandId: 'develop.undo',
      disabled: dev.historyIndex <= 0,
      onSelect: () => dev.undo(),
    },
    {
      label: 'Redo',
      icon: <RedoIcon size={MENU_ICON} />,
      commandId: 'develop.redo',
      disabled: dev.historyIndex >= dev.history.length - 1,
      onSelect: () => dev.redo(),
    },
    { kind: 'separator' },
    {
      label: 'Copy Settings',
      icon: <CopyIcon size={MENU_ICON} />,
      commandId: 'develop.copy',
      onSelect: () => {
        dev.copySettings(ALL_SECTIONS)
        toast.show('Settings copied')
      },
    },
    {
      label: 'Copy Settings From',
      icon: <CopyIcon size={MENU_ICON} />,
      submenu: ALL_SECTIONS.map<MenuItem>((section) => ({
        label: SECTION_LABELS[section],
        onSelect: () => {
          dev.copySettings([section])
          toast.show(`${SECTION_LABELS[section]} copied`)
        },
      })),
    },
    {
      label: 'Paste Settings',
      icon: <PasteIcon size={MENU_ICON} />,
      commandId: 'develop.paste',
      disabled: !dev.clipboard,
      onSelect: () => dev.pasteSettings(),
    },
    { kind: 'separator' },
    {
      label: 'Reset All Settings',
      icon: <ResetIcon size={MENU_ICON} />,
      commandId: 'develop.reset',
      danger: true,
      onSelect: () => dev.resetAll(),
    },
  ]
}

/**
 * Panel header menu — the bulk operations that would clutter a header if every
 * one of them had its own button.
 */
export function panelMenuItems(section: EditSection): MenuItem[] {
  const ui = useUI.getState()
  const dev = useDevelop.getState()
  const label = SECTION_LABELS[section]
  const sections: EditSection[] = section === 'basic' ? ['profile', 'basic'] : [section]

  return [
    {
      label: `Reset ${label}`,
      icon: <ResetIcon size={MENU_ICON} />,
      disabled: !isSectionModified(dev.edits, section, dev.kind, dev.iso),
      onSelect: () => dev.resetSection(section),
    },
    {
      label: `Copy ${label}`,
      icon: <CopyIcon size={MENU_ICON} />,
      onSelect: () => {
        dev.copySettings(sections)
        toast.show(`${label} copied`)
      },
    },
    {
      label: `Paste ${label}`,
      icon: <PasteIcon size={MENU_ICON} />,
      disabled: !sections.every((value) => dev.clipboard?.sections.includes(value)),
      onSelect: () => dev.pasteSettings(sections),
    },
    { kind: 'separator' },
    {
      label: 'Solo Mode',
      icon: <SoloIcon size={MENU_ICON} />,
      checked: ui.soloPanels,
      onSelect: () => ui.toggleSoloPanels(),
    },
    { kind: 'separator' },
    {
      label: 'Reset All Settings',
      icon: <ResetIcon size={MENU_ICON} />,
      commandId: 'develop.reset',
      danger: true,
      onSelect: () => dev.resetAll(),
    },
  ]
}

/**
 * Slider menu. Lightroom only offers double-click to reset; a menu can also
 * carry the value itself, which is the fastest way to move a number between two
 * photos or into a note. Three rows, so no title and no dividers — the slider
 * you right-clicked is the subject.
 */
export function sliderMenuItems(opts: {
  value: number
  defaultValue: number
  onReset: () => void
  onSet?: (v: number) => void
}): MenuItem[] {
  const { value, defaultValue, onReset, onSet } = opts
  const rounded = Math.round(value * 100) / 100
  return [
    {
      label: 'Reset to Default',
      icon: <ResetIcon size={MENU_ICON} />,
      disabled: value === defaultValue,
      onSelect: onReset,
    },
    ...(onSet
      ? ([
          {
            label: 'Set to Zero',
            icon: <MinusIcon size={MENU_ICON} />,
            disabled: value === 0,
            onSelect: () => onSet(0),
          },
        ] as MenuItem[])
      : []),
    {
      label: `Copy Value (${rounded})`,
      icon: <CopyIcon size={MENU_ICON} />,
      onSelect: () => {
        void navigator.clipboard?.writeText(String(rounded))
        toast.show(`Copied ${rounded}`)
      },
    },
  ]
}

/**
 * Folder and collection rows in the library sidebar. A source is a place rather
 * than a thing, so the commands are about its identity and membership — the
 * photos inside it get their own menu in the grid.
 */
export function sourceMenuItems(
  target: { kind: 'folder'; folder: CatalogFolder } | { kind: 'collection'; collection: Collection },
): MenuItem[] {
  const cat = useCatalog.getState()

  if (target.kind === 'folder') {
    const { folder } = target
    return [
      {
        label: 'Show in Library',
        icon: <FolderIcon size={MENU_ICON} />,
        onSelect: () => cat.setSource({ kind: 'folder', id: folder.id }),
      },
      ...(folder.handle
        ? [
            {
              label: 'Synchronize Folder…',
              icon: <SyncIcon size={MENU_ICON} />,
              onSelect: () => void useImporter.getState().sync(folder),
            } as MenuItem,
          ]
        : [
            {
              label: 'Import Files…',
              icon: <FilePlusIcon size={MENU_ICON} />,
              onSelect: () => void useImporter.getState().runFiles(null, true),
            } as MenuItem,
          ]),
      { kind: 'separator' },
      {
        label: 'Create Collection from Folder…',
        icon: <CollectionIcon size={MENU_ICON} />,
        onSelect: async () => {
          const name = await promptText({
            title: 'Create Collection',
            description: `Every photo currently in ${folder.name} is added.`,
            initial: folder.name,
            confirmLabel: 'Create',
          })
          if (!name) return
          const photos = await db.photos.where('folderId').equals(folder.id).toArray()
          const id = await createCollection(
            name,
            photos.map((p) => p.id),
          )
          cat.setSource({ kind: 'collection', id })
          toast.show(`Created “${name}”`, { detail: `${photos.length} photos` })
        },
      },
      { kind: 'separator' },
      {
        label: 'Remove Folder…',
        icon: <TrashIcon size={MENU_ICON} />,
        danger: true,
        onSelect: async () => {
          const ok = await confirmAction({
            title: `Remove “${folder.name}”?`,
            description:
              'The photos leave the catalog along with their edits. Nothing on disk is touched.',
            confirmLabel: 'Remove',
            danger: true,
          })
          if (!ok) return
          await removeFolder(folder.id)
          if (cat.source.kind === 'folder' && cat.source.id === folder.id)
            cat.setSource({ kind: 'all' })
          toast.show(`Removed “${folder.name}”`)
        },
      },
    ]
  }

  const { collection } = target
  const selection = cat.selected
  return [
    {
      label: 'Show in Library',
      icon: <CollectionIcon size={MENU_ICON} />,
      onSelect: () => cat.setSource({ kind: 'collection', id: collection.id }),
    },
    ...(collection.smart || selection.length === 0
      ? []
      : ([
          {
            label:
              selection.length === 1
                ? 'Add Selected Photo'
                : `Add ${selection.length} Selected Photos`,
            icon: <PlusIcon size={MENU_ICON} />,
            onSelect: async () => {
              await addToCollection(collection.id, selection)
              toast.show(`Added to “${collection.name}”`)
            },
          },
        ] as MenuItem[])),
    { kind: 'separator' },
    ...(collection.smart
      ? ([
          {
            label: 'Edit Rules…',
            icon: <SmartCollectionIcon size={MENU_ICON} />,
            onSelect: () => editSmartCollection(collection),
          },
        ] as MenuItem[])
      : []),
    {
      label: 'Rename…',
      icon: <PencilIcon size={MENU_ICON} />,
      onSelect: async () => {
        const name = await promptText({
          title: 'Rename Collection',
          initial: collection.name,
          confirmLabel: 'Rename',
        })
        if (!name || name === collection.name) return
        await db.collections.update(collection.id, { name })
      },
    },
    {
      label: 'Duplicate',
      icon: <CopyIcon size={MENU_ICON} />,
      onSelect: async () => {
        const id = collection.smart
          ? await createCollection(`${collection.name} Copy`, [], {
              rules: collection.rules,
              match: collection.match,
            })
          : await createCollection(`${collection.name} Copy`, [...collection.photoIds])
        cat.setSource({ kind: 'collection', id })
      },
    },
    ...(collection.smart
      ? []
      : ([
          {
            label: 'Empty Collection',
            icon: <EmptyIcon size={MENU_ICON} />,
            danger: true,
            disabled: collection.photoIds.length === 0,
            onSelect: async () => {
              await db.collections.update(collection.id, { photoIds: [] })
              toast.show(`Emptied “${collection.name}”`)
            },
          },
        ] as MenuItem[])),
    { kind: 'separator' },
    {
      label: 'Delete Collection…',
      icon: <TrashIcon size={MENU_ICON} />,
      danger: true,
      onSelect: async () => {
        const ok = await confirmAction({
          title: `Delete “${collection.name}”?`,
          description: 'The photos stay in the catalog; only the grouping goes away.',
          confirmLabel: 'Delete',
          danger: true,
        })
        if (!ok) return
        await db.collections.delete(collection.id)
        if (cat.source.kind === 'collection' && cat.source.id === collection.id)
          cat.setSource({ kind: 'all' })
      },
    },
  ]
}

/**
 * The histogram. Its menu is about what the graph is telling you — which
 * warnings are on, and the exposure moves those warnings are asking for.
 */
export function histogramMenuItems(): MenuItem[] {
  const ui = useUI.getState()
  const dev = useDevelop.getState()
  const clip = ui.showClipping
  const has = !!dev.photoId

  const nudge = (field: 'exposure' | 'blacks' | 'whites', by: number): MenuItem => ({
    label: `${field[0].toUpperCase() + field.slice(1)} ${by > 0 ? '+' : ''}${by}`,
    disabled: !has,
    onSelect: () =>
      dev.update(`basic.${field}`, `${field[0].toUpperCase() + field.slice(1)}`, (e) => {
        e.basic[field] = e.basic[field] + by
      }),
  })

  return [
    {
      label: 'Show Shadow Clipping',
      icon: <WarningIcon size={MENU_ICON} />,
      checked: clip.shadows,
      onSelect: () => ui.toggleClipping('shadows'),
    },
    {
      label: 'Show Highlight Clipping',
      icon: <WarningIcon size={MENU_ICON} />,
      checked: clip.highlights,
      onSelect: () => ui.toggleClipping('highlights'),
    },
    { kind: 'separator' },
    {
      label: 'Nudge Exposure',
      icon: <ExposureIcon size={MENU_ICON} />,
      disabled: !has,
      submenu: [nudge('exposure', 0.33), nudge('exposure', -0.33)],
    },
    {
      label: 'Nudge Endpoints',
      icon: <ContrastIcon size={MENU_ICON} />,
      disabled: !has,
      submenu: [nudge('whites', 5), nudge('whites', -5), nudge('blacks', 5), nudge('blacks', -5)],
    },
    { kind: 'separator' },
    {
      label: 'Reset Tone',
      icon: <ResetIcon size={MENU_ICON} />,
      disabled: !has,
      onSelect: () =>
        dev.update('basic.tone', 'Reset Tone', (e) => {
          e.basic.exposure = 0
          e.basic.contrast = 0
          e.basic.highlights = 0
          e.basic.shadows = 0
          e.basic.whites = 0
          e.basic.blacks = 0
        }),
    },
  ]
}
