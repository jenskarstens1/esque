import { PanelSection, MiniAction } from '../../../design/Panel'
import { panelMenuItems } from '../../../shell/appMenus'
import { Select } from '../../../design/Controls'
import { EditSlider } from '../EditSlider'
import { isSectionModified } from '../../../develop/modified'
import { Group } from './BasicPanel'
import { useDevelop } from '../../../develop/session'
import type { HighlightRecovery } from '../../../core/types'

const RECOVERY_OPTIONS: Array<{ value: HighlightRecovery; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'clip', label: 'Clip' },
  { value: 'blend', label: 'Blend' },
  { value: 'propagate', label: 'Color Propagation' },
]

/**
 * Local tone mapping and multiscale contrast, downstream of the global display
 * rendering controls in Basic.
 */
export function TonePanel() {
  const modified = useDevelop((s) => isSectionModified(s.edits, 'tone', s.kind))
  const isRaw = useDevelop((s) => s.kind === 'raw')
  const recovery = useDevelop((s) => s.edits.tone.recovery)
  const noSh = useDevelop((s) => !s.edits.tone.shHighlights && !s.edits.tone.shShadows)
  const noDrc = useDevelop((s) => s.edits.tone.drcAmount === 0)
  const update = useDevelop((s) => s.update)
  const reset = useDevelop((s) => s.resetSection)

  const setRecovery = (mode: HighlightRecovery) =>
    update(
      'tone.recovery',
      'Highlight Reconstruction',
      (e) => {
        e.tone.recovery = mode
      },
      false,
    )

  return (
    <PanelSection
      menuItems={() => panelMenuItems('tone')}
      title="Tone Mapping"
      defaultOpen={false}
      modified={modified}
      actions={<MiniAction onClick={() => reset('tone')}>Reset</MiniAction>}
    >
      {isRaw && (
        <Group label="Highlight Reconstruction">
          <div className="mb-1 flex items-center gap-2">
            <span className="w-[44px] shrink-0 text-mini text-label-tertiary">Mode</span>
            <Select
              value={recovery}
              options={RECOVERY_OPTIONS}
              onChange={setRecovery}
              className="min-w-0 flex-1"
            />
          </div>
          <EditSlider
            path="tone.recoveryThreshold"
            label="Threshold"
            min={20}
            max={100}
            origin={100}
            disabled={recovery === 'off' || recovery === 'clip'}
          />
        </Group>
      )}

      <Group label="Local Shadows / Highlights">
        <EditSlider path="tone.shHighlights" label="Highlights" min={0} max={100} origin={0} />
        <EditSlider path="tone.shShadows" label="Shadows" min={0} max={100} origin={0} />
        <EditSlider
          path="tone.shRadius"
          label="Radius"
          min={1}
          max={100}
          origin={40}
          disabled={noSh}
        />
        <EditSlider
          path="tone.shTonalWidth"
          label="Tonal Width"
          min={10}
          max={100}
          origin={70}
          disabled={noSh}
        />
      </Group>

      <Group label="Dynamic Range Compression">
        <EditSlider path="tone.drcAmount" label="Compression" min={0} max={100} origin={0} />
        <EditSlider
          path="tone.drcDetail"
          label="Detail"
          min={0}
          max={100}
          origin={50}
          disabled={noDrc}
        />
      </Group>

      <Group label="Contrast by Detail Levels">
        <EditSlider path="tone.detailFinest" label="Finest" min={-100} max={100} />
        <EditSlider path="tone.detailFine" label="Fine" min={-100} max={100} />
        <EditSlider path="tone.detailCoarse" label="Coarse" min={-100} max={100} />
        <EditSlider path="tone.detailCoarsest" label="Coarsest" min={-100} max={100} />
        <EditSlider path="tone.detailThreshold" label="Threshold" min={0} max={100} origin={20} />
      </Group>
    </PanelSection>
  )
}
