/**
 * Export queue.
 *
 * Exports run one at a time: each job wants a GPU device and up to a
 * gigabyte of GPU memory, so running two in parallel would be slower than
 * running them in sequence and far more likely to fall over.
 */
import { create } from 'zustand'
import { db, getSetting, setSetting } from '../catalog/db'
import { useUI } from './ui'
import { formatBytes, nextId } from '../lib/math'
import { toast } from '../design/toast'
import {
  BUILT_IN_PRESETS,
  normaliseSettings,
  type ExportJob,
  type ExportPreset,
  type ExportSettings,
} from '../export/types'
import { stem } from '../export/naming'
import { useDevelop } from '../develop/session'
import { ensurePermission, fsSupported } from '../catalog/fs'
import { prepareDownload, reserveDownloadName, startDownload, type DownloadFile } from '../export/download'
import type { Photo } from '../core/types'

const STORAGE_KEY = 'esque.export.settings'
const PRESET_KEY = 'esque.export.presets'

function loadSettings(): ExportSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return normaliseSettings(JSON.parse(raw))
  } catch {
    /* fall through to defaults */
  }
  return normaliseSettings(null)
}

function loadPresets(): ExportPreset[] {
  try {
    const raw = localStorage.getItem(PRESET_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as ExportPreset[]
    if (!Array.isArray(parsed)) return []
    return parsed.map((p) => ({
      id: p.id || nextId(),
      name: p.name || 'Preset',
      builtIn: false,
      settings: normaliseSettings(p.settings),
    }))
  } catch {
    return []
  }
}

function persistPresets(presets: ExportPreset[]) {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(presets))
  } catch {
    /* private mode, not worth surfacing */
  }
}

interface ExportState {
  open: boolean
  photoIds: string[]
  settings: ExportSettings
  destination: FileSystemDirectoryHandle | null
  destinationName: string
  delivery: 'folder' | 'download'
  pendingDownloads: Array<DownloadFile & { jobId: string }>
  readyDownload: DownloadFile | null
  downloadStarted: boolean

  /** User presets only; the built-ins are appended by {@link allPresets}. */
  presets: ExportPreset[]
  /** Which preset the current settings came from, for the sidebar highlight. */
  activePreset: string | null

  jobs: ExportJob[]
  running: boolean
  editing: boolean
  batchError: string | null
  /** 0..1 across the whole batch. */
  progress: number
  stage: string

  openDialog: (photoIds: string[]) => void
  closeDialog: () => void
  update: (patch: Partial<ExportSettings>) => void
  setDestination: (dir: FileSystemDirectoryHandle | null) => void
  setDelivery: (delivery: 'folder' | 'download') => void
  prepareDownloads: () => Promise<void>
  download: () => void
  applyPreset: (id: string) => void
  savePreset: (name: string) => void
  updatePreset: (id: string) => void
  deletePreset: (id: string) => void
  start: () => Promise<void>
  retryFailed: () => Promise<void>
  editSettings: () => void
  cancel: () => void
  clearJobs: () => void
}

let signal = { cancelled: false }

/** Built-ins first, then the user's own, the way Lightroom groups them. */
export const allPresets = (user: ExportPreset[]): ExportPreset[] => [...BUILT_IN_PRESETS, ...user]

export const useExport = create<ExportState>((set, get) => ({
  open: false,
  photoIds: [],
  settings: loadSettings(),
  destination: null,
  destinationName: '',
  delivery: fsSupported() ? 'folder' : 'download',
  pendingDownloads: [],
  readyDownload: null,
  downloadStarted: false,

  presets: loadPresets(),
  activePreset: null,

  jobs: [],
  running: false,
  editing: false,
  batchError: null,
  progress: 0,
  stage: '',

  openDialog: (photoIds) => {
    const current = get()
    const ids = [...new Set(photoIds)]
    const sameSelection = ids.length === current.photoIds.length &&
      ids.every((id, index) => id === current.photoIds[index])
    if (current.running || (sameSelection && (
      current.batchError || current.jobs.some(retryable) ||
      (current.pendingDownloads.length > 0 && !current.downloadStarted)
    ))) {
      set({ open: true })
      return
    }
    set({
      open: true, photoIds: ids, jobs: [], progress: 0, stage: '', editing: false,
      batchError: null, pendingDownloads: [], readyDownload: null, downloadStarted: false,
    })
  },
  closeDialog: () => {
    if (!get().running) set({ open: false })
  },

  update: (patch) => {
    const settings = { ...get().settings, ...patch }
    // Any manual edit means the settings are no longer "the preset".
    set({ settings, activePreset: null })
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
      /* private mode, not worth surfacing */
    }
  },

  setDestination: (dir) => {
    set({ destination: dir, destinationName: dir?.name ?? '', ...(dir ? { delivery: 'folder' } : {}) })
    rememberDestination(dir)
  },
  setDelivery: (delivery) => set({ delivery }),
  prepareDownloads: () => preparePendingDownloads(),
  download: () => {
    const file = get().readyDownload
    if (!file) {
      toast.error('Download is not ready', 'Prepare the download first.')
      return
    }
    startDownload(file)
    set({ downloadStarted: true })
    toast.show('Download started', { detail: file.name })
  },

  applyPreset: (id) => {
    const preset = allPresets(get().presets).find((p) => p.id === id)
    if (!preset) return
    const settings = normaliseSettings(preset.settings)
    set({ settings, activePreset: id })
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
      /* private mode */
    }
  },

  savePreset: (name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const preset: ExportPreset = {
      id: nextId(),
      name: trimmed,
      builtIn: false,
      settings: { ...get().settings },
    }
    const presets = [...get().presets, preset].sort((a, b) => a.name.localeCompare(b.name))
    persistPresets(presets)
    set({ presets, activePreset: preset.id })
  },

  updatePreset: (id) => {
    const presets = get().presets.map((p) =>
      p.id === id ? { ...p, settings: { ...get().settings } } : p,
    )
    persistPresets(presets)
    set({ presets, activePreset: id })
  },

  deletePreset: (id) => {
    const presets = get().presets.filter((p) => p.id !== id)
    persistPresets(presets)
    set({ presets, activePreset: get().activePreset === id ? null : get().activePreset })
  },

  cancel: () => {
    if (!get().running || signal.cancelled) return
    signal.cancelled = true
    // The flag above only stops the orchestrator between photos. The render
    // itself is in the worker, so the in-flight job needs telling directly.
    void import('../export/client').then((m) => m.cancelExportJob()).catch(() => {})
    set({ stage: 'Cancelling…' })
  },

  clearJobs: () => {
    if (!get().running) set({
      jobs: [], progress: 0, stage: '', batchError: null, editing: false,
      pendingDownloads: [], readyDownload: null, downloadStarted: false,
    })
  },
  editSettings: () => {
    if (!get().running) set({ editing: true })
  },
  start: () => runExport(false),
  retryFailed: () => runExport(true),
}))

const retryable = (job: ExportJob) => job.state === 'failed' || job.state === 'cancelled'
const errorMessage = (err: unknown) => err instanceof Error ? err.message : String(err)

async function assembleDownload(currentSignal: { cancelled: boolean }) {
  const files = useExport.getState().pendingDownloads
  if (!files.length || currentSignal.cancelled) return
  useExport.setState({ stage: 'Preparing download…', readyDownload: null, downloadStarted: false })
  const readyDownload = await prepareDownload(files, currentSignal)
  useExport.setState({ readyDownload })
}

async function preparePendingDownloads() {
  if (useExport.getState().running) return
  const currentSignal = { cancelled: false }
  signal = currentSignal
  useExport.setState({ running: true, editing: false, batchError: null })
  try {
    await assembleDownload(currentSignal)
  } catch (err) {
    if (!currentSignal.cancelled) {
      const message = errorMessage(err)
      useExport.setState({ batchError: message })
      toast.error('Could not prepare download', message)
    }
  } finally {
    useExport.setState({ running: false, stage: '' })
  }
}

type ExportSignal = { cancelled: boolean }
type ExporterModule = typeof import('../export/exporter')
type ExportResult = Awaited<ReturnType<ExporterModule['exportPhoto']>>

const STAGE_WEIGHTS = {
  decoding: 0.55,
  rendering: 0.3,
  resizing: 0.08,
  encoding: 0.05,
  writing: 0.02,
} as const
const STAGE_ORDER = ['decoding', 'rendering', 'resizing', 'encoding', 'writing'] as const

function patchJob(id: string, next: Partial<ExportJob>) {
  useExport.setState((state) => ({
    jobs: state.jobs.map((job) => job.id === id ? { ...job, ...next } : job),
  }))
}

function updateExportProgress() {
  const { jobs } = useExport.getState()
  const progress = jobs.length
    ? jobs.reduce((sum, job) => sum + job.progress, 0) / jobs.length
    : 0
  useExport.setState({ progress })
}

function checkCancelled(currentSignal: ExportSignal) {
  if (currentSignal.cancelled) throw new Error('Export cancelled')
}

function reportJobProgress(
  jobId: string,
  stage: Parameters<NonNullable<Parameters<ExporterModule['exportPhoto']>[3]>>[0],
  fraction: number,
) {
  let base = 0
  for (const step of STAGE_ORDER) {
    if (step === stage) break
    base += STAGE_WEIGHTS[step]
  }
  patchJob(jobId, { progress: base + STAGE_WEIGHTS[stage] * fraction })
  updateExportProgress()
}

function buildJobs(
  initial: ExportState,
  ids: string[],
  photos: Array<Photo | undefined>,
  retry: boolean,
) {
  const previous = new Map(useExport.getState().jobs.map((job) => [job.photoId, job]))
  const jobs: ExportJob[] = ids.map((photoId, index) => previous.get(photoId) ?? ({
    id: nextId(),
    photoId,
    filename: photos[index]?.filename ?? 'Photo no longer in catalog',
    state: 'queued',
    progress: 0,
    outputName: null,
    bytes: 0,
    error: null,
  }))
  if (!retry || !initial.jobs.length) useExport.setState({ jobs })
  return jobs
}

async function exportDirectory(
  delivery: ExportState['delivery'],
  destination: FileSystemDirectoryHandle | null,
  settings: ExportSettings,
  exporter: ExporterModule,
) {
  if (delivery !== 'folder' || !destination) return null
  return exporter.resolveDestination(destination, settings.subfolder)
}

async function storeExportResult(
  job: ExportJob,
  result: ExportResult,
  dir: FileSystemDirectoryHandle | null,
  settings: ExportSettings,
  usedNames: Set<string>,
  exporter: ExporterModule,
  currentSignal: ExportSignal,
) {
  const name = dir
    ? await exporter.uniqueName(dir, result.filename, settings.overwrite)
    : reserveDownloadName(result.filename, usedNames, !!result.sidecar)
  checkCancelled(currentSignal)
  if (!name) {
    patchJob(job.id, { state: 'skipped', progress: 1 })
    return
  }

  let warning: string | null = null
  if (dir) {
    await exporter.writeFile(dir, name, result.blob)
    if (result.sidecar) {
      try {
        await exporter.writeFile(dir, `${stem(name)}.xmp`, new Blob([result.sidecar], {
          type: 'application/rdf+xml',
        }))
      } catch (error) {
        warning = `Photo written, but the XMP sidecar failed: ${errorMessage(error)}`
      }
    }
  } else {
    const files = [{ jobId: job.id, name, blob: result.blob }]
    if (result.sidecar) {
      files.push({
        jobId: job.id,
        name: `${stem(name)}.xmp`,
        blob: new Blob([result.sidecar], { type: 'application/rdf+xml' }),
      })
    }
    useExport.setState((state) => ({
      pendingDownloads: [...state.pendingDownloads, ...files],
    }))
  }

  patchJob(job.id, {
    state: dir ? 'done' : 'prepared',
    progress: 1,
    outputName: name,
    bytes: result.blob.size,
    error: warning,
    overLimit: result.limit && !result.limit.met
      ? { requestedKb: settings.limitSizeKb, quality: result.limit.quality }
      : null,
  })
}

async function runExportJob({
  job,
  photo,
  index,
  total,
  photoIds,
  settings,
  currentSignal,
  dir,
  usedNames,
  exporter,
}: {
  job: ExportJob
  photo: Photo | undefined
  index: number
  total: number
  photoIds: string[]
  settings: ExportSettings
  currentSignal: ExportSignal
  dir: FileSystemDirectoryHandle | null
  usedNames: Set<string>
  exporter: ExporterModule
}) {
  patchJob(job.id, { state: 'running' })
  useExport.setState({ stage: `${job.filename} · ${index + 1} of ${total}` })
  try {
    if (!photo) throw new Error('This photo is no longer in the catalog.')
    const result = await exporter.exportPhoto(
      photo,
      settings,
      settings.startNumber + photoIds.indexOf(photo.id),
      (stage, fraction) => reportJobProgress(job.id, stage, fraction),
      currentSignal,
    )
    checkCancelled(currentSignal)
    await storeExportResult(job, result, dir, settings, usedNames, exporter, currentSignal)
  } catch (error) {
    if (!currentSignal.cancelled) {
      patchJob(job.id, { state: 'failed', progress: 1, error: errorMessage(error) })
    }
  }
  updateExportProgress()
}

function finishExport(currentSignal: ExportSignal, batchError: string | null) {
  useExport.setState((state) => ({
    running: false,
    stage: '',
    batchError,
    jobs: state.jobs.map((job) => {
      if (job.state !== 'queued' && job.state !== 'running') return job
      return currentSignal.cancelled
        ? { ...job, state: 'cancelled' }
        : { ...job, state: 'failed', error: batchError ?? 'The export did not finish.' }
    }),
  }))
  updateExportProgress()
}

function reportExportOutcome(currentSignal: ExportSignal, batchError: string | null) {
  const { jobs } = useExport.getState()
  const written = jobs.filter((job) => job.state === 'done').length
  const prepared = jobs.filter((job) => job.state === 'prepared').length
  const failed = jobs.filter((job) => job.state === 'failed').length
  const skipped = jobs.filter((job) => job.state === 'skipped').length
  const oversized = jobs.filter((job) => !!job.overLimit).length
  const warnings = jobs.filter((job) => job.state === 'done' && job.error).length

  if (batchError) return toast.error('Export could not finish', batchError)
  if (currentSignal.cancelled) {
    const detail = prepared
      ? `${prepared} prepared photos kept. Finish their download or retry the rest.`
      : written ? `${written} already written` : 'No files written.'
    return toast.show('Export cancelled', { detail })
  }
  if (failed || skipped || oversized || warnings) {
    const parts = [
      written ? `${written} exported` : '',
      prepared ? `${prepared} ready to download` : '',
      failed ? `${failed} failed` : '',
      skipped ? `${skipped} skipped` : '',
      oversized ? `${oversized} over the size limit — try resizing` : '',
      warnings ? `${warnings} sidecars not written` : '',
    ].filter(Boolean)
    return toast.error('Export finished with problems', parts.join(' · '))
  }
  if (prepared) return toast.show('Export ready', { detail: 'Choose Download to save the prepared files.' })
  if (!written) return
  toast.show(written === 1 ? 'Photo exported' : `${written} photos exported`, {
    detail: formatBytes(jobs.reduce((sum, job) => sum + job.bytes, 0)),
  })
  useExport.setState({ open: false })
}

async function runExport(retry: boolean) {
  const initial = useExport.getState()
  if (initial.running) return
  const { destination, delivery, photoIds } = initial
  const ids = retry && initial.jobs.length
    ? initial.jobs.filter(retryable).map((job) => job.photoId)
    : photoIds
  if (!ids.length) return

  const settings = structuredClone(initial.settings)
  const currentSignal = { cancelled: false }
  signal = currentSignal
  const attempted = new Set(ids)
  useExport.setState({
    running: true,
    editing: false,
    batchError: null,
    stage: 'Preparing…',
    progress: 0,
    pendingDownloads: retry ? initial.pendingDownloads : [],
    readyDownload: null,
    downloadStarted: false,
    jobs: retry
      ? initial.jobs.map((job) => attempted.has(job.photoId)
        ? { ...job, state: 'queued', progress: 0, error: null }
        : job)
      : [],
  })

  let batchError: string | null = null

  try {
    if (delivery === 'folder') {
      if (!destination) throw new Error('Choose a destination folder, then retry the export.')
      // Ask before storage/decoder work can consume the initiating user gesture.
      if (!(await ensurePermission(destination, 'readwrite'))) {
        throw new Error('Write access was not granted. Choose the destination folder again, then retry.')
      }
    }
    checkCancelled(currentSignal)
    useExport.setState({ stage: 'Saving edits…' })
    try {
      await useDevelop.getState().flush()
    } catch (err) {
      throw new Error(`Edits could not be saved. ${useDevelop.getState().saveError ?? errorMessage(err)}`)
    }
    checkCancelled(currentSignal)

    useExport.setState({ stage: 'Preparing photos…' })
    const photos = await db.photos.bulkGet(ids)
    const jobs = buildJobs(initial, ids, photos, retry)
    checkCancelled(currentSignal)

    const exporter = await import('../export/exporter')
    checkCancelled(currentSignal)
    const dir = await exportDirectory(delivery, destination, settings, exporter)
    const usedNames = new Set(useExport.getState().pendingDownloads.map((file) => file.name))
    checkCancelled(currentSignal)

    for (let index = 0; index < jobs.length; index++) {
      if (currentSignal.cancelled) break
      await runExportJob({
        job: jobs[index],
        photo: photos[index],
        index,
        total: jobs.length,
        photoIds,
        settings,
        currentSignal,
        dir,
        usedNames,
        exporter,
      })
    }
    await assembleDownload(currentSignal)
  } catch (err) {
    if (!currentSignal.cancelled) batchError = errorMessage(err)
  } finally {
    finishExport(currentSignal, batchError)
  }

  reportExportOutcome(currentSignal, batchError)
}

// ---------------------------------------------------------------------------
// Remembering where exports go
//
// The folder picker is the single most repeated gesture in an export workflow
// and the least interesting: almost nobody exports to a different place each
// time. The handle survives a reload because IndexedDB structured-clones it —
// what does *not* survive is the permission, so a restored destination is a
// name on a button until the next user gesture can ask for write access again.
// Asking on restore is impossible: `requestPermission` without a gesture throws.
// Asking at export time is right anyway, because that is the moment the user
// has said "yes, write there".
// ---------------------------------------------------------------------------

const DESTINATION_KEY = 'export.destination'

function rememberDestination(dir: FileSystemDirectoryHandle | null) {
  if (!useUI.getState().rememberDestination) return
  void setSetting(DESTINATION_KEY, dir).catch(() => {})
}

/** Forgets the stored destination. Called when the preference is switched off. */
export function forgetDestination() {
  void setSetting(DESTINATION_KEY, null).catch(() => {})
}

/**
 * Restores the last export destination on startup.
 *
 * Deliberately does not verify the folder still exists — that costs a disk
 * touch on every launch to answer a question the export itself will answer
 * anyway, and a missing folder surfaces as one clear failure at export time
 * rather than a silent reset the user never sees.
 */
export async function restoreDestination() {
  if (!useUI.getState().rememberDestination) return
  if (useExport.getState().destination) return
  const dir = await getSetting<FileSystemDirectoryHandle | null>(DESTINATION_KEY, null)
  if (!dir) return
  // Bypasses `setDestination` so restoring doesn't write back what it just read.
  useExport.setState({ destination: dir, destinationName: dir.name })
}
