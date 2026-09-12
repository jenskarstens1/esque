import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react'
import { cn } from './lib/cn'
import { ToastHost } from './design/ToastHost'
import { PromptHost } from './design/PromptHost'
import { TitleBar } from './shell/TitleBar'
import { PanelResizer } from './shell/PanelResizer'
import { useUI } from './state/ui'
import { LibraryModule } from './modules/library/LibraryModule'
import { DevelopModule } from './modules/develop/DevelopModule'
import { LibraryLeftPanel } from './modules/library/LibraryLeftPanel'
import { LibraryRightPanel } from './modules/library/LibraryRightPanel'
import { DevelopLeftPanel } from './modules/develop/DevelopLeftPanel'
import { DevelopRightPanel } from './modules/develop/DevelopRightPanel'
import { Filmstrip } from './modules/library/Filmstrip'
import { SmartCollectionDialog } from './modules/library/SmartCollectionDialog'
import { Toolbar } from './shell/Toolbar'
import { MobileBar } from './shell/MobileBar'
import { ImportHUD } from './shell/ImportHUD'
import { DropOverlay } from './shell/DropOverlay'
import { useKeymap } from './shell/useKeymap'
import { useTouchContextMenu } from './shell/useTouchContextMenu'
import { SettingsDialog } from './shell/SettingsDialog'
import { WelcomeDialog, type WelcomeFace } from './shell/WelcomeDialog'
import { onWhatsNew } from './shell/whatsNew'
import { APP_VERSION } from './shell/changelog'
import { useExport, restoreDestination } from './state/exportStore'
import { useCatalog } from './state/catalog'
import { usePhotoCount } from './catalog/hooks'
import { useIsCompact, useIsPhone, useWindowWidth } from './lib/useViewport'
import { Drawer, Sheet } from './design/Sheet'
import { installSaveLifecycle } from './develop/session'
import { installDropImport } from './state/dropImport'

// The export engine (ICC generation, TIFF writer, tiled renderer) is large and
// only reachable through this dialog, so it loads on demand.
const ExportDialog = lazy(() =>
  import('./modules/export/ExportDialog').then((m) => ({ default: m.ExportDialog })),
)

/**
 * When the welcome dialog shows itself, and on which face.
 *
 * Never run here → About, because nothing about this app has been established
 * yet. Run, but on an older release → What's new, because everything else has.
 * Caught up → nothing, until the menus ask for it. Closing counts as read,
 * whichever way it was opened: the notes were on screen and dismissed.
 */
function useWelcome() {
  const [face, setFace] = useState<WelcomeFace | null>(null)

  useEffect(() => {
    // Read once, off the store, rather than subscribing: the value changes on
    // dismissal, and a subscriber would reopen nothing but itself.
    const seen = useUI.getState().seenVersion
    if (seen !== APP_VERSION) setFace(seen ? 'news' : 'about')
  }, [])

  useEffect(() => {
    const open = () => setFace('news')
    return onWhatsNew(open)
  }, [])

  const close = useCallback(() => {
    setFace(null)
    useUI.getState().setSeenVersion(APP_VERSION)
  }, [])

  return { face, close }
}

/**
 * The narrowest each side panel is allowed to get. Below these the contents stop
 * being readable rather than merely tight, so a drag stops here and a rehydrated
 * width is brought back up to it.
 */
const LEFT_MIN = 180
const RIGHT_MIN = 220

type AppModule = ReturnType<typeof useUI.getState>['module']

function AppTitleBar({ onSettings }: { onSettings: () => void }) {
  const openExport = useExport((state) => state.openDialog)
  const selectedCount = useCatalog((state) => state.selected.length)
  const primaryId = useCatalog((state) => state.primaryId)
  const canExport = selectedCount > 0 || !!primaryId

  const exportSelection = useCallback(() => {
    const { selected, primaryId: primary } = useCatalog.getState()
    const ids = selected.length ? selected : primary ? [primary] : []
    if (ids.length) openExport(ids)
  }, [openExport])

  return <TitleBar onExport={exportSelection} canExport={canExport} onSettings={onSettings} />
}

function AppOverlays({
  settingsOpen,
  closeSettings,
  welcome,
}: {
  settingsOpen: boolean
  closeSettings: () => void
  welcome: ReturnType<typeof useWelcome>
}) {
  return (
    <>
      <ImportHUD />
      <ToastHost />
      <PromptHost />
      <SmartCollectionDialog />
      <Suspense fallback={null}>
        <ExportDialog />
      </Suspense>
      <SettingsDialog open={settingsOpen} onClose={closeSettings} />
      <WelcomeDialog
        open={welcome.face !== null}
        face={welcome.face ?? 'about'}
        onClose={welcome.close}
      />
    </>
  )
}

function modulePanels(module: AppModule) {
  if (module === 'library') {
    return { left: <LibraryLeftPanel />, right: <LibraryRightPanel /> }
  }
  return { left: <DevelopLeftPanel />, right: <DevelopRightPanel /> }
}

function CompactLayout({
  onSettings,
  overlays,
}: {
  onSettings: () => void
  overlays: ReactNode
}) {
  const module = useUI((s) => s.module)
  const filmstripOpen = useUI((s) => s.filmstripOpen)
  const toolbarOpen = useUI((s) => s.toolbarOpen)
  const leftWidth = Math.max(LEFT_MIN, useUI((s) => s.leftPanelWidth))
  const rightWidth = Math.max(RIGHT_MIN, useUI((s) => s.rightPanelWidth))
  const filmstripHeight = useUI((s) => s.filmstripHeight)
  const photoCount = usePhotoCount()
  const phone = useIsPhone()
  const overlayPanel = useUI((s) => s.overlayPanel)
  const setOverlayPanel = useUI((s) => s.setOverlayPanel)
  const panels = modulePanels(module)

  return (
    <div className="flex h-full flex-col bg-base">
      <AppTitleBar onSettings={onSettings} />
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
        <div className="relative min-h-0 flex-1">
          {module === 'library' ? <LibraryModule /> : <DevelopModule />}
          <DropOverlay />
        </div>
        {toolbarOpen && !phone && <Toolbar />}
      </main>
      {!phone && filmstripOpen && photoCount > 0 && (
        <div style={{ height: filmstripHeight }} className="hairline-t relative shrink-0 bg-panel">
          <Filmstrip />
        </div>
      )}
      {phone && <MobileBar />}
      <Drawer
        open={overlayPanel === 'left'}
        onClose={() => setOverlayPanel(null)}
        side="left"
        width={Math.max(leftWidth, 260)}
        label={module === 'library' ? 'Catalog' : 'Presets and history'}
      >
        {panels.left}
      </Drawer>
      {phone ? (
        <Sheet
          open={overlayPanel === 'right'}
          onClose={() => setOverlayPanel(null)}
          title={module === 'library' ? 'Info' : 'Edit'}
          height={0.66}
        >
          {panels.right}
        </Sheet>
      ) : (
        <Drawer
          open={overlayPanel === 'right'}
          onClose={() => setOverlayPanel(null)}
          side="right"
          width={Math.max(rightWidth, 280)}
          label={module === 'library' ? 'Info' : 'Edit'}
        >
          {panels.right}
        </Drawer>
      )}
      {overlays}
    </div>
  )
}

function DesktopPanel({
  side,
  open,
  size,
  min,
  max,
  onResize,
  onToggle,
  children,
}: {
  side: 'left' | 'right'
  open: boolean
  size: number
  min: number
  max: number
  onResize: (size: number) => void
  onToggle: () => void
  children: ReactNode
}) {
  const recover = (value: number) => {
    if (value < 40) return
    onResize(Math.max(min, value))
    onToggle()
  }
  const closedHandle = !open && (
    <div className={cn('relative z-20 w-0 shrink-0', side === 'left' ? 'translate-x-1' : '-translate-x-1')}>
      <PanelResizer
        side={side}
        size={0}
        min={0}
        max={max}
        onResize={recover}
        onDoubleClick={onToggle}
      />
    </div>
  )
  const panel = (
    <aside
      style={{ width: open ? size : 0 }}
      className={cn(
        'relative shrink-0 overflow-hidden bg-panel',
        'transition-[width] duration-[--duration-base] ease-[--ease-out]',
      )}
    >
      <div style={{ width: size }} className={cn('h-full', side === 'left' ? 'hairline-r' : 'hairline-l')}>
        {children}
      </div>
      {open && (
        <PanelResizer
          side={side}
          size={size}
          min={min}
          max={max}
          onResize={onResize}
          onDoubleClick={onToggle}
        />
      )}
    </aside>
  )
  return side === 'left' ? <>{panel}{closedHandle}</> : <>{closedHandle}{panel}</>
}

function DesktopFilmstrip() {
  const open = useUI((state) => state.filmstripOpen)
  const height = useUI((state) => state.filmstripHeight)
  const setHeight = useUI((state) => state.setFilmstripHeight)
  const photoCount = usePhotoCount()
  const visible = open && photoCount > 0

  return (
    <div
      style={{ height: visible ? height : 0 }}
      className={cn(
        'relative shrink-0 overflow-hidden bg-panel',
        'transition-[height] duration-[--duration-base] ease-[--ease-out]',
      )}
    >
      <div style={{ height }} className="hairline-t h-full">
        <Filmstrip />
      </div>
      {visible && (
        <PanelResizer
          side="top"
          size={height}
          min={64}
          max={220}
          onResize={setHeight}
        />
      )}
    </div>
  )
}

function DesktopLayout({
  onSettings,
  overlays,
}: {
  onSettings: () => void
  overlays: ReactNode
}) {
  const module = useUI((state) => state.module)
  const leftOpen = useUI((state) => state.leftPanelOpen)
  const rightOpen = useUI((state) => state.rightPanelOpen)
  const toolbarOpen = useUI((state) => state.toolbarOpen)
  const leftWidth = Math.max(LEFT_MIN, useUI((state) => state.leftPanelWidth))
  const rightWidth = Math.max(RIGHT_MIN, useUI((state) => state.rightPanelWidth))
  const setPanelWidth = useUI((state) => state.setPanelWidth)
  const toggleLeft = useUI((state) => state.toggleLeftPanel)
  const toggleRight = useUI((state) => state.toggleRightPanel)
  const viewportWidth = useWindowWidth()
  const panels = modulePanels(module)
  const panelMax = (limit: number) =>
    Math.max(180, Math.min(limit, Math.round(viewportWidth * 0.32)))

  return (
    <div className="flex h-full flex-col bg-base">
      <AppTitleBar onSettings={onSettings} />
      <div className="flex min-h-0 flex-1">
        <DesktopPanel
          side="left"
          open={leftOpen}
          size={leftWidth}
          min={LEFT_MIN}
          max={panelMax(420)}
          onResize={(width) => setPanelWidth('left', width)}
          onToggle={toggleLeft}
        >
          {panels.left}
        </DesktopPanel>
        <main className="relative flex min-w-0 flex-1 flex-col bg-canvas">
          <div className="relative min-h-0 flex-1">
            {module === 'library' ? <LibraryModule /> : <DevelopModule />}
            <DropOverlay />
          </div>
          {toolbarOpen && <Toolbar />}
        </main>
        <DesktopPanel
          side="right"
          open={rightOpen}
          size={rightWidth}
          min={RIGHT_MIN}
          max={panelMax(460)}
          onResize={(width) => setPanelWidth('right', width)}
          onToggle={toggleRight}
        >
          {panels.right}
        </DesktopPanel>
      </div>
      <DesktopFilmstrip />
      {overlays}
    </div>
  )
}

export default function App() {
  const compact = useIsCompact()
  const setCompact = useUI((state) => state.setCompact)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const welcome = useWelcome()

  useKeymap()
  useTouchContextMenu()
  useEffect(() => installSaveLifecycle(), [])
  useEffect(() => installDropImport(), [])
  useEffect(() => setCompact(compact), [compact, setCompact])

  useEffect(() => {
    const open = () => setSettingsOpen(true)
    window.addEventListener('esque:settings', open)
    return () => window.removeEventListener('esque:settings', open)
  }, [])

  useEffect(() => {
    const restore = () => void restoreDestination()
    if (typeof window.requestIdleCallback === 'function') {
      const idle = window.requestIdleCallback(restore)
      return () => window.cancelIdleCallback(idle)
    }
    const timer = window.setTimeout(restore, 1200)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    const suppress = (event: MouseEvent) => {
      if (event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      event.preventDefault()
    }
    document.addEventListener('contextmenu', suppress)
    return () => document.removeEventListener('contextmenu', suppress)
  }, [])

  const overlays = (
    <AppOverlays
      settingsOpen={settingsOpen}
      closeSettings={() => setSettingsOpen(false)}
      welcome={welcome}
    />
  )
  return compact ? (
    <CompactLayout onSettings={() => setSettingsOpen(true)} overlays={overlays} />
  ) : (
    <DesktopLayout onSettings={() => setSettingsOpen(true)} overlays={overlays} />
  )
}
