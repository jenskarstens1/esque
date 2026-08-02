/**
 * Export queue.
 *
 * Exports run one at a time: each job wants a GPU device and up to a
 * gigabyte of GPU memory, so running two in parallel would be slower than
 * running them in sequence and far more likely to fall over.
 */
import { create } from 'zustand'
import { db } from '../catalog/db'
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

  /** User presets only; the built-ins are appended by {@link allPresets}. */
  presets: ExportPreset[]
  /** Which preset the current settings came from, for the sidebar highlight. */
  activePreset: string | null

  jobs: ExportJob[]
  running: boolean
  /** 0..1 across the whole batch. */
  progress: number
  stage: string

  openDialog: (photoIds: string[]) => void
  closeDialog: () => void
  update: (patch: Partial<ExportSettings>) => void
  setDestination: (dir: FileSystemDirectoryHandle | null) => void
  applyPreset: (id: string) => void
  savePreset: (name: string) => void
  updatePreset: (id: string) => void
  deletePreset: (id: string) => void
  start: () => Promise<void>
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

  presets: loadPresets(),
  activePreset: null,

  jobs: [],
  running: false,
  progress: 0,
  stage: '',

  openDialog: (photoIds) => set({ open: true, photoIds, jobs: [], progress: 0, stage: '' }),
  closeDialog: () => set({ open: false }),

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

  setDestination: (dir) => set({ destination: dir, destinationName: dir?.name ?? '' }),

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
    signal.cancelled = true
    // The flag above only stops the orchestrator between photos. The render
    // itself is in the worker, so the in-flight job needs telling directly.
    void import('../export/client').then((m) => m.cancelExportJob()).catch(() => {})
    set({ stage: 'Cancelling…' })
  },

  clearJobs: () => set({ jobs: [], progress: 0, stage: '' }),


  async start() {
    const { photoIds, settings, destination } = get()
    if (!destination || !photoIds.length || get().running) return

    // The export engine pulls in the ICC generator, TIFF writer and tiled
    // renderer, so it is fetched on the first export rather than at boot.
    const { exportPhoto, resolveDestination, uniqueName, writeFile } = await import(
      '../export/exporter'
    )

    signal = { cancelled: false }
    const photos = (await db.photos.bulkGet(photoIds)).filter((p) => !!p)
    const jobs: ExportJob[] = photos.map((p) => ({
      id: nextId(),
      photoId: p.id,
      filename: p.filename,
      state: 'queued',
      progress: 0,
      outputName: null,
      bytes: 0,
      error: null,
    }))
    set({ jobs, running: true, progress: 0, stage: 'Preparing…' })

    const patch = (id: string, next: Partial<ExportJob>) =>
      set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...next } : j)) }))

    let written = 0
    let failed = 0
    let skipped = 0
    let oversized = 0
    let bytes = 0

    try {
      const dir = await resolveDestination(destination, settings.subfolder)

      for (let i = 0; i < photos.length; i++) {
        if (signal.cancelled) {
          for (const j of jobs.slice(i)) patch(j.id, { state: 'cancelled' })
          break
        }
        const photo = photos[i]
        const job = jobs[i]
        patch(job.id, { state: 'running' })
        set({ stage: `${photo.filename} · ${i + 1} of ${photos.length}` })

        try {
          const result = await exportPhoto(
            photo,
            settings,
            settings.startNumber + i,
            (stage, fraction) => {
              // Decode dominates, so it gets the lion's share of the bar.
              const weights = { decoding: 0.55, rendering: 0.3, resizing: 0.08, encoding: 0.05, writing: 0.02 }
              const order = ['decoding', 'rendering', 'resizing', 'encoding', 'writing'] as const
              let base = 0
              for (const s of order) {
                if (s === stage) break
                base += weights[s]
              }
              const p = base + weights[stage] * fraction
              patch(job.id, { progress: p })
              set({ progress: (i + p) / photos.length })
            },
            signal,
          )

          const name = await uniqueName(dir, result.filename, settings.overwrite)
          if (!name) {
            patch(job.id, { state: 'skipped', progress: 1 })
            skipped++
            continue
          }
          await writeFile(dir, name, result.blob)
          if (result.sidecar) {
            // Lightroom's sidecar convention: same stem, `.xmp` extension.
            await writeFile(
              dir,
              `${stem(name)}.xmp`,
              new Blob([result.sidecar], { type: 'application/rdf+xml' }),
            ).catch(() => {
              /* the image landed; a missing sidecar is not worth failing the job */
            })
          }
          patch(job.id, {
            state: 'done',
            progress: 1,
            outputName: name,
            bytes: result.blob.size,
            overLimit:
              result.limit && !result.limit.met
                ? { requestedKb: settings.limitSizeKb, quality: result.limit.quality }
                : null,
          })
          written++
          if (result.limit && !result.limit.met) oversized++
          bytes += result.blob.size
        } catch (err) {
          if (signal.cancelled) {
            patch(job.id, { state: 'cancelled' })
            break
          }
          patch(job.id, {
            state: 'failed',
            progress: 1,
            error: err instanceof Error ? err.message : String(err),
          })
          failed++
        }
        set({ progress: (i + 1) / photos.length })
      }
    } catch (err) {
      toast.error('Export failed', err instanceof Error ? err.message : String(err))
    }

    set({ running: false, stage: '', progress: signal.cancelled ? 0 : 1 })

    if (signal.cancelled) {
      toast.show('Export cancelled', { detail: written ? `${written} already written` : undefined })
    } else if (failed || skipped) {
      const parts = [
        written ? `${written} exported` : '',
        skipped ? `${skipped} skipped` : '',
        failed ? `${failed} failed` : '',
        oversized ? `${oversized} over the size limit` : '',
      ].filter(Boolean)
      toast.error('Export finished with problems', parts.join(' · '))
    } else if (oversized) {
      // Every file landed, but some could not be squeezed under the ceiling.
      // Silently shipping an oversized file was the old behaviour and it made
      // the limit untrustworthy.
      toast.error(
        `${oversized === 1 ? 'One file exceeds' : `${oversized} files exceed`} the ${settings.limitSizeKb} kB limit`,
        'Even at the lowest quality the encoder could not fit it. Try resizing the output.',
      )
      set({ open: false })
    } else {
      toast.show(written === 1 ? 'Photo exported' : `${written} photos exported`, {
        detail: formatBytes(bytes),
      })
      set({ open: false })
    }
  },
}))
