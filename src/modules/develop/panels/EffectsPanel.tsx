import { PanelSection, MiniAction } from '../../../design/Panel'
import { panelMenuItems } from '../../../shell/appMenus'
import { EditSlider } from '../EditSlider'
import { isSectionModified } from '../../../develop/modified'
import { useDevelop } from '../../../develop/session'

export function EffectsPanel() {
  const modified = useDevelop((s) => isSectionModified(s.edits, 'effects', s.kind))
  const fx = useDevelop((s) => s.edits.effects)
  const reset = useDevelop((s) => s.resetSection)


  return (
    <PanelSection
      menuItems={() => panelMenuItems('effects')}
      title="Effects"
      defaultOpen={false}
      modified={modified}
      actions={<MiniAction onClick={() => reset('effects')}>Reset</MiniAction>}
    >
      <EditSlider path="effects.vignetteAmount" label="Vignette" min={-100} max={100} />
      <EditSlider
        path="effects.vignetteMidpoint"
        label="Vignette Midpoint"
        min={0}
        max={100}
        origin={50}
        disabled={fx.vignetteAmount === 0}
      />
      <EditSlider
        path="effects.vignetteRoundness"
        label="Vignette Roundness"
        min={-100}
        max={100}
        disabled={fx.vignetteAmount === 0}
      />
      <EditSlider
        path="effects.vignetteFeather"
        label="Vignette Feather"
        min={0}
        max={100}
        origin={50}
        disabled={fx.vignetteAmount === 0}
      />
      <EditSlider
        path="effects.vignetteHighlights"
        label="Vignette Highlights"
        min={0}
        max={100}
        origin={0}
        disabled={fx.vignetteAmount >= 0}
      />

      <EditSlider path="effects.grainAmount" label="Grain" min={0} max={100} origin={0} />
      <EditSlider
        path="effects.grainSize"
        label="Grain Size"
        min={0}
        max={100}
        origin={25}
        disabled={fx.grainAmount === 0}
      />
      <EditSlider
        path="effects.grainRoughness"
        label="Grain Roughness"
        min={0}
        max={100}
        origin={50}
        disabled={fx.grainAmount === 0}
      />
    </PanelSection>
  )
}
