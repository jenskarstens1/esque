import { PanelSection, MiniAction } from '../../../design/Panel'
import { Checkbox } from '../../../design/Controls'
import { panelMenuItems } from '../../../shell/appMenus'
import { EditSlider } from '../EditSlider'
import { isSectionModified } from '../../../develop/modified'
import { useDevelop } from '../../../develop/session'

export function LensPanel() {
  const modified = useDevelop((s) => isSectionModified(s.edits, 'lens', s.kind))
  const lens = useDevelop((s) => s.edits.lens)
  const reset = useDevelop((s) => s.resetSection)
  const update = useDevelop((s) => s.update)

  return (
    <PanelSection
      menuItems={() => panelMenuItems('lens')}
      title="Lens Corrections"
      defaultOpen={false}
      modified={modified}
      actions={<MiniAction onClick={() => reset('lens')}>Reset</MiniAction>}
    >
      <div className="mb-2">
        <Checkbox
          label="Enable profile corrections"
          checked={lens.enableProfile}
          onChange={(v) =>
            update(
              'lens.enableProfile',
              'Lens Profile',
              (e) => {
                e.lens.enableProfile = v
              },
              false,
            )
          }
        />
      </div>

      <EditSlider path="lens.distortion" label="Distortion" min={-100} max={100} />
      <EditSlider path="lens.vignetting" label="Vignetting" min={-100} max={100} />
      <EditSlider path="lens.caRed" label="Red / Cyan Fringe" min={-100} max={100} />
      <EditSlider path="lens.caBlue" label="Blue / Yellow Fringe" min={-100} max={100} />
    </PanelSection>
  )
}
