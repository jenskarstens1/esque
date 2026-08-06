import { PanelSection, MiniAction } from '../../../design/Panel'
import { panelMenuItems } from '../../../shell/appMenus'
import { Select } from '../../../design/Controls'
import { EditSlider } from '../EditSlider'
import { isSectionModified } from '../../../develop/modified'
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
        <>
          <div className="mb-1 flex items-center gap-2">
            <span className="w-[44px] shrink-0 text-mini text-label-tertiary">Recovery</span>
            <Select
              value={recovery}
              options={RECOVERY_OPTIONS}
              onChange={setRecovery}
              className="min-w-0 flex-1"
            />
          </div>
          <EditSlider
            path="tone.recoveryThreshold"
            label="Recovery Threshold"
            min={20}
            max={100}
            origin={100}
            disabled={recovery === 'off' || recovery === 'clip'}
          />
        </>
      )}

      <EditSlider path="tone.shHighlights" label="Local Highlights" min={0} max={100} origin={0} />
      <EditSlider path="tone.shShadows" label="Local Shadows" min={0} max={100} origin={0} />
      <EditSlider
        path="tone.shRadius"
        label="Local Radius"
        min={1}
        max={100}
        origin={40}
        disabled={noSh}
      />
      <EditSlider
        path="tone.shTonalWidth"
        label="Local Tonal Width"
        min={10}
        max={100}
        origin={70}
        disabled={noSh}
      />

      <EditSlider path="tone.drcAmount" label="Range Compression" min={0} max={100} origin={0} />
      <EditSlider
        path="tone.drcDetail"
        label="Compression Detail"
        min={0}
        max={100}
        origin={50}
        disabled={noDrc}
      />

      <EditSlider path="tone.detailFinest" label="Finest Detail" min={-100} max={100} />
      <EditSlider path="tone.detailFine" label="Fine Detail" min={-100} max={100} />
      <EditSlider path="tone.detailCoarse" label="Coarse Detail" min={-100} max={100} />
      <EditSlider path="tone.detailCoarsest" label="Coarsest Detail" min={-100} max={100} />
      <EditSlider
        path="tone.detailThreshold"
        label="Detail Threshold"
        min={0}
        max={100}
        origin={20}
      />
    </PanelSection>
  )
}
