import { useState } from 'react'
import { PanelSection, MiniAction } from '../../../design/Panel'
import { panelMenuItems } from '../../../shell/appMenus'
import { SegmentedControl } from '../../../design/Controls'
import { EditSlider } from '../EditSlider'
import { isSectionModified } from '../../../develop/modified'
import { useDevelop } from '../../../develop/session'
import { COLOR_BANDS, type ColorBand } from '../../../core/types'

type Channel = 'hue' | 'saturation' | 'luminance'

const CHANNELS: Array<{ value: Channel | 'all'; label: string }> = [
  { value: 'hue', label: 'Hue' },
  { value: 'saturation', label: 'Sat' },
  { value: 'luminance', label: 'Lum' },
  { value: 'all', label: 'All' },
]

const LABEL: Record<ColorBand, string> = {
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  aqua: 'Aqua',
  blue: 'Blue',
  purple: 'Purple',
  magenta: 'Magenta',
}

/** Band centres in degrees, used to paint each slider's own ramp. */
const HUE_DEG: Record<ColorBand, number> = {
  red: 0,
  orange: 30,
  yellow: 60,
  green: 120,
  aqua: 180,
  blue: 240,
  purple: 280,
  magenta: 320,
}

function ramp(band: ColorBand, channel: Channel): string {
  const h = HUE_DEG[band]
  if (channel === 'hue') {
    return `linear-gradient(90deg,hsl(${h - 30} 85% 55%),hsl(${h} 85% 55%),hsl(${h + 30} 85% 55%))`
  }
  if (channel === 'saturation') {
    return `linear-gradient(90deg,hsl(${h} 4% 52%),hsl(${h} 90% 52%))`
  }
  return `linear-gradient(90deg,hsl(${h} 55% 12%),hsl(${h} 70% 50%),hsl(${h} 60% 92%))`
}

export function ColorMixerPanel() {
  const modified = useDevelop((s) => isSectionModified(s.edits, 'colorMixer', s.kind))
  const reset = useDevelop((s) => s.resetSection)
  const isBw = useDevelop((s) => s.edits.basic.treatment === 'bw')
  const [channel, setChannel] = useState<Channel | 'all'>('hue')

  const rows = (ch: Channel) =>
    COLOR_BANDS.map((band) => (
      <EditSlider
        key={`${ch}-${band}`}
        path={`colorMixer.${ch}.${band}`}
        label={LABEL[band]}
        min={-100}
        max={100}
        gradient={ramp(band, ch)}
      />
    ))

  // In black & white the hue/sat/lum controls have nothing to act on — the
  // colour is already gone by the time they would run — so the panel becomes
  // the eight-band grey mixer instead.
  if (isBw) {
    return (
      <PanelSection
        menuItems={() => panelMenuItems('colorMixer')}
        title="B&W Mix"
        defaultOpen={false}
        modified={modified}
        actions={<MiniAction onClick={() => reset('colorMixer')}>Reset</MiniAction>}
      >
        {COLOR_BANDS.map((band) => (
          <EditSlider
            key={`bw-${band}`}
            path={`colorMixer.bw.${band}`}
            label={LABEL[band]}
            min={-100}
            max={100}
            gradient={`linear-gradient(90deg,#111,hsl(${HUE_DEG[band]} 60% 45%),#f2f2f2)`}
          />
        ))}
      </PanelSection>
    )
  }

  return (
    <PanelSection
        menuItems={() => panelMenuItems('colorMixer')}
      title="Color Mixer"
      defaultOpen={false}
      modified={modified}
      actions={<MiniAction onClick={() => reset('colorMixer')}>Reset</MiniAction>}
    >
      <div className="mb-2">
        <SegmentedControl value={channel} options={CHANNELS} onChange={setChannel} />
      </div>

      {channel === 'all' ? (
        <div className="space-y-3">
          {(['hue', 'saturation', 'luminance'] as Channel[]).map((ch) => (
            <div key={ch}>
              <div className="mb-0.5 text-micro tracking-[0.06em] text-label-quaternary uppercase">
                {ch}
              </div>
              {rows(ch)}
            </div>
          ))}
        </div>
      ) : (
        rows(channel)
      )}
    </PanelSection>
  )
}
