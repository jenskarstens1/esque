import { useCallback } from 'react'
import { cn } from '../../../lib/cn'
import { CloseIcon } from '../../../design/icons'
import { PanelSection, MiniAction } from '../../../design/Panel'
import { Button, Select } from '../../../design/Controls'
import { SliderRow } from '../../../design/Slider'
import { useMenu } from '../../../design/useMenu'
import { panelMenuItems, sliderMenuItems, maskKindItems } from '../../../shell/appMenus'
import { promptText } from '../../../design/prompt'
import { useDevelop } from '../../../develop/session'
import { useMasking } from '../../../develop/masking'
import { useUI } from '../../../state/ui'
import {
  BLEND_LABELS,
  MASK_KIND_LABELS,
  duplicateMask,
  isEmptyMask,
  isNeutralMask,
  newComponent,
  newMask,
} from '../../../develop/masks'
import { defaultMaskAdjustments } from '../../../core/defaults'
import { useAiSupport } from '../../../ai/useAiSupport'
import { MaskDetection } from './MaskDetection'
import { isAiGeometry } from '../../../core/types'
import type { MaskAdjustments, MaskBlend, MaskGeometry } from '../../../core/types'

/** Fields the slider list drives, with their range and label. */
const ADJUSTMENTS: Array<{
  key: keyof Omit<MaskAdjustments, 'curve'>
  label: string
  min: number
  max: number
  precision?: number
}> = [
  { key: 'exposure', label: 'Exposure', min: -4, max: 4, precision: 2 },
  { key: 'contrast', label: 'Contrast', min: -100, max: 100 },
  { key: 'highlights', label: 'Highlights', min: -100, max: 100 },
  { key: 'shadows', label: 'Shadows', min: -100, max: 100 },
  { key: 'whites', label: 'Whites', min: -100, max: 100 },
  { key: 'blacks', label: 'Blacks', min: -100, max: 100 },
  { key: 'temp', label: 'Temp', min: -100, max: 100 },
  { key: 'tint', label: 'Tint', min: -100, max: 100 },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100 },
  { key: 'hue', label: 'Hue', min: 0, max: 360 },
  { key: 'hueStrength', label: 'Hue Strength', min: 0, max: 100 },
  { key: 'colorize', label: 'Colorize', min: 0, max: 100 },
  { key: 'texture', label: 'Texture', min: -100, max: 100 },
  { key: 'clarity', label: 'Clarity', min: -100, max: 100 },
  { key: 'dehaze', label: 'Dehaze', min: -100, max: 100 },
  { key: 'sharpness', label: 'Sharpness', min: -100, max: 100 },
  { key: 'noise', label: 'Noise', min: 0, max: 100 },
  { key: 'moire', label: 'Moiré', min: 0, max: 100 },
  { key: 'defringe', label: 'Defringe', min: 0, max: 100 },
]

export function MasksPanel() {
  const masks = useDevelop((s) => s.edits.masks)
  const update = useDevelop((s) => s.update)
  const selectedId = useMasking((s) => s.selectedMaskId)
  const select = useMasking((s) => s.select)
  const setPending = useMasking((s) => s.setPending)
  const overlay = useMasking((s) => s.overlay)
  const setOverlay = useMasking((s) => s.setOverlay)
  const setTool = useUI((s) => s.openDevelopTool)
  const { menu, open } = useMenu()
  const support = useAiSupport()

  const selected = masks.find((m) => m.id === selectedId) ?? null

  const addMask = useCallback(
    (kind: MaskGeometry['kind']) => {
      const mask = newMask(masks, kind)
      update('masks.add', 'Add Mask', (e) => {
        e.masks.push(mask)
      }, false)
      select(mask.id, mask.components[0].id)
      setTool('mask')
      // A gradient or brush is placed by dragging on the photo, so arm the
      // canvas rather than dropping a shape in the middle and hoping.
      if (kind === 'linear' || kind === 'radial' || kind === 'brush') {
        setPending(kind, 'new')
      }
    },
    [masks, update, select, setTool, setPending],
  )

  const addComponentTo = useCallback(
    (kind: MaskGeometry['kind'], blend: MaskBlend) => {
      if (!selected) return
      const comp = newComponent(kind, undefined, blend)
      update('masks.component', 'Add Mask Component', (e) => {
        e.masks.find((m) => m.id === selected.id)?.components.push(comp)
      }, false)
      select(selected.id, comp.id)
      if (kind === 'linear' || kind === 'radial' || kind === 'brush') {
        setPending(kind, blend)
      }
    },
    [selected, update, select, setPending],
  )

  const mutateMask = useCallback(
    (id: string, key: string, label: string, fn: (m: NonNullable<typeof selected>) => void, coalesce = false) => {
      update(key, label, (e) => {
        const m = e.masks.find((x) => x.id === id)
        if (m) fn(m)
      }, coalesce)
    },
    [update],
  )

  const addMenu = () => maskKindItems(support, addMask)

  return (
    <PanelSection
      menuItems={() => panelMenuItems('masks')}
      title="Masking"
      defaultOpen={false}
      modified={masks.length > 0}
      actions={
        masks.length ? (
          <MiniAction
            onClick={() =>
              update('masks.clear', 'Delete All Masks', (e) => {
                e.masks = []
              }, false)
            }
          >
            Clear
          </MiniAction>
        ) : undefined
      }
    >
      {menu}

      <Button full variant="secondary" onClick={(e) => open(e, addMenu())} className="mb-2">
        Create Mask
      </Button>

      {masks.length > 0 && (
        <div className="mb-2 overflow-hidden rounded-md bg-base shadow-[inset_0_0.5px_1px_rgb(0_0_0/0.3)]">
          {masks.map((m, i) => {
            const active = m.id === selectedId
            return (
              <div
                key={m.id}
                role="button"
                tabIndex={0}
                onClick={() => select(active ? null : m.id, m.components[0]?.id ?? null)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') select(active ? null : m.id)
                }}
                onContextMenu={(ev) =>
                  open(ev, [
                    { label: 'Rename…', onSelect: () => {
                      void promptText({ title: 'Rename Mask', initial: m.name }).then((name) => {
                        if (name) mutateMask(m.id, 'masks.name', 'Rename Mask', (mm) => { mm.name = name })
                      })
                    } },
                    { label: 'Duplicate', onSelect: () => {
                      const copy = duplicateMask(m, masks)
                      update('masks.add', 'Duplicate Mask', (e) => { e.masks.push(copy) }, false)
                      select(copy.id)
                    } },
                    { label: m.inverted ? 'Un-invert' : 'Invert', checked: m.inverted, onSelect: () =>
                      mutateMask(m.id, 'masks.invert', 'Invert Mask', (mm) => { mm.inverted = !mm.inverted }) },
                    { label: m.visible ? 'Hide' : 'Show', checked: m.visible, onSelect: () =>
                      mutateMask(m.id, 'masks.visible', 'Toggle Mask', (mm) => { mm.visible = !mm.visible }) },
                    { kind: 'separator' },
                    { label: 'Reset Adjustments', onSelect: () =>
                      mutateMask(m.id, 'masks.adjust', 'Reset Mask Adjustments', (mm) => {
                        mm.adjustments = defaultMaskAdjustments()
                      }) },
                    { label: 'Delete', danger: true, onSelect: () => {
                      update('masks.delete', 'Delete Mask', (e) => {
                        e.masks = e.masks.filter((x) => x.id !== m.id)
                      }, false)
                      if (selectedId === m.id) select(null)
                    } },
                  ])
                }
                className={cn(
                  'flex cursor-default items-center gap-2 px-2 py-1.5 text-mini',
                  'transition-colors duration-[--duration-fast] ease-[--ease-out]',
                  i > 0 && 'hairline-t',
                  active
                    ? 'bg-control text-label'
                    : 'text-label-secondary hover:bg-raised hover:text-label',
                )}
              >
                <button
                  type="button"
                  aria-label={m.visible ? `Hide ${m.name}` : `Show ${m.name}`}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    mutateMask(m.id, 'masks.visible', 'Toggle Mask', (mm) => { mm.visible = !mm.visible })
                  }}
                  className={cn(
                    // The dot is the mask's most-used control; the pseudo-element
                    // gives it a 20px hit target without changing what you see.
                    'relative size-2 shrink-0 rounded-full transition-colors duration-[--duration-fast]',
                    'before:absolute before:-inset-1.5 before:content-[""]',
                    m.visible ? 'bg-accent' : 'bg-label-quaternary hover:bg-label-tertiary',
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{m.name}</span>
                <span className="shrink-0 text-label-tertiary">
                  {isEmptyMask(m) ? 'empty' : isNeutralMask(m) ? 'no effect' : MASK_KIND_LABELS[m.components[0].geometry.kind]}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {selected && (
        <>
          <div className="mb-2 flex items-center gap-1.5">
            <span className="w-[44px] shrink-0 text-mini text-label-tertiary">Show</span>
            <Select
              value={overlay}
              onChange={(v) => setOverlay(v as typeof overlay)}
              options={[
                { value: 'tint', label: 'Overlay' },
                { value: 'coverage', label: 'Mask Only' },
                { value: 'off', label: 'Off' },
              ]}
            />
          </div>

          <div className="mt-2.5">
            <div className="flex flex-col gap-1">
              {selected.components.map((c, i) => (
                <div key={c.id} className="flex flex-col">
                  <div className="flex items-center gap-1.5">
                    <span className="w-[70px] shrink-0 truncate text-mini text-label-secondary">
                      {MASK_KIND_LABELS[c.geometry.kind]}
                    </span>
                    <Select
                      value={c.blend}
                      disabled={i === 0}
                      onChange={(v) =>
                        mutateMask(selected.id, 'masks.blend', 'Mask Blend', (mm) => {
                          const comp = mm.components.find((x) => x.id === c.id)
                          if (comp) comp.blend = v as MaskBlend
                        })
                      }
                      options={(Object.keys(BLEND_LABELS) as MaskBlend[]).map((b) => ({
                        value: b,
                        label: BLEND_LABELS[b],
                      }))}
                    />
                    <button
                      type="button"
                      aria-label="Remove component"
                      disabled={selected.components.length === 1}
                      onClick={() =>
                        mutateMask(selected.id, 'masks.component', 'Remove Component', (mm) => {
                          mm.components = mm.components.filter((x) => x.id !== c.id)
                        })
                      }
                      className="shrink-0 px-1 text-icon-tertiary transition-colors duration-[--duration-fast] hover:text-icon disabled:opacity-30"
                    >
                      <CloseIcon size={9} />
                    </button>
                  </div>
                  {isAiGeometry(c.geometry) && (
                    <MaskDetection mask={selected} component={c} geometry={c.geometry} />
                  )}
                </div>
              ))}
            </div>
            <div className="mt-1.5 flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={(e) =>
                  open(
                    e,
                    maskKindItems(support, (k) => addComponentTo(k, 'add')),
                  )
                }
              >
                Add
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={(e) =>
                  open(
                    e,
                    maskKindItems(support, (k) => addComponentTo(k, 'subtract')),
                  )
                }
              >
                Subtract
              </Button>
            </div>
          </div>

          <SliderRow
            label="Opacity"
            min={0}
            max={1}
            step={0.01}
            precision={2}
            defaultValue={1}
            value={selected.opacity}
            modified={selected.opacity !== 1}
            onChange={(v) =>
              mutateMask(selected.id, 'masks.opacity', 'Mask Opacity', (mm) => {
                mm.opacity = v
              }, true)
            }
          />

          {ADJUSTMENTS.map((a) => {
            const value = selected.adjustments[a.key]
            const reset = defaultMaskAdjustments()[a.key]
            return (
              <SliderRow
                key={a.key}
                label={a.label}
                min={a.min}
                max={a.max}
                precision={a.precision}
                step={a.precision ? 0.01 : 1}
                defaultValue={reset}
                origin={reset}
                value={value}
                modified={value !== reset}
                menuItems={() =>
                  sliderMenuItems({
                    label: a.label,
                    value,
                    defaultValue: reset,
                    onReset: () =>
                      mutateMask(selected.id, `masks.adj.${a.key}`, a.label, (mm) => {
                        mm.adjustments[a.key] = reset
                      }),
                    onSet: (v: number) =>
                      mutateMask(selected.id, `masks.adj.${a.key}`, a.label, (mm) => {
                        mm.adjustments[a.key] = v
                      }),
                  })
                }
                onChange={(v) =>
                  mutateMask(selected.id, `masks.adj.${a.key}`, a.label, (mm) => {
                    mm.adjustments[a.key] = v
                  }, true)
                }
              />
            )
          })}
        </>
      )}
    </PanelSection>
  )
}
