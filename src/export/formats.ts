/**
 * Container-format capability probe.
 *
 * Lives on its own so the export dialog can populate its format menu without
 * pulling in the encoders, and so the export worker can answer the same
 * question without a round trip to the main thread.
 */

let cached: Set<string> | null = null

/** Which container formats this browser can actually encode. */
export async function detectFormats(): Promise<Set<string>> {
  if (cached) return cached
  const found = new Set<string>(['tiff', 'dng'])
  const probe = new OffscreenCanvas(2, 2)
  const ctx = probe.getContext('2d')
  ctx?.fillRect(0, 0, 2, 2)
  for (const [format, mime] of [
    ['jpeg', 'image/jpeg'],
    ['png', 'image/png'],
    ['webp', 'image/webp'],
  ] as const) {
    try {
      const blob = await probe.convertToBlob({ type: mime })
      // Chrome silently falls back to PNG for types it cannot encode, so the
      // returned MIME type is the only trustworthy signal.
      if (blob.type === mime) found.add(format)
    } catch {
      /* unsupported */
    }
  }
  cached = found
  return cached
}
