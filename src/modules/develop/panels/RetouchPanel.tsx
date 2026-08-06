import { useCallback } from 'react'
import { cn } from '../../../lib/cn'
import { CloseIcon } from '../../../design/icons'
import { PanelSection, MiniAction } from '../../../design/Panel'
import { Button, Select } from '../../../design/Controls'
import { SliderRow } from '../../../design/Slider'
import { useMenu } from '../../../design/useMenu'
import { panelMenuItems } from '../../../shell/appMenus'
import { useDevelop } from '../../../develop/session'
import { useUI } from '../../../state/ui'
import {
  EYE_KIND_LABELS,
  SPOT_MODE_LABELS,
  useRetouch,
} from '../../../develop/retouch'
import type { RedEyeEdit, SpotEdit } from '../../../core/types'

/**
 * Spot removal and red-eye.
 *
 * One panel for both because they are the same gesture — click the thing you
 * want gone — and Lightroom's split into two tools mostly reflects where they
 * landed historically.
 */
export function RetouchPanel() {
  const spots = useDevelop((s) => s.edits.spots)
  const redEye = useDevelop((s) => s.edits.redEye)
  const update = useDevelop((s) => s.update)
  const tool = useUI((s) => s.developTool)
  const setTool = useUI((s) => s.setDevelopTool)
  const rt = useRetouch()
  const { menu, open } = useMenu()

  const spot = spots.find((s) => s.id === rt.selectedSpotId) ?? null
  const eye = redEye.find((e) => e.id === rt.selectedEyeId) ?? null

  const editSpot = useCallback(
    (id: string, key: string, label: string, fn: (s: SpotEdit) => void, coalesce = true) => {
      update(key, label, (e) => {
        const target = e.spots.find((x) => x.id === id)
        if (target) fn(target)
      }, coalesce)
    },
    [update],
  )

  const editEye = useCallback(
    (id: string, key: string, label: string, fn: (r: RedEyeEdit) => void, coalesce = true) => {
      update(key, label, (e) => {
        const target = e.redEye.find((x) => x.id === id)
        if (target) fn(target)
      }, coalesce)
    },
    [update],
  )

  return (
    <PanelSection
      menuItems={() => panelMenuItems('spots')}
      title="Retouch"
      defaultOpen={false}
      modified={spots.length > 0 || redEye.length > 0}
      actions={
        spots.length || redEye.length ? (
          <MiniAction
            onClick={() =>
              update('retouch.clear', 'Clear Retouching', (e) => {
                e.spots = []
                e.redEye = []
              }, false)
            }
          >
            Clear
          </MiniAction>
        ) : undefined
      }
    >
      {menu}

      <div className="mb-2 flex gap-1">
        <Button
          className="grow basis-0"
          variant={tool === 'heal' ? 'primary' : 'secondary'}
          onClick={() => setTool('heal')}
        >
          {tool === 'heal' ? 'Done' : 'Spot Removal'}
        </Button>
        <Button
          className="grow basis-0"
          variant={tool === 'redeye' ? 'primary' : 'secondary'}
          onClick={() => setTool('redeye')}
        >
          {tool === 'redeye' ? 'Done' : 'Red Eye'}
        </Button>
      </div>

      {tool === 'heal' && (
        <p className="mb-2 text-mini text-label-tertiary">
          Click a blemish to remove it. Drag the second circle to choose where the
          repair is copied from.
        </p>
      )}
      {tool === 'redeye' && (
        <p className="mb-2 text-mini text-label-tertiary">
          Drag across a pupil to size the correction.
        </p>
      )}

      <div className="mt-2.5">
        <div className="mb-1.5 flex items-center gap-1.5">
          <span className="w-[44px] shrink-0 text-mini text-label-tertiary">Spot</span>
          <Select
            value={spot ? spot.mode : rt.spotMode}
            onChange={(v) => {
              const mode = v as SpotEdit['mode']
              if (spot) editSpot(spot.id, 'spot.mode', 'Spot Mode', (s) => { s.mode = mode }, false)
              else rt.setSpot({ spotMode: mode })
            }}
            options={(Object.keys(SPOT_MODE_LABELS) as SpotEdit['mode'][]).map((m) => ({
              value: m,
              label: SPOT_MODE_LABELS[m],
            }))}
          />
        </div>
        <SliderRow
          label="Spot Size"
          min={0.005}
          max={0.4}
          step={0.001}
          precision={3}
          defaultValue={0.04}
          value={spot ? spot.radius : rt.spotRadius}
          modified={!!spot && spot.radius !== 0.04}
          onChange={(v) => {
            if (spot) editSpot(spot.id, 'spot.radius', 'Spot Size', (s) => { s.radius = v })
            else rt.setSpot({ spotRadius: v })
          }}
        />
        <SliderRow
          label="Spot Feather"
          min={0}
          max={100}
          defaultValue={50}
          value={spot ? spot.feather : rt.spotFeather}
          modified={!!spot && spot.feather !== 50}
          onChange={(v) => {
            if (spot) editSpot(spot.id, 'spot.feather', 'Spot Feather', (s) => { s.feather = v })
            else rt.setSpot({ spotFeather: v })
          }}
        />
        <SliderRow
          label="Spot Opacity"
          min={0}
          max={1}
          step={0.01}
          precision={2}
          defaultValue={1}
          value={spot ? spot.opacity : rt.spotOpacity}
          modified={!!spot && spot.opacity !== 1}
          onChange={(v) => {
            if (spot) editSpot(spot.id, 'spot.opacity', 'Spot Opacity', (s) => { s.opacity = v })
            else rt.setSpot({ spotOpacity: v })
          }}
        />

        {spots.length > 0 && (
          <div className="mt-1.5 overflow-hidden rounded-md bg-base shadow-[inset_0_0.5px_1px_rgb(0_0_0/0.3)]">
            {spots.map((s, i) => (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                onClick={() => rt.selectSpot(rt.selectedSpotId === s.id ? null : s.id)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') rt.selectSpot(s.id)
                }}
                onContextMenu={(ev) =>
                  open(ev, [
                    { label: 'Toggle Heal / Clone', onSelect: () =>
                      editSpot(s.id, 'spot.mode', 'Spot Mode', (x) => {
                        x.mode = x.mode === 'heal' ? 'clone' : 'heal'
                      }, false) },
                    { label: 'Delete', danger: true, onSelect: () => {
                      update('spot.delete', 'Delete Spot', (e) => {
                        e.spots = e.spots.filter((x) => x.id !== s.id)
                      }, false)
                      if (rt.selectedSpotId === s.id) rt.selectSpot(null)
                    } },
                  ])
                }
                className={cn(
                  'flex cursor-default items-center gap-2 px-2 py-1 text-mini',
                  'transition-colors duration-[--duration-fast] ease-[--ease-out]',
                  i > 0 && 'hairline-t',
                  s.id === rt.selectedSpotId
                    ? 'bg-control text-label'
                    : 'text-label-secondary hover:bg-raised hover:text-label',
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  {SPOT_MODE_LABELS[s.mode]} {i + 1}
                </span>
                <button
                  type="button"
                  aria-label="Delete spot"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    update('spot.delete', 'Delete Spot', (e) => {
                      e.spots = e.spots.filter((x) => x.id !== s.id)
                    }, false)
                  }}
                  className="shrink-0 px-1 text-icon-tertiary transition-colors duration-[--duration-fast] hover:text-icon"
                >
                  <CloseIcon size={9} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-2.5">
        <div className="mb-1.5 flex items-center gap-1.5">
          <span className="w-[44px] shrink-0 text-mini text-label-tertiary">Eye</span>
          <Select
            value={eye ? eye.kind : rt.eyeKind}
            onChange={(v) => {
              const kind = v as RedEyeEdit['kind']
              if (eye) editEye(eye.id, 'eye.kind', 'Red Eye Type', (r) => { r.kind = kind }, false)
              else rt.setEye({ eyeKind: kind })
            }}
            options={(Object.keys(EYE_KIND_LABELS) as RedEyeEdit['kind'][]).map((k) => ({
              value: k,
              label: EYE_KIND_LABELS[k],
            }))}
          />
        </div>
        <SliderRow
          label="Pupil Size"
          min={0.005}
          max={0.3}
          step={0.001}
          precision={3}
          defaultValue={0.03}
          value={eye ? eye.radius : rt.eyeRadius}
          modified={!!eye && eye.radius !== 0.03}
          onChange={(v) => {
            if (eye) editEye(eye.id, 'eye.radius', 'Pupil Size', (r) => { r.radius = v })
            else rt.setEye({ eyeRadius: v })
          }}
        />
        <SliderRow
          label="Pupil Darken"
          min={0}
          max={100}
          defaultValue={50}
          value={eye ? eye.darken : rt.eyeDarken}
          modified={!!eye && eye.darken !== 50}
          onChange={(v) => {
            if (eye) editEye(eye.id, 'eye.darken', 'Darken', (r) => { r.darken = v })
            else rt.setEye({ eyeDarken: v })
          }}
        />

        {redEye.length > 0 && (
          <div className="mt-1.5 overflow-hidden rounded-md bg-base shadow-[inset_0_0.5px_1px_rgb(0_0_0/0.3)]">
            {redEye.map((r, i) => (
              <div
                key={r.id}
                role="button"
                tabIndex={0}
                onClick={() => rt.selectEye(rt.selectedEyeId === r.id ? null : r.id)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') rt.selectEye(r.id)
                }}
                className={cn(
                  'flex cursor-default items-center gap-2 px-2 py-1 text-mini',
                  'transition-colors duration-[--duration-fast] ease-[--ease-out]',
                  i > 0 && 'hairline-t',
                  r.id === rt.selectedEyeId
                    ? 'bg-control text-label'
                    : 'text-label-secondary hover:bg-raised hover:text-label',
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  {EYE_KIND_LABELS[r.kind]} {i + 1}
                </span>
                <button
                  type="button"
                  aria-label="Delete red eye correction"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    update('eye.delete', 'Delete Red Eye', (e) => {
                      e.redEye = e.redEye.filter((x) => x.id !== r.id)
                    }, false)
                  }}
                  className="shrink-0 px-1 text-icon-tertiary transition-colors duration-[--duration-fast] hover:text-icon"
                >
                  <CloseIcon size={9} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </PanelSection>
  )
}
