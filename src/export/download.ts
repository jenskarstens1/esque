import { crc32 } from './crc32'
import { stem } from './naming'

export interface DownloadFile {
  name: string
  blob: Blob
}

const ZIP_LIMIT = 0xffffffff
const encoder = new TextEncoder()

function checkCancelled(signal?: { cancelled: boolean }) {
  if (signal?.cancelled) throw new Error('Export cancelled')
}

function checkedName(name: string): Uint8Array<ArrayBuffer> {
  if (!name || name === '.' || name === '..' || /[/\\\u0000]/.test(name)) {
    throw new Error('Export filenames must not contain folder paths.')
  }
  const bytes = encoder.encode(name)
  if (bytes.length > 0xffff) throw new Error('An export filename is too long. Shorten its template.')
  return bytes
}

/** Keeps paired XMP names aligned and never discards duplicate download names. */
export function reserveDownloadName(name: string, used: Set<string>, sidecar: boolean): string {
  checkedName(name)
  const base = stem(name)
  const extension = name.slice(base.length)
  let candidate = name
  let suffix = 1
  while (used.has(candidate) || (sidecar && used.has(`${stem(candidate)}.xmp`))) {
    candidate = `${base} (${suffix++})${extension}`
  }
  used.add(candidate)
  if (sidecar) used.add(`${stem(candidate)}.xmp`)
  return candidate
}

async function checksum(blob: Blob, signal?: { cancelled: boolean }): Promise<number> {
  const reader = blob.stream().getReader()
  let crc = 0
  try {
    for (;;) {
      checkCancelled(signal)
      const chunk = await reader.read()
      if (chunk.done) return crc
      crc = crc32(chunk.value, crc)
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

/**
 * Store-only ZIP: photos are already compressed, and Blob parts avoid another
 * complete in-memory copy. ZIP32 limits are checked before reading any payload.
 */
export async function prepareDownload(
  files: readonly DownloadFile[],
  signal?: { cancelled: boolean },
): Promise<DownloadFile> {
  checkCancelled(signal)
  if (!files.length) throw new Error('There are no prepared files to download.')
  const names = files.map((file) => checkedName(file.name))
  if (new Set(files.map((file) => file.name)).size !== files.length) {
    throw new Error('The download contains duplicate filenames.')
  }
  if (files.length === 1) return files[0]
  const expected = 22 + files.reduce((bytes, file, index) =>
    bytes + file.blob.size + 76 + names[index].length * 2, 0)
  if (files.length >= 0xffff || expected >= ZIP_LIMIT) {
    throw new Error('This download exceeds the ZIP limit. Export fewer photos at a time (under 4 GB).')
  }

  const now = new Date()
  const date = ((Math.min(2107, Math.max(1980, now.getFullYear())) - 1980) << 9) |
    ((now.getMonth() + 1) << 5) | now.getDate()
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
  const parts: BlobPart[] = []
  const directory: Uint8Array<ArrayBuffer>[] = []
  let offset = 0

  for (const [index, file] of files.entries()) {
    const name = names[index]
    const crc = await checksum(file.blob, signal)
    checkCancelled(signal)
    const header = new Uint8Array(30 + name.length)
    const view = new DataView(header.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, 0x0800, true)
    view.setUint16(10, time, true)
    view.setUint16(12, date, true)
    view.setUint32(14, crc, true)
    view.setUint32(18, file.blob.size, true)
    view.setUint32(22, file.blob.size, true)
    view.setUint16(26, name.length, true)
    header.set(name, 30)
    parts.push(header, file.blob)

    const central = new Uint8Array(46 + name.length)
    const entry = new DataView(central.buffer)
    entry.setUint32(0, 0x02014b50, true)
    entry.setUint16(4, 20, true)
    entry.setUint16(6, 20, true)
    entry.setUint16(8, 0x0800, true)
    entry.setUint16(12, time, true)
    entry.setUint16(14, date, true)
    entry.setUint32(16, crc, true)
    entry.setUint32(20, file.blob.size, true)
    entry.setUint32(24, file.blob.size, true)
    entry.setUint16(28, name.length, true)
    entry.setUint32(42, offset, true)
    central.set(name, 46)
    directory.push(central)
    offset += header.length + file.blob.size
  }

  const end = new Uint8Array(22)
  const view = new DataView(end.buffer)
  view.setUint32(0, 0x06054b50, true)
  view.setUint16(8, files.length, true)
  view.setUint16(10, files.length, true)
  view.setUint32(12, directory.reduce((bytes, entry) => bytes + entry.length, 0), true)
  view.setUint32(16, offset, true)
  checkCancelled(signal)
  return {
    name: `esque-export-${now.toISOString().slice(0, 19).replaceAll(':', '-')}.zip`,
    blob: new Blob([...parts, ...directory, end], { type: 'application/zip' }),
  }
}

/** Called by a real click after rendering, so Safari retains user activation. */
export function startDownload(file: DownloadFile): void {
  const url = URL.createObjectURL(file.blob)
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  document.body.append(link)
  try {
    link.click()
  } finally {
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}
