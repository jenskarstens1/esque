import { SegmentedControl, IconButton, IconLink } from '../design/Controls'
import { Tooltip } from '../design/Tooltip'
import { Logo, ExportIcon, GitHubIcon, SettingsIcon } from '../design/icons'
import { useUI, type Module } from '../state/ui'

/*
 * esque is AGPL-3.0, which asks a network-served build to offer its source to
 * the people using it. A permanent link in the chrome is the plainest way to
 * do that, and it is where anyone would look for the repo anyway.
 */
const REPO_URL = 'https://github.com/jenskarstens1/esque'

export function TitleBar({
  onExport,
  onSettings,
}: {
  onExport: () => void
  onSettings: () => void
}) {
  const module = useUI((s) => s.module)
  const setModule = useUI((s) => s.setModule)

  return (
    <header className="material-thick hairline-b relative z-30 flex h-11 shrink-0 items-center gap-3 px-3">
      <div className="flex w-56 items-center gap-[3px]">
        <Logo size={18} className="shrink-0" />
        <span className="font-display text-title font-[590] tracking-[-0.025em] text-label">
          esque
        </span>
      </div>

      <div className="flex flex-1 justify-center">
        <SegmentedControl<Module>
          value={module}
          onChange={setModule}
          options={[
            { value: 'library', label: 'Library', title: 'Library  (G)' },
            { value: 'develop', label: 'Develop', title: 'Develop  (D)' },
          ]}
          className="w-56"
        />
      </div>

      <div className="flex w-56 items-center justify-end gap-0.5">
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
        <Tooltip content="Source on GitHub">
          <IconLink
            label="Source on GitHub"
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
          >
            <GitHubIcon />
          </IconLink>
        </Tooltip>
      </div>
    </header>
  )
}
