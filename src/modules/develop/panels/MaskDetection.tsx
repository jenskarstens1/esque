import { useCallback, useMemo, useState } from 'react'
import { Button, Select } from '../../../design/Controls'
import { SliderRow } from '../../../design/Slider'
import { Tooltip } from '../../../design/Tooltip'
import { ProgressBar } from '../../../design/ProgressBar'
import { useDevelop } from '../../../develop/session'
import { detectKey, isDetectionBusy, useDetect, type DetectStatus } from '../../../ai/detect'
import { getAlpha } from '../../../ai/alpha'
import { useAiSupport } from '../../../ai/useAiSupport'
import { consentKey, useAiPreferences } from '../../../ai/preferences'
import { useModelCache } from '../../../ai/useModelCache'
import {
  RUNTIME_BYTES,
  formatBytes,
  defaultRefineFor,
  modelsFor,
  type AiMaskKind,
  type SegmentModel,
  type SegmentModelId,
} from '../../../ai/models'
import { activeRenderer } from '../activeRenderer'
import { runMaskDetection } from './maskDetectionActions'
import type { AiMaskGeometry, Mask, MaskComponent } from '../../../core/types'

function detectionAction(ready: boolean, replacing: boolean, kind: AiMaskKind) {
  if (ready && replacing) return 'Replace Mask'
  if (ready) return 'Detect Again'
  return kind === 'aiPerson' ? 'Detect People' : 'Detect'
}

function modelCost(onDisk: boolean | null, model: SegmentModel) {
  if (onDisk === null) return model.note
  if (onDisk) return `${model.note} Already downloaded.`
  return `${model.note} Downloads ${formatBytes(model.bytes)} of weights (${model.license}) after your permission. Detection may also load a ${formatBytes(RUNTIME_BYTES)} shared runtime from this site.`
}

function DetectionProgress({ status }: { status: DetectStatus | undefined }) {
  if (status?.phase !== 'downloading') return null
  return (
    <ProgressBar label="Model download" value={status.progress ?? 0} detail="Downloading model..." />
  )
}

function DetectionResult({
  status,
  ready,
}: {
  status: DetectStatus | undefined
  ready: boolean
}) {
  if (status?.phase === 'error') {
    return <p role="alert" className="text-mini leading-snug text-red">{status.message}</p>
  }
  if (!ready || !status) return null
  const detail =
    status.ms == null
      ? 'Using the saved result.'
      : `Detected in ${status.ms} ms${status.gpu ? '' : ' on the CPU'}.`
  return <p className="text-mini text-label-tertiary">{detail}</p>
}

function DetectionActions({
  blocked,
  busy,
  photoId,
  onDisk,
  needsConsent,
  phase,
  ready,
  replacing,
  kind,
  reason,
  run,
}: {
  blocked: boolean
  busy: boolean
  photoId: string | null
  onDisk: boolean | null
  needsConsent: boolean
  phase: DetectStatus['phase'] | 'idle'
  ready: boolean
  replacing: boolean
  kind: AiMaskKind
  reason: string | null
  run: () => Promise<void>
}) {
  const label = busy
    ? phase === 'queued' ? 'Waiting…' : phase === 'downloading' ? 'Loading model…' : 'Detecting…'
    : detectionAction(ready, replacing, kind)
  return (
    <>
      <Tooltip content={reason ?? ''} disabled={!reason} side="top">
        <span className="block">
          <Button
            size="sm"
            variant="ghost"
            disabled={blocked || busy || !photoId || onDisk === null || needsConsent}
            onClick={run}
          >
            {label}
          </Button>
        </span>
      </Tooltip>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => window.dispatchEvent(new CustomEvent('esque:settings', { detail: { pane: 'ai' } }))}
      >
        {needsConsent ? 'Allow download in Settings' : 'Manage AI models'}
      </Button>
    </>
  )
}

function useModelSelection(photoId: string | null, maskId: string, componentId: string, geometry: AiMaskGeometry) {
  const [selection, setSelection] = useState<{
    photoId: string | null
    maskId: string
    componentId: string
    original: string | undefined
    cacheKey: string | null
    next: SegmentModelId
  } | null>(null)
  const kind = geometry.kind as AiMaskKind
  const tiers = useMemo(() => modelsFor(kind, geometry.model), [kind, geometry.model])
  const selected = selection?.photoId === photoId && selection.maskId === maskId &&
    selection.componentId === componentId && selection.original === geometry.model &&
    selection.cacheKey === geometry.cacheKey ? selection.next : geometry.model
  const model = tiers.find((tier) => tier.id === selected) ?? tiers[0]
  const chooseModel = useCallback((next: SegmentModelId) => {
    setSelection({ photoId, maskId, componentId, original: geometry.model, cacheKey: geometry.cacheKey, next })
  }, [photoId, maskId, componentId, geometry.model, geometry.cacheKey])
  return { tiers, model, chooseModel, setSelection }
}

/**
 * The controls behind a detected mask.
 *
 * Everything here exists to answer one question before the user commits to it:
 * what is this going to cost? The model size and licence are stated next to
 * the picker, and a model already on disk says so rather than implying a
 * download that will not happen. Saved masks retain their original model.
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
  const { tiers, model, chooseModel, setSelection } = useModelSelection(photoId, mask.id, component.id, geometry)
  const modelId = model.id
  const allowed = useAiPreferences((s) => s.downloads[modelId] === consentKey(model))
  const { cached: onDisk, error: cacheError } = useModelCache(model)

  const key = photoId ? detectKey({ photoId, kind, modelId }) : null
  // Existing edits retain their saved coverage even when the inference recipe
  // changes; only an explicit detection should replace that result.
  const statusKey = geometry.cacheKey ?? key
  const status = useDetect((s) => {
    const requested = key ? s.status[key] : undefined
    if (requested && (isDetectionBusy(requested.phase) || requested.phase === 'error')) return requested
    return statusKey ? s.status[statusKey] : undefined
  })
  const phase = status?.phase ?? 'idle'
  const ready = useDetect((s) => !!geometry.cacheKey &&
    (s.status[geometry.cacheKey]?.phase === 'ready' || !!getAlpha(geometry.cacheKey)))
  const replacing = !!geometry.cacheKey && geometry.cacheKey !== key

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
    const ok = await runMaskDetection({ photoId, kind, modelId, maskId: mask.id, componentId: component.id })
    if (ok) {
      activeRenderer()?.invalidateCoverage(key)
      setSelection(null)
    }
  }, [photoId, key, kind, modelId, mask.id, component.id, setSelection])

  const blocked = support ? !support.ok : true
  const reason = support?.reason ?? (support ? null : 'Checking what this browser supports…')
  const busy = isDetectionBusy(phase)

  const needsConsent = onDisk === false && !allowed

  return (
    <div className="mt-1.5 flex flex-col gap-1.5 rounded-[4px] bg-raised px-2 py-2">
      <div className="flex items-center gap-1.5">
        <span className="w-[44px] shrink-0 text-mini text-label-tertiary">Model</span>
        <Select
          value={modelId}
          aria-label="Mask model"
          disabled={blocked || busy}
          onChange={(v) => chooseModel(v as SegmentModelId)}
          options={tiers.map((t) => ({
            value: t.id,
            label: `${t.label} · ${formatBytes(t.bytes)}`,
          }))}
        />
      </div>

      <p className="text-mini leading-snug text-label-tertiary">{modelCost(onDisk, model)}</p>
      {ready && replacing && (
        <p role="status" className="text-mini leading-snug text-label-secondary">
          Your current mask stays visible until the replacement is ready.
        </p>
      )}

      <DetectionActions
        blocked={blocked}
        busy={busy}
        photoId={photoId}
        onDisk={onDisk}
        needsConsent={needsConsent}
        phase={phase}
        ready={ready}
        replacing={replacing}
        kind={kind}
        reason={reason}
        run={run}
      />
      {cacheError && <p role="alert" className="text-mini leading-snug text-red">{cacheError}</p>}

      <DetectionProgress status={status} />
      <DetectionResult status={status} ready={ready} />

      {!blocked && support && !support.gpu && phase === 'idle' && (
        <p className="text-mini leading-snug text-label-tertiary">{support.reason}</p>
      )}

      <SliderRow
        label="Refine"
        min={0}
        max={100}
        defaultValue={defaultRefineFor(geometry.model)}
        value={geometry.refine}
        modified={geometry.refine !== defaultRefineFor(geometry.model)}
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
