import { PanelSection, MiniAction } from '../../../design/Panel'
import { panelMenuItems } from '../../../shell/appMenus'
import { EditSlider } from '../EditSlider'
import { isSectionModified } from '../../../develop/modified'
import { Group } from './BasicPanel'
import { useDevelop } from '../../../develop/session'

export function TransformPanel() {
  const modified = useDevelop((s) => isSectionModified(s.edits, 'transform', s.kind))
  const reset = useDevelop((s) => s.resetSection)

  return (
    <PanelSection
      menuItems={() => panelMenuItems('transform')}
      title="Transform"
      defaultOpen={false}
      modified={modified}
      actions={<MiniAction onClick={() => reset('transform')}>Reset</MiniAction>}
    >
      <EditSlider path="transform.vertical" label="Vertical" min={-100} max={100} />
      <EditSlider path="transform.horizontal" label="Horizontal" min={-100} max={100} />
      <EditSlider path="transform.rotate" label="Rotate" min={-45} max={45} step={0.1} />
      <EditSlider path="transform.aspect" label="Aspect" min={-100} max={100} />

      <Group label="Frame">
        <EditSlider path="transform.scale" label="Scale" min={50} max={200} origin={100} />
        <EditSlider path="transform.offsetX" label="X Offset" min={-100} max={100} />
        <EditSlider path="transform.offsetY" label="Y Offset" min={-100} max={100} />
      </Group>
    </PanelSection>
  )
}
