import { useCallback, useEffect, useMemo } from 'react'
import { Button, Select } from '../../../design/Controls'
import { SliderRow } from '../../../design/Slider'
import { Tooltip } from '../../../design/Tooltip'
import { useDevelop } from '../../../develop/session'
import { detect, detectKey, useDetect } from '../../../ai/detect'
import { useAiSupport } from '../../../ai/useAiSupport'
import { isModelCached, anyModelCached } from '../../../ai/modelCache'
import {
  RUNTIME_BYTES,
  SEGMENT_MODELS,
  SEGMENT_MODEL_LIST,
  defaultModelFor,
  formatBytes,
  modelsFor,
  type AiMaskKind,
  type SegmentModelId,
} from '../../../ai/models'
import { activeRenderer } from '../activeRenderer'
import type { AiMaskGeometry, Mask, MaskComponent } from '../../../core/types'
import { useState } from 'react'

/**
 * The controls behind a detected mask.
 *
 * Everything here exists to answer one question before the user commits to it:
 * what is this going to cost? A subject mask is the only thing in esque that
 * might download a hundred megabytes, and the difference between the two tiers
 * is four megabytes and half a second against a hundred and fourteen and
 * several. Hiding that behind a button labelled "Detect" would be a poor trade
 * for the second it takes to read — so the size is stated next to the picker,
 * the licence with it, and a model already on disk says so rather than
 * implying a download that will not happen.
 *
 * The failure cases are given the same treatment. A browser without WebGPU
 * cannot do this at all, and one without a GPU adapter can only do it slowly;
 * both are said plainly, on the disabled control, instead of leaving the user
 * to click and wonder.
 */
export function MaskDetection({
  mask,
  component,
  geometry,
}: {
  mask: Mask
  component: MaskComponent
  geometry: AiMaskGeometry
}) {
  const photoId = useDevelop((s) => s.photoId)
  const update = useDevelop((s) => s.update)
  const support = useAiSupport()

  const kind = geometry.kind as AiMaskKind
  const tiers = useMemo(() => modelsFor(kind), [kind])
  const modelId = (geometry.model as SegmentModelId | undefined) ?? defaultModelFor(kind)
  const model = SEGMENT_MODELS[modelId] ?? tiers[0]

  const key = photoId ? detectKey({ photoId, kind, modelId }) : null
  const status = useDetect((s) => (key ? s.status[key] : undefined))
  const revision = useDetect((s) => s.revision)
  const phase = status?.phase ?? 'idle'

  // Whether the weights are already on disk decides whether the button implies
  // a download, so it is checked rather than assumed — and rechecked whenever
  // the tier changes, since the answer is per model. `warm` covers the runtime:
  // it is charged once for all models, so it only belongs in the sentence when
  // nothing has ever been downloaded.
  const [onDisk, setOnDisk] = useState<boolean | null>(null)
  const [warm, setWarm] = useState(false)
  useEffect(() => {
    let live = true
    setOnDisk(null)
    void isModelCached(model).then((v) => {
      if (live) setOnDisk(v)
    })
    void anyModelCached(SEGMENT_MODEL_LIST).then((v) => {
      if (live) setWarm(v)
    })
    return () => {
      live = false
    }
  }, [model, revision])

  const mutate = useCallback(
    (label: string, fn: (g: AiMaskGeometry) => void, coalesce = false) => {
      update(
        'masks.ai',
        label,
        (e) => {
          const m = e.masks.find((x) => x.id === mask.id)
          const c = m?.components.find((x) => x.id === component.id)
          if (c && 'refine' in c.geometry) fn(c.geometry as AiMaskGeometry)
        },
        coalesce,
      )
    },
    [update, mask.id, component.id],
  )

  const run = useCallback(async () => {
    if (!photoId || !key) return
    // The key is written before the run rather than after it. It names where
    // coverage will be, which is true the moment the request is made, and it
    // means a detection that is still in flight when the user reloads picks up
    // the cached result instead of starting again.
    mutate('Detect Subject', (g) => {
      g.cacheKey = key
      g.model = modelId
    })
    const ok = await detect({ photoId, kind, modelId })
    if (ok) {
      activeRenderer()?.invalidateCoverage(key)
      // The store's revision drives the viewport's rebuild; nudging the edit
      // stack as well would push a no-op onto history.
    }
  }, [photoId, key, kind, modelId, mutate])

  const chooseModel = useCallback(
    (next: SegmentModelId) => {
      mutate('Mask Model', (g) => {
        g.model = next
        // Coverage belongs to the tier that produced it, so switching tiers
        // clears the pointer rather than leaving the old mask under a new
        // label. Re-selecting the first tier finds its cached result intact.
        g.cacheKey = null
      })
    },
    [mutate],
  )

  const blocked = support ? !support.ok : true
  const reason = support?.reason ?? (support ? null : 'Checking what this browser supports…')
  const busy = phase === 'downloading' || phase === 'running'
  const ready = phase === 'ready' && geometry.cacheKey === key

  const action = ready ? 'Detect Again' : kind === 'aiPerson' ? 'Detect People' : 'Detect'

  const cost =
    onDisk === null
      ? model.note
      : onDisk
        ? `${model.note} Already downloaded.`
        : warm
          ? `${model.note} Downloads ${formatBytes(model.bytes)} once (${model.license}).`
          : `${model.note} First detection downloads ${formatBytes(model.bytes)} of weights (${model.license}) and a ${formatBytes(RUNTIME_BYTES)} runtime, then works offline.`

  return (
    <div className="mt-1.5 flex flex-col gap-1.5 rounded-[4px] bg-raised px-2 py-2">
      <div className="flex items-center gap-1.5">
        <span className="w-[44px] shrink-0 text-mini text-label-tertiary">Model</span>
        <Select
          value={modelId}
          disabled={blocked || busy}
          onChange={(v) => chooseModel(v as SegmentModelId)}
          // The size belongs on the option, not just on the sentence below it.
          // "Thorough" is a hundred and ten megabytes more than "Fast", and a
          // user should not have to select it to find that out.
          options={tiers.map((t) => ({
            value: t.id,
            label: `${t.label} · ${formatBytes(t.bytes)}`,
          }))}
        />
      </div>

      <p className="text-mini leading-snug text-label-tertiary">{cost}</p>

      <Tooltip content={reason ?? ''} disabled={!reason} side="top">
        <span className="block">
          <Button size="sm" variant="ghost" disabled={blocked || busy || !photoId} onClick={run}>
            {busy ? (phase === 'downloading' ? 'Downloading…' : 'Detecting…') : action}
          </Button>
        </span>
      </Tooltip>

      {phase === 'downloading' && (
        <div className="flex items-center gap-1.5">
          <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-slider-track">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-[--duration-fast]"
              style={{ width: `${Math.round((status?.progress ?? 0) * 100)}%` }}
            />
          </div>
          <span className="shrink-0 text-mini tabular-nums text-label-tertiary">
            {Math.round((status?.progress ?? 0) * 100)}%
          </span>
        </div>
      )}

      {phase === 'error' && <p className="text-mini leading-snug text-red">{status?.message}</p>}

      {ready && (
        <p className="text-mini text-label-tertiary">
          {status?.ms != null
            ? `Detected in ${status.ms} ms${status.gpu ? '' : ' on the CPU'}.`
            : 'Using the saved result.'}
        </p>
      )}

      {!blocked && support && !support.gpu && phase === 'idle' && (
        <p className="text-mini leading-snug text-label-tertiary">{support.reason}</p>
      )}

      <SliderRow
        label="Refine"
        min={0}
        max={100}
        defaultValue={50}
        value={geometry.refine}
        modified={geometry.refine !== 50}
        disabled={!ready}
        onChange={(v) =>
          mutate('Mask Refine', (g) => {
            g.refine = v
          }, true)
        }
      />
    </div>
  )
}
