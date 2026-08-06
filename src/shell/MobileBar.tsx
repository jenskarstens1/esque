/**
 * The phone's bottom bar.
 *
 * On a phone there is no room to keep two side panels, a toolbar and a filmstrip
 * on screen at once, so the chrome collapses to one row of destinations at the
 * bottom edge — where a thumb actually reaches — and each one opens the panel it
 * names as a drawer or a sheet.
 *
 * It carries what the module needs rather than a fixed set: culling a shoot and
 * grading a frame want different things under the thumb.
 */
import { cn } from '../lib/cn'
import {
  CollectionIcon,
  FilterIcon,
  GridIcon,
  InfoIcon,
  LoupeIcon,
  MaskIcon,
  PresetIcon,
  SlidersIcon,
} from '../design/icons'
import { useUI } from '../state/ui'
import type { ReactNode } from 'react'

export function MobileBar() {
  const module = useUI((s) => s.module)
  const viewMode = useUI((s) => s.viewMode)
  const setViewMode = useUI((s) => s.setViewMode)
  const developTool = useUI((s) => s.developTool)
  const setDevelopTool = useUI((s) => s.setDevelopTool)
  /*
   * The bar only renders in the compact shell, where the panels are transient
   * drawers tracked by `overlayPanel`. The persisted `leftPanelOpen` /
   * `rightPanelOpen` flags describe the desktop layout and both default to
   * true, so reading them here would light up two tabs at rest.
   */
  const overlayPanel = useUI((s) => s.overlayPanel)
  const leftOpen = overlayPanel === 'left'
  const rightOpen = overlayPanel === 'right'
  const toggleLeft = useUI((s) => s.toggleLeftPanel)
  const toggleRight = useUI((s) => s.toggleRightPanel)
  const filterBarOpen = useUI((s) => s.filterBarOpen)
  const toggleFilterBar = useUI((s) => s.toggleFilterBar)

  return (
    <nav
      aria-label="Views"
      className="material-thick hairline-t esq-safe-b esq-safe-x relative z-30 flex shrink-0 items-stretch justify-around px-1 pt-1"
    >
      {module === 'library' ? (
        <>
          <Tab
            label="Catalog"
            icon={<CollectionIcon size={19} />}
            active={leftOpen}
            onClick={toggleLeft}
          />
          <Tab
            label={viewMode === 'grid' ? 'Loupe' : 'Grid'}
            icon={viewMode === 'grid' ? <LoupeIcon size={19} /> : <GridIcon size={19} />}
            onClick={() => setViewMode(viewMode === 'grid' ? 'loupe' : 'grid')}
          />
          <Tab
            label="Filter"
            icon={<FilterIcon size={19} />}
            active={filterBarOpen}
            onClick={toggleFilterBar}
          />
          <Tab
            label="Info"
            icon={<InfoIcon size={19} />}
            active={rightOpen}
            onClick={toggleRight}
          />
        </>
      ) : (
        <>
          <Tab
            label="Presets"
            icon={<PresetIcon size={19} />}
            active={leftOpen}
            onClick={toggleLeft}
          />
          <Tab
            label="Masks"
            icon={<MaskIcon size={19} />}
            active={developTool === 'mask'}
            onClick={() => setDevelopTool('mask')}
          />
          <Tab
            label="Edit"
            icon={<SlidersIcon size={19} />}
            active={rightOpen}
            onClick={toggleRight}
          />
        </>
      )}
    </nav>
  )
}

/*
 * A full 44pt column each, label always shown. Icon-only would be denser, but
 * this bar is the only way to reach the panels on a phone, and a row of unlabelled
 * glyphs is a guess — the same reason the platform tab bars keep their captions.
 */
function Tab({
  label,
  icon,
  active,
  onClick,
}: {
  label: string
  icon: ReactNode
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex min-h-[46px] flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-2 pb-1',
        'transition-[color,background-color,scale] duration-[--duration-fast] ease-[--ease-out]',
        'active:scale-95 active:bg-raised',
        active ? 'text-accent' : 'text-icon-tertiary',
      )}
    >
      {icon}
      <span className="text-micro font-medium tracking-[0.01em]">{label}</span>
    </button>
  )
}
