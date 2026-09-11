import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Checkbox, Select, SelectField } from '../../../design/Controls'
import { SliderRow } from '../../../design/Slider'
import { Tooltip } from '../../../design/Tooltip'
import { ProgressBar } from '../../../design/ProgressBar'
import { Spinner } from '../../../design/Spinner'
import { toast } from '../../../design/toast'
import { useDevelop } from '../../../develop/session'
import { loadProxy, peekProxy } from '../../../develop/proxy'
import { detectKey, isDetectionBusy, useDetect, type DetectStatus } from '../../../ai/detect'
import { getAlpha } from '../../../ai/alpha'
import { useAiSupport } from '../../../ai/useAiSupport'
import { MASK_KIND_LABELS } from '../../../develop/layers'
import { consentKey, setModelConsent, useAiPreferences } from '../../../ai/preferences'
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
import type { AiMaskGeometry, Layer, MaskComponent } from '../../../core/types'

function detectionAction(ready: boolean, replacing: boolean, kind: AiMaskKind) {
  if (ready && replacing) return 'Replace Mask'
  if (ready) return 'Detect Again'
  return kind === 'aiPerson' ? 'Detect People' : 'Detect'
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
  busy,
}: {
  status: DetectStatus | undefined
  ready: boolean
  busy: boolean
}) {
  if (status?.phase === 'error') {
    return <p role="alert" className="text-mini leading-snug text-red">{status.message}</p>
  }
  if (busy || !ready || !status) return null
  const detail =
    status.ms == null ? 'Using the saved result.' : `${status.ms} ms${status.gpu ? '' : ' · CPU'}`
  return <p className="text-mini text-label-tertiary">{detail}</p>
}

/**
 * The full cost of a download, kept out of the way until it is asked for.
 *
 * Consent has to be informed, but a paragraph nobody reads is not information —
 * it is what the user learns to skip. The checkbox names the model and the
 * size, which is the decision; the rest waits in the tooltip.
 */
function consentDetail(model: SegmentModel): string {
  return `${model.note} ${formatBytes(model.bytes)} of weights (${model.license}) and a ${formatBytes(RUNTIME_BYTES)} shared runtime, downloaded once and kept on this device. Your photos never leave it.`
}

/** The one-time permission, offered where the download is about to happen. */
function DownloadConsent({
  model,
  allowed,
  onDisk,
  disabled,
}: {
  model: SegmentModel
  allowed: boolean
  onDisk: boolean | null
  disabled: boolean
}) {
  const consent = (value: boolean) => {
    try {
      setModelConsent(model, value)
    } catch (cause) {
      toast.error('Could not save download permission', cause instanceof Error ? cause.message : String(cause))
    }
  }
  if (onDisk !== false) return null
  return (
    <Checkbox
      checked={allowed}
      disabled={disabled}
      onChange={consent}
      label={
        <Tooltip content={consentDetail(model)} side="top">
          <span className="text-mini leading-snug">
            Download {model.label} · {formatBytes(model.bytes)}
          </span>
        </Tooltip>
      }
    />
  )
}

/**
 * Which model answers this mask, and what it costs.
 *
 * The picker only appears where there is a choice to make — a saved mask whose
 * model has since been replaced. A new mask has exactly one sensible model, and
 * a one-option dropdown asks the user to decide something they cannot.
 */
function ModelChoice({
  tiers,
  model,
  disabled,
  choose,
}: {
  tiers: SegmentModel[]
  model: SegmentModel
  disabled: boolean
  choose: (id: SegmentModelId) => void
}) {
  if (tiers.length < 2) return null
  return (
    <SelectField label="Model">
      <Select
        size="sm"
        className="min-w-0 flex-1"
        value={model.id}
        aria-label="Mask model"
        disabled={disabled}
        onChange={(v) => choose(v as SegmentModelId)}
        options={tiers.map((t) => ({
          value: t.id,
          label: `${t.label} · ${formatBytes(t.bytes)}`,
        }))}
      />
    </SelectField>
  )
}

/** WASM inference is slow rather than broken, so it is a note, not a refusal. */
function CpuNotice({
  support,
  blocked,
  phase,
}: {
  support: ReturnType<typeof useAiSupport>
  blocked: boolean
  phase: DetectStatus['phase'] | 'idle'
}) {
  if (blocked || !support || support.gpu || phase !== 'idle') return null
  return <p className="text-mini leading-snug text-label-tertiary">{support.reason}</p>
}

/**
 * The one control, shown only when there is something to press.
 *
 * Detection runs by itself, so in the ordinary case there is nothing to do
 * here and a button would be furniture. It comes back for the cases a click
 * actually resolves: a failure, a model swap the user must confirm, and the
 * deliberate re-run of a mask that already exists.
 */
function DetectionActions({
  blocked,
  busy,
  photoId,
  onDisk,
  needsConsent,
  phase,
  preparing,
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
  preparing: boolean
  ready: boolean
  replacing: boolean
  kind: AiMaskKind
  reason: string | null
  run: () => Promise<void>
}) {
  // While it is working, the status line already says so.
  if (busy || preparing) return null

  const settled = ready && !replacing && phase !== 'error' && !blocked
  if (settled) {
    return (
      <button
        type="button"
        onClick={run}
        className="shrink-0 text-mini text-label-tertiary transition-colors duration-[--duration-fast] hover:text-label"
      >
        Detect Again
      </button>
    )
  }

  const hint = reason ?? (needsConsent ? 'Allow the download above to run detection.' : null)
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Tooltip content={hint ?? ''} disabled={!hint} side="top">
        <span className="block">
          <Button
            size="sm"
            variant={ready ? 'ghost' : 'secondary'}
            disabled={blocked || !photoId || onDisk === null || needsConsent}
            onClick={run}
          >
            {phase === 'error' ? 'Try Again' : detectionAction(ready, replacing, kind)}
          </Button>
        </span>
      </Tooltip>
      {blocked && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => window.dispatchEvent(new CustomEvent('esque:settings', { detail: { pane: 'ai' } }))}
        >
          AI settings
        </Button>
      )}
    </div>
  )
}

/** What detection is doing, in one line that replaces itself. */
function DetectionStatus({
  busy,
  preparing,
  phase,
}: {
  busy: boolean
  preparing: boolean
  phase: DetectStatus['phase'] | 'idle'
}) {
  if (!busy && !preparing) return null
  const label = preparing
    ? 'Opening photo…'
    : phase === 'queued'
      ? 'Waiting…'
      : phase === 'downloading'
        ? 'Loading model…'
        : 'Detecting…'
  return (
    <p role="status" className="flex items-center gap-1.5 text-mini text-label-tertiary">
      <Spinner size={10} />
      {label}
    </p>
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

/** Everything that must resolve before detection may start on its own. */
function detectionHeld({
  blocked,
  busy,
  phase,
  onDisk,
  needsConsent,
}: {
  blocked: boolean
  busy: boolean
  phase: DetectStatus['phase'] | 'idle'
  onDisk: boolean | null
  needsConsent: boolean
}) {
  return blocked || busy || phase === 'error' || onDisk === null || needsConsent
}

/**
 * Runs a never-detected component's model without being asked twice.
 *
 * Held back only for what a click could not fix either: an unsupported browser,
 * a model that is neither on disk nor permitted, a run already in flight, or a
 * previous failure the user should see before it repeats. Reports whether the
 * photo's pixels are still being waited on, which the action label uses.
 */
function useAutomaticDetection({
  photoId,
  detectionKey,
  cacheKey,
  maskId,
  componentId,
  hold,
  run,
}: {
  photoId: string | null
  detectionKey: string | null
  cacheKey: string | null | undefined
  maskId: string
  componentId: string
  hold: boolean
  run: () => Promise<void>
}) {
  const [preparing, setPreparing] = useState(false)
  const attempted = useRef<string | null>(null)
  useEffect(() => {
    if (!photoId || !detectionKey || cacheKey || hold) return
    const token = `${photoId}|${maskId}|${componentId}|${detectionKey}`
    if (attempted.current === token) return
    attempted.current = token
    let live = true
    void (async () => {
      if (!peekProxy(photoId)) {
        setPreparing(true)
        // Detection reads the decoded proxy and will not force one; in Develop
        // the photo is on screen, so this joins the load already in flight.
        await loadProxy(photoId).catch(() => null)
        if (live) setPreparing(false)
      }
      if (!live || useDevelop.getState().photoId !== photoId) return
      await run()
    })()
    return () => { live = false }
  }, [photoId, detectionKey, cacheKey, hold, maskId, componentId, run])
  return preparing
}

/**
 * Everything the detection controls need to know, resolved in one place.
 *
 * Which model, whether its weights are here, whether the user has allowed them
 * to arrive, what a run of it is currently doing, and whether the answer on
 * screen came from a different model than the one now selected. Pulling it out
 * of the component keeps the markup a description of those facts rather than a
 * second place they are worked out.
 */
function useDetection(mask: Layer, component: MaskComponent, geometry: AiMaskGeometry) {
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
        'layers.ai',
        label,
        (e) => {
          const m = e.layers.find((x) => x.id === mask.id)
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

  const preparing = useAutomaticDetection({
    photoId,
    detectionKey: key,
    cacheKey: geometry.cacheKey,
    maskId: mask.id,
    componentId: component.id,
    hold: detectionHeld({ blocked, busy, phase, onDisk, needsConsent }),
    run,
  })

  // Nothing to report while it is idle and has never run — and an empty column
  // would push the one control that is there to the far edge.
  const reporting = busy || preparing || phase === 'error' || (ready && !!status)

  return {
    photoId, support, kind, tiers, model, chooseModel, allowed, onDisk, cacheError,
    status, phase, ready, replacing, mutate, run, blocked, reason, busy, needsConsent,
    preparing, reporting,
  }
}

/**
 * The controls behind a detected mask.
 *
 * A new detected component runs its model by itself. Asking for a Subject mask
 * is already the instruction, and a panel that answers it with a disabled
 * button and a trip to Settings teaches nothing except that the feature is
 * broken — so detection starts as soon as it honestly can, and the controls
 * exist for the second and third attempt rather than the first.
 *
 * What cannot start by itself is the one thing that costs the user something.
 * Weights are fetched only after explicit permission, so that permission is
 * offered here, next to the sentence naming the size and licence, instead of
 * being deferred to another window; granting it is what releases the automatic
 * run. Saved layers retain their original model, and replacing one stays a
 * deliberate click.
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
  mask: Layer
  component: MaskComponent
  geometry: AiMaskGeometry
}) {
  const {
    photoId, support, kind, tiers, model, chooseModel, allowed, onDisk, cacheError,
    status, phase, ready, replacing, mutate, run, blocked, reason, busy, needsConsent,
    preparing, reporting,
  } = useDetection(mask, component, geometry)

  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-base px-2 py-2 shadow-[inset_0_0.5px_1px_rgb(0_0_0/0.3)]">
      <div className="flex min-h-5 items-center gap-2">
        <span className="truncate text-mini text-label-secondary">
          {MASK_KIND_LABELS[kind]}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <DetectionActions
            blocked={blocked}
            busy={busy}
            photoId={photoId}
            onDisk={onDisk}
            needsConsent={needsConsent}
            phase={phase}
            preparing={preparing}
            ready={ready}
            replacing={replacing}
            kind={kind}
            reason={reason}
            run={run}
          />
        </div>
      </div>

      <DownloadConsent
        model={model}
        allowed={allowed}
        onDisk={blocked ? null : onDisk}
        disabled={busy || preparing}
      />

      {reporting && (
        <div className="min-w-0">
          <DetectionStatus busy={busy} preparing={preparing} phase={phase} />
          <DetectionResult status={status} ready={ready} busy={busy || preparing} />
        </div>
      )}

      {ready && replacing && (
        <p role="status" className="text-mini leading-snug text-label-secondary">
          Your current mask stays visible until the replacement is ready.
        </p>
      )}

      <DetectionProgress status={status} />
      <ModelChoice tiers={tiers} model={model} disabled={blocked || busy} choose={chooseModel} />

      {cacheError && <p role="alert" className="text-mini leading-snug text-red">{cacheError}</p>}
      <CpuNotice support={support} blocked={blocked} phase={phase} />

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
