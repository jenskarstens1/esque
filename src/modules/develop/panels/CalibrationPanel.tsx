import { PanelSection, MiniAction } from '../../../design/Panel'
import { panelMenuItems } from '../../../shell/appMenus'
import { EditSlider } from '../EditSlider'
import { isSectionModified } from '../../../develop/modified'
import { Group } from './BasicPanel'
import { useDevelop } from '../../../develop/session'

const HUE_RAMP = (a: string, b: string) => `linear-gradient(90deg,${a},#b9b9bd,${b})`

export function CalibrationPanel() {
  const modified = useDevelop((s) => isSectionModified(s.edits, 'calibration', s.kind))
  const reset = useDevelop((s) => s.resetSection)

  return (
    <PanelSection
      menuItems={() => panelMenuItems('calibration')}
      title="Calibration"
      defaultOpen={false}
      modified={modified}
      actions={<MiniAction onClick={() => reset('calibration')}>Reset</MiniAction>}
    >
      <Group label="Shadows">
        <EditSlider
          path="calibration.shadowTint"
          label="Tint"
          min={-100}
          max={100}
          gradient={HUE_RAMP('#3ad16b', '#e055c8')}
        />
      </Group>

      <Group label="Red Primary">
        <EditSlider
          path="calibration.redHue"
          label="Hue"
          min={-100}
          max={100}
          gradient={HUE_RAMP('#ff34d2', '#ffb02e')}
        />
        <EditSlider path="calibration.redSaturation" label="Saturation" min={-100} max={100} />
      </Group>

      <Group label="Green Primary">
        <EditSlider
          path="calibration.greenHue"
          label="Hue"
          min={-100}
          max={100}
          gradient={HUE_RAMP('#ffe92e', '#2effe0')}
        />
        <EditSlider path="calibration.greenSaturation" label="Saturation" min={-100} max={100} />
      </Group>

      <Group label="Blue Primary">
        <EditSlider
          path="calibration.blueHue"
          label="Hue"
          min={-100}
          max={100}
          gradient={HUE_RAMP('#2effe0', '#6b3cff')}
        />
        <EditSlider path="calibration.blueSaturation" label="Saturation" min={-100} max={100} />
      </Group>
    </PanelSection>
  )
}
