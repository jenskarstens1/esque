import { crc32 } from '../export/crc32'
import { prepareDownload, reserveDownloadName } from '../export/download'

const failures: string[] = []
let assertions = 0
const ok = (condition: boolean, message: string) => {
  assertions++
  if (!condition) failures.push(message)
}
const encode = (text: string) => new TextEncoder().encode(text)

async function rejects(action: () => unknown, pattern: RegExp, message: string) {
  try {
    await action()
    ok(false, message)
  } catch (error) {
    ok(error instanceof Error && pattern.test(error.message), message)
  }
}

async function run() {
  const bytes = encode('123456789')
  ok(crc32(bytes) === 0xcbf43926, 'CRC32 differs from the standard reference')
  ok(crc32(bytes.subarray(4), crc32(bytes.subarray(0, 4))) === 0xcbf43926,
    'Chunked CRC32 differs from one-shot CRC32')
  ok(crc32(new Uint8Array()) === 0, 'Empty CRC32 is not zero')

  const used = new Set<string>()
  ok(reserveDownloadName('image.jpg', used, true) === 'image.jpg', 'First filename changed')
  ok(reserveDownloadName('image.jpg', used, true) === 'image (1).jpg', 'Duplicate was not renamed')
  ok(reserveDownloadName('image.png', used, true) === 'image (2).png', 'XMP stems collided')
  ok(used.has('image (2).xmp'), 'Renamed sidecar was not reserved')
  const single = { name: 'image.png', blob: new Blob([bytes], { type: 'image/png' }) }
  ok(await prepareDownload([single]) === single, 'Single output was unnecessarily zipped')
  await rejects(() => prepareDownload([]), /no prepared files/i, 'Empty download did not fail')
  await rejects(() => prepareDownload([single, single]), /duplicate/i, 'Duplicate ZIP names were accepted')
  await rejects(() => prepareDownload([{ ...single, name: '../image.png' }]), /folder paths/i,
    'Relative paths were accepted')
  await rejects(() => prepareDownload([single], { cancelled: true }), /cancelled/i,
    'Cancelled preparation continued')
  const oversized = new class extends Blob {
    get size() { return 0xffffffff }
  }()
  await rejects(() => prepareDownload([single, { name: 'huge.tif', blob: oversized }]), /ZIP limit/i,
    'ZIP32 overflow was not rejected before reading')

  const files = [
    { name: 'image.png', blob: new Blob([bytes]) },
    { name: 'image.xmp', blob: new Blob(['<xmp>edits</xmp>']) },
    { name: 'caf\u00e9.png', blob: new Blob([new Uint8Array([0, 1, 254, 255])]) },
  ]
  const archive = await prepareDownload(files)
  ok(archive.name.endsWith('.zip') && archive.blob.type === 'application/zip', 'ZIP identity is incorrect')
  const buffer = await archive.blob.arrayBuffer()
  const view = new DataView(buffer)
  const offsets: number[] = []
  let offset = 0
  for (const file of files) {
    offsets.push(offset)
    ok(view.getUint32(offset, true) === 0x04034b50, 'Invalid local header')
    ok(view.getUint16(offset + 6, true) === 0x0800, 'UTF-8 flag missing')
    ok(view.getUint16(offset + 8, true) === 0, 'ZIP method should be store-only')
    const length = view.getUint16(offset + 26, true)
    const name = new TextDecoder().decode(new Uint8Array(buffer, offset + 30, length))
    ok(name === file.name, 'Local filename encoding is incorrect')
    const payload = new Uint8Array(buffer, offset + 30 + length, file.blob.size)
    ok(view.getUint32(offset + 14, true) === crc32(payload), 'Local checksum is incorrect')
    ok(view.getUint32(offset + 18, true) === file.blob.size, 'Local size is incorrect')
    ok(await new Blob([payload]).text() === await file.blob.text(), 'ZIP changed file contents')
    offset += 30 + length + file.blob.size
  }
  const directoryOffset = offset
  for (const [index, file] of files.entries()) {
    ok(view.getUint32(offset, true) === 0x02014b50, 'Invalid central header')
    ok(view.getUint32(offset + 42, true) === offsets[index], 'Central offset is incorrect')
    const length = view.getUint16(offset + 28, true)
    ok(new TextDecoder().decode(new Uint8Array(buffer, offset + 46, length)) === file.name,
      'Central filename encoding is incorrect')
    offset += 46 + length
  }
  ok(view.getUint32(offset, true) === 0x06054b50, 'End-of-directory signature is incorrect')
  ok(view.getUint16(offset + 10, true) === files.length, 'End-of-directory count is incorrect')
  ok(view.getUint32(offset + 12, true) === offset - directoryOffset, 'Directory size is incorrect')
  ok(view.getUint32(offset + 16, true) === directoryOffset, 'Directory offset is incorrect')
  ok(offset + 22 === buffer.byteLength, 'ZIP has trailing or missing bytes')
  const signal = { cancelled: false }
  const preparing = prepareDownload(files, signal)
  signal.cancelled = true
  await rejects(() => preparing, /cancelled/i, 'Cancellation while reading did not stop preparation')
}

void run().catch((error: unknown) => {
  failures.push(error instanceof Error ? error.message : String(error))
}).finally(() => {
  const result = { ok: failures.length === 0, assertions, failures }
  document.getElementById('root')!.textContent = JSON.stringify(result, null, 2)
  window.__result = result
  window.__done = true
})
