import { useState } from 'react'
import { PanelSection, MiniAction } from '../../../design/Panel'
import { panelMenuItems } from '../../../shell/appMenus'
import { SegmentedControl } from '../../../design/Controls'
import { ColorWheel } from '../../../design/ColorWheel'
import { EditSlider } from '../EditSlider'
import { isSectionModified } from '../../../develop/modified'
import { Group } from './BasicPanel'
import { useDevelop } from '../../../develop/session'
import type { ColorGradingEdits } from '../../../core/types'

type Range = 'shadows' | 'midtones' | 'highlights' | 'global'

const RANGES: Array<{ value: Range | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'shadows', label: 'Shad' },
  { value: 'midtones', label: 'Mid' },
  { value: 'highlights', label: 'High' },
  { value: 'global', label: 'Glob' },
]

const TITLE: Record<Range, string> = {
  shadows: 'Shadows',
  midtones: 'Midtones',
  highlights: 'Highlights',
  global: 'Global',
}

export function ColorGradingPanel() {
  const modified = useDevelop((s) => isSectionModified(s.edits, 'colorGrading', s.kind))
  const update = useDevelop((s) => s.update)
  const reset = useDevelop((s) => s.resetSection)
  const [range, setRange] = useState<Range | 'all'>('all')

  const setWheel = (which: Range) => (hue: number, saturation: number) => {
    update(`colorGrading.${which}.hue`, `Grading ${TITLE[which]}`, (e) => {
      const w = e.colorGrading[which] as ColorGradingEdits['shadows']
      w.hue = hue
      w.saturation = saturation
    })
  }

  const wheel = (which: Range) => (
    <GradingWheel key={which} which={which} size={range === 'all' ? 74 : 128} onChange={setWheel(which)} />
  )

  return (
    <PanelSection
      menuItems={() => panelMenuItems('colorGrading')}
      title="Color Grading"
      defaultOpen={false}
      modified={modified}
      actions={<MiniAction onClick={() => reset('colorGrading')}>Reset</MiniAction>}
    >
      <div className="mb-3">
        <SegmentedControl value={range} options={RANGES} onChange={setRange} />
      </div>

      {range === 'all' ? (
        <>
          <div className="flex items-start justify-between gap-1 px-1">
            {(['shadows', 'midtones', 'highlights'] as Range[]).map(wheel)}
          </div>
          <div className="mt-3 flex justify-center">{wheel('global')}</div>
        </>
      ) : (
        <>
          <div className="flex justify-center">{wheel(range)}</div>
          <Group className="mt-3">
            <EditSlider
              path={`colorGrading.${range}.hue`}
              label="Hue"
              min={0}
              max={360}
              gradient="linear-gradient(90deg,#ff2d2d,#ffe92e,#4cff5a,#2effe0,#2e9dff,#6b3cff,#ff34d2,#ff2d2d)"
            />
            <EditSlider path={`colorGrading.${range}.saturation`} label="Saturation" min={0} max={100} />
            <EditSlider
              path={`colorGrading.${range}.luminance`}
              label="Luminance"
              min={-100}
              max={100}
            />
          </Group>
        </>
      )}

      <Group label="Blending" className="mt-3">
        <EditSlider path="colorGrading.blending" label="Blending" min={0} max={100} origin={50} />
        <EditSlider path="colorGrading.balance" label="Balance" min={-100} max={100} />
      </Group>
    </PanelSection>
  )
}

/** Bound to one grading range so the other three wheels stay untouched. */
function GradingWheel({
  which,
  size,
  onChange,
}: {
  which: Range
  size: number
  onChange: (hue: number, saturation: number) => void
}) {
  const w = useDevelop((s) => s.edits.colorGrading[which] as ColorGradingEdits['shadows'])
  return (
    <ColorWheel
      label={TITLE[which]}
      hue={w.hue}
      saturation={w.saturation}
      size={size}
      onChange={onChange}
    />
  )
}
