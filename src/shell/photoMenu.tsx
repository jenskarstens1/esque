import type { MenuItem } from '../design/Menu'
import {
  CollectionIcon,
  CopyIcon,
  ExportIcon,
  FlagIcon,
  LoupeIcon,
  RejectIcon,
  ResetIcon,
  SlidersIcon,
  StackIcon,
  StarIcon,
  TrashIcon,
} from '../design/icons'
import {
  addToCollection,
  createCollection,
  createVirtualCopy,
  removeFromCollection,
  removePhotos,
  resetEdits,
  setFlag,
  setLabel,
  setRating,
  stackPhotos,
  toggleStack,
  unstackPhotos,
} from '../catalog/actions'
import { db } from '../catalog/db'
import { cloneEdits, defaultEdits, editsKind } from '../core/defaults'
import { useCatalog } from '../state/catalog'
import { useUI } from '../state/ui'
import { useDevelop, ALL_SECTIONS } from '../develop/session'
import { useExport } from '../state/exportStore'
import { toast } from '../design/toast'
import type { Collection, ColorLabel, Edits, Photo } from '../core/types'

const LABELS: Array<{ value: ColorLabel; label: string; shortcut?: string }> = [
  { value: 'red', label: 'Red', shortcut: '6' },
  { value: 'yellow', label: 'Yellow', shortcut: '7' },
  { value: 'green', label: 'Green', shortcut: '8' },
  { value: 'blue', label: 'Blue', shortcut: '9' },
  { value: 'purple', label: 'Purple' },
  { value: 'none', label: 'None' },
]

const swatch = (label: ColorLabel) =>
  label === 'none' ? null : (
    <span
      className="size-2 rounded-[2px]"
      style={{ background: `var(--color-label-${label})` }}
      aria-hidden
    />
  )

/**
 * The photo context menu, shared by the grid, the filmstrip, the loupe and the
 * develop canvas.
 *
 * Right-clicking a photo that is not in the current selection retargets the
 * selection to it first — every desktop app does this, and without it a menu
 * opened on one thumbnail silently acts on a dozen others.
 */
export function photoMenuItems(photo: Photo, options: PhotoMenuOptions = {}): MenuItem[] {
  const cat = useCatalog.getState()
  const ui = useUI.getState()

  const inSelection = cat.selected.includes(photo.id)
  const targets = inSelection && cat.selected.length ? cat.selected : [photo.id]
  const many = targets.length > 1
  const suffix = many ? ` (${targets.length})` : ''

  const dev = useDevelop.getState()
  const isDeveloping = ui.module === 'develop' && dev.photoId === photo.id
  const canPaste = !!dev.clipboard
  const compact = !!options.compact

  const navigation: MenuItem[] = compact
    ? []
    : [
        {
          label: many ? `Open in Loupe${suffix}` : 'Open in Loupe',
          icon: <LoupeIcon size={12} />,
          shortcut: 'E',
          onSelect: () => {
            ui.setModule('library')
            ui.setViewMode('loupe')
          },
        },
        {
          label: 'Edit in Develop',
          icon: <SlidersIcon size={12} />,
          shortcut: 'D',
          onSelect: () => ui.setModule('develop'),
        },
        { kind: 'separator' },
      ]

  const settings: MenuItem[] = compact
    ? []
    : [
        {
          label: `Copy Settings${isDeveloping ? '' : suffix}`,
          icon: <CopyIcon size={12} />,
          shortcut: '⇧⌘C',
          disabled: !isDeveloping,
          onSelect: () => {
            dev.copySettings(ALL_SECTIONS)
            toast.show('Settings copied')
          },
        },
        {
          label: `Paste Settings${suffix}`,
          shortcut: '⇧⌘V',
          disabled: !canPaste,
          onSelect: () => void pasteToAll(targets),
        },
        {
          label: `Reset Settings${suffix}`,
          icon: <ResetIcon size={12} />,
          onSelect: () => {
            void resetEdits(targets)
            if (isDeveloping) dev.resetAll()
            toast.show(many ? `Reset ${targets.length} photos` : 'Settings reset')
          },
        },
        { kind: 'separator' },
      ]

  return [
    ...navigation,

    // --- Flags & marks -------------------------------------------------------
    {
      label: 'Flag',
      icon: <FlagIcon size={12} filled={photo.flag === 'pick'} />,
      submenu: [
        {
          label: 'Pick',
          shortcut: 'P',
          checked: photo.flag === 'pick',
          onSelect: () => void setFlag(targets, 'pick'),
        },
        {
          label: 'Reject',
          shortcut: 'X',
          icon: <RejectIcon size={12} />,
          checked: photo.flag === 'reject',
          onSelect: () => void setFlag(targets, 'reject'),
        },
        {
          label: 'Unflagged',
          shortcut: 'U',
          checked: photo.flag === 'unflagged',
          onSelect: () => void setFlag(targets, 'unflagged'),
        },
      ],
    },
    {
      label: 'Rating',
      icon: <StarIcon size={12} filled={photo.rating > 0} />,
      submenu: [0, 1, 2, 3, 4, 5].map((n) => ({
        label: n === 0 ? 'None' : `${n} Star${n === 1 ? '' : 's'}`,
        shortcut: String(n),
        checked: photo.rating === n,
        onSelect: () => void setRating(targets, n),
      })),
    },
    {
      label: 'Color Label',
      submenu: LABELS.map((l) => ({
        label: l.label,
        shortcut: l.shortcut,
        icon: swatch(l.value),
        checked: photo.label === l.value,
        onSelect: () => void setLabel(targets, l.value),
      })),
    },
    { kind: 'separator' },

    // --- Develop settings ----------------------------------------------------
    ...settings,

    // --- Copies, stacks, collections ----------------------------------------
    {
      label: 'Create Virtual Copy',
      onSelect: () => void createVirtualCopy(photo.id),
    },
    {
      label: photo.stackId ? 'Stack' : `Stack${suffix}`,
      icon: <StackIcon size={12} />,
      submenu: [
        {
          label: 'Group into Stack',
          disabled: targets.length < 2,
          onSelect: () => void stackPhotos(targets),
        },
        {
          label: 'Unstack',
          disabled: !photo.stackId,
          onSelect: () => photo.stackId && void unstackPhotos(photo.stackId),
        },
        {
          label: 'Expand / Collapse Stack',
          disabled: !photo.stackId,
          onSelect: () => photo.stackId && void toggleStack(photo.stackId),
        },
      ],
    },
    {
      label: 'Add to Collection',
      icon: <CollectionIcon size={12} />,
      submenu: collectionSubmenu(targets, options.collections ?? []),
    },
    ...(options.collectionId
      ? ([
          {
            label: `Remove from Collection${suffix}`,
            onSelect: () => void removeFromCollection(options.collectionId!, targets),
          },
        ] as MenuItem[])
      : []),
    { kind: 'separator' },

    {
      label: `Export…${suffix}`,
      icon: <ExportIcon size={12} />,
      shortcut: '⇧⌘E',
      onSelect: () => useExport.getState().openDialog(targets),
    },
    {
      label: `Show in Info${suffix}`,
      onSelect: () => {
        if (!ui.rightPanelOpen) ui.toggleRightPanel()
      },
    },
    { kind: 'separator' },
    {
      label: many ? `Remove ${targets.length} Photos` : 'Remove Photo',
      icon: <TrashIcon size={12} />,
      danger: true,
      onSelect: () => void removePhotos(targets),
    },
  ]
}

export interface PhotoMenuOptions {
  /** Offered in the "Add to Collection" submenu. */
  collections?: Collection[]
  /** When the menu is opened from inside a collection, allow removing from it. */
  collectionId?: string
  /**
   * Drops the navigation and develop-settings entries. Used when the menu is
   * appended to a surface that already offers them — the develop canvas.
   */
  compact?: boolean
}

/**
 * Right-click selection semantics: a photo outside the current selection
 * becomes the selection, one already inside it leaves the selection alone.
 */
export function retargetSelection(photoId: string) {
  const cat = useCatalog.getState()
  if (!cat.selected.includes(photoId)) cat.select(photoId)
  else cat.setPrimary(photoId)
}

async function pasteToAll(targets: string[]) {
  const dev = useDevelop.getState()
  const clip = dev.clipboard
  if (!clip) return

  // The photo on the canvas goes through the session so the paste lands in its
  // history; anything else is written to the catalog and re-thumbnailed.
  const onCanvas = dev.photoId && targets.includes(dev.photoId)
  if (onCanvas) dev.pasteSettings()

  const others = targets.filter((id) => id !== dev.photoId)
  if (others.length) {
    const rows = (await db.photos.bulkGet(others)).filter(Boolean) as Photo[]
    const pasted = new Map<string, Edits>()
    for (const p of rows) {
      // An unedited target starts from its own baseline: a JPEG must not
      // inherit a RAW's capture sharpening just because Detail wasn't copied.
      const next = cloneEdits(
        p.edits ?? defaultEdits(editsKind(p.isRaw), undefined, p.meta.iso),
      )
      for (const section of clip.sections) {
        next[section] = structuredClone(clip.edits[section]) as never
      }
      pasted.set(p.id, next)
    }
    await db.photos.bulkUpdate(
      rows.map((p) => ({ key: p.id, changes: { edits: pasted.get(p.id)! } })),
    )
    const { refreshThumb } = await import('../develop/thumbs')
    for (const p of rows) refreshThumb(p.id, pasted.get(p.id)!)
  }

  toast.show(targets.length > 1 ? `Pasted to ${targets.length} photos` : 'Settings pasted')
}

function collectionSubmenu(targets: string[], collections: Collection[]): MenuItem[] {
  const usable = collections.filter((c) => !c.smart)
  return [
    {
      label: 'New Collection…',
      onSelect: async () => {
        const id = await createCollection('Untitled Collection', targets)
        if (id) toast.show('Collection created')
      },
    },
    ...(usable.length ? ([{ kind: 'separator' }] as MenuItem[]) : []),
    ...usable.map<MenuItem>((c) => ({
      label: c.name,
      onSelect: () => void addToCollection(c.id, targets),
    })),
    ...(collections.length && !usable.length
      ? ([{ label: 'Smart collections update themselves', disabled: true }] as MenuItem[])
      : []),
  ]
}
