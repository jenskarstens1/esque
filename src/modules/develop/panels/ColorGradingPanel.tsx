import { useState } from 'react'
import { PanelSection, MiniAction } from '../../../design/Panel'
import { panelMenuItems } from '../../../shell/appMenus'
import { SegmentedControl } from '../../../design/Controls'
import { ColorWheel } from '../../../design/ColorWheel'
import { EditSlider } from '../EditSlider'
import { isSectionModified } from '../../../develop/modified'
import { useDevelop } from '../../../develop/session'
import { cn } from '../../../lib/cn'
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

/** A range is at its default when nothing about it has been touched. */
const isNeutral = (w: ColorGradingEdits['shadows']) =>
  w.hue === 0 && w.saturation === 0 && w.luminance === 0

const BLENDING_DEFAULT = 50
const BALANCE_DEFAULT = 0

export function ColorGradingPanel() {
  const modified = useDevelop((s) => isSectionModified(s.edits, 'colorGrading', s.kind))
  const update = useDevelop((s) => s.update)
  const reset = useDevelop((s) => s.resetSection)
  const grading = useDevelop((s) => s.edits.colorGrading)
  const [range, setRange] = useState<Range | 'all'>('all')

  const setWheel = (which: Range) => (hue: number, saturation: number) => {
    update(`colorGrading.${which}.hue`, `Grading ${TITLE[which]}`, (e) => {
      const w = e.colorGrading[which] as ColorGradingEdits['shadows']
      w.hue = hue
      w.saturation = saturation
    })
  }

  /*
   * Clearing a range takes its luminance with it. The wheel only draws hue and
   * saturation, but the three numbers are one decision — a reset that left the
   * luminance behind would look like it had worked and quietly go on lifting
   * the shadows.
   */
  const resetRange = (which: Range) => () => {
    update(
      `colorGrading.${which}.reset`,
      `Reset Grading ${TITLE[which]}`,
      (e) => {
        const w = e.colorGrading[which] as ColorGradingEdits['shadows']
        w.hue = 0
        w.saturation = 0
        w.luminance = 0
      },
      false,
    )
  }

  const resetBlending = () => {
    update(
      'colorGrading.blend.reset',
      'Reset Grading Blending',
      (e) => {
        e.colorGrading.blending = BLENDING_DEFAULT
        e.colorGrading.balance = BALANCE_DEFAULT
      },
      false,
    )
  }

  const wheel = (which: Range) => (
    <GradingWheel
      key={which}
      which={which}
      size={range === 'all' ? 74 : 128}
      onChange={setWheel(which)}
      onReset={resetRange(which)}
    />
  )

  // A dot on the tab, so switching away from "All" never hides the fact that a
  // range you cannot currently see is doing something to the picture.
  const options = RANGES.map((r) => ({
    value: r.value,
    label:
      r.value === 'all' ? (
        r.label
      ) : (
        <span className="inline-flex items-center gap-1">
          {r.label}
          <span
            aria-hidden
            className={cn(
              'size-[4px] rounded-full transition-opacity duration-[--duration-fast]',
              isNeutral(grading[r.value as Range]) ? 'opacity-0' : 'bg-accent opacity-100',
            )}
          />
        </span>
      ),
    title: r.value === 'all' ? 'All four ranges' : TITLE[r.value as Range],
  }))

  const blendingModified =
    grading.blending !== BLENDING_DEFAULT || grading.balance !== BALANCE_DEFAULT

  return (
    <PanelSection
      menuItems={() => panelMenuItems('colorGrading')}
      title="Color Grading"
      defaultOpen={false}
      modified={modified}
      actions={
        <>
          {/* The per-range reset lives on the wheel's own footer; blending has
              no wheel, so its reset has to live up here. */}
          <MiniAction disabled={!blendingModified} title="Reset blending" onClick={resetBlending}>
            Reset Blending
          </MiniAction>
          <MiniAction onClick={() => reset('colorGrading')}>Reset</MiniAction>
        </>
      }
    >
      <div className="mb-3">
        <SegmentedControl value={range} options={options} onChange={setRange} />
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
          <div className="mt-3">
            <EditSlider
              path={`colorGrading.${range}.hue`}
              label="Hue"
              min={0}
              max={360}
              gradient="linear-gradient(90deg,#ff2d2d,#ffe92e,#4cff5a,#2effe0,#2e9dff,#6b3cff,#ff34d2,#ff2d2d)"
            />
            <EditSlider
              path={`colorGrading.${range}.saturation`}
              label="Saturation"
              min={0}
              max={100}
            />
            <EditSlider
              path={`colorGrading.${range}.luminance`}
              label="Luminance"
              min={-100}
              max={100}
            />
          </div>
        </>
      )}

      <div className="mt-3">
        <EditSlider
          path="colorGrading.blending"
          label="Blending"
          min={0}
          max={100}
          origin={BLENDING_DEFAULT}
        />
        <EditSlider path="colorGrading.balance" label="Balance" min={-100} max={100} />
      </div>
    </PanelSection>
  )
}

/** Bound to one grading range so the other three wheels stay untouched. */
function GradingWheel({
  which,
  size,
  onChange,
  onReset,
}: {
  which: Range
  size: number
  onChange: (hue: number, saturation: number) => void
  onReset: () => void
}) {
  const w = useDevelop((s) => s.edits.colorGrading[which] as ColorGradingEdits['shadows'])
  return (
    <ColorWheel
      label={TITLE[which]}
      hue={w.hue}
      saturation={w.saturation}
      size={size}
      modified={!isNeutral(w)}
      onChange={onChange}
      onReset={onReset}
    />
  )
}
