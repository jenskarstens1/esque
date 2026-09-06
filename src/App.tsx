import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
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

export default function App() {
  const module = useUI((s) => s.module)
  const leftOpen = useUI((s) => s.leftPanelOpen)
  const rightOpen = useUI((s) => s.rightPanelOpen)
  const filmstripOpen = useUI((s) => s.filmstripOpen)
  const toolbarOpen = useUI((s) => s.toolbarOpen)
  /*
   * Clamped on the way out of the store rather than trusted. The width is
   * persisted, so a value written by an older build — or by a window narrow
   * enough that `panelMax` was below the minimum — would otherwise rehydrate as
   * a few pixels of panel that reads as "the sidebar is gone" and leaves nothing
   * wide enough to grab.
   */
  const leftWidth = Math.max(LEFT_MIN, useUI((s) => s.leftPanelWidth))
  const rightWidth = Math.max(RIGHT_MIN, useUI((s) => s.rightPanelWidth))
  const filmstripHeight = useUI((s) => s.filmstripHeight)
  const setPanelWidth = useUI((s) => s.setPanelWidth)
  const setFilmstripHeight = useUI((s) => s.setFilmstripHeight)
  const photoCount = usePhotoCount()
  const toggleLeft = useUI((s) => s.toggleLeftPanel)
  const toggleRight = useUI((s) => s.toggleRightPanel)

  const compact = useIsCompact()
  const phone = useIsPhone()
  const vw = useWindowWidth()
  const setCompact = useUI((s) => s.setCompact)
  const overlayPanel = useUI((s) => s.overlayPanel)
  const setOverlayPanel = useUI((s) => s.setOverlayPanel)

  /*
   * A panel drag is bounded by the window as well as by its own limits. Without
   * this, two panels dragged wide on a large display and then carried to a
   * smaller one leave the photo with a sliver — and the resizer is the only way
   * back, at the edge of a canvas that is no longer there.
   */
  const panelMax = (limit: number) => Math.max(180, Math.min(limit, Math.round(vw * 0.32)))

  const [settingsOpen, setSettingsOpen] = useState(false)
  const welcome = useWelcome()
  const openExport = useExport((s) => s.openDialog)

  useKeymap()
  // Long press stands in for a right click, so every `onContextMenu` in the app
  // is reachable with a finger.
  useTouchContextMenu()
  useEffect(() => installSaveLifecycle(), [])

  // The panel toggles are reached from the keymap, the menus and the toolbar as
  // well as from here, so the breakpoint lives in the store rather than being
  // threaded through every caller.
  useEffect(() => setCompact(compact), [compact, setCompact])

  useEffect(() => {
    const open = () => setSettingsOpen(true)
    window.addEventListener('esque:settings', open)
    return () => window.removeEventListener('esque:settings', open)
  }, [])

  useEffect(() => {
    // Deferred to idle: nothing on screen depends on it, and the first frame
    // shouldn't wait on an IndexedDB read to find out where the last export went.
    const restore = () => void restoreDestination()
    if (typeof window.requestIdleCallback === 'function') {
      const idle = window.requestIdleCallback(restore)
      return () => window.cancelIdleCallback(idle)
    }
    const timer = window.setTimeout(restore, 1200)
    return () => window.clearTimeout(timer)
  }, [])

  /*
   * The browser's own context menu has nothing to offer a photo editor, and
   * seeing "Reload" over a print is jarring. This runs last, so anywhere the
   * app opened its own menu has already claimed the event; text fields keep
   * theirs because spelling and clipboard genuinely live there.
   */
  useEffect(() => {
    const suppress = (e: MouseEvent) => {
      if (e.defaultPrevented) return
      const el = e.target as HTMLElement | null
      if (el?.closest('input, textarea, [contenteditable="true"]')) return
      e.preventDefault()
    }
    document.addEventListener('contextmenu', suppress)
    return () => document.removeEventListener('contextmenu', suppress)
  }, [])

  const leftPanel = module === 'library' ? <LibraryLeftPanel /> : <DevelopLeftPanel />
  const rightPanel = module === 'library' ? <LibraryRightPanel /> : <DevelopRightPanel />

  /*
   * Below the desktop break the panels stop being columns. 240 + 268px of chrome
   * is more than a phone has in total, so they float over the canvas instead —
   * as a drawer on the side they came from, and on a phone the right-hand panel
   * as a bottom sheet, which is the only edge a thumb comfortably reaches.
   */
  if (compact) {
    return (
      <div className="flex h-full flex-col bg-base">
        <TitleBar
          onExport={() => {
            const { selected, primaryId } = useCatalog.getState()
            const ids = selected.length ? selected : primaryId ? [primaryId] : []
            if (ids.length) openExport(ids)
          }}
          onSettings={() => setSettingsOpen(true)}
        />

        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
          <div className="relative min-h-0 flex-1">
            {module === 'library' ? <LibraryModule /> : <DevelopModule />}
          </div>
          {/* The toolbar's clusters need ~700px; a phone gets the bottom bar instead. */}
          {toolbarOpen && !phone && <Toolbar />}
        </main>

        {/* A filmstrip on a phone would cost a fifth of the photo's height for a
            row nothing can comfortably scrub. Tablets keep it. */}
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
          {leftPanel}
        </Drawer>

        {phone ? (
          <Sheet
            open={overlayPanel === 'right'}
            onClose={() => setOverlayPanel(null)}
            title={module === 'library' ? 'Info' : 'Edit'}
            height={0.66}
          >
            {rightPanel}
          </Sheet>
        ) : (
          <Drawer
            open={overlayPanel === 'right'}
            onClose={() => setOverlayPanel(null)}
            side="right"
            width={Math.max(rightWidth, 280)}
            label={module === 'library' ? 'Info' : 'Edit'}
          >
            {rightPanel}
          </Drawer>
        )}

        <ImportHUD />
        <ToastHost />
        <PromptHost />
        <SmartCollectionDialog />
        <Suspense fallback={null}>
          <ExportDialog />
        </Suspense>
        <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        <WelcomeDialog
          open={welcome.face !== null}
          face={welcome.face ?? 'about'}
          onClose={welcome.close}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-base">
      <TitleBar
        onExport={() => {
          const { selected, primaryId } = useCatalog.getState()
          const ids = selected.length ? selected : primaryId ? [primaryId] : []
          if (ids.length) openExport(ids)
        }}
        onSettings={() => setSettingsOpen(true)}
      />

      <div className="flex min-h-0 flex-1">
        {/* Left panel */}
        <aside
          style={{ width: leftOpen ? leftWidth : 0 }}
          className={cn(
            'relative shrink-0 overflow-hidden bg-panel',
            'transition-[width] duration-[--duration-base] ease-[--ease-out]',
          )}
        >
          <div style={{ width: leftWidth }} className="hairline-r h-full">
            {leftPanel}
          </div>
          {leftOpen && (
            <PanelResizer
              side="left"
              size={leftWidth}
              min={LEFT_MIN}
              max={panelMax(420)}
              onResize={(w) => setPanelWidth('left', w)}
              onDoubleClick={toggleLeft}
            />
          )}
        </aside>

        {/*
         * A closed panel takes its resizer with it, which made hiding one a
         * one-way door: the only way back was the keymap. This zero-width strip
         * keeps the edge itself grabbable, so the panel is recovered where it
         * was lost.
         */}
        {!leftOpen && (
          // Zero-width, so it costs the canvas nothing; nudged inward by its own
          // half-width so the whole 8px of grab is on screen rather than half of
          // it hanging off the edge of the window.
          <div className="relative z-20 w-0 shrink-0 translate-x-1">
            <PanelResizer
              side="left"
              size={0}
              min={0}
              max={panelMax(420)}
              onResize={(w) => {
                if (w < 40) return
                setPanelWidth('left', Math.max(LEFT_MIN, w))
                toggleLeft()
              }}
              onDoubleClick={toggleLeft}
            />
          </div>
        )}

        {/* Center */}
        <main className="relative flex min-w-0 flex-1 flex-col bg-canvas">
          <div className="relative min-h-0 flex-1">
            {module === 'library' ? <LibraryModule /> : <DevelopModule />}
          </div>
          {toolbarOpen && <Toolbar />}
        </main>

        {/* Right panel */}
        {!rightOpen && (
          <div className="relative z-20 w-0 shrink-0 -translate-x-1">
            <PanelResizer
              side="right"
              size={0}
              min={0}
              max={panelMax(460)}
              onResize={(w) => {
                if (w < 40) return
                setPanelWidth('right', Math.max(RIGHT_MIN, w))
                toggleRight()
              }}
              onDoubleClick={toggleRight}
            />
          </div>
        )}
        <aside
          style={{ width: rightOpen ? rightWidth : 0 }}
          className={cn(
            'relative shrink-0 overflow-hidden bg-panel',
            'transition-[width] duration-[--duration-base] ease-[--ease-out]',
          )}
        >
          <div style={{ width: rightWidth }} className="hairline-l h-full">
            {rightPanel}
          </div>
          {rightOpen && (
            <PanelResizer
              side="right"
              size={rightWidth}
              min={RIGHT_MIN}
              max={panelMax(460)}
              onResize={(w) => setPanelWidth('right', w)}
              onDoubleClick={toggleRight}
            />
          )}
        </aside>
      </div>

      {/* Filmstrip spans the full width, Lightroom-style. An empty catalog has
          nothing to strip, so it collapses rather than showing a third empty state. */}
      <div
        style={{ height: filmstripOpen && photoCount > 0 ? filmstripHeight : 0 }}
        className={cn(
          'relative shrink-0 overflow-hidden bg-panel',
          'transition-[height] duration-[--duration-base] ease-[--ease-out]',
        )}
      >
        <div style={{ height: filmstripHeight }} className="hairline-t h-full">
          <Filmstrip />
        </div>
        {filmstripOpen && photoCount > 0 && (
          <PanelResizer
            side="top"
            size={filmstripHeight}
            min={64}
            max={220}
            onResize={setFilmstripHeight}
          />
        )}
      </div>

      <ImportHUD />
      <ToastHost />
      <PromptHost />
      <SmartCollectionDialog />
      <Suspense fallback={null}>
        <ExportDialog />
      </Suspense>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <WelcomeDialog
        open={welcome.face !== null}
        face={welcome.face ?? 'about'}
        onClose={welcome.close}
      />
    </div>
  )
}
