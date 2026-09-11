/**
 * Where a finished mask lives between the network and the renderer.
 *
 * A detection result is an odd thing to fit into esque's edit model. It is not
 * a setting — it is far too big to sit in `Edits` and be written to IndexedDB
 * on every keystroke — but it is not disposable either, because re-running the
 * network on every reload would make opening an edited photo cost a second of
 * GPU time. So `AiGeometry` stores a *key*, and the pixels it names live here:
 * in memory for the session, and in OPFS across sessions.
 *
 * That indirection is what keeps AI layers non-destructive in the same sense as
 * everything else. The edit stack still holds nothing but parameters, history
 * and presets still round-trip, and the alpha is derived data that can always
 * be rebuilt from the photo and the key.
 *
 * Coverage is stored at the network's square resolution in normalised source
 * coordinates. The input was stretched to that square, so the stretch cancels
 * when the renderer samples it back over the frame, and the mask needs no
 * record of the aspect it came from.
 */
import { cacheDelete, cacheRead, cacheWrite } from '../catalog/opfs'

export interface AlphaMap {
  size: number
  /** `size` × `size` coverage in 0..1. */
  data: Float32Array
}

const MAGIC = 0x45534149 // "ESAI"
const HEADER_BYTES = 12

const memory = new Map<string, AlphaMap>()

/**
 * The OPFS key for one photo's mask under one model.
 *
 * The model id is part of it because the tiers disagree: a mask detected by
 * BiRefNet and one detected by U²-Net are different pictures, and switching
 * tiers has to be able to fall back to the other's cached result rather than
 * silently serving the wrong one.
 */
export function alphaKey(photoId: string, kind: string, modelId: string): string {
  return `ai/${photoId}/${kind}.${modelId}`
}

export function getAlpha(key: string): AlphaMap | null {
  return memory.get(key) ?? null
}

export function putAlpha(key: string, alpha: AlphaMap): void {
  memory.set(key, alpha)
}

/** Forgets a photo's results — used when its proxy is dropped. */
export function dropAlphasFor(photoId: string): void {
  const prefix = `ai/${photoId}/`
  for (const key of memory.keys()) {
    if (key.startsWith(prefix)) memory.delete(key)
  }
}

/** Releases a render worker's coverage between jobs, not its persisted files. */
export function clearAlphas(): void {
  memory.clear()
}

/**
 * Persists coverage as bytes rather than floats.
 *
 * 8 bits is a quarter of the size and below what the guided refinement can
 * resolve anyway — it re-derives the edge from the photo's own colours, so the
 * quantisation it is handed disappears into a result computed at full
 * precision. A 1024 px BiRefNet mask is a megabyte this way and four if it
 * were floats, on a cache shared with 40 MP proxies.
 */
export async function saveAlpha(key: string, alpha: AlphaMap): Promise<void> {
  const bytes = new Uint8Array(HEADER_BYTES + alpha.data.length)
  const head = new DataView(bytes.buffer, 0, HEADER_BYTES)
  head.setUint32(0, MAGIC, true)
  head.setUint32(4, alpha.size, true)
  head.setUint32(8, alpha.data.length, true)
  for (let i = 0; i < alpha.data.length; i++) {
    bytes[HEADER_BYTES + i] = Math.round(Math.min(1, Math.max(0, alpha.data[i])) * 255)
  }
  await cacheWrite(key, bytes)
}

/**
 * Reads coverage back, verifying it rather than trusting it.
 *
 * A truncated OPFS write is indistinguishable from a valid short file without
 * the length in the header, and a mask that is half garbage is worse than one
 * that has to be recomputed — so anything that does not match is treated as a
 * miss and deleted.
 */
export async function loadAlpha(key: string): Promise<AlphaMap | null> {
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
  const size = head.getUint32(4, true)
  const count = head.getUint32(8, true)
  if (
    head.getUint32(0, true) !== MAGIC ||
    size <= 0 ||
    count !== size * size ||
    buffer.byteLength !== HEADER_BYTES + count
  ) {
    await cacheDelete(key)
    return null
  }

  const bytes = new Uint8Array(buffer, HEADER_BYTES, count)
  const data = new Float32Array(count)
  for (let i = 0; i < count; i++) data[i] = bytes[i] / 255
  const alpha: AlphaMap = { size, data }
  memory.set(key, alpha)
  return alpha
}
