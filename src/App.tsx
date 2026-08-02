import { lazy, Suspense, useEffect, useState } from 'react'
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
import { Toolbar } from './shell/Toolbar'
import { ImportHUD } from './shell/ImportHUD'
import { useKeymap } from './shell/useKeymap'
import { SettingsDialog } from './shell/SettingsDialog'
import { useExport } from './state/exportStore'
import { useCatalog } from './state/catalog'
import { usePhotoCount } from './catalog/hooks'

// The export engine (ICC generation, TIFF writer, tiled renderer) is large and
// only reachable through this dialog, so it loads on demand.
const ExportDialog = lazy(() =>
  import('./modules/export/ExportDialog').then((m) => ({ default: m.ExportDialog })),
)

export default function App() {
  const module = useUI((s) => s.module)
  const leftOpen = useUI((s) => s.leftPanelOpen)
  const rightOpen = useUI((s) => s.rightPanelOpen)
  const filmstripOpen = useUI((s) => s.filmstripOpen)
  const toolbarOpen = useUI((s) => s.toolbarOpen)
  const leftWidth = useUI((s) => s.leftPanelWidth)
  const rightWidth = useUI((s) => s.rightPanelWidth)
  const filmstripHeight = useUI((s) => s.filmstripHeight)
  const setPanelWidth = useUI((s) => s.setPanelWidth)
  const setFilmstripHeight = useUI((s) => s.setFilmstripHeight)
  const photoCount = usePhotoCount()
  const toggleLeft = useUI((s) => s.toggleLeftPanel)
  const toggleRight = useUI((s) => s.toggleRightPanel)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const openExport = useExport((s) => s.openDialog)

  useKeymap()

  useEffect(() => {
    const open = () => setSettingsOpen(true)
    window.addEventListener('esque:settings', open)
    return () => window.removeEventListener('esque:settings', open)
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
            {module === 'library' ? <LibraryLeftPanel /> : <DevelopLeftPanel />}
          </div>
          {leftOpen && (
            <PanelResizer
              side="left"
              size={leftWidth}
              min={180}
              max={420}
              onResize={(w) => setPanelWidth('left', w)}
              onDoubleClick={toggleLeft}
            />
          )}
        </aside>

        {/* Center */}
        <main className="relative flex min-w-0 flex-1 flex-col bg-canvas">
          <div className="relative min-h-0 flex-1">
            {module === 'library' ? <LibraryModule /> : <DevelopModule />}
          </div>
          {toolbarOpen && <Toolbar />}
        </main>

        {/* Right panel */}
        <aside
          style={{ width: rightOpen ? rightWidth : 0 }}
          className={cn(
            'relative shrink-0 overflow-hidden bg-panel',
            'transition-[width] duration-[--duration-base] ease-[--ease-out]',
          )}
        >
          <div style={{ width: rightWidth }} className="hairline-l h-full">
            {module === 'library' ? <LibraryRightPanel /> : <DevelopRightPanel />}
          </div>
          {rightOpen && (
            <PanelResizer
              side="right"
              size={rightWidth}
              min={220}
              max={460}
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
      <Suspense fallback={null}>
        <ExportDialog />
      </Suspense>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
