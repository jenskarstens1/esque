import { useState } from 'react'
import { PanelSection, MiniAction } from '../../../design/Panel'
import { panelMenuItems } from '../../../shell/appMenus'
import { SegmentedControl, Select, SelectField } from '../../../design/Controls'
import { CurveEditor, type CurveChannel } from '../CurveEditor'
import { EditSlider } from '../EditSlider'
import { isSectionModified } from '../../../develop/modified'
import { useDevelop } from '../../../develop/session'
import type { CurveMode, CurvePoint } from '../../../core/types'

const CHANNELS: Array<{ value: CurveChannel; label: string }> = [
  { value: 'rgb', label: 'RGB' },
  { value: 'red', label: 'R' },
  { value: 'green', label: 'G' },
  { value: 'blue', label: 'B' },
]

const CURVE_MODES: Array<{ value: CurveMode; label: string }> = [
  { value: 'standard', label: 'Standard' },
  { value: 'weighted', label: 'Weighted Standard' },
  { value: 'filmLike', label: 'Film-like' },
  { value: 'saturationAndValue', label: 'Saturation and Value' },
  { value: 'luminance', label: 'Luminance' },
  { value: 'perceptual', label: 'Perceptual' },
]

export function ToneCurvePanel() {
  const modified = useDevelop((s) => isSectionModified(s.edits, 'curve', s.kind))
  const curve = useDevelop((s) => s.edits.curve)
  const update = useDevelop((s) => s.update)
  const reset = useDevelop((s) => s.resetSection)
  const [channel, setChannel] = useState<CurveChannel>('rgb')

  const mode = curve.mode
  const points = curve[channel]

  const setPoints = (next: CurvePoint[], commit: boolean) => {
    update(
      `curve.${channel}`,
      'Tone Curve',
      (e) => {
        e.curve[channel] = next
      },
      !commit,
    )
  }

  return (
    <PanelSection
      menuItems={() => panelMenuItems('curve')}
      title="Tone Curve"
      modified={modified}
      actions={<MiniAction onClick={() => reset('curve')}>Reset</MiniAction>}
    >
      <SegmentedControl
        full
        value={mode}
        options={[
          { value: 'parametric' as const, label: 'Parametric' },
          { value: 'point' as const, label: 'Point' },
        ]}
        onChange={(m) => {
          // A block body, not a concise one: immer rejects a producer that both
          // returns a value and mutates its draft, and `d.curve.mode = m` is an
          // expression.
          update(
            'curve.mode',
            'Curve Mode',
            (e) => {
              e.curve.mode = m
            },
            false,
          )
          if (m === 'parametric') setChannel('rgb')
        }}
        className="mb-2"
      />

      {mode === 'point' && (
        <SegmentedControl
          full
          value={channel}
          options={CHANNELS}
          onChange={setChannel}
          className="mb-2"
        />
      )}

      <CurveEditor
        mode={mode}
        channel={channel}
        points={points}
        parametric={curve.parametric}
        onPointsChange={setPoints}
        onSplitsChange={(splits) =>
          update(
            'curve.parametric.midtoneSplit',
            'Curve Range',
            (e) => {
              e.curve.parametric.shadowSplit = splits.shadowSplit
              e.curve.parametric.midtoneSplit = splits.midtoneSplit
              e.curve.parametric.highlightSplit = splits.highlightSplit
            },
            true,
          )
        }
      />

      {mode === 'parametric' && (
        <div className="mt-2">
          <EditSlider
            path="curve.parametric.highlights"
            label="Highlights"
            min={-100}
            max={100}
          />
          <EditSlider path="curve.parametric.lights" label="Lights" min={-100} max={100} />
          <EditSlider path="curve.parametric.darks" label="Darks" min={-100} max={100} />
          <EditSlider path="curve.parametric.shadows" label="Shadows" min={-100} max={100} />
        </div>
      )}

      {/* The composite curve's mode decides what the shape is applied to, and
          changes the result far more than any tweak to the shape itself. */}
      {(mode === 'parametric' || channel === 'rgb') && (
        <SelectField label="Apply to">
          <Select
            size="sm"
            value={curve.rgbMode}
            options={CURVE_MODES}
            onChange={(m) =>
              update(
                'curve.rgbMode',
                'Curve Applied To',
                (e) => {
                  e.curve.rgbMode = m
                },
                false,
              )
            }
            className="min-w-0 flex-1"
          />
        </SelectField>
      )}
    </PanelSection>
  )
}
