/** File System Access helpers: real folders on disk, no server involved. */

/**
 * Stills-only RAW formats LibRaw can actually open. Cinema container formats
 * (`.braw`, `.r3d`) look like RAW but are video and decode to nothing, so they
 * are deliberately absent — offering them only produces broken imports.
 */
export const RAW_EXTENSIONS = new Set([
  '3fr', 'ari', 'arw', 'bay', 'cap', 'cr2', 'cr3', 'crw', 'dcr', 'dcs', 'dng',
  'erf', 'fff', 'gpr', 'iiq', 'k25', 'kdc', 'mdc', 'mef', 'mos', 'mrw', 'nef',
  'nrw', 'orf', 'ori', 'pef', 'ptx', 'pxn', 'raf', 'raw', 'rw2', 'rwl', 'rwz',
  'sr2', 'srf', 'srw', 'x3f',
])

export const RENDERED_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'jpe', 'png', 'tif', 'tiff', 'webp', 'avif', 'heic', 'heif', 'bmp',
])

export const extOf = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase()

export const isSupported = (name: string) => {
  const e = extOf(name)
  return RAW_EXTENSIONS.has(e) || RENDERED_EXTENSIONS.has(e)
}

export const isRawFile = (name: string) => RAW_EXTENSIONS.has(extOf(name))

export const fsSupported = () =>
  typeof window !== 'undefined' && 'showDirectoryPicker' in window

export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!fsSupported()) return null
  try {
    return await window.showDirectoryPicker({ mode: 'readwrite', id: 'esque-photos' })
  } catch {
    return null // user cancelled
  }
}

export const filePickerSupported = () =>
  typeof window !== 'undefined' && 'showOpenFilePicker' in window

/**
 * Picks loose files rather than a whole folder. Chromium hands back file
 * handles with no parent directory, so these are catalogued against the
 * synthetic "Imported Files" folder and keep their own handle for re-reads.
 */
export async function pickFiles(multiple = false): Promise<FileSystemFileHandle[]> {
  if (!filePickerSupported()) return []
  try {
    return await window.showOpenFilePicker({
      multiple,
      id: 'esque-photos',
      types: [
        {
          description: 'Photos',
          accept: {
            'image/*': [...RENDERED_EXTENSIONS].map((e) => `.${e}`),
            'image/x-dcraw': [...RAW_EXTENSIONS].map((e) => `.${e}`),
          },
        },
      ],
    })
  } catch {
    return [] // user cancelled
  }
}

export type PermissionResult = 'granted' | 'denied' | 'prompt'

export async function checkPermission(
  handle: FileSystemHandle,
  mode: 'read' | 'readwrite' = 'readwrite',
): Promise<PermissionResult> {
  const q = await handle.queryPermission?.({ mode })
  return (q ?? 'prompt') as PermissionResult
}

/**
 * Chromium drops directory permissions between sessions. This must be called
 * from a user gesture, so the UI surfaces an explicit "Reconnect" affordance
 * rather than silently showing an empty catalog.
 */
export async function ensurePermission(
  handle: FileSystemHandle,
  mode: 'read' | 'readwrite' = 'readwrite',
): Promise<boolean> {
  if ((await checkPermission(handle, mode)) === 'granted') return true
  const r = await handle.requestPermission?.({ mode })
  return r === 'granted'
}

export interface ScannedFile {
  handle: FileSystemFileHandle
  relPath: string
  name: string
  size: number
  modifiedAt: number
}

/** Depth-first scan for supported images, skipping hidden and sidecar dirs. */
export async function scanFolder(
  dir: FileSystemDirectoryHandle,
  opts: {
    recursive?: boolean
    signal?: AbortSignal
    onProgress?: (found: number, current: string) => void
  } = {},
): Promise<ScannedFile[]> {
  const { recursive = true, signal, onProgress } = opts
  const out: ScannedFile[] = []

  const visit = async (d: FileSystemDirectoryHandle, prefix: string) => {
    if (signal?.aborted) return
    for await (const [name, handle] of d.entries()) {
      if (signal?.aborted) return
      if (name.startsWith('.')) continue
      const rel = prefix ? `${prefix}/${name}` : name
      if (handle.kind === 'directory') {
        if (!recursive) continue
        if (name === 'Lightroom' || name === '.lrdata' || name.endsWith('.lrdata')) continue
        await visit(handle as FileSystemDirectoryHandle, rel)
      } else if (isSupported(name)) {
        const fh = handle as FileSystemFileHandle
        const file = await fh.getFile()
        out.push({
          handle: fh,
          relPath: rel,
          name,
          size: file.size,
          modifiedAt: file.lastModified,
        })
        if (out.length % 25 === 0) onProgress?.(out.length, rel)
      }
    }
  }

  await visit(dir, '')
  onProgress?.(out.length, '')
  return out
}

/** Walks a stored relative path back to its file handle. */
export async function resolveFile(
  root: FileSystemDirectoryHandle,
  relPath: string,
): Promise<File | null> {
  try {
    const parts = relPath.split('/')
    const name = parts.pop()!
    let dir = root
    for (const p of parts) dir = await dir.getDirectoryHandle(p)
    const fh = await dir.getFileHandle(name)
    return await fh.getFile()
  } catch {
    return null
  }
}

/** Writes a file next to an existing one — used for XMP sidecars and exports. */
export async function writeSibling(
  root: FileSystemDirectoryHandle,
  relPath: string,
  data: Blob | string,
): Promise<boolean> {
  try {
    const parts = relPath.split('/')
    const name = parts.pop()!
    let dir = root
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true })
    const fh = await dir.getFileHandle(name, { create: true })
    const w = await fh.createWritable()
    await w.write(data)
    await w.close()
    return true
  } catch {
    return false
  }
}
