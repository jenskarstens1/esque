import { PanelSection, MiniAction } from '../../../design/Panel'
import { Button, Checkbox, Select, SelectField } from '../../../design/Controls'
import {
  FlipHorizontalIcon,
  FlipVerticalIcon,
  RotateLeftIcon,
  RotateRightIcon,
} from '../../../design/icons'
import { cropMenuItems, panelMenuItems } from '../../../shell/appMenus'
import { useUI } from '../../../state/ui'
import { EditSlider } from '../EditSlider'
import { isSectionModified } from '../../../develop/modified'
import { useDevelop } from '../../../develop/session'
import { ASPECT_LABELS, fitCropToAspect, frameAspect } from '../../../gpu/geometry'
import type { CropAspect } from '../../../core/types'

const ASPECTS = Object.keys(ASPECT_LABELS) as CropAspect[]

export function CropPanel() {
  const modified = useDevelop((s) => isSectionModified(s.edits, 'crop', s.kind))
  const crop = useDevelop((s) => s.edits.crop)
  const reset = useDevelop((s) => s.resetSection)
  const update = useDevelop((s) => s.update)
  const tool = useUI((s) => s.developTool)
  const setTool = useUI((s) => s.setDevelopTool)
  const fa = useDevelop((s) => frameAspect(s.sourceSize.width, s.sourceSize.height, s.edits))

  const setAspect = (aspect: CropAspect) =>
    update(
      'crop.aspect',
      'Crop Aspect',
      (e) => {
        e.crop.aspect = aspect
        // Snapping on choice is what makes a preset feel like a preset; the
        // frame's own proportions are the reference for 'original'.
        if (aspect !== 'free') {
          Object.assign(e.crop, fitCropToAspect(e.crop, aspect, fa))
        }
      },
      false,
    )

  const turn = (by: number) =>
    update(
      'crop.quarterTurns',
      by > 0 ? 'Rotate Right' : 'Rotate Left',
      (e) => {
        e.crop.quarterTurns = (((e.crop.quarterTurns + by) % 4) + 4) % 4
      },
      false,
    )

  const flip = (axis: 'flipH' | 'flipV') =>
    update(
      `crop.${axis}`,
      axis === 'flipH' ? 'Flip Horizontal' : 'Flip Vertical',
      (e) => {
        e.crop[axis] = !e.crop[axis]
      },
      false,
    )

  return (
    <PanelSection
      id="develop-crop"
      revealKey={tool === 'crop' ? tool : null}
      menuItems={() => [...cropMenuItems(false), { kind: 'separator' }, ...panelMenuItems('crop')]}
      title="Crop & Straighten"
      defaultOpen={false}
      modified={modified}
      actions={<MiniAction onClick={() => reset('crop')}>Reset</MiniAction>}
    >
      <Button
        variant={tool === 'crop' ? 'primary' : 'secondary'}
        full
        className="mb-2"
        onClick={() => setTool(tool === 'crop' ? 'none' : 'crop')}
      >
        {tool === 'crop' ? 'Done' : 'Crop Photo'}
        <span className="ml-1.5 text-label-tertiary">R</span>
      </Button>

      <SelectField label="Aspect">
        <Select
          size="sm"
          value={crop.aspect}
          onChange={setAspect}
          options={ASPECTS.map((a) => ({ value: a, label: ASPECT_LABELS[a] }))}
          className="min-w-0 flex-1"
        />
      </SelectField>
      <div className="mb-2">
        <Checkbox
          label="Lock aspect"
          checked={crop.aspectLocked}
          onChange={(v) =>
            update(
              'crop.aspectLocked',
              'Lock Aspect',
              (e) => {
                e.crop.aspectLocked = v
              },
              false,
            )
          }
        />
      </div>

      <EditSlider path="crop.angle" label="Straighten" min={-45} max={45} step={0.1} />

      <div className="mt-2 grid grid-cols-4 gap-1">
        <Button
          variant="secondary"
          onClick={() => turn(-1)}
          title="Rotate left 90°"
          aria-label="Rotate left 90°"
          className="px-0"
        >
          <RotateLeftIcon size={14} />
        </Button>
        <Button
          variant="secondary"
          onClick={() => turn(1)}
          title="Rotate right 90°"
          aria-label="Rotate right 90°"
          className="px-0"
        >
          <RotateRightIcon size={14} />
        </Button>
        <Button
          variant={crop.flipH ? 'primary' : 'secondary'}
          onClick={() => flip('flipH')}
          title="Flip horizontal"
          aria-label="Flip horizontal"
          aria-pressed={crop.flipH}
          className="px-0"
        >
          <FlipHorizontalIcon size={14} />
        </Button>
        <Button
          variant={crop.flipV ? 'primary' : 'secondary'}
          onClick={() => flip('flipV')}
          title="Flip vertical"
          aria-label="Flip vertical"
          aria-pressed={crop.flipV}
          className="px-0"
        >
          <FlipVerticalIcon size={14} />
        </Button>
      </div>

      <EditSlider path="crop.left" label="Crop Left" min={0} max={1} step={0.001} origin={0} />
      <EditSlider path="crop.top" label="Crop Top" min={0} max={1} step={0.001} origin={0} />
      <EditSlider path="crop.right" label="Crop Right" min={0} max={1} step={0.001} origin={1} />
      <EditSlider path="crop.bottom" label="Crop Bottom" min={0} max={1} step={0.001} origin={1} />
    </PanelSection>
  )
}
