import { PanelSection, MiniAction } from '../../../design/Panel'
import { panelMenuItems } from '../../../shell/appMenus'
import { EditSlider } from '../EditSlider'
import { isSectionModified } from '../../../develop/modified'
import { useDevelop } from '../../../develop/session'

export function LensPanel() {
  const modified = useDevelop((s) => isSectionModified(s.edits, 'lens', s.kind))
  const reset = useDevelop((s) => s.resetSection)

  return (
    <PanelSection
      menuItems={() => panelMenuItems('lens')}
      title="Lens Corrections"
      defaultOpen={false}
      modified={modified}
      actions={<MiniAction onClick={() => reset('lens')}>Reset</MiniAction>}
    >
      <EditSlider path="lens.distortion" label="Distortion" min={-100} max={100} />
      <EditSlider path="lens.vignetting" label="Vignetting" min={-100} max={100} />
      <EditSlider path="lens.caRed" label="Red / Cyan Fringe" min={-100} max={100} />
      <EditSlider path="lens.caBlue" label="Blue / Yellow Fringe" min={-100} max={100} />
    </PanelSection>
  )
}
