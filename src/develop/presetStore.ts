/**
 * The preset library.
 *
 * Built-ins live in code; user presets live in Dexie. Importing understands
 * both formats Lightroom has shipped — `.xmp` (Lightroom 6 / Classic / Camera
 * Raw) and `.lrtemplate` (Lightroom 3–5) — and exporting writes `.xmp` that
 * Lightroom Classic will read straight out of its `Settings` folder.
 *
 * Packs are bought and sold as folders, so both directions work on one:
 * `importPresetFolder` walks a tree and takes each folder name as a group,
 * and `exportPresets` writes a group back out as one.
 */
import { db } from '../catalog/db'
import { nextId } from '../lib/math'
import { BUILTIN_PRESETS, scopePaths } from './presets'
import { parsePresetFile, presetToXmp } from './xmp'
import { defaultEdits, getPath, sectionOfPath, setPath, type FileKind } from '../core/defaults'
import type { Edits, Preset } from '../core/types'

export interface ImportResult {
  added: number
  failed: string[]
  /** Groups that gained presets, so the panel can open them on the way in. */
  groups: string[]
}

/** One preset file, already read, with the folder it came out of. */
interface PresetSource {
  name: string
  text: string
  /** The containing folder, used as the group when the file doesn't name one. */
  folder?: string
}

/**
 * Parses, de-duplicates against the library, and stores a batch.
 *
 * De-duplication is by group and name rather than by content, because that is
 * the identity a preset actually has: re-importing the same pack after adding
 * one look to it should add the one look, not 40 copies.
 */
async function ingest(sources: PresetSource[]): Promise<ImportResult> {
  const existing = await db.presets.toArray()
  const seen = new Set(existing.map((p) => `${p.group}/${p.name}`.toLowerCase()))
  const fresh: Preset[] = []
  const failed: string[] = []
  const groups = new Set<string>()

  for (const source of sources) {
    try {
      const preset = parsePresetFile(source.name, source.text)
      if (!preset) {
        failed.push(source.name)
        continue
      }
      // Lightroom writes the group inside the file, but folder names win when
      // the file doesn't say — that's how people actually organise their packs.
      if (preset.group === 'Imported' && source.folder) preset.group = source.folder
      const dedupe = `${preset.group}/${preset.name}`.toLowerCase()
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      groups.add(preset.group)
      fresh.push(preset)
    } catch {
      failed.push(source.name)
    }
  }

  if (fresh.length) await db.presets.bulkAdd(fresh)
  return { added: fresh.length, failed, groups: [...groups] }
}

const isPresetFile = (name: string) => /\.(xmp|lrtemplate)$/i.test(name)

/** Reads a batch of preset files. Folders of presets are the normal case. */
export async function importPresetFiles(files: File[]): Promise<ImportResult> {
  const sources: PresetSource[] = []
  const failed: string[] = []

  for (const file of files) {
    if (!isPresetFile(file.name)) continue
    try {
      sources.push({ name: file.name, text: await file.text() })
    } catch {
      failed.push(file.name)
    }
  }

  const result = await ingest(sources)
  return { ...result, failed: [...failed, ...result.failed] }
}

/** Opens the file picker and imports whatever the user chose. */
export async function pickAndImportPresets(): Promise<ImportResult | null> {
  const picker = (
    window as unknown as {
      showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]>
    }
  ).showOpenFilePicker

  if (picker) {
    try {
      const handles = await picker({
        multiple: true,
        types: [
          {
            description: 'Lightroom presets',
            accept: { 'application/xml': ['.xmp'], 'text/plain': ['.lrtemplate'] },
          },
        ],
      })
      const files = await Promise.all(handles.map((h) => h.getFile()))
      return importPresetFiles(files)
    } catch {
      // The user dismissed the picker.
      return null
    }
  }

  // Fallback for browsers without the File System Access API.
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = '.xmp,.lrtemplate'
    input.onchange = () => {
      const files = Array.from(input.files ?? [])
      resolve(files.length ? importPresetFiles(files) : null)
    }
    input.oncancel = () => resolve(null)
    input.click()
  })
}

/** Imports a whole folder of presets, keeping Lightroom's folder-as-group convention. */
export async function importPresetFolder(
  dir: FileSystemDirectoryHandle,
): Promise<ImportResult> {
  const sources: PresetSource[] = []
  const failed: string[] = []

  const walk = async (handle: FileSystemDirectoryHandle, group: string, depth: number) => {
    if (depth > 4) return
    for await (const entry of (
      handle as unknown as {
        values(): AsyncIterable<FileSystemHandle>
      }
    ).values()) {
      if (entry.kind === 'file' && isPresetFile(entry.name)) {
        try {
          const file = await (entry as FileSystemFileHandle).getFile()
          sources.push({ name: file.name, text: await file.text(), folder: group })
        } catch {
          failed.push(entry.name)
        }
      } else if (entry.kind === 'directory') {
        await walk(entry as FileSystemDirectoryHandle, entry.name, depth + 1)
      }
    }
  }
  await walk(dir, dir.name, 0)

  const result = await ingest(sources)
  return { ...result, failed: [...failed, ...result.failed] }
}

/** Opens the directory picker and imports the tree beneath it. */
export async function pickAndImportPresetFolder(): Promise<ImportResult | null> {
  const picker = (
    window as unknown as {
      showDirectoryPicker?: (o?: unknown) => Promise<FileSystemDirectoryHandle>
    }
  ).showDirectoryPicker

  if (picker) {
    try {
      return await importPresetFolder(await picker({ mode: 'read' }))
    } catch {
      // The user dismissed the picker.
      return null
    }
  }

  // `webkitdirectory` is the only folder upload the other browsers offer. It
  // hands back a flat file list, so the group comes from the path instead of
  // from a handle we can walk.
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    Object.assign(input, { webkitdirectory: true })
    input.onchange = async () => {
      const files = Array.from(input.files ?? []).filter((f) => isPresetFile(f.name))
      if (!files.length) return resolve(null)
      const sources: PresetSource[] = []
      const failed: string[] = []
      for (const file of files) {
        const parts = (file.webkitRelativePath || file.name).split('/')
        try {
          sources.push({
            name: file.name,
            text: await file.text(),
            folder: parts.length > 1 ? parts[parts.length - 2] : undefined,
          })
        } catch {
          failed.push(file.name)
        }
      }
      const result = await ingest(sources)
      resolve({ ...result, failed: [...failed, ...result.failed] })
    }
    input.oncancel = () => resolve(null)
    input.click()
  })
}

export async function createPreset(
  name: string,
  group: string,
  edits: Edits,
  scopeIds: string[],
  kind: FileKind = 'raw',
): Promise<Preset> {
  const paths = scopePaths(scopeIds, kind)
  const sections = [...new Set(paths.map(sectionOfPath))]

  // The patch keeps a whole section's shape so it stays inspectable, but every
  // field outside the ticked scopes stays at its default — a preset should not
  // be quietly carrying around the white balance of the photo it was made from.
  const patch: Partial<Edits> = {}
  const fresh = defaultEdits(kind) as unknown as Record<string, unknown>
  for (const section of sections) {
    ;(patch as unknown as Record<string, unknown>)[section] = structuredClone(fresh[section])
  }
  for (const path of paths) {
    setPath(patch, path, structuredClone(getPath(edits, path)))
  }

  const preset: Preset = {
    id: nextId(),
    name: name.trim() || 'Untitled',
    group: group.trim() || 'User Presets',
    builtin: false,
    sections,
    paths,
    edits: patch,
    createdAt: Date.now(),
  }
  await db.presets.add(preset)
  return preset
}

export const deletePreset = (id: string) => db.presets.delete(id)

export function renamePreset(id: string, name: string, group: string) {
  return db.presets.update(id, { name, group })
}

/** Downloads a preset as a Lightroom-compatible `.xmp`. */
export function exportPreset(preset: Preset) {
  const blob = new Blob([presetXml(preset)], { type: 'application/rdf+xml' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${fileSafe(preset.name)}.xmp`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Writes a whole group into a folder the user picks — the shape a preset pack
 * has to be in for Lightroom, or another esque catalog, to read it back.
 *
 * Falls back to one download per preset where the File System Access API is
 * missing; browsers throttle that past a handful of files, which is exactly why
 * the folder path is preferred. Resolves null if the picker is dismissed.
 */
export async function exportPresets(presets: Preset[]): Promise<number | null> {
  const picker = (
    window as unknown as {
      showDirectoryPicker?: (o?: unknown) => Promise<FileSystemDirectoryHandle>
    }
  ).showDirectoryPicker

  if (!picker) {
    for (const preset of presets) exportPreset(preset)
    return presets.length
  }

  let dir: FileSystemDirectoryHandle
  try {
    dir = await picker({ mode: 'readwrite' })
  } catch {
    return null
  }

  let written = 0
  for (const preset of presets) {
    const handle = await dir.getFileHandle(`${fileSafe(preset.name)}.xmp`, { create: true })
    const stream = await handle.createWritable()
    await stream.write(presetXml(preset))
    await stream.close()
    written++
  }
  return written
}

function presetXml(preset: Preset): string {
  return presetToXmp(preset, { ...defaultEdits(), ...(preset.edits as Edits) })
}

const fileSafe = (name: string) => name.replace(/[/\\:*?"<>|]/g, '-')

/** Built-ins first, then user presets, grouped and sorted for display. */
export function groupPresets(user: Preset[]): Array<{ group: string; presets: Preset[] }> {
  const all: Preset[] = [...BUILTIN_PRESETS, ...user]
  const byGroup = new Map<string, Preset[]>()
  for (const preset of all) {
    const list = byGroup.get(preset.group)
    if (list) list.push(preset)
    else byGroup.set(preset.group, [preset])
  }

  const builtinOrder = ['Colour Negative', 'Cinematic', 'Black & White', 'Genre', 'Tools']
  return [...byGroup.entries()]
    .map(([group, presets]) => ({
      group,
      // Built-ins keep their authored order — film stocks read in speed order,
      // not alphabetically. Only user presets get sorted by name.
      presets: builtinOrder.includes(group)
        ? presets
        : presets.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => {
      const ai = builtinOrder.indexOf(a.group)
      const bi = builtinOrder.indexOf(b.group)
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
      return a.group.localeCompare(b.group)
    })
}
