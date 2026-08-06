import { PanelSection, MiniAction } from '../../../design/Panel'
import { panelMenuItems } from '../../../shell/appMenus'
import { EditSlider } from '../EditSlider'
import { isSectionModified } from '../../../develop/modified'
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
      <EditSlider
        path="calibration.shadowTint"
        label="Shadow Tint"
        min={-100}
        max={100}
        gradient={HUE_RAMP('#3ad16b', '#e055c8')}
      />

      <EditSlider
        path="calibration.redHue"
        label="Red Hue"
        min={-100}
        max={100}
        gradient={HUE_RAMP('#ff34d2', '#ffb02e')}
      />
      <EditSlider
        path="calibration.redSaturation"
        label="Red Saturation"
        min={-100}
        max={100}
      />

      <EditSlider
        path="calibration.greenHue"
        label="Green Hue"
        min={-100}
        max={100}
        gradient={HUE_RAMP('#ffe92e', '#2effe0')}
      />
      <EditSlider
        path="calibration.greenSaturation"
        label="Green Saturation"
        min={-100}
        max={100}
      />

      <EditSlider
        path="calibration.blueHue"
        label="Blue Hue"
        min={-100}
        max={100}
        gradient={HUE_RAMP('#2effe0', '#6b3cff')}
      />
      <EditSlider
        path="calibration.blueSaturation"
        label="Blue Saturation"
        min={-100}
        max={100}
      />
    </PanelSection>
  )
}
