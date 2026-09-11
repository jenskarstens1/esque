import { useState } from 'react'
import { Button, Checkbox } from '../design/Controls'
import { Field, FieldGroup } from '../design/Field'
import { ProgressBar } from '../design/ProgressBar'
import { toast } from '../design/toast'
import { releaseDetectionModel } from '../ai/detect'
import {
  cancelModelDownload,
  forgetModel,
  loadModelWeights,
  useModelDownloads,
  type ModelDownload,
} from '../ai/modelCache'
import { consentKey, setModelConsent, useAiPreferences } from '../ai/preferences'
import { RUNTIME_BYTES, SEGMENT_MODEL_LIST, formatBytes, type SegmentModel } from '../ai/models'
import { useModelCache } from '../ai/useModelCache'
import { useAiSupport } from '../ai/useAiSupport'

function storageLabel(
  removing: boolean,
  cached: boolean | null,
  bytes: number,
) {
  if (removing) return 'Deleting...'
  if (cached === null) return 'Checking...'
  if (cached) return `Downloaded (${formatBytes(bytes)})`
  if (bytes > 0) return `Incomplete (${formatBytes(bytes)}). Delete or download again.`
  return 'Not downloaded'
}

function ModelActions({
  model,
  allowed,
  cached,
  bytes,
  busy,
  removing,
  download,
  remove,
}: {
  model: SegmentModel
  allowed: boolean
  cached: boolean | null
  bytes: number
  busy: boolean
  removing: boolean
  download: () => Promise<void>
  remove: () => Promise<void>
}) {
  return (
    <Field>
      {busy ? (
        <Button disabled={removing} onClick={() => cancelModelDownload(model)}>Cancel download</Button>
      ) : (
        <Button disabled={!allowed || cached !== false || removing} onClick={() => void download()}>Download</Button>
      )}
      <Button disabled={!bytes || busy || removing} onClick={() => void remove()}>Delete model</Button>
    </Field>
  )
}

function ModelStorage({
  model,
  status,
  removing,
  cached,
  bytes,
}: {
  model: SegmentModel
  status: ModelDownload | undefined
  removing: boolean
  cached: boolean | null
  bytes: number
}) {
  if (status?.phase === 'downloading' || status?.phase === 'saving') {
    return (
      <Field label="Download">
        <ProgressBar
          label={`${model.label} model download`}
          value={status.progress}
          detail={status.phase === 'saving'
            ? 'Saving model...'
            : `${formatBytes(status.progress * model.bytes)} of ${formatBytes(model.bytes)}`}
        />
      </Field>
    )
  }
  return (
    <Field label="Storage">
      <span className="text-ui text-label-secondary" role="status">
        {storageLabel(removing, cached, bytes)}
      </span>
    </Field>
  )
}

function ModelSettings({ model }: { model: SegmentModel }) {
  const allowed = useAiPreferences((s) => s.downloads[model.id] === consentKey(model))
  const status = useModelDownloads((s) => s.status[model.id])
  const { cached, bytes, error } = useModelCache(model)
  const [deleting, setDeleting] = useState(false)
  const busy = status?.phase === 'downloading' || status?.phase === 'saving'
  const removing = deleting || status?.phase === 'removing'
  const source = new URL(model.remote).hostname

  const consent = (value: boolean) => {
    try {
      setModelConsent(model, value)
    } catch (cause) {
      toast.error('Could not save download permission', cause instanceof Error ? cause.message : String(cause))
    }
  }

  const download = async () => {
    try {
      await loadModelWeights(model)
      toast.show(`${model.label} model downloaded`)
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') return
      toast.error('Could not download the model', cause instanceof Error ? cause.message : String(cause))
    }
  }

  const remove = async () => {
    setDeleting(true)
    try {
      await forgetModel(model)
      await releaseDetectionModel(model.id)
      toast.show(`${model.label} model deleted`, { detail: 'Download permission removed. Saved layers are unchanged.' })
    } catch (cause) {
      toast.error('Could not delete the model', cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDeleting(false)
    }
  }

  const message = error ?? status?.message
  return (
    <FieldGroup title={model.label}>
      <p className="mb-3 text-mini leading-relaxed text-label-secondary">
        {model.note} {formatBytes(model.bytes)}, {model.license}, from {source}.
      </p>
      {model.licenseNote && <p className="mb-3 text-mini leading-relaxed text-label-secondary">{model.licenseNote}</p>}
      <Field label="Permission" hint="Turning this off cancels the download. Files already saved stay usable.">
        <Checkbox
          checked={allowed}
          disabled={removing}
          onChange={consent}
          label="Allow download"
        />
      </Field>
      <ModelStorage model={model} status={status} removing={removing} cached={cached} bytes={bytes} />
      <ModelActions
        model={model}
        allowed={allowed}
        cached={cached}
        bytes={bytes}
        busy={busy}
        removing={removing}
        download={download}
        remove={remove}
      />
      {message && (
        <p
          role={error || status?.phase === 'error' ? 'alert' : 'status'}
          className={`mt-2 text-mini leading-relaxed ${error || status?.phase === 'error' ? 'text-red' : 'text-label-secondary'}`}
        >{message}</p>
      )}
    </FieldGroup>
  )
}

export function AiModelsPane() {
  const support = useAiSupport()
  const error = useAiPreferences((s) => s.error)
  return (
    <>
      <FieldGroup title="Local AI models">
        <p className="text-ui leading-relaxed text-label-secondary">
          AI layers run on this device; photos are never uploaded. Nothing is downloaded
          until you allow it. Models are stored in this browser, plus a shared
          runtime of about {formatBytes(RUNTIME_BYTES)}.
        </p>
        {support?.reason && <p className="mt-2 text-mini leading-relaxed text-label-secondary">{support.reason}</p>}
        {error && <p role="alert" className="mt-2 text-mini leading-relaxed text-red">{error}</p>}
      </FieldGroup>
      {SEGMENT_MODEL_LIST.filter((model) => !model.legacy).map((model) => <ModelSettings key={model.id} model={model} />)}
    </>
  )
}
