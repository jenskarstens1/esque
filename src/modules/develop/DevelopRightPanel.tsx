import { DevelopHistogram } from './DevelopHistogram'
import { BasicPanel } from './panels/BasicPanel'
import { TonePanel } from './panels/TonePanel'
import { ToneCurvePanel } from './panels/ToneCurvePanel'
import { ColorMixerPanel } from './panels/ColorMixerPanel'
import { ColorGradingPanel } from './panels/ColorGradingPanel'
import { DetailPanel } from './panels/DetailPanel'
import { CropPanel } from './panels/CropPanel'
import { TransformPanel } from './panels/TransformPanel'
import { LensPanel } from './panels/LensPanel'
import { MasksPanel } from './panels/MasksPanel'
import { RetouchPanel } from './panels/RetouchPanel'
import { EffectsPanel } from './panels/EffectsPanel'
import { CalibrationPanel } from './panels/CalibrationPanel'
import { ALL_SECTIONS, useDevelop } from '../../develop/session'
import { Button } from '../../design/Controls'
import { Scroller } from '../../design/Scroller'
import { useCatalog } from '../../state/catalog'
import { copyEditsTo } from '../../catalog/actions'
import { toast } from '../../design/toast'

export function DevelopRightPanel() {
  const photoId = useDevelop((s) => s.photoId)
  const resetAll = useDevelop((s) => s.resetAll)
  const copySettings = useDevelop((s) => s.copySettings)
  const pasteSettings = useDevelop((s) => s.pasteSettings)
  const hasClipboard = useDevelop((s) => !!s.clipboard)
  const selected = useCatalog((s) => s.selected)

  if (!photoId) {
    return (
      <div className="grid h-full place-items-center px-6 text-center text-mini text-label-quaternary">
        Select a photo to edit
      </div>
    )
  }

  const others = selected.filter((id) => id !== photoId)

  const sync = async () => {
    if (!others.length) return
    // Flush first: the debounced save may not have landed for the source yet.
    await useDevelop.getState().flush()
    await copyEditsTo(photoId, others, ALL_SECTIONS)
    toast.show(`Synced settings to ${others.length} photo${others.length === 1 ? '' : 's'}`)
  }

  return (
    <div className="flex h-full flex-col" data-panel="develop-right">
      <DevelopHistogram />

      <Scroller frameClassName="min-h-0 flex-1">
        <BasicPanel />
        <TonePanel />
        <ToneCurvePanel />
        <ColorMixerPanel />
        <ColorGradingPanel />
        <DetailPanel />
        <LensPanel />
        <TransformPanel />
        <CropPanel />
        <MasksPanel />
        <RetouchPanel />
        <EffectsPanel />
        <CalibrationPanel />
        <div className="h-4" />
      </Scroller>

      <div className="hairline-t flex items-center gap-1.5 px-3 py-2">
        {others.length > 0 ? (
          <Button size="sm" variant="primary" className="flex-1" onClick={sync}>
            Sync {others.length}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            className="flex-1"
            onClick={() => {
              copySettings(ALL_SECTIONS)
              toast.show('Settings copied')
            }}
          >
            Copy
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          className="flex-1"
          disabled={!hasClipboard}
          onClick={() => pasteSettings()}
        >
          Paste
        </Button>
        <Button size="sm" variant="ghost" onClick={resetAll} title="Reset all settings">
          Reset
        </Button>
      </div>
    </div>
  )
}
