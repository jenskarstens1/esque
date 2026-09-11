/**
 * Where an image layer's pixels live between the file and the renderer.
 *
 * The same bargain `ai/alpha` strikes for detected coverage. An imported
 * picture is not a setting — it cannot sit in `Edits` and be written to
 * IndexedDB on every slider move — but it is not disposable either, because the
 * file it came from may be gone by the next session. So `LayerContent` stores a
 * *key*, and the pixels it names live here: in memory for the session, and in
 * OPFS across sessions.
 *
 * That indirection is what keeps a layer stack parametric. The edit stack still
 * holds nothing but parameters, so presets, snapshots, history and XMP all
 * round-trip exactly as they did — a sidecar carries the key, and a machine
 * that has never seen those pixels renders the layer as nothing rather than as
 * something wrong.
 *
 * Pixels are stored 8-bit sRGB, straight from the decoder. Imported artwork is
 * display-referred by definition; the renderer linearises on upload.
 */
import { cacheDelete, cacheRead, cacheWrite } from '../catalog/opfs'

export interface LayerPixels {
  width: number
  height: number
  /** `width` × `height` RGBA, 8-bit, sRGB encoded. */
  data: Uint8Array
}

const MAGIC = 0x4553494d // "ESIM"
const HEADER_BYTES = 16

const memory = new Map<string, LayerPixels>()

/** The OPFS key for one imported image, named by its content hash. */
export function layerPixelsKey(hash: string): string {
  return `layer/${hash}`
}

export function getLayerPixels(key: string): LayerPixels | null {
  return memory.get(key) ?? null
}

export function putLayerPixels(key: string, pixels: LayerPixels): void {
  memory.set(key, pixels)
}

/** Releases a render worker's imports between jobs, not its persisted files. */
export function clearLayerPixels(): void {
  memory.clear()
}

export async function saveLayerPixels(key: string, pixels: LayerPixels): Promise<void> {
  const bytes = new Uint8Array(HEADER_BYTES + pixels.data.length)
  const head = new DataView(bytes.buffer, 0, HEADER_BYTES)
  head.setUint32(0, MAGIC, true)
  head.setUint32(4, pixels.width, true)
  head.setUint32(8, pixels.height, true)
  head.setUint32(12, pixels.data.length, true)
  bytes.set(pixels.data, HEADER_BYTES)
  await cacheWrite(key, bytes)
  memory.set(key, pixels)
}

/**
 * Reads pixels back, verifying rather than trusting.
 *
 * A truncated OPFS write is indistinguishable from a short file without the
 * length in the header, and half an image composited into a photograph is
 * worse than no image at all — so anything that does not match is treated as a
 * miss and deleted.
 */
export async function loadLayerPixels(key: string): Promise<LayerPixels | null> {
  const hit = memory.get(key)
  if (hit) return hit

  const file = await cacheRead(key)
  if (!file) return null

  const buffer = await file.arrayBuffer()
  if (buffer.byteLength <= HEADER_BYTES) {
    await cacheDelete(key)
    return null
  }
  const head = new DataView(buffer, 0, HEADER_BYTES)
  const width = head.getUint32(4, true)
  const height = head.getUint32(8, true)
  const count = head.getUint32(12, true)
  if (
    head.getUint32(0, true) !== MAGIC ||
    width <= 0 ||
    height <= 0 ||
    count !== width * height * 4 ||
    buffer.byteLength !== HEADER_BYTES + count
  ) {
    await cacheDelete(key)
    return null
  }

  const pixels: LayerPixels = {
    width,
    height,
    data: new Uint8Array(buffer.slice(HEADER_BYTES)),
  }
  memory.set(key, pixels)
  return pixels
}
