import { useCallback } from 'react'
import { cn } from '../../../lib/cn'
import { CloseIcon, HealIcon, TrashIcon } from '../../../design/icons'
import { MENU_ICON } from '../../../design/Menu'
import { PanelSection, MiniAction } from '../../../design/Panel'
import { Button, Select, SelectField } from '../../../design/Controls'
import { SliderRow } from '../../../design/Slider'
import { useMenu } from '../../../design/useMenu'
import { panelMenuItems } from '../../../shell/appMenus'
import { useDevelop } from '../../../develop/session'
import { useUI } from '../../../state/ui'
import {
  EYE_KIND_LABELS,
  SPOT_MODE_LABELS,
  useRetouch,
  type RetouchState,
} from '../../../develop/retouch'
import type { RedEyeEdit, SpotEdit } from '../../../core/types'

type DevelopUpdate = ReturnType<typeof useDevelop.getState>['update']
type EditSpot = (
  id: string,
  key: string,
  label: string,
  edit: (spot: SpotEdit) => void,
  coalesce?: boolean,
) => void
type EditEye = (
  id: string,
  key: string,
  label: string,
  edit: (eye: RedEyeEdit) => void,
  coalesce?: boolean,
) => void

function SpotControls({
  spots,
  spot,
  retouch,
  editSpot,
  update,
  openMenu,
}: {
  spots: SpotEdit[]
  spot: SpotEdit | null
  retouch: RetouchState
  editSpot: EditSpot
  update: DevelopUpdate
  openMenu: ReturnType<typeof useMenu>['open']
}) {
  return (
    <div className="mt-2.5">
      <SelectField label="Spot">
        <Select
          size="sm"
          className="min-w-0 flex-1"
          value={spot ? spot.mode : retouch.spotMode}
          onChange={(value) => {
            const mode = value as SpotEdit['mode']
            if (spot) editSpot(spot.id, 'spot.mode', 'Spot Mode', (item) => { item.mode = mode }, false)
            else retouch.setSpot({ spotMode: mode })
          }}
          options={(Object.keys(SPOT_MODE_LABELS) as SpotEdit['mode'][]).map((mode) => ({
            value: mode,
            label: SPOT_MODE_LABELS[mode],
          }))}
        />
      </SelectField>
      <SliderRow
        label="Spot Size"
        min={0.005}
        max={0.4}
        step={0.001}
        precision={3}
        defaultValue={0.04}
        value={spot ? spot.radius : retouch.spotRadius}
        modified={!!spot && spot.radius !== 0.04}
        onChange={(value) => {
          if (spot) editSpot(spot.id, 'spot.radius', 'Spot Size', (item) => { item.radius = value })
          else retouch.setSpot({ spotRadius: value })
        }}
      />
      <SliderRow
        label="Spot Feather"
        min={0}
        max={100}
        defaultValue={50}
        value={spot ? spot.feather : retouch.spotFeather}
        modified={!!spot && spot.feather !== 50}
        onChange={(value) => {
          if (spot) editSpot(spot.id, 'spot.feather', 'Spot Feather', (item) => { item.feather = value })
          else retouch.setSpot({ spotFeather: value })
        }}
      />
      <SliderRow
        label="Spot Opacity"
        min={0}
        max={1}
        step={0.01}
        precision={2}
        defaultValue={1}
        value={spot ? spot.opacity : retouch.spotOpacity}
        modified={!!spot && spot.opacity !== 1}
        onChange={(value) => {
          if (spot) editSpot(spot.id, 'spot.opacity', 'Spot Opacity', (item) => { item.opacity = value })
          else retouch.setSpot({ spotOpacity: value })
        }}
      />

      {spots.length > 0 && (
        <div className="mt-1.5 overflow-hidden rounded-md bg-base shadow-[inset_0_0.5px_1px_rgb(0_0_0/0.3)]">
          {spots.map((item, index) => (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              onClick={() => retouch.selectSpot(retouch.selectedSpotId === item.id ? null : item.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') retouch.selectSpot(item.id)
              }}
              onContextMenu={(event) =>
                openMenu(event, [
                  {
                    label: 'Toggle Heal / Clone',
                    icon: <HealIcon size={MENU_ICON} />,
                    onSelect: () =>
                      editSpot(item.id, 'spot.mode', 'Spot Mode', (target) => {
                        target.mode = target.mode === 'heal' ? 'clone' : 'heal'
                      }, false),
                  },
                  {
                    label: 'Delete',
                    icon: <TrashIcon size={MENU_ICON} />,
                    danger: true,
                    onSelect: () => {
                      update('spot.delete', 'Delete Spot', (edits) => {
                        edits.spots = edits.spots.filter((target) => target.id !== item.id)
                      }, false)
                      if (retouch.selectedSpotId === item.id) retouch.selectSpot(null)
                    },
                  },
                ])
              }
              className={cn(
                'flex cursor-default items-center gap-2 px-2 py-1 text-mini',
                'transition-colors duration-[--duration-fast] ease-[--ease-out]',
                index > 0 && 'hairline-t',
                item.id === retouch.selectedSpotId
                  ? 'bg-control text-label'
                  : 'text-label-secondary hover:bg-raised hover:text-label',
              )}
            >
              <span className="min-w-0 flex-1 truncate">
                {SPOT_MODE_LABELS[item.mode]} {index + 1}
              </span>
              <button
                type="button"
                aria-label="Delete spot"
                onClick={(event) => {
                  event.stopPropagation()
                  update('spot.delete', 'Delete Spot', (edits) => {
                    edits.spots = edits.spots.filter((target) => target.id !== item.id)
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
  )
}

function EyeControls({
  redEye,
  eye,
  retouch,
  editEye,
  update,
}: {
  redEye: RedEyeEdit[]
  eye: RedEyeEdit | null
  retouch: RetouchState
  editEye: EditEye
  update: DevelopUpdate
}) {
  return (
    <div className="mt-2.5">
      <SelectField label="Eye">
        <Select
          size="sm"
          className="min-w-0 flex-1"
          value={eye ? eye.kind : retouch.eyeKind}
          onChange={(value) => {
            const kind = value as RedEyeEdit['kind']
            if (eye) editEye(eye.id, 'eye.kind', 'Red Eye Type', (item) => { item.kind = kind }, false)
            else retouch.setEye({ eyeKind: kind })
          }}
          options={(Object.keys(EYE_KIND_LABELS) as RedEyeEdit['kind'][]).map((kind) => ({
            value: kind,
            label: EYE_KIND_LABELS[kind],
          }))}
        />
      </SelectField>
      <SliderRow
        label="Pupil Size"
        min={0.005}
        max={0.3}
        step={0.001}
        precision={3}
        defaultValue={0.03}
        value={eye ? eye.radius : retouch.eyeRadius}
        modified={!!eye && eye.radius !== 0.03}
        onChange={(value) => {
          if (eye) editEye(eye.id, 'eye.radius', 'Pupil Size', (item) => { item.radius = value })
          else retouch.setEye({ eyeRadius: value })
        }}
      />
      <SliderRow
        label="Pupil Darken"
        min={0}
        max={100}
        defaultValue={50}
        value={eye ? eye.darken : retouch.eyeDarken}
        modified={!!eye && eye.darken !== 50}
        onChange={(value) => {
          if (eye) editEye(eye.id, 'eye.darken', 'Darken', (item) => { item.darken = value })
          else retouch.setEye({ eyeDarken: value })
        }}
      />

      {redEye.length > 0 && (
        <div className="mt-1.5 overflow-hidden rounded-md bg-base shadow-[inset_0_0.5px_1px_rgb(0_0_0/0.3)]">
          {redEye.map((item, index) => (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              onClick={() => retouch.selectEye(retouch.selectedEyeId === item.id ? null : item.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') retouch.selectEye(item.id)
              }}
              className={cn(
                'flex cursor-default items-center gap-2 px-2 py-1 text-mini',
                'transition-colors duration-[--duration-fast] ease-[--ease-out]',
                index > 0 && 'hairline-t',
                item.id === retouch.selectedEyeId
                  ? 'bg-control text-label'
                  : 'text-label-secondary hover:bg-raised hover:text-label',
              )}
            >
              <span className="min-w-0 flex-1 truncate">
                {EYE_KIND_LABELS[item.kind]} {index + 1}
              </span>
              <button
                type="button"
                aria-label="Delete red eye correction"
                onClick={(event) => {
                  event.stopPropagation()
                  update('eye.delete', 'Delete Red Eye', (edits) => {
                    edits.redEye = edits.redEye.filter((target) => target.id !== item.id)
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
  )
}

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
      id="develop-retouch"
      revealKey={tool === 'heal' || tool === 'redeye' ? tool : null}
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

      <SpotControls
        spots={spots}
        spot={spot}
        retouch={rt}
        editSpot={editSpot}
        update={update}
        openMenu={open}
      />
      <EyeControls
        redEye={redEye}
        eye={eye}
        retouch={rt}
        editEye={editEye}
        update={update}
      />
    </PanelSection>
  )
}
