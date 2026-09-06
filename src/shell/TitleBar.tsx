import { SegmentedControl, IconButton, IconLink } from '../design/Controls'
import { Tooltip } from '../design/Tooltip'
import { Logo, ExportIcon, GitHubIcon, InfoIcon, MoreHorizontalIcon, SettingsIcon } from '../design/icons'
import { useUI, type Module } from '../state/ui'
import { useIsCompact, useIsPhone } from '../lib/useViewport'
import { useMenu } from '../design/useMenu'
import { MENU_ICON } from '../design/Menu'
import { cn } from '../lib/cn'
import { REPO_URL } from './changelog'
import { openWhatsNew } from './whatsNew'

export function TitleBar({
  onExport,
  onSettings,
}: {
  onExport: () => void
  onSettings: () => void
}) {
  const module = useUI((s) => s.module)
  const setModule = useUI((s) => s.setModule)
  const compact = useIsCompact()
  const phone = useIsPhone()
  const { menu, openAt } = useMenu()

  /*
   * The desktop bar is three equal 224px blocks so the module switch sits on the
   * window's true centre. That symmetry costs ~700px, more than a phone has, so
   * below the break the side blocks shrink to their content and the switch takes
   * the middle of what is left — a few pixels off centre, and present rather
   * than clipped off the edge.
   */
  const sideBlock = compact ? 'flex shrink-0 items-center' : 'flex w-56 items-center'

  return (
    <header
      className={cn(
        'material-thick hairline-b esq-safe-t esq-safe-px-3 relative z-30',
        'flex shrink-0 items-center gap-3',
        // Grows by the notch inset rather than letting content sit under it.
        compact ? 'min-h-11 py-1' : 'h-11',
      )}
    >
      <div className={cn(sideBlock, 'gap-[3px]')}>
        <Logo size={18} className="shrink-0" />
        {/* On a phone the mark is the wordmark: six letters are the least useful
            thing competing for the one row of chrome there is. */}
        {!phone && (
          <span className="font-display text-title font-[590] tracking-[-0.025em] text-label">
            esque
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-1 justify-center">
        <SegmentedControl<Module>
          value={module}
          onChange={setModule}
          options={[
            { value: 'library', label: 'Library', title: 'Library  (G)' },
            { value: 'develop', label: 'Develop', title: 'Develop  (D)' },
          ]}
          className={compact ? 'w-full max-w-56' : 'w-56'}
        />
      </div>

      <div className={cn(sideBlock, 'justify-end gap-0.5')}>
        {phone ? (
          /*
           * Three targets don't fit beside the module switch, and the source link
           * is a destination rather than an action — it belongs in an overflow,
           * not on the row someone reaches for to change module.
           */
          <>
            <IconButton
              label="More"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                openAt(
                  r.right,
                  r.bottom + 4,
                  [
                    { label: 'Export…', icon: <ExportIcon size={MENU_ICON} />, onSelect: onExport },
                    {
                      label: 'Settings…',
                      icon: <SettingsIcon size={MENU_ICON} />,
                      onSelect: onSettings,
                    },
                    { kind: 'separator' },
                    {
                      label: "What's new…",
                      icon: <InfoIcon size={MENU_ICON} />,
                      onSelect: openWhatsNew,
                    },
                    {
                      label: 'Source on GitHub',
                      // A pixel under its neighbours: a solid silhouette puts
                      // more ink on the same box than a 1.75px outline does.
                      icon: <GitHubIcon size={MENU_ICON - 1} />,
                      onSelect: () => window.open(REPO_URL, '_blank', 'noreferrer'),
                    },
                  ],
                  { fromRight: true },
                )
              }}
            >
              <MoreHorizontalIcon />
            </IconButton>
            {menu}
          </>
        ) : (
          <>
            <Tooltip content="Export" shortcut="⇧⌘E">
              <IconButton label="Export" onClick={onExport}>
                <ExportIcon />
              </IconButton>
            </Tooltip>
            <Tooltip content="Settings" shortcut="⌘,">
              <IconButton label="Settings" onClick={onSettings}>
                <SettingsIcon />
              </IconButton>
            </Tooltip>
            <Tooltip content="What's new">
              <IconButton label="What's new" onClick={openWhatsNew}>
                <InfoIcon />
              </IconButton>
            </Tooltip>
            <Tooltip content="Source on GitHub">
              <IconLink label="Source on GitHub" href={REPO_URL} target="_blank" rel="noreferrer">
                <GitHubIcon />
              </IconLink>
            </Tooltip>
          </>
        )}
      </div>
    </header>
  )
}
