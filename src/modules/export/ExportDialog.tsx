import { useEffect, useMemo, useState } from 'react'
import { Dialog } from '../../design/Dialog'
import { Button, Checkbox, IconButton, Select, Switch, TextField } from '../../design/Controls'
import { Field, FieldGroup } from '../../design/Field'
import { Slider } from '../../design/Slider'
import { Spinner } from '../../design/Spinner'
import { toast } from '../../design/toast'
import { Scroller } from '../../design/Scroller'
import {
  CheckIcon,
  CloseIcon,
  FolderIcon,
  FolderPlusIcon,
  PlusIcon,
  TrashIcon,
  WarningIcon,
} from '../../design/icons'
import { cn } from '../../lib/cn'
import { formatBytes } from '../../lib/math'
import { useIsPhone } from '../../lib/useViewport'
import { allPresets, useExport } from '../../state/exportStore'
import { db } from '../../catalog/db'
import { fsSupported } from '../../catalog/fs'
import type { DownloadFile } from '../../export/download'
import { useLiveQuery } from 'dexie-react-hooks'
import { detectFormats } from '../../export/formats'
import {
  estimateBytes,
  expandTemplate,
  targetSize,
  withExtension,
} from '../../export/naming'
import {
  EXTENSIONS,
  FORMAT_LABELS,
  NEGATIVE_FORMATS,
  SUPPORTS_16_BIT,
  SUPPORTS_QUALITY,
  type ExportJob,
  type ExportFormat,
  type ExportPreset,
  type ExportSettings,
  type ResizeMode,
} from '../../export/types'
import type { OutputSpace } from '../../gpu/colorspace'
import type { Photo } from '../../core/types'

/** A stable empty result, so the size estimate isn't recomputed every render. */
const NO_PHOTOS: Photo[] = []

const COLOR_SPACES: Array<{ value: OutputSpace; label: string }> = [
  { value: 'srgb', label: 'sRGB' },
  { value: 'display-p3', label: 'Display P3' },
  { value: 'adobe-rgb', label: 'Adobe RGB (1998)' },
  { value: 'prophoto', label: 'ProPhoto RGB' },
  { value: 'rec2020', label: 'Rec. 2020' },
]

const RESIZE_MODES: Array<{ value: ResizeMode; label: string }> = [
  { value: 'none', label: "Don't resize" },
  { value: 'longEdge', label: 'Long edge' },
  { value: 'shortEdge', label: 'Short edge' },
  { value: 'width', label: 'Width' },
  { value: 'height', label: 'Height' },
  { value: 'fit', label: 'Fit within' },
  { value: 'megapixels', label: 'Megapixels' },
  { value: 'percent', label: 'Percentage' },
]

type UpdateExportSettings = (patch: Partial<ExportSettings>) => void

interface ExportPreview {
  size: { width: number; height: number }
  name: string
  total: number
  each: number
}

function NumberInput({
  value,
  onChange,
  min = 1,
  max = 100000,
  suffix,
  width = 72,
  label,
  disabled,
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  suffix?: string
  width?: number
  label: string
  disabled?: boolean
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <TextField
        value={String(value)}
        onChange={(v) => onChange(Number(v))}
        aria-label={label}
        numeric
        min={min}
        max={max}
        disabled={disabled}
        style={{ width }}
      />
      {suffix && (
        <span className={cn('text-ui', disabled ? 'text-label-tertiary' : 'text-label-secondary')}>
          {suffix}
        </span>
      )}
    </span>
  )
}

/** A slider with its numeric readout, the pairing used all over the dialog. */
function SliderRow({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  format = (v: number) => String(v),
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
  format?: (v: number) => string
}) {
  return (
    <Field label={label}>
      <div className="min-w-0 flex-1">
        <Slider
          value={value}
          onChange={onChange}
          min={min}
          max={max}
          step={step}
          origin={min}
          size="S"
          aria-label={label}
        />
      </div>
      {/* The readout rides inside the field measure, so a slider row closes on
          the same vertical as the selects and text fields above it. */}
      <span className="w-8 shrink-0 text-right text-ui text-label-secondary tabular-nums">
        {format(value)}
      </span>
    </Field>
  )
}

// ---------------------------------------------------------------------------
// Preset rail
// ---------------------------------------------------------------------------

function PresetRail() {
  const phone = useIsPhone()
  const presets = useExport((s) => s.presets)
  const active = useExport((s) => s.activePreset)
  const applyPreset = useExport((s) => s.applyPreset)
  const savePreset = useExport((s) => s.savePreset)
  const updatePreset = useExport((s) => s.updatePreset)
  const deletePreset = useExport((s) => s.deletePreset)

  const [naming, setNaming] = useState(false)
  const [draft, setDraft] = useState('')

  const commit = () => {
    savePreset(draft)
    setDraft('')
    setNaming(false)
  }

  const all = allPresets(presets)
  const builtIn = all.filter((p) => p.builtIn)

  const item = (p: ExportPreset) => (
    <li key={p.id} className="group/preset relative">
      <button
        type="button"
        onClick={() => applyPreset(p.id)}
        aria-pressed={p.id === active}
        title={p.name}
        className={cn(
          'flex h-8 w-full items-center rounded-sm px-2.5 text-left text-ui coarse:h-11',
          'transition-colors duration-[--duration-fast] ease-[--ease-out]',
          !p.builtIn && 'pr-14 coarse:pr-24',
          p.id === active
            ? 'bg-control font-medium text-label'
            : 'text-label-secondary hover:bg-raised hover:text-label',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{p.name}</span>
      </button>
      {!p.builtIn && (
        <span
          className={cn(
            'absolute inset-y-0 right-1 flex items-center gap-0.5',
            'opacity-0 transition-opacity duration-[--duration-fast]',
            'group-hover/preset:opacity-100 focus-within:opacity-100 coarse:opacity-100',
          )}
        >
          <IconButton
            label={`Update ${p.name} with the current settings`}
            size="sm"
            className="coarse:size-11"
            onClick={() => updatePreset(p.id)}
          >
            <CheckIcon className="size-3.5" />
          </IconButton>
          <IconButton label={`Delete ${p.name}`} size="sm" className="coarse:size-11" onClick={() => deletePreset(p.id)}>
            <TrashIcon className="size-3.5" />
          </IconButton>
        </span>
      )}
    </li>
  )

  const saveForm = (
    <form onSubmit={(event) => { event.preventDefault(); commit() }}>
      <TextField
        value={draft}
        onChange={setDraft}
        placeholder="Preset name"
        aria-label="Preset name"
        autoFocus
        className="w-full"
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button size="sm" onClick={() => { setNaming(false); setDraft('') }}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="primary" disabled={!draft.trim()}>
          Save
        </Button>
      </div>
    </form>
  )

  if (phone) {
    return (
      <nav aria-label="Presets" className="hairline-b shrink-0 bg-base px-5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="text-ui text-label-secondary">Preset</span>
          <Select
            value={active ?? ''}
            onChange={(id) => { if (id) applyPreset(id) }}
            options={[
              ...(!active ? [{ value: '', label: 'Custom settings' }] : []),
              ...all.map((preset) => ({ value: preset.id, label: preset.name })),
            ]}
            aria-label="Export preset"
            className="flex-1"
          />
          <IconButton label="Save export preset" onClick={() => setNaming(true)} className="coarse:size-11">
            <PlusIcon size={15} />
          </IconButton>
        </div>
        {naming && <div className="mt-3">{saveForm}</div>}
        {presets.length > 0 && (
          <details className="mt-2">
            <summary className="py-1 text-mini text-label-secondary">Manage saved presets</summary>
            <Scroller frameClassName="max-h-44">
              <ul aria-label="Your presets" className="pt-1">{presets.map(item)}</ul>
            </Scroller>
          </details>
        )}
      </nav>
    )
  }

  return (
    <nav
      aria-label="Presets"
      className="hairline-r flex min-h-0 w-[192px] shrink-0 flex-col bg-base"
    >
      <h3 className="px-4 pt-4 pb-3 text-ui font-medium text-label">Export presets</h3>
      <Scroller frameClassName="min-h-0 flex-1" className="px-2 pb-3">
        <p className="px-2.5 pb-1 text-mini text-label-secondary">Built-in</p>
        <ul aria-label="Built-in presets">{builtIn.map(item)}</ul>
        {presets.length > 0 && (
          <>
            <p className="px-2.5 pt-5 pb-1 text-mini text-label-secondary">User presets</p>
            <ul aria-label="Your presets">{presets.map(item)}</ul>
          </>
        )}
      </Scroller>
      <div className="hairline-t shrink-0 p-3">
        {naming ? saveForm : (
          <Button
            full
            onClick={() => setNaming(true)}
            icon={<PlusIcon size={13} />}
          >
            Save preset…
          </Button>
        )}
      </div>
    </nav>
  )
}

function retryButtonLabel(count: number) {
  return count === 1 ? 'Retry photo' : `Retry ${count} photos`
}

function RunningFooter({
  stage,
  progress,
  cancel,
}: {
  stage: string
  progress: number
  cancel: () => void
}) {
  return (
    <>
      <Spinner size={13} />
      <span className="min-w-0 flex-1 truncate text-mini text-label-secondary">
        {stage}
      </span>
      <span className="font-mono text-mini text-label-secondary tabular-nums">
        {Math.round(progress * 100)}%
      </span>
      <Button onClick={cancel} disabled={stage === 'Cancelling…'}>
        {stage === 'Cancelling…' ? 'Cancelling…' : 'Cancel'}
      </Button>
    </>
  )
}

function DownloadButton({
  readyDownload,
  downloadStarted,
  download,
  prepareDownloads,
}: {
  readyDownload: DownloadFile | null
  downloadStarted: boolean
  download: () => void
  prepareDownloads: () => Promise<void>
}) {
  return (
    <Button
      variant="primary"
      onClick={readyDownload ? download : () => void prepareDownloads()}
    >
      {readyDownload ? (downloadStarted ? 'Download again' : 'Download') : 'Prepare download'}
    </Button>
  )
}

function FinishedFooter({
  editSettings,
  retryCount,
  hasDownload,
  closeDialog,
  retryFailed,
  readyDownload,
  downloadStarted,
  download,
  prepareDownloads,
}: {
  editSettings: () => void
  retryCount: number
  hasDownload: boolean
  closeDialog: () => void
  retryFailed: () => Promise<void>
  readyDownload: DownloadFile | null
  downloadStarted: boolean
  download: () => void
  prepareDownloads: () => Promise<void>
}) {
  return (
    <>
      <span className="min-w-0 flex-1" />
      <Button onClick={editSettings}>Change settings</Button>
      <Button
        variant={retryCount || hasDownload ? 'secondary' : 'primary'}
        onClick={closeDialog}
      >
        {hasDownload ? 'Close' : 'Done'}
      </Button>
      {retryCount > 0 && (
        <Button
          variant={hasDownload ? 'secondary' : 'primary'}
          onClick={() => void retryFailed()}
        >
          {retryButtonLabel(retryCount)}
        </Button>
      )}
      {hasDownload && (
        <DownloadButton
          readyDownload={readyDownload}
          downloadStarted={downloadStarted}
          download={download}
          prepareDownloads={prepareDownloads}
        />
      )}
    </>
  )
}

function ExportEstimate({
  preview,
  isOriginal,
  selectedCount,
}: {
  preview: ExportPreview | null
  isOriginal: boolean
  selectedCount: number
}) {
  if (!preview) return null
  if (isOriginal) return <>Original files copied unchanged</>

  return (
    <>
      {preview.size.width} × {preview.size.height}, about {formatBytes(preview.each)}
      {selectedCount > 1 && <> each ({formatBytes(preview.total)} total)</>}
    </>
  )
}

function SettingsFooter({
  preview,
  isOriginal,
  selectedCount,
  closeDialog,
  delivery,
  destination,
  retryCount,
  retryFailed,
  start,
}: {
  preview: ExportPreview | null
  isOriginal: boolean
  selectedCount: number
  closeDialog: () => void
  delivery: 'folder' | 'download'
  destination: FileSystemDirectoryHandle | null
  retryCount: number
  retryFailed: () => Promise<void>
  start: () => Promise<void>
}) {
  return (
    <>
      <span className="min-w-0 flex-1 text-mini text-label-secondary tabular-nums max-md:basis-full">
        <ExportEstimate
          preview={preview}
          isOriginal={isOriginal}
          selectedCount={selectedCount}
        />
      </span>
      <Button className="min-w-20" onClick={closeDialog}>
        Cancel
      </Button>
      <Button
        variant="primary"
        className="min-w-24"
        disabled={
          (delivery === 'folder' && !destination) || (!selectedCount && !retryCount)
        }
        onClick={() => void (retryCount ? retryFailed() : start())}
      >
        {retryCount
          ? retryButtonLabel(retryCount)
          : `Export ${selectedCount > 1 ? `${selectedCount} photos` : 'photo'}`}
      </Button>
    </>
  )
}

interface ExportDialogFooterProps {
  running: boolean
  stage: string
  progress: number
  cancel: () => void
  finished: boolean
  editSettings: () => void
  retryCount: number
  hasDownload: boolean
  closeDialog: () => void
  retryFailed: () => Promise<void>
  readyDownload: DownloadFile | null
  downloadStarted: boolean
  download: () => void
  prepareDownloads: () => Promise<void>
  preview: ExportPreview | null
  isOriginal: boolean
  selectedCount: number
  delivery: 'folder' | 'download'
  destination: FileSystemDirectoryHandle | null
  start: () => Promise<void>
}

function ExportDialogFooter(props: ExportDialogFooterProps) {
  if (props.running) {
    return (
      <RunningFooter stage={props.stage} progress={props.progress} cancel={props.cancel} />
    )
  }

  if (props.finished) {
    return (
      <FinishedFooter
        editSettings={props.editSettings}
        retryCount={props.retryCount}
        hasDownload={props.hasDownload}
        closeDialog={props.closeDialog}
        retryFailed={props.retryFailed}
        readyDownload={props.readyDownload}
        downloadStarted={props.downloadStarted}
        download={props.download}
        prepareDownloads={props.prepareDownloads}
      />
    )
  }

  return (
    <SettingsFooter
      preview={props.preview}
      isOriginal={props.isOriginal}
      selectedCount={props.selectedCount}
      closeDialog={props.closeDialog}
      delivery={props.delivery}
      destination={props.destination}
      retryCount={props.retryCount}
      retryFailed={props.retryFailed}
      start={props.start}
    />
  )
}

function RetryNotice({
  retryCount,
  clearJobs,
}: {
  retryCount: number
  clearJobs: () => void
}) {
  if (!retryCount) return null

  return (
    <div className="flex items-center gap-3 pt-3 pb-1">
      <p className="flex-1 text-mini text-label-secondary">
        Only{' '}
        {retryCount === 1
          ? 'the unfinished photo will'
          : `${retryCount} unfinished photos will`}{' '}
        retry. Completed photos are kept.
      </p>
      <Button onClick={clearJobs}>Start over</Button>
    </div>
  )
}

function ExportLocationSection({
  settings,
  update,
  delivery,
  setDelivery,
  destination,
  destinationName,
  chooseFolder,
}: {
  settings: ExportSettings
  update: UpdateExportSettings
  delivery: 'folder' | 'download'
  setDelivery: (delivery: 'folder' | 'download') => void
  destination: FileSystemDirectoryHandle | null
  destinationName: string
  chooseFolder: () => Promise<void>
}) {
  return (
    <FieldGroup title="Export location">
      <Field label="Save to">
        {fsSupported() ? (
          <Select
            value={delivery}
            onChange={setDelivery}
            options={[
              { value: 'folder', label: 'Folder' },
              { value: 'download', label: 'Browser download' },
            ]}
            aria-label="Save to"
            className="flex-1"
          />
        ) : (
          <span className="text-ui text-label">Browser download</span>
        )}
      </Field>
      {delivery === 'download' ? (
        <Field hint="Prepare your photos, then choose Download. Multiple files and XMP sidecars are bundled in one ZIP (under 4 GB). Your browser chooses where to save it.">
          <span className="text-mini text-label-secondary">
            No folder permission required.
          </span>
        </Field>
      ) : (
        <>
          <Field label="Folder">
            <button
              type="button"
              onClick={() => void chooseFolder()}
              aria-label={
                destinationName
                  ? `Export folder: ${destinationName}`
                  : 'Choose export folder'
              }
              className="esq-field flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              {destination ? (
                <FolderIcon className="size-3.5 shrink-0 text-icon-tertiary" />
              ) : (
                <FolderPlusIcon className="size-3.5 shrink-0 text-icon-tertiary" />
              )}
              <span className={cn('truncate', !destination && 'text-label-tertiary')}>
                {destinationName || 'Choose a folder…'}
              </span>
            </button>
          </Field>
          <Field label="Subfolder">
            <TextField
              value={settings.subfolder}
              onChange={(subfolder) => update({ subfolder })}
              placeholder="None"
              aria-label="Subfolder"
              className="flex-1"
            />
          </Field>
          <Field label="Existing files">
            <Select
              value={settings.overwrite}
              onChange={(overwrite) => update({ overwrite })}
              options={[
                { value: 'rename', label: 'Add a suffix' },
                { value: 'skip', label: 'Skip' },
                { value: 'overwrite', label: 'Overwrite' },
              ]}
              aria-label="Existing files"
              className="flex-1"
            />
          </Field>
        </>
      )}
    </FieldGroup>
  )
}

function FileNamingSection({
  settings,
  update,
  preview,
}: {
  settings: ExportSettings
  update: UpdateExportSettings
  preview: ExportPreview | null
}) {
  return (
    <FieldGroup title="File naming">
      <Field
        label="Template"
        hint={
          <>
            <span className="block font-mono">
              {'{name} {seq:3} {date:YYYY-MM-DD}'}
            </span>
            <span className="block font-mono">{'{camera} {lens} {iso} {custom}'}</span>
            {preview && (
              <span className="mt-1.5 block">
                Example: <span className="break-all text-label">{preview.name}</span>
              </span>
            )}
          </>
        }
      >
        <TextField
          value={settings.filenameTemplate}
          onChange={(filenameTemplate) => update({ filenameTemplate })}
          aria-label="Filename template"
          mono
          className="flex-1"
        />
      </Field>
      {/* Both of these appear only once the template asks for them —
          the same rule the custom-text row already followed, and what
          kept a stray, unlabelled number box parked out on the right. */}
      {settings.filenameTemplate.includes('{seq') && (
        <Field label="Start at">
          <NumberInput
            label="Start number"
            value={settings.startNumber}
            onChange={(startNumber) => update({ startNumber })}
            min={0}
            max={99999}
          />
        </Field>
      )}
      {settings.filenameTemplate.includes('{custom}') && (
        <Field label="Custom text">
          <TextField
            value={settings.customText}
            onChange={(customText) => update({ customText })}
            placeholder="Substituted for {custom}"
            aria-label="Custom text"
            className="flex-1"
          />
        </Field>
      )}
      <Field label="Extension">
        <Select
          value={settings.extensionCase}
          onChange={(extensionCase) => update({ extensionCase })}
          options={[
            { value: 'lower', label: 'Lowercase' },
            { value: 'upper', label: 'Uppercase' },
          ]}
          aria-label="Extension case"
          className="flex-1"
        />
      </Field>
    </FieldGroup>
  )
}

function FileSettingsSection({
  settings,
  update,
  formatOptions,
  isDng,
  rendered,
}: {
  settings: ExportSettings
  update: UpdateExportSettings
  formatOptions: Array<{ value: ExportFormat; label: string }>
  isDng: boolean
  rendered: boolean
}) {
  return (
    <FieldGroup title="File settings">
      <Field
        label="Format"
        hint={isDng ? '16-bit linear negative with edits stored as XMP.' : undefined}
      >
        <Select
          value={settings.format}
          onChange={(format) => {
            const patch: Partial<ExportSettings> = { format }
            if (!SUPPORTS_16_BIT.has(format)) patch.bitDepth = 8
            if (format === 'webp') patch.colorSpace = 'srgb'
            update(patch)
          }}
          options={formatOptions}
          aria-label="File format"
          className="flex-1"
        />
      </Field>

      {SUPPORTS_QUALITY.has(settings.format) && (
        <>
          <SliderRow
            label="Quality"
            value={settings.quality}
            onChange={(quality) => update({ quality })}
            min={1}
            max={100}
          />
          <Field
            label="Limit size"
            hint={
              settings.limitSize
                ? 'Reduces quality to meet the limit (minimum 20).'
                : undefined
            }
          >
            <Checkbox
              checked={settings.limitSize}
              onChange={(limitSize) => update({ limitSize })}
              label="Not larger than"
            />
            <NumberInput
              label="Size limit"
              value={settings.limitSizeKb}
              onChange={(limitSizeKb) => update({ limitSizeKb })}
              min={10}
              max={100000}
              suffix="KB"
              disabled={!settings.limitSize}
            />
          </Field>
        </>
      )}

      {settings.format === 'jpeg' && (
        <>
          <Field
            label="Encoding"
            hint="Smaller files that load progressively over a slow connection."
          >
            <Switch
              checked={settings.jpegProgressive}
              onChange={(jpegProgressive) => update({ jpegProgressive })}
              label="Progressive"
              showLabel
            />
          </Field>
          <Field label="Chroma" hint="Auto picks 4:4:4 above quality 90, 4:2:0 below.">
            <Select
              value={settings.jpegSubsampling}
              onChange={(jpegSubsampling) => update({ jpegSubsampling })}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: '4:4:4', label: '4:4:4 · full colour' },
                { value: '4:2:0', label: '4:2:0 · smaller' },
              ]}
              aria-label="Chroma subsampling"
              className="flex-1"
            />
          </Field>
        </>
      )}

      {rendered && (
        <Field
          label="Colour space"
          hint={
            settings.format === 'webp'
              ? 'WebP embeds no profile, so it is written as sRGB. Use JPEG, PNG or TIFF for wide gamut.'
              : undefined
          }
        >
          <Select
            value={settings.colorSpace}
            onChange={(colorSpace) => update({ colorSpace })}
            options={COLOR_SPACES}
            aria-label="Colour space"
            disabled={settings.format === 'webp'}
            className="flex-1"
          />
        </Field>
      )}

      {SUPPORTS_16_BIT.has(settings.format) && (
        <Field
          label="Bit depth"
          hint="Use 16-bit files for further editing without banding."
        >
          <Select
            value={String(settings.bitDepth) as '8' | '16'}
            onChange={(value) => update({ bitDepth: value === '16' ? 16 : 8 })}
            options={[
              { value: '8', label: '8 bits / channel' },
              { value: '16', label: '16 bits / channel' },
            ]}
            aria-label="Bit depth"
            className="flex-1"
          />
        </Field>
      )}

      {settings.format === 'tiff' && (
        <Field label="Compression">
          <Switch
            checked={settings.compress}
            onChange={(compress) => update({ compress })}
            label="Deflate"
            showLabel
          />
        </Field>
      )}
    </FieldGroup>
  )
}

function ResizeDimensions({
  settings,
  update,
}: {
  settings: ExportSettings
  update: UpdateExportSettings
}) {
  switch (settings.resizeMode) {
    case 'longEdge':
      return (
        <NumberInput
          label="Long edge"
          value={settings.resizeLongEdge}
          onChange={(resizeLongEdge) => update({ resizeLongEdge })}
          suffix="px"
        />
      )
    case 'shortEdge':
      return (
        <NumberInput
          label="Short edge"
          value={settings.resizeShortEdge}
          onChange={(resizeShortEdge) => update({ resizeShortEdge })}
          suffix="px"
        />
      )
    case 'width':
      return (
        <NumberInput
          label="Width"
          value={settings.resizeWidth}
          onChange={(resizeWidth) => update({ resizeWidth })}
          suffix="w"
        />
      )
    case 'height':
      return (
        <NumberInput
          label="Height"
          value={settings.resizeHeight}
          onChange={(resizeHeight) => update({ resizeHeight })}
          suffix="h"
        />
      )
    case 'fit':
      return (
        <>
          <NumberInput
            label="Width"
            value={settings.resizeWidth}
            onChange={(resizeWidth) => update({ resizeWidth })}
            suffix="w"
          />
          <NumberInput
            label="Height"
            value={settings.resizeHeight}
            onChange={(resizeHeight) => update({ resizeHeight })}
            suffix="h"
          />
        </>
      )
    case 'megapixels':
      return (
        <NumberInput
          label="Megapixels"
          value={settings.megapixels}
          onChange={(megapixels) => update({ megapixels })}
          min={1}
          max={200}
          suffix="MP"
          width={56}
        />
      )
    case 'percent':
      return (
        <NumberInput
          label="Percentage"
          value={settings.resizePercent}
          onChange={(resizePercent) => update({ resizePercent })}
          min={1}
          max={400}
          suffix="%"
          width={56}
        />
      )
    default:
      return null
  }
}

function ImageSizingSection({
  settings,
  update,
  rendered,
}: {
  settings: ExportSettings
  update: UpdateExportSettings
  rendered: boolean
}) {
  if (!rendered) return null

  const resizing = settings.resizeMode !== 'none'

  return (
    <FieldGroup title="Image sizing">
      <Field label="Resize">
        <Select
          value={settings.resizeMode}
          onChange={(resizeMode) => update({ resizeMode })}
          options={RESIZE_MODES}
          aria-label="Resize"
          className="flex-1"
        />
      </Field>
      {resizing && (
        <Field label={settings.resizeMode === 'fit' ? 'Dimensions' : 'Size'}>
          <ResizeDimensions settings={settings} update={update} />
        </Field>
      )}
      {resizing && (
        <Field>
          <Checkbox
            checked={settings.dontEnlarge}
            onChange={(dontEnlarge) => update({ dontEnlarge })}
            label="Don't enlarge"
          />
        </Field>
      )}
      <Field label="Resolution">
        <NumberInput
          label="Resolution"
          value={settings.resolution}
          onChange={(resolution) => update({ resolution })}
          min={1}
          max={2400}
        />
        <Select
          value={settings.resolutionUnit}
          onChange={(resolutionUnit) => update({ resolutionUnit })}
          options={[
            { value: 'inch', label: 'pixels / inch' },
            { value: 'cm', label: 'pixels / cm' },
          ]}
          aria-label="Resolution unit"
          className="min-w-0 flex-1"
        />
      </Field>
    </FieldGroup>
  )
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function ExportDialog() {
  const open = useExport((s) => s.open)
  const closeDialog = useExport((s) => s.closeDialog)
  const settings = useExport((s) => s.settings)
  const update = useExport((s) => s.update)
  const photoIds = useExport((s) => s.photoIds)
  const destination = useExport((s) => s.destination)
  const destinationName = useExport((s) => s.destinationName)
  const setDestination = useExport((s) => s.setDestination)
  const delivery = useExport((s) => s.delivery)
  const setDelivery = useExport((s) => s.setDelivery)
  const readyDownload = useExport((s) => s.readyDownload)
  const pendingDownloads = useExport((s) => s.pendingDownloads)
  const downloadStarted = useExport((s) => s.downloadStarted)
  const download = useExport((s) => s.download)
  const prepareDownloads = useExport((s) => s.prepareDownloads)
  const clearJobs = useExport((s) => s.clearJobs)
  const start = useExport((s) => s.start)
  const retryFailed = useExport((s) => s.retryFailed)
  const editSettings = useExport((s) => s.editSettings)
  const cancel = useExport((s) => s.cancel)
  const running = useExport((s) => s.running)
  const progress = useExport((s) => s.progress)
  const stage = useExport((s) => s.stage)
  const jobs = useExport((s) => s.jobs)
  const editing = useExport((s) => s.editing)
  const batchError = useExport((s) => s.batchError)

  const [formats, setFormats] = useState<Set<string> | null>(null)

  useEffect(() => {
    if (open) void detectFormats().then(setFormats)
  }, [open])

  const selected =
    useLiveQuery(
      async () => (await db.photos.bulkGet(photoIds)).filter((p) => !!p),
      [photoIds],
    ) ?? NO_PHOTOS

  const sample = selected[0]
  const preview = useMemo(() => {
    if (!sample) return null
    const size = targetSize(sample.width, sample.height, settings)
    const name = withExtension(
      expandTemplate(settings.filenameTemplate, sample, settings.startNumber, settings.customText),
      settings.format === 'original' ? sample.ext : EXTENSIONS[settings.format],
      settings.extensionCase,
    )
    // Summing every photo beats multiplying the first one: a mixed selection of
    // landscape and portrait crops can differ by a factor of two.
    const total = selected.reduce((sum, p) => {
      const s = targetSize(p.width, p.height, settings)
      return sum + estimateBytes(s.width, s.height, settings)
    }, 0)
    return { size, name, total, each: estimateBytes(size.width, size.height, settings) }
  }, [sample, selected, settings])

  const formatOptions = useMemo(() => {
    const all: ExportFormat[] = ['jpeg', 'png', 'webp', 'tiff', 'dng', 'original']
    return all
      .filter((f) => !!formats?.has(f) || f === 'original' || !formats)
      .map((f) => ({ value: f, label: FORMAT_LABELS[f] }))
  }, [formats])

  const isOriginal = settings.format === 'original'
  const isDng = settings.format === 'dng'
  const rendered = !NEGATIVE_FORMATS.has(settings.format)
  const done = jobs.filter((j) => j.state === 'done').length
  const prepared = jobs.filter((j) => j.state === 'prepared').length
  const hasDownload = pendingDownloads.length > 0
  const failures = jobs.filter((j) => j.state === 'failed')
  const retryCount = jobs.filter((j) => j.state === 'failed' || j.state === 'cancelled').length ||
    (batchError && !jobs.length ? photoIds.length : 0)
  const finished = !running && !editing && (jobs.length > 0 || !!batchError)

  const chooseFolder = async () => {
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'esque-export' })
      setDestination(dir)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      toast.error('Could not choose a destination', err instanceof Error ? err.message : String(err))
    }
  }

  const busy = running || finished

  return (
    <Dialog
      open={open}
      onClose={running ? () => {} : closeDialog}
      dismissable={!running}
      title="Export"
      description={
        selected.length === 1 ? selected[0].filename : `${selected.length} photos selected`
      }
      width={840}
      height={680}
      scrollable={false}
      dividers
      bodyClassName="items-stretch max-md:flex-col [--field-measure:100%] [--field-label-width:104px] md:[--field-label-width:128px]"
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-3">
          <ExportDialogFooter
            running={running}
            stage={stage}
            progress={progress}
            cancel={cancel}
            finished={finished}
            editSettings={editSettings}
            retryCount={retryCount}
            hasDownload={hasDownload}
            closeDialog={closeDialog}
            retryFailed={retryFailed}
            readyDownload={readyDownload}
            downloadStarted={downloadStarted}
            download={download}
            prepareDownloads={prepareDownloads}
            preview={preview}
            isOriginal={isOriginal}
            selectedCount={selected.length}
            delivery={delivery}
            destination={destination}
            start={start}
          />
        </div>
      }
    >
      {busy ? (
        <JobList
          jobs={jobs}
          progress={progress}
          done={done}
          prepared={prepared}
          readyDownload={readyDownload}
          downloadStarted={downloadStarted}
          failures={failures.length}
          error={batchError}
        />
      ) : (
        <>
          <PresetRail />
          <Scroller frameClassName="min-h-0 min-w-0 flex-1" className="px-5 py-4">
            <RetryNotice retryCount={retryCount} clearJobs={clearJobs} />
            <ExportLocationSection
              settings={settings}
              update={update}
              delivery={delivery}
              setDelivery={setDelivery}
              destination={destination}
              destinationName={destinationName}
              chooseFolder={chooseFolder}
            />

            <FileNamingSection settings={settings} update={update} preview={preview} />

            <FileSettingsSection
              settings={settings}
              update={update}
              formatOptions={formatOptions}
              isDng={isDng}
              rendered={rendered}
            />

            <ImageSizingSection settings={settings} update={update} rendered={rendered} />

            {rendered && (
              <FieldGroup title="Output sharpening">
                <Field label="Sharpen for">
                  <Select
                    value={settings.sharpenTarget}
                    onChange={(sharpenTarget) => update({ sharpenTarget })}
                    options={[
                      { value: 'none', label: 'None' },
                      { value: 'screen', label: 'Screen' },
                      { value: 'matte', label: 'Matte paper' },
                      { value: 'glossy', label: 'Glossy paper' },
                    ]}
                    aria-label="Sharpen for"
                    className="flex-1"
                  />
                </Field>
                {settings.sharpenTarget !== 'none' && (
                  <Field label="Amount">
                    <Select
                      value={settings.sharpenAmount}
                      onChange={(sharpenAmount) => update({ sharpenAmount })}
                      options={[
                        { value: 'low', label: 'Low' },
                        { value: 'standard', label: 'Standard' },
                        { value: 'high', label: 'High' },
                      ]}
                      aria-label="Sharpening amount"
                      className="min-w-0 flex-1"
                    />
                  </Field>
                )}
              </FieldGroup>
            )}

            <FieldGroup title="Metadata">
              <Field label="Include">
                <Select
                  value={settings.metadata}
                  onChange={(metadata) => update({ metadata })}
                  options={[
                    { value: 'all', label: 'All metadata' },
                    { value: 'noCamera', label: 'Except camera info' },
                    { value: 'copyrightContact', label: 'Copyright and contact' },
                    { value: 'copyrightOnly', label: 'Copyright only' },
                    { value: 'none', label: 'None' },
                  ]}
                  aria-label="Include metadata"
                  className="flex-1"
                />
              </Field>
              {settings.metadata !== 'none' && (
                <>
                  <Field>
                    <Checkbox
                      checked={settings.removeLocation}
                      onChange={(removeLocation) => update({ removeLocation })}
                      label="Remove location info"
                    />
                  </Field>
                  <Field hint="Drops keywords filed under People, Person or Faces.">
                    <Checkbox
                      checked={settings.removePersonInfo}
                      onChange={(removePersonInfo) => update({ removePersonInfo })}
                      label="Remove person info"
                    />
                  </Field>
                  <Field>
                    <Checkbox
                      checked={settings.writeKeywords}
                      onChange={(writeKeywords) => update({ writeKeywords })}
                      label="Write keywords"
                    />
                  </Field>
                </>
              )}
              <Field
                hint={
                  isDng
                    ? 'DNG files already include these settings.'
                    : 'Save Develop settings for use in another RAW editor.'
                }
              >
                <Checkbox
                  checked={settings.writeSidecar}
                  onChange={(writeSidecar) => update({ writeSidecar })}
                  label="Also write an .xmp sidecar"
                />
              </Field>
            </FieldGroup>

            {rendered && (
              <FieldGroup
                title="Watermark"
                aside={
                  <Switch
                    checked={settings.watermark.enabled}
                    onChange={(enabled) =>
                      update({ watermark: { ...settings.watermark, enabled } })
                    }
                    label="Enable watermark"
                  />
                }
              >
                <Field label="Text">
                  <TextField
                    value={settings.watermark.text}
                    onChange={(text) => update({ watermark: { ...settings.watermark, text } })}
                    disabled={!settings.watermark.enabled}
                    placeholder="© Your name"
                    aria-label="Watermark text"
                    className="min-w-0 flex-1"
                  />
                </Field>
                {settings.watermark.enabled && (
                  <>
                    <Field label="Typeface">
                      <Select
                        value={settings.watermark.font}
                        onChange={(font) => update({ watermark: { ...settings.watermark, font } })}
                        options={[
                          { value: 'sans', label: 'Sans serif' },
                          { value: 'serif', label: 'Serif' },
                          { value: 'mono', label: 'Monospace' },
                        ]}
                        aria-label="Watermark typeface"
                        className="flex-1"
                      />
                    </Field>
                    <Field>
                      <Checkbox
                        checked={settings.watermark.shadow}
                        onChange={(shadow) =>
                          update({ watermark: { ...settings.watermark, shadow } })
                        }
                        label="Text shadow"
                      />
                    </Field>
                    <Field label="Position">
                      <Select
                        value={settings.watermark.position}
                        onChange={(position) =>
                          update({ watermark: { ...settings.watermark, position } })
                        }
                        options={[
                          { value: 'bottom-right', label: 'Bottom right' },
                          { value: 'bottom-center', label: 'Bottom centre' },
                          { value: 'bottom-left', label: 'Bottom left' },
                          { value: 'top-right', label: 'Top right' },
                          { value: 'top-center', label: 'Top centre' },
                          { value: 'top-left', label: 'Top left' },
                        ]}
                        aria-label="Watermark position"
                        className="flex-1"
                      />
                    </Field>
                    <Field label="Colour">
                      <Select
                        value={settings.watermark.color}
                        onChange={(color) => update({ watermark: { ...settings.watermark, color } })}
                        options={[
                          { value: 'white', label: 'White' },
                          { value: 'black', label: 'Black' },
                        ]}
                        aria-label="Watermark colour"
                        className="min-w-0 flex-1"
                      />
                    </Field>
                    <SliderRow
                      label="Size"
                      value={settings.watermark.size}
                      onChange={(size) => update({ watermark: { ...settings.watermark, size } })}
                      min={1}
                      max={12}
                      step={0.1}
                      format={(v) => v.toFixed(1)}
                    />
                    <SliderRow
                      label="Inset"
                      value={settings.watermark.inset}
                      onChange={(inset) => update({ watermark: { ...settings.watermark, inset } })}
                      min={0}
                      max={10}
                      step={0.1}
                      format={(v) => v.toFixed(1)}
                    />
                    <SliderRow
                      label="Opacity"
                      value={settings.watermark.opacity}
                      onChange={(opacity) =>
                        update({ watermark: { ...settings.watermark, opacity } })
                      }
                      min={5}
                      max={100}
                    />
                  </>
                )}
              </FieldGroup>
            )}
          </Scroller>
        </>
      )}
    </Dialog>
  )
}

function jobTitle(job: ExportJob) {
  return (
    job.error ??
    (job.overLimit
      ? `Could not reach ${job.overLimit.requestedKb} kB; encoded at quality ${job.overLimit.quality}`
      : undefined)
  )
}

function JobStatusIcon({ job }: { job: ExportJob }) {
  const complete = job.state === 'done' || job.state === 'prepared'

  if (complete) {
    if (job.overLimit || job.error) {
      return <WarningIcon className="size-3.5 text-orange" />
    }
    return <CheckIcon className="size-3.5 text-green" />
  }

  switch (job.state) {
    case 'failed':
      return <WarningIcon className="size-3.5 text-red" />
    case 'skipped':
    case 'cancelled':
      return <CloseIcon className="size-3 text-icon-tertiary" />
    case 'running':
      return <Spinner size={11} />
    case 'queued':
      return <span className="size-1.5 rounded-full bg-icon-quaternary" />
    default:
      return null
  }
}

function JobResult({ job }: { job: ExportJob }) {
  if (job.state === 'failed' || job.error) {
    return (
      <span
        className={cn(
          'max-w-[45%] shrink-0 truncate text-mini',
          job.state === 'failed' ? 'text-red' : 'text-orange',
        )}
      >
        {job.error ?? 'Failed'}
      </span>
    )
  }

  if (job.state === 'skipped' || job.state === 'cancelled') {
    return (
      <span className="shrink-0 text-mini text-label-secondary">
        {job.state === 'skipped' ? 'Skipped' : 'Cancelled'}
      </span>
    )
  }

  return (
    <span
      className={cn(
        'shrink-0 font-mono text-micro tabular-nums',
        job.overLimit ? 'text-orange' : 'text-label-secondary',
      )}
    >
      {job.bytes ? formatBytes(job.bytes) : ''}
    </span>
  )
}

function JobRow({ job }: { job: ExportJob }) {
  return (
    <li
      className="flex h-7 items-center gap-2.5 rounded-md px-1.5 text-mini"
      title={jobTitle(job)}
    >
      <span className="grid size-3.5 shrink-0 place-items-center">
        <JobStatusIcon job={job} />
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          job.state === 'done' ? 'text-label-secondary' : 'text-label',
          (job.state === 'skipped' || job.state === 'cancelled') &&
            'text-label-secondary',
        )}
      >
        {job.outputName ?? job.filename}
      </span>
      {/*
       * A failure used to read "Failed" with the reason buried in a
       * `title`, so the one row that needs explaining was the only one
       * that withheld it. The reason takes the trailing cell; the
       * tooltip stays for anything too long to sit in it.
       */}
      <JobResult job={job} />
    </li>
  )
}

function JobList({
  jobs,
  progress,
  done,
  prepared,
  readyDownload,
  downloadStarted,
  failures,
  error,
}: {
  jobs: ExportJob[]
  progress: number
  done: number
  prepared: number
  readyDownload: DownloadFile | null
  downloadStarted: boolean
  failures: number
  error: string | null
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col px-5 pt-4 pb-2">
      {error && (
        <div className="mb-4 shrink-0" role="alert">
          <p className="text-ui text-red [overflow-wrap:anywhere]">{error}</p>
          <p className="mt-1 text-mini text-label-secondary">
            Your selection and settings are kept. Resolve the error, then retry.
            {' '}Use Change settings to choose another destination.
          </p>
        </div>
      )}
      {readyDownload && (
        <div className="mb-4 shrink-0" role="status">
          <p className="text-ui text-label">
            {downloadStarted
              ? 'Download started. Check your browser downloads.'
              : 'Your files are ready. Choose Download to save them.'}
          </p>
          <p className="mt-1 truncate text-mini text-label-secondary" title={readyDownload.name}>
            {readyDownload.name} · {formatBytes(readyDownload.blob.size)}
          </p>
        </div>
      )}
      <div className="mb-2.5 h-1 shrink-0 overflow-hidden rounded-full bg-control">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-[--duration-fast] ease-[--ease-out]"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
      <p className="mb-2.5 shrink-0 text-mini text-label-secondary tabular-nums">
        {prepared
          ? `${prepared} of ${jobs.length} prepared${done ? ` · ${done} written` : ''}`
          : jobs.length ? `${done} of ${jobs.length} written` : 'No photos prepared'}
        {failures > 0 && <span className="text-red"> · {failures} failed</span>}
      </p>
      <Scroller frameClassName="min-h-0 flex-1">
        <ul>
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </ul>
      </Scroller>
    </div>
  )
}
