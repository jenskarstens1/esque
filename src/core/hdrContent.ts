/**
 * Whether a *file* actually carries light above SDR white.
 *
 * `hdr.ts` answers what the browser and display can present; this answers
 * whether there is anything to present. Both have to be true before HDR
 * viewing means anything, which is why the toolbar's HDR control only appears
 * for photos that pass this test — a toggle offered over an ordinary sRGB
 * JPEG promises an effect it cannot have.
 *
 * Three things qualify:
 *
 *   gain map     Ultra HDR JPEG, Apple HEIC, ISO 21496-1. A second image
 *                stored alongside the base picture that reconstructs the
 *                highlights. Announced in XMP or in an auxiliary item's URN,
 *                both of which sit in the first few hundred kilobytes.
 *   PQ / HLG     An AVIF, HEIF or PNG whose colour box names an HDR transfer
 *                function outright (transfer characteristic 16 or 18).
 *   RAW          Scene-referred sensor data always holds highlight headroom
 *                above the white point the render maps to, which is exactly
 *                what the Develop viewport expands into.
 *
 * Detection is a byte scan rather than a container parse on purpose: the
 * markers are unambiguous ASCII, and a wrong answer here costs a hidden
 * button, not a broken import.
 */

import type { Photo } from './types'

/** Enough to cover a JPEG's APP segments and a HEIF/AVIF `meta` box. */
const HEAD_BYTES = 512 * 1024

/**
 * Strings that only appear when a gain map is present. Ultra HDR and Adobe
 * both write the `hdrgm:` XMP prefix into the *primary* image, so the base
 * image's own header is enough — the appended gain map never has to be read.
 */
const GAIN_MAP_MARKERS = [
  'hdrgm:',
  'hdr-gain-map',
  'urn:iso:std:iso:ts:21496',
  'urn:com:apple:photo:2020:aux:hdrgainmap',
  'HDRGainMap',
]

/** ITU-T H.273 transfer characteristics that mean HDR: PQ and HLG. */
const HDR_TRANSFER = new Set([16, 18])

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  const last = hay.length - needle.length
  outer: for (let i = from; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

const contains = (hay: Uint8Array, s: string) => indexOfBytes(hay, ascii(s)) !== -1

/**
 * ISOBMFF `colr` box, `nclx` flavour: two bytes each of primaries, transfer
 * and matrix. Every occurrence is checked, because an auxiliary image can
 * carry its own colour box ahead of the one that describes the picture.
 */
function isobmffHdrTransfer(bytes: Uint8Array): boolean {
  const nclx = ascii('nclx')
  for (let i = indexOfBytes(bytes, nclx); i !== -1; i = indexOfBytes(bytes, nclx, i + 1)) {
    const t = (bytes[i + 6] << 8) | bytes[i + 7]
    if (HDR_TRANSFER.has(t)) return true
  }
  return false
}

/** PNG `cICP` chunk: primaries, transfer, matrix, full-range — one byte each. */
function pngHdrTransfer(bytes: Uint8Array): boolean {
  const i = indexOfBytes(bytes, ascii('cICP'))
  return i !== -1 && HDR_TRANSFER.has(bytes[i + 5])
}

/**
 * Reads only as much of the file as the markers can live in. Anything that
 * throws — a file that vanished mid-import, a browser without `slice` on a
 * remote handle — is answered "SDR", the state that promises least.
 */
export async function detectHdrContent(file: File, isRaw: boolean): Promise<boolean> {
  if (isRaw) return true
  try {
    const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()
    const bytes = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer())

    if (GAIN_MAP_MARKERS.some((m) => contains(bytes, m))) return true
    if (ext === 'png') return pngHdrTransfer(bytes)
    if (ext === 'avif' || ext === 'heic' || ext === 'heif') return isobmffHdrTransfer(bytes)
    return false
  } catch {
    return false
  }
}

/**
 * Photos imported before detection existed have no flag. RAW is the honest
 * fallback there — it is HDR by construction — while a rendered file stays
 * SDR until the folder is re-imported and its header is actually read.
 */
export const photoIsHdr = (photo: Pick<Photo, 'hdr' | 'isRaw'>): boolean =>
  photo.hdr ?? photo.isRaw
