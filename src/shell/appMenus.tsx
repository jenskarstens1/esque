import type { MenuItem } from '../design/Menu'
import {
  CheckIcon,
  CollectionIcon,
  FilterIcon,
  FolderIcon,
  GridIcon,
  ImportIcon,
  LoupeIcon,
  SmartCollectionIcon,
  SortAscIcon,
  SyncIcon,
  TileFillIcon,
  WaterfallIcon,
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
  duplicateMask,
  newMask,
} from '../develop/masks'
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
      shortcut: '⌘A',
      onSelect: () => cat.selectAll(),
    },
    {
      label: 'Deselect All',
      shortcut: '⌘D',
      disabled: !cat.selected.length,
      onSelect: () => cat.clearSelection(),
    },
    { kind: 'separator' },
    {
      label: 'Sort By',
      icon: <SortAscIcon size={12} />,
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
      icon: <TileFillIcon size={12} />,
      submenu: [
        {
          label: 'Fill',
          icon: <TileFillIcon size={12} />,
          checked: ui.gridLayout === 'fill',
          onSelect: () => ui.setGridLayout('fill'),
        },
        {
          label: 'Waterfall',
          icon: <WaterfallIcon size={12} />,
          checked: ui.gridLayout === 'waterfall',
          onSelect: () => ui.setGridLayout('waterfall'),
        },
      ],
    },
    {
      label: 'Thumbnail Size',
      icon: <GridIcon size={12} />,
      submenu: THUMB_SIZES.map<MenuItem>((n) => ({
        label: `${n} px`,
        checked: ui.thumbSize === n,
        onSelect: () => ui.setThumbSize(n),
      })),
    },
    {
      label: 'Show Badges and Ratings',
      checked: ui.showGridExtras,
      onSelect: () => ui.toggleGridExtras(),
    },
    { kind: 'separator' },
    {
      label: 'Loupe View',
      icon: <LoupeIcon size={12} />,
      shortcut: 'E',
      onSelect: () => ui.setViewMode('loupe'),
    },
    {
      label: 'Filter Bar',
      icon: <FilterIcon size={12} />,
      shortcut: '\\',
      checked: ui.filterBarOpen,
      onSelect: () => ui.toggleFilterBar(),
    },
    {
      label: 'Clear Filters',
      disabled: !filtersActive(cat.filters),
      onSelect: () => cat.clearFilters(),
    },
    { kind: 'separator' },
    {
      label: 'Import Photos…',
      icon: <ImportIcon size={12} />,
      shortcut: '⇧⌘I',
      onSelect: () => void useImporter.getState().run(),
    },
    {
      label: 'Import Files…',
      icon: <ImportIcon size={12} />,
      onSelect: () => void useImporter.getState().runFiles(null, true),
    },
    {
      label: 'Export Selected…',
      shortcut: '⇧⌘E',
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
export function cropMenuItems(): MenuItem[] {
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
      label: ui.developTool === 'crop' ? 'Close Crop' : 'Crop',
      shortcut: 'R',
      checked: ui.developTool === 'crop',
      onSelect: () => ui.setDevelopTool(ui.developTool === 'crop' ? 'none' : 'crop'),
    },
    {
      label: 'Aspect',
      submenu: (Object.keys(ASPECT_LABELS) as CropAspect[]).map<MenuItem>((a) => ({
        label: ASPECT_LABELS[a],
        checked: crop.aspect === a,
        onSelect: () => setAspect(a),
      })),
    },
    { kind: 'separator' },
    { label: 'Rotate Left', onSelect: () => turn(-1) },
    { label: 'Rotate Right', onSelect: () => turn(1) },
    {
      label: 'Flip Horizontal',
      checked: crop.flipH,
      onSelect: () =>
        dev.update('crop.flipH', 'Flip Horizontal', (e) => {
          e.crop.flipH = !e.crop.flipH
        }, false),
    },
    {
      label: 'Flip Vertical',
      checked: crop.flipV,
      onSelect: () =>
        dev.update('crop.flipV', 'Flip Vertical', (e) => {
          e.crop.flipV = !e.crop.flipV
        }, false),
    },
    { kind: 'separator' },
    {
      label: 'Reset Crop',
      disabled: isSectionModified(dev.edits, 'crop', dev.kind) === false,
      onSelect: () => dev.resetSection('crop'),
    },
  ]
}

/** The develop canvas menu: what you can do to the image you are looking at. */
/**
 * The mask-kind menu, with the detected kinds gated on what the browser can do.
 *
 * A menu cannot carry a tooltip, so an unsupported kind states its reason in
 * the label instead of being hidden. Hiding it would be the tidier design and
 * the wrong one: "Subject" missing from a menu reads as a feature esque does
 * not have, rather than one this browser cannot run, and the user has no way
 * to tell those apart or to know that switching browsers would fix it.
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
    const off = detected && blocked
    items.push({
      label:
        off && support?.reason
          ? `${MASK_KIND_LABELS[kind]} — ${support.reason}`
          : MASK_KIND_LABELS[kind],
      disabled: off,
      onSelect: () => onSelect(kind),
    })
  }
  return items
}

/** Mask creation, selection and overlay — the viewport's masking submenu. */
export function maskMenuItems(): MenuItem[] {
  const ui = useUI.getState()
  const dev = useDevelop.getState()
  const mk = useMasking.getState()
  const masks = dev.edits.masks
  const selected = masks.find((m) => m.id === mk.selectedMaskId) ?? null

  const create = (kind: MaskGeometryKind) => {
    const mask = newMask(masks, kind)
    dev.update('masks.add', 'Add Mask', (e) => {
      e.masks.push(mask)
    }, false)
    mk.select(mask.id, mask.components[0].id)
    ui.openDevelopTool('mask')
    if (kind === 'linear' || kind === 'radial' || kind === 'brush') mk.setPending(kind, 'new')
  }

  const items: MenuItem[] = [
    {
      label: ui.developTool === 'mask' ? 'Close Masking' : 'Masking',
      shortcut: 'M',
      checked: ui.developTool === 'mask',
      onSelect: () => ui.setDevelopTool('mask'),
    },
    {
      label: 'Create Mask',
      submenu: maskKindItems(aiSupportNow(), create),
    },
  ]

  if (masks.length) {
    items.push({
      label: 'Select Mask',
      submenu: masks.map((m) => ({
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
      submenu: (['tint', 'coverage', 'off'] as const).map((o) => ({
        label: o === 'tint' ? 'Overlay' : o === 'coverage' ? 'Mask Only' : 'Off',
        shortcut: o === 'tint' ? 'O' : undefined,
        checked: mk.overlay === o,
        onSelect: () => mk.setOverlay(o),
      })),
    })
  }

  if (selected) {
    items.push({ kind: 'separator' })
    items.push({
      label: selected.inverted ? 'Un-invert Mask' : 'Invert Mask',
      checked: selected.inverted,
      onSelect: () =>
        dev.update('masks.invert', 'Invert Mask', (e) => {
          const m = e.masks.find((x) => x.id === selected.id)
          if (m) m.inverted = !m.inverted
        }),
    })
    items.push({
      label: selected.visible ? 'Hide Mask' : 'Show Mask',
      checked: selected.visible,
      onSelect: () =>
        dev.update('masks.visible', 'Toggle Mask', (e) => {
          const m = e.masks.find((x) => x.id === selected.id)
          if (m) m.visible = !m.visible
        }),
    })
    items.push({
      label: 'Duplicate Mask',
      onSelect: () => {
        const copy = duplicateMask(selected, dev.edits.masks)
        dev.update('masks.add', 'Duplicate Mask', (e) => {
          e.masks.push(copy)
        }, false)
        mk.select(copy.id)
      },
    })
    items.push({
      label: 'Delete Mask',
      danger: true,
      onSelect: () => {
        dev.update('masks.delete', 'Delete Mask', (e) => {
          e.masks = e.masks.filter((x) => x.id !== selected.id)
        }, false)
        mk.select(null)
      },
    })
  }

  if (masks.length) {
    items.push({
      label: 'Delete All Masks',
      danger: true,
      onSelect: () => {
        dev.update('masks.clear', 'Delete All Masks', (e) => {
          e.masks = []
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
      label: ui.developTool === 'heal' ? 'Close Spot Removal' : 'Spot Removal',
      shortcut: 'Q',
      checked: ui.developTool === 'heal',
      onSelect: () => ui.setDevelopTool('heal'),
    },
    {
      label: ui.developTool === 'redeye' ? 'Close Red Eye' : 'Red Eye',
      shortcut: '⇧Q',
      checked: ui.developTool === 'redeye',
      onSelect: () => ui.setDevelopTool('redeye'),
    },
    { kind: 'separator' },
    {
      label: 'New Spots Heal',
      checked: rt.spotMode === 'heal',
      onSelect: () => rt.setSpot({ spotMode: 'heal' }),
    },
    {
      label: 'New Spots Clone',
      checked: rt.spotMode === 'clone',
      onSelect: () => rt.setSpot({ spotMode: 'clone' }),
    },
  ]

  if (spots.length) {
    items.push({ kind: 'separator' })
    items.push({
      label: rt.showSpots ? 'Hide Spot Outlines' : 'Show Spot Outlines',
      checked: rt.showSpots,
      onSelect: () => rt.toggleSpots(),
    })
    items.push({
      label: 'Heal All Spots',
      onSelect: () =>
        dev.update('spot.mode', 'Heal All Spots', (e) => {
          for (const s of e.spots) s.mode = 'heal'
        }, false),
    })
    items.push({
      label: `Delete ${spots.length} Spot${spots.length === 1 ? '' : 's'}`,
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
    items.push({
      label: `Delete ${redEye.length} Red Eye Fix${redEye.length === 1 ? '' : 'es'}`,
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

export function viewportMenuItems(): MenuItem[] {
  const ui = useUI.getState()
  const dev = useDevelop.getState()
  const zoom = zoomCommands()

  return [
    { label: 'Crop & Straighten', submenu: cropMenuItems() },
    { label: 'Masking', submenu: maskMenuItems() },
    { label: 'Retouch', submenu: retouchMenuItems() },
    {
      label: 'Zoom',
      submenu: [
        { label: 'Fit', shortcut: '⌘0', onSelect: () => zoom?.fit() },
        { label: '1:1', shortcut: '⌘1', onSelect: () => zoom?.actual() },
        { label: 'Toggle Zoom', shortcut: 'Z', onSelect: () => zoom?.toggle() },
        { kind: 'separator' },
        { label: 'Zoom In', shortcut: '+', onSelect: () => zoom?.zoomIn() },
        { label: 'Zoom Out', shortcut: '−', onSelect: () => zoom?.zoomOut() },
      ],
    },
    {
      label: 'Before / After',
      submenu: COMPARE_MODES.map<MenuItem>((m) => ({
        label: BEFORE_AFTER_LABELS[m],
        checked: ui.beforeAfter === m,
        shortcut: m === 'before' ? '\\' : m === 'sideBySide' ? 'Y' : undefined,
        onSelect: () => ui.setBeforeAfter(m),
      })),
    },
    {
      label: 'Compare Settings',
      disabled: ui.beforeAfter === 'off',
      submenu: [
        { label: 'Swap Before and After', onSelect: () => dev.swapBeforeAfter() },
        { label: "Copy After's Settings to Before", onSelect: () => dev.copyAfterToBefore() },
        { label: "Copy Before's Settings to After", onSelect: () => dev.copyBeforeToAfter() },
        { kind: 'separator' },
        { label: 'Reset Before to Import', onSelect: () => dev.resetBefore() },
      ],
    },
    { kind: 'separator' },
    {
      label: 'Show Clipping',
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
          label: 'Both',
          shortcut: 'J',
          onSelect: () => {
            ui.toggleClipping('shadows')
            ui.toggleClipping('highlights')
          },
        },
      ],
    },
    {
      label: 'HDR Preview',
      shortcut: 'H',
      checked: ui.hdr,
      disabled: !hdrSupported(),
      onSelect: () => ui.toggleHdr(),
    },
    { kind: 'separator' },
    {
      label: 'Undo',
      shortcut: '⌘Z',
      disabled: dev.historyIndex <= 0,
      onSelect: () => dev.undo(),
    },
    {
      label: 'Redo',
      shortcut: '⇧⌘Z',
      disabled: dev.historyIndex >= dev.history.length - 1,
      onSelect: () => dev.redo(),
    },
    { kind: 'separator' },
    {
      label: 'Copy Settings',
      shortcut: '⇧⌘C',
      onSelect: () => {
        dev.copySettings(ALL_SECTIONS)
        toast.show('Settings copied')
      },
    },
    {
      label: 'Copy Settings From',
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
      shortcut: '⇧⌘V',
      disabled: !dev.clipboard,
      onSelect: () => dev.pasteSettings(),
    },
    { kind: 'separator' },
    {
      label: 'Reset All Settings',
      shortcut: '⌘R',
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
    { kind: 'header', label },
    {
      label: `Reset ${label}`,
      onSelect: () => dev.resetSection(section),
    },
    {
      label: `Copy ${label}`,
      onSelect: () => {
        dev.copySettings(sections)
        toast.show(`${label} copied`)
      },
    },
    {
      label: `Paste ${label}`,
      disabled: !sections.every((value) => dev.clipboard?.sections.includes(value)),
      onSelect: () => dev.pasteSettings(sections),
    },
    { kind: 'separator' },
    {
      label: 'Solo Mode',
      checked: ui.soloPanels,
      onSelect: () => ui.toggleSoloPanels(),
    },
    { kind: 'separator' },
    {
      label: 'Reset All Settings',
      danger: true,
      onSelect: () => dev.resetAll(),
    },
  ]
}

/**
 * Slider menu. Lightroom only offers double-click to reset; a menu can also
 * carry the value itself, which is the fastest way to move a number between two
 * photos or into a note.
 */
export function sliderMenuItems(opts: {
  label: string
  value: number
  defaultValue: number
  onReset: () => void
  onSet?: (v: number) => void
}): MenuItem[] {
  const { label, value, defaultValue, onReset, onSet } = opts
  const rounded = Math.round(value * 100) / 100
  return [
    { kind: 'header', label },
    {
      label: 'Reset to Default',
      icon: <CheckIcon size={12} />,
      disabled: value === defaultValue,
      onSelect: onReset,
    },
    ...(onSet
      ? ([
          { label: 'Set to Zero', disabled: value === 0, onSelect: () => onSet(0) },
        ] as MenuItem[])
      : []),
    { kind: 'separator' },
    {
      label: `Copy Value (${rounded})`,
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
      { kind: 'header', label: folder.name },
      {
        label: 'Show in Library',
        icon: <FolderIcon size={12} />,
        onSelect: () => cat.setSource({ kind: 'folder', id: folder.id }),
      },
      ...(folder.handle
        ? [
            {
              label: 'Synchronize Folder…',
              icon: <SyncIcon size={12} />,
              onSelect: () => void useImporter.getState().sync(folder),
            } as MenuItem,
          ]
        : [
            {
              label: 'Import Files…',
              icon: <ImportIcon size={12} />,
              onSelect: () => void useImporter.getState().runFiles(),
            } as MenuItem,
          ]),
      { kind: 'separator' },
      {
        label: 'Create Collection from Folder…',
        icon: <CollectionIcon size={12} />,
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
    { kind: 'header', label: collection.name },
    {
      label: 'Show in Library',
      icon: <CollectionIcon size={12} />,
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
            icon: <SmartCollectionIcon size={12} />,
            onSelect: () => editSmartCollection(collection),
          },
        ] as MenuItem[])
      : []),
    {
      label: 'Rename…',
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
    { kind: 'header', label: 'Histogram' },
    {
      label: 'Show Shadow Clipping',
      shortcut: 'J',
      checked: clip.shadows,
      onSelect: () => ui.toggleClipping('shadows'),
    },
    {
      label: 'Show Highlight Clipping',
      shortcut: '⇧J',
      checked: clip.highlights,
      onSelect: () => ui.toggleClipping('highlights'),
    },
    {
      label: 'Show Both',
      disabled: clip.shadows && clip.highlights,
      onSelect: () => {
        if (!clip.shadows) ui.toggleClipping('shadows')
        if (!clip.highlights) ui.toggleClipping('highlights')
      },
    },
    {
      label: 'Hide All Warnings',
      disabled: !clip.shadows && !clip.highlights,
      onSelect: () => {
        if (clip.shadows) ui.toggleClipping('shadows')
        if (clip.highlights) ui.toggleClipping('highlights')
      },
    },
    { kind: 'separator' },
    {
      label: 'Nudge Exposure',
      disabled: !has,
      submenu: [nudge('exposure', 0.33), nudge('exposure', -0.33)],
    },
    {
      label: 'Nudge Endpoints',
      disabled: !has,
      submenu: [nudge('whites', 5), nudge('whites', -5), nudge('blacks', 5), nudge('blacks', -5)],
    },
    { kind: 'separator' },
    {
      label: 'Reset Tone',
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
