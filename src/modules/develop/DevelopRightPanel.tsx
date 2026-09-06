import { useLayoutEffect, useRef } from 'react'
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
import { useUI } from '../../state/ui'
import { toolPanelId } from './useToolInspector'
import { SaveStatus } from '../../shell/SaveStatus'

export function DevelopRightPanel() {
  const photoId = useDevelop((s) => s.photoId)
  const resetAll = useDevelop((s) => s.resetAll)
  const copySettings = useDevelop((s) => s.copySettings)
  const pasteSettings = useDevelop((s) => s.pasteSettings)
  const hasClipboard = useDevelop((s) => !!s.clipboard)
  const selected = useCatalog((s) => s.selected)
  const tool = useUI((s) => s.developTool)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const previousScroll = useRef<number | null>(null)

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || !photoId) return
    const id = toolPanelId(tool)
    if (!id) {
      if (previousScroll.current !== null) {
        scroller.scrollTop = previousScroll.current
        previousScroll.current = null
      }
      return
    }
    const section = scroller.querySelector<HTMLElement>(`#${id}`)
    if (!section) return
    if (previousScroll.current === null) previousScroll.current = scroller.scrollTop
    const reveal = () => {
      if (!scroller.clientHeight) return
      scroller.scrollTop += section.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    }
    const frame = requestAnimationFrame(reveal)
    // Opening the section increases the available scroll range. Align again
    // after that transition, without scrolling the page or stealing focus.
    const finish = (event: TransitionEvent) => {
      if (event.propertyName !== 'grid-template-rows') return
      reveal()
      section.removeEventListener('transitionend', finish)
    }
    section.addEventListener('transitionend', finish)
    return () => {
      cancelAnimationFrame(frame)
      section.removeEventListener('transitionend', finish)
    }
  }, [tool, photoId])

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
    try {
      // Flush first: the debounced save may not have landed for the source yet.
      await useDevelop.getState().flush()
    } catch {
      // SaveStatus and the save queue's toast already explain this failure.
      // Never copy the older on-disk settings or add a duplicate notification.
      return
    }
    try {
      await copyEditsTo(photoId, others, ALL_SECTIONS)
      toast.show(`Synced settings to ${others.length} photo${others.length === 1 ? '' : 's'}`)
    } catch (error) {
      toast.error(
        'Settings not synced',
        error instanceof Error ? error.message : 'Could not sync the selected photos. Try again.',
      )
    }
  }

  return (
    <div className="flex h-full flex-col" data-panel="develop-right">
      <DevelopHistogram />

      <Scroller ref={scrollerRef} data-develop-inspector frameClassName="min-h-0 flex-1">
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

      <div className="hairline-t flex flex-col gap-1.5 px-3 py-2">
        <SaveStatus />
        <div className="flex items-center gap-1.5">
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
    </div>
  )
}
