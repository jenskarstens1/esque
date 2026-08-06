import { PanelSection, MiniAction } from '../../../design/Panel'
import { panelMenuItems } from '../../../shell/appMenus'
import { EditSlider } from '../EditSlider'
import { isSectionModified } from '../../../develop/modified'
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
      <EditSlider path="detail.sharpenAmount" label="Sharpen Amount" min={0} max={150} origin={0} />
      <EditSlider
        path="detail.sharpenRadius"
        label="Sharpen Radius"
        min={0.5}
        max={3}
        step={0.1}
        precision={1}
        origin={1}
      />
      <EditSlider path="detail.sharpenDetail" label="Sharpen Detail" min={0} max={100} origin={0} />
      <EditSlider
        path="detail.sharpenMasking"
        label="Sharpen Masking"
        min={0}
        max={100}
        origin={0}
      />

      <EditSlider path="detail.luminanceNR" label="Luminance Noise" min={0} max={100} origin={0} />
      <EditSlider
        path="detail.luminanceNRDetail"
        label="Luminance Detail"
        min={0}
        max={100}
        origin={0}
        disabled={noLumNR}
      />
      <EditSlider
        path="detail.luminanceNRContrast"
        label="Luminance Contrast"
        min={0}
        max={100}
        origin={0}
        disabled={noLumNR}
      />

      <EditSlider path="detail.colorNR" label="Color Noise" min={0} max={100} origin={0} />
      <EditSlider
        path="detail.colorNRDetail"
        label="Color Detail"
        min={0}
        max={100}
        origin={0}
        disabled={noColorNR}
      />
      <EditSlider
        path="detail.colorNRSmoothness"
        label="Color Smoothness"
        min={0}
        max={100}
        origin={0}
        disabled={noColorNR}
      />

      <EditSlider path="detail.impulseNR" label="Impulse Noise" min={0} max={100} origin={0} />

      <EditSlider
        path="lens.defringePurpleAmount"
        label="Defringe Purple"
        min={0}
        max={20}
        origin={0}
      />
      <EditSlider
        path="lens.defringePurpleHueLo"
        label="Purple Hue Min"
        min={0}
        max={100}
        origin={30}
        disabled={noPurple}
      />
      <EditSlider
        path="lens.defringePurpleHueHi"
        label="Purple Hue Max"
        min={0}
        max={100}
        origin={70}
        disabled={noPurple}
      />
      <EditSlider
        path="lens.defringeGreenAmount"
        label="Defringe Green"
        min={0}
        max={20}
        origin={0}
      />
      <EditSlider
        path="lens.defringeGreenHueLo"
        label="Green Hue Min"
        min={0}
        max={100}
        origin={40}
        disabled={noGreen}
      />
      <EditSlider
        path="lens.defringeGreenHueHi"
        label="Green Hue Max"
        min={0}
        max={100}
        origin={60}
        disabled={noGreen}
      />
    </PanelSection>
  )
}
