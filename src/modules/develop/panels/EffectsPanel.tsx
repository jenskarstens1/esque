import { PanelSection, MiniAction } from '../../../design/Panel'
import { panelMenuItems } from '../../../shell/appMenus'
import { EditSlider } from '../EditSlider'
import { isSectionModified } from '../../../develop/modified'
import { Group } from './BasicPanel'
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
      <Group label="Post-Crop Vignetting">
        <EditSlider path="effects.vignetteAmount" label="Amount" min={-100} max={100} />
        <EditSlider
          path="effects.vignetteMidpoint"
          label="Midpoint"
          min={0}
          max={100}
          origin={50}
          disabled={fx.vignetteAmount === 0}
        />
        <EditSlider
          path="effects.vignetteRoundness"
          label="Roundness"
          min={-100}
          max={100}
          disabled={fx.vignetteAmount === 0}
        />
        <EditSlider
          path="effects.vignetteFeather"
          label="Feather"
          min={0}
          max={100}
          origin={50}
          disabled={fx.vignetteAmount === 0}
        />
        <EditSlider
          path="effects.vignetteHighlights"
          label="Highlights"
          min={0}
          max={100}
          origin={0}
          disabled={fx.vignetteAmount >= 0}
        />
      </Group>

      <Group label="Grain">
        <EditSlider path="effects.grainAmount" label="Amount" min={0} max={100} origin={0} />
        <EditSlider
          path="effects.grainSize"
          label="Size"
          min={0}
          max={100}
          origin={25}
          disabled={fx.grainAmount === 0}
        />
        <EditSlider
          path="effects.grainRoughness"
          label="Roughness"
          min={0}
          max={100}
          origin={50}
          disabled={fx.grainAmount === 0}
        />
      </Group>
    </PanelSection>
  )
}
