import { PanelSection, MiniAction } from '../../../design/Panel'
import { panelMenuItems } from '../../../shell/appMenus'
import { Checkbox, IconButton, SegmentedControl, Select, SelectField } from '../../../design/Controls'
import { DropperIcon, ExposureIcon } from '../../../design/icons'
import { MENU_ICON } from '../../../design/Menu'
import { EditSlider } from '../EditSlider'
import { isSectionModified } from '../../../develop/modified'
import { useDevelop } from '../../../develop/session'
import { autoDevelopCurrent } from '../../../develop/autoApply'
import { CAMERA_PROFILES } from '../../../core/profiles'
import { WB_PRESETS } from '../../../core/wb'
import type { BasicEdits, Edits, Treatment, WhiteBalanceMode } from '../../../core/types'
import { useUI } from '../../../state/ui'

const WB_OPTIONS: Array<{ value: WhiteBalanceMode; label: string }> = [
  { value: 'asShot', label: 'As Shot' },
  { value: 'auto', label: 'Auto' },
  { value: 'daylight', label: 'Daylight' },
  { value: 'cloudy', label: 'Cloudy' },
  { value: 'shade', label: 'Shade' },
  { value: 'tungsten', label: 'Tungsten' },
  { value: 'fluorescent', label: 'Fluorescent' },
  { value: 'flash', label: 'Flash' },
  { value: 'custom', label: 'Custom' },
]

/** Ramps run in the direction the slider pushes the image, not the light. */
const TEMP_GRADIENT =
  'linear-gradient(90deg,#3f7dff 0%,#8fb6ff 25%,#dcdcdc 50%,#ffd479 75%,#ff9d2e 100%)'
const TINT_GRADIENT = 'linear-gradient(90deg,#3ad16b 0%,#c9c9c9 50%,#e055c8 100%)'

/** Nudging Temp or Tint by hand is what turns a preset into a Custom balance. */
const toCustom = (e: Edits) => {
  e.basic.wbMode = 'custom'
}

const PROFILE_OPTIONS = CAMERA_PROFILES.map((p) => ({ value: p.id, label: p.name }))

export function BasicPanel() {
  const modified = useDevelop(
    (s) =>
      isSectionModified(s.edits, 'basic', s.kind) ||
      (s.kind === 'raw' && isSectionModified(s.edits, 'profile', s.kind)),
  )
  const isRaw = useDevelop((s) => s.kind === 'raw')
  const wbMode = useDevelop((s) => s.edits.basic.wbMode)
  const picking = useUI((s) => s.wbPicking)
  const togglePicker = useUI((s) => s.toggleWbPicking)
  const update = useDevelop((s) => s.update)
  const reset = useDevelop((s) => s.resetSection)
  const original = useDevelop((s) => s.original)

  const profile = useDevelop((s) => s.edits.profile)
  const treatment = useDevelop((s) => s.edits.basic.treatment)
  const protectSkin = useDevelop((s) => s.edits.basic.protectSkin)
  const avoidColorShift = useDevelop((s) => s.edits.basic.avoidColorShift)

  const setFlag = (key: 'protectSkin' | 'avoidColorShift', label: string, value: boolean) =>
    update(
      `basic.${key}`,
      label,
      (e) => {
        ;(e.basic as BasicEdits)[key] = value
      },
      false,
    )

  const setTreatment = (t: Treatment) =>
    update(
      'basic.treatment',
      'Treatment',
      (e) => {
        e.basic.treatment = t
      },
      false,
    )

  const setProfile = (id: string) =>
    update('profile', 'Profile', (e) => {
      e.profile = id
    }, false)

  const setMode = async (mode: WhiteBalanceMode) => {
    // Auto has to look at the pixels, so it takes the path through `autoApply`
    // that knows how to find them; every other mode is a table lookup.
    if (mode === 'auto') {
      await autoDevelopCurrent('wb')
      return
    }

    update(
      'basic.wbMode',
      'White Balance',
      (e) => {
        e.basic.wbMode = mode
        if (mode === 'asShot') {
          e.basic.temp = original.basic.temp
          e.basic.tint = original.basic.tint
        } else {
          const preset = WB_PRESETS[mode]
          if (preset) {
            e.basic.temp = preset.temp
            e.basic.tint = preset.tint
          }
        }
      },
      false,
    )
  }

  const runAutoTone = async () => {
    await autoDevelopCurrent('tone')
  }

  return (
    <PanelSection
      menuItems={() => [
        { label: 'Auto Tone', icon: <ExposureIcon size={MENU_ICON} />, onSelect: () => void runAutoTone() },
        { kind: 'separator' },
        ...panelMenuItems('basic'),
      ]}
      title="Basic"
      modified={modified}
      revealActions="always"
      actions={
        <>
          <span className="esq-reveal opacity-0 transition-opacity duration-[--duration-fast] group-hover/head:opacity-100 focus-within:opacity-100">
            <MiniAction onClick={() => reset('basic')}>Reset</MiniAction>
          </span>
          <MiniAction
            title="Set white balance, tone and vibrance from the photo"
            onClick={() => void autoDevelopCurrent('all')}
          >
            Auto
          </MiniAction>
        </>
      }
    >
      <div className="mb-2">
        <SegmentedControl
          full
          value={treatment}
          options={[
            { value: 'color' as const, label: 'Color' },
            { value: 'bw' as const, label: 'B&W' },
          ]}
          onChange={setTreatment}
          className="mb-2"
        />
        {isRaw && (
          <SelectField label="Profile">
            <Select
              size="sm"
              value={profile}
              options={PROFILE_OPTIONS}
              onChange={setProfile}
              className="w-full"
            />
          </SelectField>
        )}
        {/* The dropdown names the light and the two sliders describe it, so the
            three are spaced as one group rather than as three unrelated rows. */}
        <SelectField label="White balance">
          <Select
            size="sm"
            value={wbMode}
            options={WB_OPTIONS}
            onChange={(m) => void setMode(m)}
            className="min-w-0 flex-1"
          />
          {/* Beside the dropdown rather than in the toolbar: the dropper is one
              more way of answering the question the dropdown asks. */}
          <IconButton
            size="sm"
            label="Pick a neutral colour in the photo"
            active={picking}
            onClick={togglePicker}
          >
            <DropperIcon size={13} />
          </IconButton>
        </SelectField>
        <EditSlider
          path="basic.temp"
          label="Temp"
          min={2000}
          max={50000}
          step={10}
          origin={original.basic.temp}
          defaultValue={original.basic.temp}
          gradient={TEMP_GRADIENT}
          side={toCustom}
        />
        <EditSlider
          path="basic.tint"
          label="Tint"
          min={-150}
          max={150}
          origin={original.basic.tint}
          defaultValue={original.basic.tint}
          gradient={TINT_GRADIENT}
          side={toCustom}
        />
      </div>

      <EditSlider
        path="basic.exposure"
        label="Exposure"
        min={-5}
        max={5}
        step={0.01}
        precision={2}
      />
      <EditSlider path="basic.contrast" label="Contrast" min={-100} max={100} />
      <EditSlider path="basic.highlights" label="Highlights" min={-100} max={100} />
      <EditSlider path="basic.shadows" label="Shadows" min={-100} max={100} />
      <EditSlider path="basic.whites" label="Whites" min={-100} max={100} />
      <EditSlider path="basic.blacks" label="Blacks" min={-100} max={100} />

      <EditSlider path="basic.texture" label="Texture" min={-100} max={100} />
      <EditSlider path="basic.clarity" label="Clarity" min={-100} max={100} />
      <EditSlider path="basic.dehaze" label="Dehaze" min={-100} max={100} />
      <EditSlider path="basic.vibrance" label="Vibrance" min={-100} max={100} />
      <EditSlider path="basic.saturation" label="Saturation" min={-100} max={100} />
      <div className="mt-1.5 flex flex-col gap-1">
        <Checkbox
          checked={protectSkin}
          onChange={(v) => setFlag('protectSkin', 'Protect Skin Tones', v)}
          label={<span className="text-mini">Protect skin tones</span>}
        />
        <Checkbox
          checked={avoidColorShift}
          onChange={(v) => setFlag('avoidColorShift', 'Avoid Color Shift', v)}
          label={<span className="text-mini">Avoid color shift</span>}
        />
      </div>
    </PanelSection>
  )
}
