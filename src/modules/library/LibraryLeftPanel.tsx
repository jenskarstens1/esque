import { useState } from 'react'
import { cn } from '../../lib/cn'
import { PanelSection } from '../../design/Panel'
import { Button } from '../../design/Controls'
import { Scroller } from '../../design/Scroller'
import {
  CloseIcon,
  CollectionIcon,
  FilePlusIcon,
  FolderIcon,
  ImportIcon,
  PlusIcon,
  SmartCollectionIcon,
  SyncIcon,
} from '../../design/icons'
import { useMenu } from '../../design/useMenu'
import { sourceMenuItems } from '../../shell/appMenus'
import { editSmartCollection } from '../../state/smartEditor'
import { useCatalog, type Source } from '../../state/catalog'
import { useCollections, useFolders } from '../../catalog/hooks'
import { useImporter } from '../../state/importer'
import { createCollection, removeFolder } from '../../catalog/actions'
import { checkPermission, ensurePermission } from '../../catalog/fs'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../catalog/db'
import { toast } from '../../design/toast'
import type { CatalogFolder } from '../../core/types'

export function LibraryLeftPanel() {
  const folders = useFolders()
  const collections = useCollections()
  const source = useCatalog((s) => s.source)
  const setSource = useCatalog((s) => s.setSource)
  const run = useImporter((s) => s.run)
  const runFiles = useImporter((s) => s.runFiles)
  const total = useLiveQuery(() => db.photos.count(), []) ?? 0
  const { menu, open } = useMenu()

  const isActive = (s: Source) =>
    s.kind === source.kind && ('id' in s && 'id' in source ? s.id === source.id : true)

  return (
    <Scroller frameClassName="h-full" className="flex flex-col pb-4">
      <PanelSection title="Catalog" collapsible={false}>
        <Row
          label="All Photos"
          count={total}
          active={isActive({ kind: 'all' })}
          onClick={() => setSource({ kind: 'all' })}
          icon={<CollectionIcon size={13} />}
        />
        <Row
          label="Previous Import"
          active={isActive({ kind: 'previousImport' })}
          onClick={() => setSource({ kind: 'previousImport' })}
          icon={<ImportIcon size={13} />}
        />
      </PanelSection>

      <PanelSection
        title="Folders"
        collapsible={false}
        actions={
          <>
            <button
              type="button"
              title="Import a file…"
              onClick={(e) => {
                e.stopPropagation()
                runFiles(null, e.altKey)
              }}
              className="text-icon-tertiary transition-colors hover:text-icon"
            >
              <FilePlusIcon size={12} />
            </button>
            <button
              type="button"
              title="Import a folder…"
              onClick={(e) => {
                e.stopPropagation()
                run()
              }}
              className="text-icon-tertiary transition-colors hover:text-icon"
            >
              <PlusIcon size={12} />
            </button>
          </>
        }
      >
        {folders.length === 0 ? (
          <Hint>
            <Button
              size="sm"
              variant="ghost"
              icon={<ImportIcon size={12} />}
              className="-ml-2"
              onClick={() => run()}
            >
              Import a folder…
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<FilePlusIcon size={12} />}
              onClick={() => runFiles()}
            >
              Import a file…
            </Button>
          </Hint>
        ) : (
          folders.map((f) => (
            <FolderRow
              key={f.id}
              folder={f}
              active={isActive({ kind: 'folder', id: f.id })}
              onClick={() => setSource({ kind: 'folder', id: f.id })}
              onContextMenu={(e) => open(e, sourceMenuItems({ kind: 'folder', folder: f }))}
            />
          ))
        )}
      </PanelSection>

      <PanelSection
        title="Collections"
        collapsible={false}
        actions={
          <button
            type="button"
            title="New collection"
            onClick={(e) => {
              e.stopPropagation()
              const rect = e.currentTarget.getBoundingClientRect()
              open(
                { clientX: rect.right, clientY: rect.bottom + 4, preventDefault() {}, stopPropagation() {} },
                [
                  {
                    label: 'New Collection',
                    icon: <CollectionIcon size={12} />,
                    onSelect: async () => {
                      const id = await createCollection('Untitled Collection')
                      setSource({ kind: 'collection', id })
                    },
                  },
                  {
                    label: 'New Smart Collection…',
                    icon: <SmartCollectionIcon size={12} />,
                    onSelect: () => editSmartCollection(),
                  },
                ],
              )
            }}
            className="text-icon-tertiary transition-colors hover:text-icon"
          >
            <PlusIcon size={12} />
          </button>
        }
      >
        {collections.length === 0 ? (
          <Hint>
            <span className="text-mini text-label-quaternary">
              Group photos without moving files.
            </span>
          </Hint>
        ) : (
          collections.map((c) => (
            <Row
              key={c.id}
              label={c.name}
              count={c.smart ? undefined : c.photoIds.length}
              active={isActive({ kind: 'collection', id: c.id })}
              onClick={() => setSource({ kind: 'collection', id: c.id })}
              onDoubleClick={c.smart ? () => editSmartCollection(c) : undefined}
              onContextMenu={(e) => open(e, sourceMenuItems({ kind: 'collection', collection: c }))}
              icon={
                c.smart ? (
                  <SmartCollectionIcon size={13} className="text-accent" />
                ) : (
                  <CollectionIcon size={13} />
                )
              }
            />
          ))
        )}
      </PanelSection>
      {menu}
    </Scroller>
  )
}

function FolderRow({
  folder,
  active,
  onClick,
  onContextMenu,
}: {
  folder: CatalogFolder
  active: boolean
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent) => void
}) {
  const sync = useImporter((s) => s.sync)
  const [denied, setDenied] = useState(false)

  async function reconnect(e: React.MouseEvent) {
    e.stopPropagation()
    if (!folder.handle) return
    const state = await checkPermission(folder.handle)
    if (state === 'granted') {
      sync(folder)
      return
    }
    const ok = await ensurePermission(folder.handle)
    if (ok) {
      setDenied(false)
      sync(folder)
    } else {
      setDenied(true)
      toast.error('Folder unavailable', 'Grant access to read this folder again.')
    }
  }

  return (
    <Row
      label={folder.name}
      count={folder.photoCount}
      active={active}
      onClick={onClick}
      onContextMenu={onContextMenu}
      icon={
        folder.loose ? (
          <FilePlusIcon size={13} className={denied ? 'text-orange' : undefined} />
        ) : (
          <FolderIcon size={13} className={denied ? 'text-orange' : undefined} />
        )
      }
      actions={
        <>
          {folder.handle && (
            <button
              type="button"
              title="Sync folder"
              onClick={reconnect}
              className="text-icon-tertiary transition-colors hover:text-icon"
            >
              <SyncIcon size={12} />
            </button>
          )}
          <button
            type="button"
            title="Remove from catalog"
            onClick={(e) => {
              e.stopPropagation()
              if (confirm(`Remove “${folder.name}” from the catalog?\n\nFiles on disk are not touched.`))
                removeFolder(folder.id)
            }}
            className="text-icon-tertiary transition-colors hover:text-red"
          >
            <CloseIcon size={11} />
          </button>
        </>
      }
    />
  )
}

function Row({
  label,
  count,
  active,
  onClick,
  onDoubleClick,
  onContextMenu,
  icon,
  actions,
}: {
  label: string
  count?: number
  active: boolean
  onClick: () => void
  onDoubleClick?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  icon?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
      className={cn(
        'group/row -mx-1.5 flex h-[26px] cursor-default items-center gap-2 rounded-md px-1.5',
        'transition-colors duration-[--duration-fast] ease-[--ease-out]',
        active ? 'bg-control text-label' : 'text-label-secondary hover:bg-raised hover:text-label',
      )}
    >
      <span className={cn('shrink-0', active ? 'text-accent' : 'text-icon-tertiary')}>{icon}</span>
      <span className="min-w-0 flex-1 truncate text-mini">{label}</span>
      {actions && (
        <span className="esq-reveal-flex hidden shrink-0 items-center gap-1.5 group-hover/row:flex">
          {actions}
        </span>
      )}
      {count !== undefined && (
        <span
          className={cn(
            'shrink-0 text-micro tnum text-label-quaternary',
            // The count and the row's actions share one slot. With no hover to
            // trade on, the actions simply win: a folder's count is readable
            // from the grid, its "sync" button is not reachable anywhere else.
            actions && 'group-hover/row:hidden touch:hidden',
          )}
        >
          {count.toLocaleString()}
        </span>
      )}
    </div>
  )
}

/* Rows and hints all pull out by their own padding so their icons and text land
   on the section titles' left edge, now that no chevron indents those. */
const Hint = ({ children }: { children: React.ReactNode }) => (
  <div className="flex min-h-[26px] items-center py-0.5">{children}</div>
)
