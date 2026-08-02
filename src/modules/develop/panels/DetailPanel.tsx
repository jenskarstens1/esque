import { PanelSection, MiniAction } from '../../../design/Panel'
import { panelMenuItems } from '../../../shell/appMenus'
import { EditSlider } from '../EditSlider'
import { isSectionModified } from '../../../develop/modified'
import { Group } from './BasicPanel'
import { useDevelop } from '../../../develop/session'

export function DetailPanel() {
  const modified = useDevelop(
    (s) =>
      isSectionModified(s.edits, 'detail', s.kind, s.iso) ||
      isSectionModified(s.edits, 'lens', s.kind),
  )
  const noLumNR = useDevelop((s) => s.edits.detail.luminanceNR === 0)
  const noColorNR = useDevelop((s) => s.edits.detail.colorNR === 0)
  const noPurple = useDevelop((s) => s.edits.lens.defringePurpleAmount === 0)
  const noGreen = useDevelop((s) => s.edits.lens.defringeGreenAmount === 0)
  const reset = useDevelop((s) => s.resetSection)

  const resetAll = () => {
    reset('detail')
    reset('lens')
  }

  return (
    <PanelSection
      menuItems={() => panelMenuItems('detail')}
      title="Detail"
      defaultOpen={false}
      modified={modified}
      actions={<MiniAction onClick={resetAll}>Reset</MiniAction>}
    >
      <Group label="Sharpening">
        <EditSlider path="detail.sharpenAmount" label="Amount" min={0} max={150} origin={0} />
        <EditSlider
          path="detail.sharpenRadius"
          label="Radius"
          min={0.5}
          max={3}
          step={0.1}
          precision={1}
          origin={1}
        />
        <EditSlider path="detail.sharpenDetail" label="Detail" min={0} max={100} origin={0} />
        <EditSlider path="detail.sharpenMasking" label="Masking" min={0} max={100} origin={0} />
      </Group>

      <Group label="Noise Reduction">
        <EditSlider path="detail.luminanceNR" label="Luminance" min={0} max={100} origin={0} />
        <EditSlider
          path="detail.luminanceNRDetail"
          label="Detail"
          min={0}
          max={100}
          origin={0}
          disabled={noLumNR}
        />
        <EditSlider
          path="detail.luminanceNRContrast"
          label="Contrast"
          min={0}
          max={100}
          origin={0}
          disabled={noLumNR}
        />
      </Group>

      <Group label="Color Noise">
        <EditSlider path="detail.colorNR" label="Color" min={0} max={100} origin={0} />
        <EditSlider
          path="detail.colorNRDetail"
          label="Detail"
          min={0}
          max={100}
          origin={0}
          disabled={noColorNR}
        />
        <EditSlider
          path="detail.colorNRSmoothness"
          label="Smoothness"
          min={0}
          max={100}
          origin={0}
          disabled={noColorNR}
        />
      </Group>

      <Group label="Impulse Noise">
        <EditSlider path="detail.impulseNR" label="Amount" min={0} max={100} origin={0} />
      </Group>

      <Group label="Defringe">
        <EditSlider path="lens.defringePurpleAmount" label="Purple" min={0} max={20} origin={0} />
        <EditSlider
          path="lens.defringePurpleHueLo"
          label="Hue Min"
          min={0}
          max={100}
          origin={30}
          disabled={noPurple}
        />
        <EditSlider
          path="lens.defringePurpleHueHi"
          label="Hue Max"
          min={0}
          max={100}
          origin={70}
          disabled={noPurple}
        />
        <EditSlider path="lens.defringeGreenAmount" label="Green" min={0} max={20} origin={0} />
        <EditSlider
          path="lens.defringeGreenHueLo"
          label="Hue Min"
          min={0}
          max={100}
          origin={40}
          disabled={noGreen}
        />
        <EditSlider
          path="lens.defringeGreenHueHi"
          label="Hue Max"
          min={0}
          max={100}
          origin={60}
          disabled={noGreen}
        />
      </Group>
    </PanelSection>
  )
}
