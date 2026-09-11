import { useCallback, useRef } from 'react'
import { cn } from '../../../lib/cn'
import {
  ContrastIcon,
  CopyIcon,
  EyeIcon,
  MinusIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  ResetIcon,
  TrashIcon,
} from '../../../design/icons'
import { MENU_ICON, type MenuItem } from '../../../design/Menu'
import { PanelSection, PanelSubSection, PanelDivider, MiniAction } from '../../../design/Panel'
import { Button, Checkbox, ControlField, Select } from '../../../design/Controls'
import { SliderRow } from '../../../design/Slider'
import { Tooltip } from '../../../design/Tooltip'
import { useMenu } from '../../../design/useMenu'
import { panelMenuItems, sliderMenuItems, maskKindItems } from '../../../shell/appMenus'
import { promptText } from '../../../design/prompt'
import { useDevelop } from '../../../develop/session'
import { useMasking } from '../../../develop/masking'
import { useUI } from '../../../state/ui'
import {
  BLEND_LABELS,
  DETECTED_KINDS,
  MASK_KINDS,
  MASK_KIND_LABELS,
  duplicateLayer,
  isEmptyLayer,
  isNeutralLayer,
  newComponent,
  newMaskLayer,
} from '../../../develop/layers'
import { defaultMaskAdjustments } from '../../../core/defaults'
import { useAiSupport } from '../../../ai/useAiSupport'
import { MaskDetection } from './MaskDetection'
import { isAiGeometry } from '../../../core/types'
import type { Layer, MaskAdjustments, MaskBlend, MaskComponent, MaskGeometry } from '../../../core/types'

type Kind = MaskGeometry['kind']
type AdjustmentKey = keyof Omit<MaskAdjustments, 'curve'>

interface Adjustment {
  key: AdjustmentKey
  label: string
  min: number
  max: number
  precision?: number
}

/**
 * The mask's sliders, grouped the way the global panels already are.
 *
 * A mask can do nineteen things to the pixels it covers — the same nineteen
 * the right-hand panel spreads across Light, Color, Effects and Detail.
 * Listing them flat here made the panel a scroll with no landmarks, so they
 * are collapsed under names the user has already learned, with Light open
 * because it is what a new mask is almost always for.
 */
const GROUPS: Array<{ title: string; defaultOpen?: boolean; fields: Adjustment[] }> = [
  {
    title: 'Light',
    defaultOpen: true,
    fields: [
      { key: 'exposure', label: 'Exposure', min: -4, max: 4, precision: 2 },
      { key: 'contrast', label: 'Contrast', min: -100, max: 100 },
      { key: 'highlights', label: 'Highlights', min: -100, max: 100 },
      { key: 'shadows', label: 'Shadows', min: -100, max: 100 },
      { key: 'whites', label: 'Whites', min: -100, max: 100 },
      { key: 'blacks', label: 'Blacks', min: -100, max: 100 },
    ],
  },
  {
    title: 'Color',
    fields: [
      { key: 'temp', label: 'Temp', min: -100, max: 100 },
      { key: 'tint', label: 'Tint', min: -100, max: 100 },
      { key: 'saturation', label: 'Saturation', min: -100, max: 100 },
      { key: 'hue', label: 'Hue', min: 0, max: 360 },
      { key: 'hueStrength', label: 'Hue Strength', min: 0, max: 100 },
      { key: 'colorize', label: 'Colorize', min: 0, max: 100 },
    ],
  },
  {
    title: 'Effects',
    fields: [
      { key: 'texture', label: 'Texture', min: -100, max: 100 },
      { key: 'clarity', label: 'Clarity', min: -100, max: 100 },
      { key: 'dehaze', label: 'Dehaze', min: -100, max: 100 },
    ],
  },
  {
    title: 'Detail',
    fields: [
      { key: 'sharpness', label: 'Sharpness', min: -100, max: 100 },
      { key: 'noise', label: 'Noise', min: 0, max: 100 },
      { key: 'moire', label: 'Moiré', min: 0, max: 100 },
      { key: 'defringe', label: 'Defringe', min: 0, max: 100 },
    ],
  },
]

/** How a component joins the ones before it, in one character. */
const BLEND_GLYPH: Record<MaskBlend, string> = { add: '+', subtract: '−', intersect: '∩' }

type Mutate = (
  id: string,
  key: string,
  label: string,
  fn: (m: Layer) => void,
  coalesce?: boolean,
) => void

// ---------------------------------------------------------------------------
// Creating a mask
// ---------------------------------------------------------------------------

/**
 * The kinds, laid out as one press each.
 *
 * Choosing what a mask is *made of* is the first and least avoidable decision
 * in masking, and hiding eight options behind a button that opens a menu makes
 * the user pay two clicks and a guess for it. Lightroom shows them; so do we.
 * Detected kinds sit in their own row because they are the ones that can be
 * refused by the browser, and a row that greys out together explains itself.
 */
function KindChips({ onPick }: { onPick: (kind: Kind) => void }) {
  const support = useAiSupport()
  const blocked = support ? !support.ok : false
  const manual = MASK_KINDS.filter((k) => !DETECTED_KINDS.includes(k))
  const chip = (kind: Kind, disabled: boolean, span?: boolean) => (
    <button
      key={kind}
      type="button"
      disabled={disabled}
      onClick={() => onPick(kind)}
      className={cn(
        'esq-tap flex h-7 coarse:h-9 items-center justify-center rounded-sm bg-control px-2',
        'text-mini text-label',
        'shadow-[0_1px_2px_rgb(0_0_0/0.25),inset_0_0.5px_0_rgb(255_255_255/0.07)]',
        'truncate transition-colors duration-[--duration-fast]',
        span && 'col-span-2',
        disabled ? 'pointer-events-none opacity-35' : 'hover:bg-hover active:bg-active',
      )}
    >
      {MASK_KIND_LABELS[kind]}
    </button>
  )
  return (
    <div className="flex flex-col">
      <ControlField label="Detect">
        <Tooltip content={blocked ? (support?.reason ?? '') : ''} disabled={!blocked} side="top">
          <div className="grid grid-cols-3 gap-1">
            {DETECTED_KINDS.map((k) => chip(k, blocked))}
          </div>
        </Tooltip>
      </ControlField>
      <ControlField label="Draw">
        <div className="grid grid-cols-2 gap-1">
          {manual.map((k, i) => chip(k, false, i === manual.length - 1 && manual.length % 2 === 1))}
        </div>
      </ControlField>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The stack
// ---------------------------------------------------------------------------

/** What the row says about a mask when its name does not say enough. */
function maskSummary(layer: Layer): string {
  if (isEmptyLayer(layer)) return 'empty'
  if (isNeutralLayer(layer)) return 'no effect'
  const first = layer.components[0]
  return first ? MASK_KIND_LABELS[first.geometry.kind] : 'frame'
}

/** The dot that hides a mask, sized to be hit rather than to be seen. */
function VisibleDot({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(ev) => {
        ev.stopPropagation()
        onClick()
      }}
      className={cn(
        'relative size-2 shrink-0 rounded-full transition-colors duration-[--duration-fast]',
        'before:absolute before:-inset-1.5 before:content-[""]',
        on ? 'bg-accent' : 'bg-label-quaternary hover:bg-label-tertiary',
      )}
    />
  )
}

function MaskRow({
  layer,
  first,
  active,
  onChoose,
  onMenu,
  onToggleVisible,
}: {
  layer: Layer
  first: boolean
  active: boolean
  onChoose: () => void
  onMenu: (e: React.MouseEvent) => void
  onToggleVisible: () => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onChoose}
      onKeyDown={(ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return
        ev.preventDefault()
        onChoose()
      }}
      onContextMenu={onMenu}
      className={cn(
        'group/row flex cursor-default items-center gap-2 px-2 py-1.5 text-mini',
        'transition-colors duration-[--duration-fast] ease-[--ease-out]',
        !first && 'hairline-t',
        active ? 'bg-control text-label' : 'text-label-secondary hover:bg-raised hover:text-label',
      )}
    >
      <VisibleDot
        on={layer.visible}
        label={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`}
        onClick={onToggleVisible}
      />
      <span className="min-w-0 flex-1 truncate">{layer.name}</span>
      <span className="shrink-0 text-label-tertiary group-hover/row:hidden">
        {maskSummary(layer)}
      </span>
      <button
        type="button"
        aria-label={`${layer.name} options`}
        onClick={(ev) => {
          ev.stopPropagation()
          onMenu(ev)
        }}
        className="hidden shrink-0 text-icon-tertiary transition-colors duration-[--duration-fast] hover:text-icon group-hover/row:block"
      >
        <MoreHorizontalIcon size={12} />
      </button>
    </div>
  )
}

/**
 * One piece of a mask, under the mask it belongs to.
 *
 * The leading glyph is the whole of what a component does to the ones before
 * it — added, cut out, or kept only where they overlap — so it is the control
 * rather than a label beside a dropdown. The first component has nothing to
 * join, so its glyph is inert.
 *
 * The row stays a row. Whatever the component itself can be tuned for is shown
 * below the list, for the one that is selected, so the stack never turns into
 * a stack of nested panels.
 */
function ComponentRow({
  layer,
  component,
  index,
  active,
  onChoose,
  mutate,
  onMenu,
}: {
  layer: Layer
  component: MaskComponent
  index: number
  active: boolean
  onChoose: () => void
  mutate: Mutate
  onMenu: (e: React.MouseEvent, items: MenuItem[]) => void
}) {
  const first = index === 0
  const blendMenu = (): MenuItem[] =>
    (Object.keys(BLEND_LABELS) as MaskBlend[]).map((b) => ({
      label: BLEND_LABELS[b],
      checked: component.blend === b,
      onSelect: () =>
        mutate(layer.id, 'layers.blend', 'Mask Blend', (mm) => {
          const comp = mm.components.find((x) => x.id === component.id)
          if (comp) comp.blend = b
        }),
    }))
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onChoose}
      onKeyDown={(ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return
        ev.preventDefault()
        onChoose()
      }}
      className={cn(
        'group/comp flex cursor-default items-center gap-1.5 py-1 pr-2 pl-4 text-mini',
        'transition-colors duration-[--duration-fast]',
        active ? 'text-label' : 'text-label-secondary hover:text-label',
      )}
    >
      <Tooltip content={first ? 'Base' : BLEND_LABELS[component.blend]} side="top">
        <button
          type="button"
          aria-label="Component blend"
          disabled={first}
          onClick={(e) => {
            e.stopPropagation()
            onMenu(e, blendMenu())
          }}
          className={cn(
            'esq-tap flex size-4 shrink-0 items-center justify-center rounded-xs',
            'transition-colors duration-[--duration-fast]',
            first
              ? 'text-label-quaternary'
              : 'bg-raised text-label-secondary hover:bg-control hover:text-label',
          )}
        >
          {first ? '·' : BLEND_GLYPH[component.blend]}
        </button>
      </Tooltip>
      <span className={cn('min-w-0 flex-1 truncate', active && 'text-accent')}>
        {MASK_KIND_LABELS[component.geometry.kind]}
      </span>
      <button
        type="button"
        aria-label="Remove component"
        disabled={layer.components.length === 1}
        onClick={(e) => {
          e.stopPropagation()
          mutate(layer.id, 'layers.component', 'Remove Component', (mm) => {
            mm.components = mm.components.filter((x) => x.id !== component.id)
          })
        }}
        className={cn(
          'shrink-0 text-icon-tertiary transition-opacity duration-[--duration-fast]',
          'hover:text-icon disabled:opacity-0',
          active ? 'opacity-60' : 'opacity-0 group-hover/comp:opacity-60',
        )}
      >
        <TrashIcon size={11} />
      </button>
    </div>
  )
}

/**
 * What the selected component itself can be tuned for.
 *
 * Only detected components have anything to say here yet — a gradient is
 * adjusted on the photo, not in the panel — so this is usually empty, which is
 * the point: the space belongs to the component the user is pointing at, and
 * nothing has to nest inside the list to claim it.
 */
function ComponentOptions({ layer, componentId }: { layer: Layer; componentId: string | null }) {
  const component = layer.components.find((c) => c.id === componentId) ?? layer.components[0]
  if (!component || !isAiGeometry(component.geometry)) return null
  return (
    <div className="mt-2">
      <MaskDetection mask={layer} component={component} geometry={component.geometry} />
    </div>
  )
}

function AdjustmentGroup({
  title,
  fields,
  defaultOpen,
  layer,
  mutate,
}: {
  title: string
  fields: Adjustment[]
  defaultOpen?: boolean
  layer: Layer
  mutate: Mutate
}) {
  const defaults = defaultMaskAdjustments()
  const modified = fields.some((f) => layer.adjustments[f.key] !== defaults[f.key])
  return (
    <PanelSubSection title={title} defaultOpen={defaultOpen} modified={modified}>
      {fields.map((a) => {
        const value = layer.adjustments[a.key]
        const reset = defaults[a.key]
        const set = (v: number, coalesce = false) =>
          mutate(layer.id, `layers.adj.${a.key}`, a.label, (mm) => {
            mm.adjustments[a.key] = v
          }, coalesce)
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
                value,
                defaultValue: reset,
                onReset: () => set(reset),
                onSet: (v: number) => set(v),
              })
            }
            onChange={(v) => set(v, true)}
          />
        )
      })}
    </PanelSubSection>
  )
}

/** Whether the mask is drawn over the photo, and how. */
function OverlayRow() {
  const overlay = useMasking((s) => s.overlay)
  const setOverlay = useMasking((s) => s.setOverlay)
  const last = useRef<'tint' | 'coverage'>('tint')
  if (overlay !== 'off') last.current = overlay
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        checked={overlay !== 'off'}
        onChange={(on) => setOverlay(on ? last.current : 'off')}
        label={<span className="text-mini">Show Overlay</span>}
      />
      <div className="ml-auto w-[104px]">
        <Select
          value={last.current}
          size="sm"
          aria-label="Overlay mode"
          disabled={overlay === 'off'}
          onChange={(v) => setOverlay(v as 'tint' | 'coverage')}
          options={[
            { value: 'tint', label: 'Colour' },
            { value: 'coverage', label: 'Mask Only' },
          ]}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function MasksPanel() {
  const layers = useDevelop((s) => s.edits.layers)
  const update = useDevelop((s) => s.update)
  const selectedId = useMasking((s) => s.selectedMaskId)
  const selectedComponentId = useMasking((s) => s.selectedComponentId)
  const select = useMasking((s) => s.select)
  const setPending = useMasking((s) => s.setPending)
  const setTool = useUI((s) => s.openDevelopTool)
  const tool = useUI((s) => s.developTool)
  const { menu, open } = useMenu()
  const support = useAiSupport()

  const selected = layers.find((m) => m.id === selectedId) ?? null

  // A gradient or brush is placed by dragging on the photo, so arm the canvas
  // rather than dropping a shape in the middle and hoping.
  const armed = (kind: Kind) => kind === 'linear' || kind === 'radial' || kind === 'brush'

  const addMask = useCallback(
    (kind: Kind) => {
      const mask = newMaskLayer(layers, kind)
      update('layers.add', 'Add Mask', (e) => {
        e.layers.push(mask)
      }, false)
      select(mask.id, mask.components[0].id)
      setTool('mask')
      if (armed(kind)) setPending(kind, 'new')
    },
    [layers, update, select, setTool, setPending],
  )

  const addComponentTo = useCallback(
    (kind: Kind, blend: MaskBlend) => {
      if (!selected) return
      const comp = newComponent(kind, undefined, blend)
      update('layers.component', 'Add Mask Component', (e) => {
        e.layers.find((m) => m.id === selected.id)?.components.push(comp)
      }, false)
      select(selected.id, comp.id)
      if (armed(kind)) setPending(kind, blend)
    },
    [selected, update, select, setPending],
  )

  // Selecting a mask has to arm the tool as well, or the overlay never appears
  // and the selection looks like it did nothing.
  const chooseMask = useCallback(
    (id: string, componentId: string | null, active: boolean) => {
      if (active) {
        select(null)
        return
      }
      select(id, componentId)
      setTool('mask')
    },
    [select, setTool],
  )

  const mutateMask = useCallback<Mutate>(
    (id, key, label, fn, coalesce = false) => {
      update(key, label, (e) => {
        const m = e.layers.find((x) => x.id === id)
        if (m) fn(m)
      }, coalesce)
    },
    [update],
  )

  const rowMenu = (m: Layer): MenuItem[] => [
    { label: 'Rename…', icon: <PencilIcon size={MENU_ICON} />, onSelect: () => {
      void promptText({ title: 'Rename Mask', initial: m.name }).then((name) => {
        if (name) mutateMask(m.id, 'layers.name', 'Rename Mask', (mm) => { mm.name = name })
      })
    } },
    { label: 'Duplicate', icon: <CopyIcon size={MENU_ICON} />, onSelect: () => {
      const copy = duplicateLayer(m, layers)
      update('layers.add', 'Duplicate Mask', (e) => { e.layers.push(copy) }, false)
      select(copy.id)
    } },
    { label: m.inverted ? 'Un-invert' : 'Invert', icon: <ContrastIcon size={MENU_ICON} />, checked: m.inverted, onSelect: () =>
      mutateMask(m.id, 'layers.invert', 'Invert Mask', (mm) => { mm.inverted = !mm.inverted }) },
    { label: m.visible ? 'Hide' : 'Show', icon: <EyeIcon size={MENU_ICON} off={m.visible} />, checked: m.visible, onSelect: () =>
      mutateMask(m.id, 'layers.visible', 'Toggle Mask', (mm) => { mm.visible = !mm.visible }) },
    { kind: 'separator' },
    { label: 'Reset Adjustments', icon: <ResetIcon size={MENU_ICON} />, onSelect: () =>
      mutateMask(m.id, 'layers.adjust', 'Reset Mask Adjustments', (mm) => {
        mm.adjustments = defaultMaskAdjustments()
      }) },
    { label: 'Delete', icon: <TrashIcon size={MENU_ICON} />, danger: true, onSelect: () => {
      update('layers.delete', 'Delete Mask', (e) => {
        e.layers = e.layers.filter((x) => x.id !== m.id)
      }, false)
      if (selectedId === m.id) select(null)
    } },
  ]

  return (
    <PanelSection
      id="develop-mask"
      revealKey={tool === 'mask' ? tool : null}
      menuItems={() => panelMenuItems('layers')}
      title="Masking"
      defaultOpen={false}
      modified={layers.length > 0}
      actions={
        layers.length ? (
          <>
            <MiniAction onClick={(e) => open(e, maskKindItems(support, addMask))}>New</MiniAction>
            <MiniAction
              onClick={() =>
                update('layers.clear', 'Delete All Masks', (e) => {
                  e.layers = []
                }, false)
              }
            >
              Clear
            </MiniAction>
          </>
        ) : undefined
      }
      revealActions="always"
    >
      {menu}

      {!layers.length && <KindChips onPick={addMask} />}

      {layers.length > 0 && (
        <div className="overflow-hidden rounded-md bg-base shadow-[inset_0_0.5px_1px_rgb(0_0_0/0.3)]">
          {layers.map((m, i) => (
            <div key={m.id}>
              <MaskRow
                layer={m}
                first={i === 0}
                active={m.id === selectedId}
                onChoose={() => chooseMask(m.id, m.components[0]?.id ?? null, m.id === selectedId)}
                onMenu={(ev) => open(ev, rowMenu(m))}
                onToggleVisible={() =>
                  mutateMask(m.id, 'layers.visible', 'Toggle Mask', (mm) => { mm.visible = !mm.visible })
                }
              />
              {m.id === selectedId && (
                <div className="bg-control/40 pb-1">
                  {m.components.map((c, ci) => (
                    <ComponentRow
                      key={c.id}
                      layer={m}
                      component={c}
                      index={ci}
                      active={c.id === selectedComponentId}
                      onChoose={() => select(m.id, c.id)}
                      mutate={mutateMask}
                      onMenu={open}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {selected && (
        <>
          <div className="mt-2 grid grid-cols-2 gap-1">
            <Button
              size="sm"
              icon={<PlusIcon size={10} />}
              onClick={(e) => open(e, maskKindItems(support, (k) => addComponentTo(k, 'add')))}
            >
              Add
            </Button>
            <Button
              size="sm"
              icon={<MinusIcon size={10} />}
              onClick={(e) => open(e, maskKindItems(support, (k) => addComponentTo(k, 'subtract')))}
            >
              Subtract
            </Button>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <Checkbox
              checked={selected.inverted}
              onChange={() =>
                mutateMask(selected.id, 'layers.invert', 'Invert Mask', (mm) => {
                  mm.inverted = !mm.inverted
                })
              }
              label={<span className="text-mini">Invert</span>}
            />
          </div>

          <ComponentOptions layer={selected} componentId={selectedComponentId} />

          <PanelDivider />

          <SliderRow
            label="Amount"
            min={0}
            max={1}
            step={0.01}
            precision={2}
            defaultValue={1}
            value={selected.opacity}
            modified={selected.opacity !== 1}
            onChange={(v) =>
              mutateMask(selected.id, 'layers.opacity', 'Mask Opacity', (mm) => {
                mm.opacity = v
              }, true)
            }
          />

          <div className="mt-1">
            {GROUPS.map((g) => (
              <AdjustmentGroup
                key={g.title}
                title={g.title}
                fields={g.fields}
                defaultOpen={g.defaultOpen}
                layer={selected}
                mutate={mutateMask}
              />
            ))}
          </div>

          <PanelDivider />
          <OverlayRow />
        </>
      )}
    </PanelSection>
  )
}
