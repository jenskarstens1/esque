import { useEffect, useMemo, useState } from 'react'
import { Dialog } from '../../design/Dialog'
import { Button, Checkbox, IconButton, Select, Switch, TextField } from '../../design/Controls'
import { Field, FieldGroup } from '../../design/Field'
import { Slider } from '../../design/Slider'
import { Spinner } from '../../design/Spinner'
import { Scroller } from '../../design/Scroller'
import {
  CheckIcon,
  CloseIcon,
  FolderIcon,
  FolderPlusIcon,
  PlusIcon,
  PresetIcon,
  TrashIcon,
  WarningIcon,
} from '../../design/icons'
import { cn } from '../../lib/cn'
import { formatBytes } from '../../lib/math'
import { allPresets, useExport } from '../../state/exportStore'
import { db } from '../../catalog/db'
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
  type ExportFormat,
  type ExportPreset,
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
      <span className="w-8 shrink-0 text-right font-mono text-ui text-label-secondary tabular-nums">
        {format(value)}
      </span>
    </Field>
  )
}

// ---------------------------------------------------------------------------
// Preset rail
// ---------------------------------------------------------------------------

function PresetRail() {
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
        className={cn(
          'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-ui',
          'transition-colors duration-[--duration-fast] ease-[--ease-out]',
          // Only a saved preset carries hover actions, so only it gives up the
          // room for them — a built-in name keeps the full width to run in.
          !p.builtIn && 'pr-14',
          p.id === active
            ? 'bg-accent-soft text-accent'
            : 'text-label-secondary hover:bg-raised hover:text-label',
        )}
      >
        {/* The icon ramp, not the label alphas: a 1.75px stroke at 18% reads as
            a glyph that failed to finish drawing rather than a quiet one. */}
        <PresetIcon
          className={cn('size-3.5 shrink-0', p.id === active ? 'text-accent' : 'text-icon-tertiary')}
        />
        <span className="min-w-0 flex-1 truncate">{p.name}</span>
      </button>
      {!p.builtIn && (
        <span
          className={cn(
            'absolute inset-y-0 right-1 flex items-center gap-0.5',
            'opacity-0 transition-opacity duration-[--duration-fast]',
            'group-hover/preset:opacity-100 focus-within:opacity-100',
          )}
        >
          <IconButton
            label={`Update ${p.name} with the current settings`}
            size="sm"
            onClick={() => updatePreset(p.id)}
          >
            <CheckIcon className="size-3.5" />
          </IconButton>
          <IconButton label={`Delete ${p.name}`} size="sm" onClick={() => deletePreset(p.id)}>
            <TrashIcon className="size-3.5" />
          </IconButton>
        </span>
      )}
    </li>
  )

  return (
    <div className="flex w-[208px] shrink-0 flex-col hairline-r">
      <div className="flex h-8 shrink-0 items-center px-5">
        <span className="esq-section-title min-w-0 flex-1">Presets</span>
      </div>
      <Scroller frameClassName="min-h-0 flex-1" className="px-2 pb-2 pl-3">
        <ul>{builtIn.map(item)}</ul>
        {presets.length > 0 && (
          <>
            <p className="esq-section-title mt-4 mb-1.5 px-2">Yours</p>
            <ul>{presets.map(item)}</ul>
          </>
        )}
      </Scroller>
      {/*
       * The save affordance closes the column instead of hiding as a bare `+`
       * in the header. Six presets in a 600px rail left the bottom two thirds
       * empty and the one action in it unnamed; anchored here it reads as the
       * end of the list and says what it does.
       */}
      <div className="shrink-0 px-3 pt-2 pb-3">
        {naming ? (
          <div>
            <TextField
              value={draft}
              onChange={setDraft}
              placeholder="Preset name"
              aria-label="Preset name"
              size="sm"
              className="w-full"
            />
            <div className="mt-1.5 flex justify-end gap-1.5">
              <Button size="sm" onClick={() => setNaming(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" disabled={!draft.trim()} onClick={commit}>
                Save
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setNaming(true)}
            className={cn(
              'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-ui',
              'text-label-secondary transition-colors duration-[--duration-fast] ease-[--ease-out]',
              'hover:bg-raised hover:text-label',
            )}
          >
            <PlusIcon className="size-3.5 shrink-0 text-icon-tertiary" />
            <span className="min-w-0 flex-1 truncate">Save these settings…</span>
          </button>
        )}
      </div>
    </div>
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
  const start = useExport((s) => s.start)
  const cancel = useExport((s) => s.cancel)
  const running = useExport((s) => s.running)
  const progress = useExport((s) => s.progress)
  const stage = useExport((s) => s.stage)
  const jobs = useExport((s) => s.jobs)
  const clearJobs = useExport((s) => s.clearJobs)

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
  const failures = jobs.filter((j) => j.state === 'failed')
  const finished = !running && jobs.length > 0

  const chooseFolder = async () => {
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'esque-export' })
      setDestination(dir)
    } catch {
      /* the user dismissed the picker */
    }
  }

  const busy = running || jobs.length > 0

  return (
    <Dialog
      open={open}
      onClose={running ? () => {} : closeDialog}
      dismissable={!running}
      title="Export"
      description={
        selected.length === 1 ? selected[0].filename : `${selected.length} photos selected`
      }
      width={740}
      height={620}
      scrollable={false}
      bodyClassName="items-stretch [--field-measure:360px]"
      footer={
        <div className="flex w-full items-center gap-3">
          {running ? (
            <>
              <Spinner size={13} />
              <span className="min-w-0 flex-1 truncate text-mini text-label-secondary">
                {stage}
              </span>
              <span className="font-mono text-mini text-label-secondary tabular-nums">
                {Math.round(progress * 100)}%
              </span>
              <Button onClick={cancel}>Cancel</Button>
            </>
          ) : finished ? (
            <>
              <span className="min-w-0 flex-1" />
              <Button onClick={clearJobs}>Back</Button>
              <Button variant="primary" onClick={closeDialog}>
                Done
              </Button>
            </>
          ) : (
            <>
              {/* What you are about to write. It was set two steps down the
                  label ramp, which put the one number worth checking before
                  committing below the threshold for reading it at all. */}
              <span className="min-w-0 flex-1 truncate text-mini text-label-secondary tabular-nums">
                {preview && !isOriginal && (
                  <>
                    {preview.size.width} × {preview.size.height} · about{' '}
                    {formatBytes(preview.each)} each
                    {selected.length > 1 && <> · {formatBytes(preview.total)} total</>}
                  </>
                )}
                {preview && isOriginal && 'Original files copied unchanged'}
              </span>
              <Button onClick={closeDialog}>Cancel</Button>
              <Button
                variant="primary"
                disabled={!destination || !selected.length}
                onClick={() => void start()}
              >
                Export {selected.length > 1 ? `${selected.length} photos` : 'photo'}
              </Button>
            </>
          )}
        </div>
      }
    >
      {busy ? (
        <JobList jobs={jobs} progress={progress} done={done} failures={failures.length} />
      ) : (
        <>
          <PresetRail />
          <Scroller frameClassName="min-h-0 flex-1" className="px-5 pt-1 pb-4">
            <FieldGroup title="Destination">
              <Field label="Folder">
                <button
                  type="button"
                  onClick={() => void chooseFolder()}
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
                  className="flex-1"
                />
              </Field>
            </FieldGroup>

            <FieldGroup title="File naming">
              <Field
                label="Template"
                hint={
                  <>
                    {/* Broken deliberately rather than left to wrap: seven
                        tokens reflow into a six-and-one orphan at this measure. */}
                    <span className="block font-mono text-label-secondary">
                      {'{name} {seq:3} {date:YYYY-MM-DD}'}
                    </span>
                    <span className="block font-mono text-label-secondary">
                      {'{camera} {lens} {iso} {custom}'}
                    </span>
                    {preview && (
                      <span className="mt-1.5 block">
                        Each file lands as <span className="text-label">{preview.name}</span>
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
                  className="flex-1"
                />
              </Field>
            </FieldGroup>

            <FieldGroup title="File settings">
              <Field
                label="Format"
                hint={isDng ? '16-bit negative; edits ride along as XMP, not baked in.' : undefined}
              >
                <Select
                  value={settings.format}
                  onChange={(format) => {
                    const patch: Parameters<typeof update>[0] = { format }
                    if (!SUPPORTS_16_BIT.has(format)) patch.bitDepth = 8
                    if (format === 'webp') patch.colorSpace = 'srgb'
                    update(patch)
                  }}
                  options={formatOptions}
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
                    hint={settings.limitSize ? 'Quality drops until it fits, down to 20.' : undefined}
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
                    hint="Smaller, and paints in stages over a slow connection."
                  >
                    <Switch
                      checked={settings.jpegProgressive}
                      onChange={(jpegProgressive) => update({ jpegProgressive })}
                      label="Progressive"
                      showLabel
                    />
                  </Field>
                  <Field
                    label="Chroma"
                    hint="Auto picks 4:4:4 above quality 90, 4:2:0 below."
                  >
                    <Select
                      value={settings.jpegSubsampling}
                      onChange={(jpegSubsampling) => update({ jpegSubsampling })}
                      options={[
                        { value: 'auto', label: 'Auto' },
                        { value: '4:4:4', label: '4:4:4 · full colour' },
                        { value: '4:2:0', label: '4:2:0 · smaller' },
                      ]}
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
                    disabled={settings.format === 'webp'}
                    className="flex-1"
                  />
                </Field>
              )}

              {SUPPORTS_16_BIT.has(settings.format) && (
                <Field
                  label="Bit depth"
                  hint="16 bits survives further editing without banding."
                >
                  <Select
                    value={String(settings.bitDepth) as '8' | '16'}
                    onChange={(v) => update({ bitDepth: v === '16' ? 16 : 8 })}
                    options={[
                      { value: '8', label: '8 bits / channel' },
                      { value: '16', label: '16 bits / channel' },
                    ]}
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

            {rendered && (
              <FieldGroup title="Image sizing">
                <Field label="Resize">
                  <Select
                    value={settings.resizeMode}
                    onChange={(resizeMode) => update({ resizeMode })}
                    options={RESIZE_MODES}
                    className={settings.resizeMode === 'none' ? 'flex-1' : 'w-40'}
                  />
                  {settings.resizeMode === 'longEdge' && (
                    <NumberInput
                      label="Long edge"
                      value={settings.resizeLongEdge}
                      onChange={(resizeLongEdge) => update({ resizeLongEdge })}
                      suffix="px"
                    />
                  )}
                  {settings.resizeMode === 'shortEdge' && (
                    <NumberInput
                      label="Short edge"
                      value={settings.resizeShortEdge}
                      onChange={(resizeShortEdge) => update({ resizeShortEdge })}
                      suffix="px"
                    />
                  )}
                  {(settings.resizeMode === 'width' || settings.resizeMode === 'fit') && (
                    <NumberInput
                      label="Width"
                      value={settings.resizeWidth}
                      onChange={(resizeWidth) => update({ resizeWidth })}
                      suffix="w"
                    />
                  )}
                  {(settings.resizeMode === 'height' || settings.resizeMode === 'fit') && (
                    <NumberInput
                      label="Height"
                      value={settings.resizeHeight}
                      onChange={(resizeHeight) => update({ resizeHeight })}
                      suffix="h"
                    />
                  )}
                  {settings.resizeMode === 'megapixels' && (
                    <NumberInput
                      label="Megapixels"
                      value={settings.megapixels}
                      onChange={(megapixels) => update({ megapixels })}
                      min={1}
                      max={200}
                      suffix="MP"
                      width={56}
                    />
                  )}
                  {settings.resizeMode === 'percent' && (
                    <NumberInput
                      label="Percentage"
                      value={settings.resizePercent}
                      onChange={(resizePercent) => update({ resizePercent })}
                      min={1}
                      max={400}
                      suffix="%"
                      width={56}
                    />
                  )}
                </Field>
                {settings.resizeMode !== 'none' && (
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
                    className="min-w-0 flex-1"
                  />
                </Field>
              </FieldGroup>
            )}

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
                    className={settings.sharpenTarget === 'none' ? 'flex-1' : 'w-40'}
                  />
                  {settings.sharpenTarget !== 'none' && (
                    <Select
                      value={settings.sharpenAmount}
                      onChange={(sharpenAmount) => update({ sharpenAmount })}
                      options={[
                        { value: 'low', label: 'Low' },
                        { value: 'standard', label: 'Standard' },
                        { value: 'high', label: 'High' },
                      ]}
                      className="min-w-0 flex-1"
                    />
                  )}
                </Field>
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
                    ? 'A DNG already carries its settings; this is a spare copy.'
                    : 'Develop settings, for another raw developer to pick up.'
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
                    label="Stamp a line of text on the export"
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
                        className="w-40"
                      />
                      <Checkbox
                        checked={settings.watermark.shadow}
                        onChange={(shadow) =>
                          update({ watermark: { ...settings.watermark, shadow } })
                        }
                        label="Shadow"
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
                        className="w-40"
                      />
                      <Select
                        value={settings.watermark.color}
                        onChange={(color) => update({ watermark: { ...settings.watermark, color } })}
                        options={[
                          { value: 'white', label: 'White' },
                          { value: 'black', label: 'Black' },
                        ]}
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

function JobList({
  jobs,
  progress,
  done,
  failures,
}: {
  jobs: ReturnType<typeof useExport.getState>['jobs']
  progress: number
  done: number
  failures: number
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col px-5 pt-4 pb-2">
      <div className="mb-2.5 h-1 shrink-0 overflow-hidden rounded-full bg-control">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-[--duration-fast] ease-[--ease-out]"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
      <p className="mb-2.5 shrink-0 text-mini text-label-secondary tabular-nums">
        {done} of {jobs.length} written
        {failures > 0 && <span className="text-red"> · {failures} failed</span>}
      </p>
      <Scroller frameClassName="min-h-0 flex-1">
        <ul>
          {jobs.map((job) => (
            <li
              key={job.id}
              className="flex h-7 items-center gap-2.5 rounded-md px-1.5 text-mini"
              title={
                job.error ??
                (job.overLimit
                  ? `Could not reach ${job.overLimit.requestedKb} kB; written at quality ${job.overLimit.quality}`
                  : undefined)
              }
            >
              <span className="grid size-3.5 shrink-0 place-items-center">
                {job.state === 'done' && !job.overLimit && (
                  <CheckIcon className="size-3.5 text-green" />
                )}
                {job.state === 'done' && job.overLimit && (
                  <WarningIcon className="size-3.5 text-orange" />
                )}
                {job.state === 'failed' && <WarningIcon className="size-3.5 text-red" />}
                {job.state === 'skipped' && <CloseIcon className="size-3 text-icon-tertiary" />}
                {job.state === 'cancelled' && <CloseIcon className="size-3 text-icon-tertiary" />}
                {job.state === 'running' && <Spinner size={11} />}
                {job.state === 'queued' && (
                  <span className="size-1.5 rounded-full bg-icon-quaternary" />
                )}
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
              {job.state === 'failed' ? (
                <span className="max-w-[45%] shrink-0 truncate text-mini text-red">
                  {job.error ?? 'Failed'}
                </span>
              ) : job.state === 'skipped' || job.state === 'cancelled' ? (
                <span className="shrink-0 text-mini text-label-secondary">
                  {job.state === 'skipped' ? 'Skipped' : 'Cancelled'}
                </span>
              ) : (
                <span
                  className={cn(
                    'shrink-0 font-mono text-micro tabular-nums',
                    job.overLimit ? 'text-orange' : 'text-label-secondary',
                  )}
                >
                  {job.bytes ? formatBytes(job.bytes) : ''}
                </span>
              )}
            </li>
          ))}
        </ul>
      </Scroller>
    </div>
  )
}
