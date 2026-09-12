/**
 * HDR gain maps, read out of the files phones actually write.
 *
 * A gain-map JPEG is two pictures in one: an ordinary SDR rendering that any
 * viewer can show, and a second, usually smaller, single-channel image holding
 * the per-pixel ratio back up to the original highlight luminance. Browsers
 * apply it themselves inside an `<img>`, but nothing they expose hands the
 * combined result back as pixels — `createImageBitmap` and a 2D canvas both
 * give the SDR base and drop the map. That is why the Develop viewport used to
 * show an Ultra HDR photo with no range above white at all, whatever the HDR
 * toggle said.
 *
 * So the reconstruction is done here, from the bytes, following the Ultra HDR
 * specification (developer.android.com/media/platform/hdr-image-format):
 *
 *     recovery     = sample / 255
 *     log_recovery = recovery ^ (1 / map_gamma)
 *     log_boost    = min * (1 - log_recovery) + max * log_recovery
 *     HDR          = (SDR + offset_sdr) * 2^(log_boost * w) - offset_hdr
 *
 * with `min`/`max` already in log2 and SDR in **linear** light, not the encoded
 * values — the spec is explicit, and libultrahdr linearises before applying the
 * gain. `w` is the weight the display's own headroom earns; the viewport asks
 * for the full rendition and leaves the limiting to the output pass, which is
 * where every other display decision in this app already lives.
 */

/** Gain map parameters, per channel. A grey map repeats one value three times. */
export interface GainMapMeta {
  /** log2 of the smallest boost the map encodes. */
  min: [number, number, number]
  /** log2 of the largest boost the map encodes. */
  max: [number, number, number]
  gamma: [number, number, number]
  offsetSdr: [number, number, number]
  offsetHdr: [number, number, number]
  hdrCapacityMin: number
  hdrCapacityMax: number
  baseRenditionIsHdr: boolean
}

export interface GainMap {
  /** The secondary JPEG, ready for `createImageBitmap`. */
  bytes: Uint8Array
  meta: GainMapMeta
  /**
   * The two XMP packets verbatim, primary's first.
   *
   * A transcode has to carry these across unchanged. They name the version,
   * the container layout and every gain parameter, and a decoder that finds
   * one of them malformed falls back to the SDR base with no way to say so.
   * Re-deriving them from `meta` would mean re-deriving Adobe's exact RDF
   * shape as well, which is a lot of risk for metadata we already hold.
   */
  primaryXmp: string
  gainXmp: string
}

const XMP_ID = 'http://ns.adobe.com/xap/1.0/'
const HDRGM_NS = 'http://ns.adobe.com/hdr-gain-map/1.0/'

const triple = (v: number): [number, number, number] => [v, v, v]

/**
 * Spec defaults. Only `GainMapMax` and `HDRCapacityMax` are required, so
 * everything else has to have somewhere to fall back to.
 */
const DEFAULTS: GainMapMeta = {
  min: triple(0),
  max: triple(1),
  gamma: triple(1),
  offsetSdr: triple(1 / 64),
  offsetHdr: triple(1 / 64),
  hdrCapacityMin: 0,
  hdrCapacityMax: 1,
  baseRenditionIsHdr: false,
}

// ---------------------------------------------------------------------------
// JPEG structure
// ---------------------------------------------------------------------------

interface Segment {
  marker: number
  /** Offset of the 0xFF that starts the marker. */
  start: number
  /** Payload, excluding the two length bytes. */
  body: Uint8Array
}

interface Scan {
  segments: Segment[]
  /** Offset one past the EOI, or the end of the data if there wasn't one. */
  end: number
}

const SOI = 0xd8
const EOI = 0xd9
const SOS = 0xda
const APP1 = 0xe1
const APP2 = 0xe2

/**
 * Walks one JPEG's marker segments, stopping at its EOI.
 *
 * Entropy-coded scan data is skipped by looking for the next marker that isn't
 * a stuffed byte or a restart, which is the only safe way through: compressed
 * data contains 0xFFD8 pairs often enough that scanning for them naively finds
 * an SOI in the middle of the primary image.
 */
function scanJpeg(bytes: Uint8Array, from = 0): Scan | null {
  if (bytes[from] !== 0xff || bytes[from + 1] !== SOI) return null
  const segments: Segment[] = []
  let i = from + 2

  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xff) {
      i++
      continue
    }
    const marker = bytes[i + 1]
    // Fill bytes, and the standalone markers that carry no payload.
    if (marker === 0xff || marker === 0x00) {
      i++
      continue
    }
    if (marker === EOI) return { segments, end: i + 2 }
    if (marker === SOI || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }

    const length = (bytes[i + 2] << 8) | bytes[i + 3]
    if (length < 2 || i + 2 + length > bytes.length) return null
    segments.push({ marker, start: i, body: bytes.subarray(i + 4, i + 2 + length) })

    if (marker === SOS) {
      // Step over the entropy-coded data to the marker that ends it.
      let j = i + 2 + length
      while (j < bytes.length - 1) {
        if (bytes[j] === 0xff && bytes[j + 1] !== 0x00 && !(bytes[j + 1] >= 0xd0 && bytes[j + 1] <= 0xd7)) break
        j++
      }
      i = j
      continue
    }
    i += 2 + length
  }
  return { segments, end: bytes.length }
}

const latin1 = new TextDecoder('latin1')

/** The XMP packets in a segment list, as strings. */
function xmpPackets(segments: Segment[]): string[] {
  const out: string[] = []
  for (const seg of segments) {
    if (seg.marker !== APP1) continue
    const head = latin1.decode(seg.body.subarray(0, XMP_ID.length))
    if (head !== XMP_ID) continue
    out.push(latin1.decode(seg.body.subarray(XMP_ID.length + 1)))
  }
  return out
}

// ---------------------------------------------------------------------------
// Locating the gain map
// ---------------------------------------------------------------------------

/**
 * The secondary image's byte range from the MPF index.
 *
 * MPF offsets are measured from the first byte of the MP Endian field — the
 * byte straight after the `MPF\0` signature — not from the start of the file
 * and not from the start of the segment. Getting that anchor wrong lands eight
 * bytes into the primary image, which decodes as nothing at all.
 */
function mpfSecondary(bytes: Uint8Array, segments: Segment[]): { start: number; length: number } | null {
  const seg = segments.find(
    (s) => s.marker === APP2 && latin1.decode(s.body.subarray(0, 4)) === 'MPF\0',
  )
  if (!seg) return null

  // start is the 0xFF; +2 marker, +2 length, +4 signature.
  const anchor = seg.start + 8
  const view = new DataView(bytes.buffer, bytes.byteOffset + anchor, bytes.byteLength - anchor)

  const tag = view.getUint16(0, false)
  const little = tag === 0x4949
  if (!little && tag !== 0x4d4d) return null

  const ifdOffset = view.getUint32(4, little)
  if (ifdOffset + 2 > view.byteLength) return null

  const count = view.getUint16(ifdOffset, little)
  let entries = 0
  let entriesOffset = 0
  for (let i = 0; i < count; i++) {
    const entry = ifdOffset + 2 + i * 12
    if (entry + 12 > view.byteLength) return null
    const id = view.getUint16(entry, little)
    if (id === 0xb001) entries = view.getUint32(entry + 8, little)
    if (id === 0xb002) entriesOffset = view.getUint32(entry + 8, little)
  }
  if (entries < 2 || !entriesOffset) return null

  // Entry 0 is the primary, whose offset is required to be 0; entry 1 is the
  // gain map. Its recorded size spans its own SOI through its EOI.
  const entry = entriesOffset + 16
  if (entry + 16 > view.byteLength) return null
  const length = view.getUint32(entry + 4, little)
  const offset = view.getUint32(entry + 8, little)
  if (!offset || !length) return null

  const start = anchor + offset
  if (start + length > bytes.length) return null
  return { start, length }
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/**
 * Reads one `hdrgm` property.
 *
 * Both serialisations are accepted because both are written in the wild: an
 * attribute on `rdf:Description`, which is what the spec's own example uses,
 * and a child element holding an `rdf:Seq` of one or three `rdf:li` values.
 */
function readProperty(xmp: string, name: string): number[] | null {
  const attr = new RegExp(`hdrgm:${name}\\s*=\\s*"([^"]*)"`).exec(xmp)
  if (attr) {
    const value = Number(attr[1])
    return Number.isFinite(value) ? [value] : null
  }

  const element = new RegExp(`<hdrgm:${name}[^>]*>([\\s\\S]*?)</hdrgm:${name}>`).exec(xmp)
  if (!element) return null
  const items = [...element[1].matchAll(/<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/g)].map((m) =>
    Number(m[1].trim()),
  )
  const values = items.filter((v) => Number.isFinite(v))
  return values.length ? values : null
}

/** One value applies to every channel; three are red, green and blue. */
function channels(
  values: number[] | null,
  fallback: [number, number, number],
): [number, number, number] {
  if (!values || !values.length) return fallback
  if (values.length >= 3) return [values[0], values[1], values[2]]
  return triple(values[0])
}

function readMeta(xmp: string): GainMapMeta | null {
  if (!xmp.includes(HDRGM_NS)) return null
  const max = readProperty(xmp, 'GainMapMax')
  const capacityMax = readProperty(xmp, 'HDRCapacityMax')
  // Both are required; without them the file is not conformant and the spec
  // says to ignore the map rather than guess at it.
  if (!max || !capacityMax) return null

  const gamma = channels(readProperty(xmp, 'Gamma'), DEFAULTS.gamma)
  // A zero or negative gamma would divide by zero below.
  if (gamma.some((g) => !(g > 0))) return null

  const isHdr = /hdrgm:BaseRenditionIsHDR\s*=\s*"([^"]*)"/.exec(xmp)?.[1]

  return {
    min: channels(readProperty(xmp, 'GainMapMin'), DEFAULTS.min),
    max: channels(max, DEFAULTS.max),
    gamma,
    offsetSdr: channels(readProperty(xmp, 'OffsetSDR'), DEFAULTS.offsetSdr),
    offsetHdr: channels(readProperty(xmp, 'OffsetHDR'), DEFAULTS.offsetHdr),
    hdrCapacityMin: channels(readProperty(xmp, 'HDRCapacityMin'), triple(0))[0],
    hdrCapacityMax: capacityMax[0],
    baseRenditionIsHdr: /^true$/i.test(isHdr ?? ''),
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Finds a JPEG's gain map, or answers null for the overwhelming majority of
 * files that have none.
 *
 * The cheap test comes first: the primary image has to announce the format in
 * its own XMP. Only then is it worth walking the MPF index, and only then is
 * the SOI fallback worth running for the writers that append a gain map
 * without a usable index.
 */
export function findGainMap(buffer: ArrayBuffer | Uint8Array): GainMap | null {
  try {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
    const primary = scanJpeg(bytes)
    if (!primary) return null
    const primaryXmp = xmpPackets(primary.segments).find((x) => x.includes(HDRGM_NS))
    if (primaryXmp === undefined) return null

    const range = mpfSecondary(bytes, primary.segments)
    const start = range ? range.start : primary.end
    const secondary = scanJpeg(bytes, start)
    if (!secondary) return null
    const end = range ? Math.min(bytes.length, start + range.length) : secondary.end

    for (const gainXmp of xmpPackets(secondary.segments)) {
      const meta = readMeta(gainXmp)
      // v1 files must carry an SDR base; an HDR base would need the map applied
      // in the other direction, and no writer produces one.
      if (meta && !meta.baseRenditionIsHdr) {
        return { bytes: bytes.subarray(start, end), meta, primaryXmp, gainXmp }
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * The weight that reconstructs the *full* HDR rendition.
 *
 * The spec's weight fades the map in as a display's headroom grows, so a panel
 * with none gets the SDR base back. That decision belongs at the end of the
 * pipeline, not at decode: the proxy is cached and shared across displays, and
 * the output pass already limits to the headroom the viewer asked for. So the
 * decode takes the whole map and lets the viewing transform do the limiting.
 */
export const FULL_RENDITION_WEIGHT = 1

/**
 * Per-channel lookup from an 8-bit gain map sample to a linear multiplier.
 *
 * A gain map is applied to every pixel of a full-resolution image, so the
 * `pow` and `exp2` it needs are worth paying for 256 times per channel rather
 * than once per pixel.
 */
export function gainLut(meta: GainMapMeta, weight = FULL_RENDITION_WEIGHT): Float32Array[] {
  return [0, 1, 2].map((c) => {
    const lut = new Float32Array(256)
    const min = meta.min[c]
    const max = meta.max[c]
    const invGamma = 1 / meta.gamma[c]
    for (let i = 0; i < 256; i++) {
      const logRecovery = Math.pow(i / 255, invGamma)
      const logBoost = min * (1 - logRecovery) + max * logRecovery
      lut[i] = Math.pow(2, logBoost * weight)
    }
    return lut
  })
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const MPF_PAYLOAD = 82 // MP header + index IFD + two 16-byte entries
const MPF_SEGMENT = 2 + 2 + 4 + MPF_PAYLOAD // marker, length, "MPF\0", payload
const MPF_ANCHOR = 8 // marker byte to MP Endian base, where offsets are measured

/** Where a rendition's own segments end and its payload begins. */
function afterLeadingApp0(bytes: Uint8Array): number {
  // JFIF requires APP0 to come first, so anything inserted has to follow it.
  if (bytes[2] === 0xff && bytes[3] === 0xe0) {
    return 4 + ((bytes[4] << 8) | bytes[5])
  }
  return 2
}

function app1Xmp(packet: string): Uint8Array {
  const head = `${XMP_ID}\0`
  const body = new Uint8Array(head.length + packet.length)
  for (let i = 0; i < head.length; i++) body[i] = head.charCodeAt(i)
  for (let i = 0; i < packet.length; i++) body[head.length + i] = packet.charCodeAt(i) & 0xff

  const len = body.length + 2
  const out = new Uint8Array(len + 2)
  out[0] = 0xff
  out[1] = APP1
  out[2] = len >> 8
  out[3] = len & 0xff
  out.set(body, 4)
  return out
}

/**
 * The multi-picture index, with room for the offsets but not yet the offsets.
 *
 * They can't be known yet: an entry points at the gain map, which lands after
 * this segment, whose own size moves everything that follows it. Writing the
 * segment at its final size first and patching the numbers in afterwards is
 * what breaks the circle.
 */
function mpfSegment(): Uint8Array {
  const out = new Uint8Array(MPF_SEGMENT)
  const view = new DataView(out.buffer)
  out[0] = 0xff
  out[1] = APP2
  view.setUint16(2, MPF_SEGMENT - 2)
  out.set([0x4d, 0x50, 0x46, 0x00], 4) // "MPF\0"

  // Offsets below are relative to the MP Endian base, which starts here.
  const base = MPF_ANCHOR
  out.set([0x4d, 0x4d, 0x00, 0x2a], base) // "MM\0*", big-endian
  view.setUint32(base + 4, 8) // first IFD follows the 8-byte header

  const ifd = base + 8
  view.setUint16(ifd, 3) // three tags

  view.setUint16(ifd + 2, 0xb000) // MPFVersion
  view.setUint16(ifd + 4, 7) // UNDEFINED
  view.setUint32(ifd + 6, 4)
  out.set([0x30, 0x31, 0x30, 0x30], ifd + 10) // "0100", inline

  view.setUint16(ifd + 14, 0xb001) // NumberOfImages
  view.setUint16(ifd + 16, 4) // LONG
  view.setUint32(ifd + 18, 1)
  view.setUint32(ifd + 22, 2)

  view.setUint16(ifd + 26, 0xb002) // MPEntry
  view.setUint16(ifd + 28, 7) // UNDEFINED
  view.setUint32(ifd + 30, 32) // two entries
  view.setUint32(ifd + 34, 8 + 2 + 36 + 4) // they follow the IFD

  view.setUint32(ifd + 38, 0) // no further IFD
  return out
}

/** Fills in the sizes and offsets once the file has been laid out. */
function patchMpf(file: Uint8Array, mpfAt: number, primarySize: number, gainSize: number): void {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  const entries = mpfAt + MPF_ANCHOR + 8 + 2 + 36 + 4

  // Attributes: the primary is the baseline representative image, the gain map
  // an undefined-type companion — which is what every Ultra HDR writer emits
  // and what decoders match on.
  view.setUint32(entries, 0x00030000)
  view.setUint32(entries + 4, primarySize)
  view.setUint32(entries + 8, 0) // the first image's offset is defined as zero
  view.setUint16(entries + 12, 0)
  view.setUint16(entries + 14, 0)

  view.setUint32(entries + 16, 0x00000000)
  view.setUint32(entries + 20, gainSize)
  view.setUint32(entries + 24, primarySize - (mpfAt + MPF_ANCHOR))
  view.setUint16(entries + 28, 0)
  view.setUint16(entries + 30, 0)
}

/**
 * Rewrites the container's record of how long the gain map is.
 *
 * The primary's XMP carries a GContainer directory naming each rendition and
 * its byte length. Re-encoding changes that length, and a decoder that trusts
 * the stale one reads past the end of the map or stops short of it.
 */
function retargetContainer(xmp: string, gainSize: number): string {
  return xmp.replace(/(Item:Length=")(\d+)(")/g, (all, head, value, tail) =>
    value === '0' ? all : `${head}${gainSize}${tail}`,
  )
}

/**
 * Assembles a smaller Ultra HDR file from re-encoded renditions.
 *
 * Thumbnails are the reason this exists. Handing back the original is the only
 * other way to keep a gain map intact, and a grid of originals is tens of
 * megabytes per screen. Both renditions re-encode like any other JPEG; what
 * cannot be re-derived is the metadata, so the XMP packets are carried across
 * verbatim and only the container's byte offsets are recomputed.
 */
export function packUltraHdr(
  base: Uint8Array,
  gain: Uint8Array,
  primaryXmp: string,
  gainXmp: string,
): Uint8Array | null {
  if (base[0] !== 0xff || base[1] !== SOI || gain[0] !== 0xff || gain[1] !== SOI) return null

  const primaryHead = afterLeadingApp0(base)
  const gainHead = afterLeadingApp0(gain)
  const gainXmpSeg = app1Xmp(gainXmp)
  const gainSize = gain.length + gainXmpSeg.length
  const primaryXmpSeg = app1Xmp(retargetContainer(primaryXmp, gainSize))

  const primarySize = base.length + primaryXmpSeg.length + MPF_SEGMENT
  const file = new Uint8Array(primarySize + gainSize)

  let at = 0
  const put = (part: Uint8Array): void => {
    file.set(part, at)
    at += part.length
  }

  put(base.subarray(0, primaryHead))
  put(primaryXmpSeg)
  const mpfAt = at
  put(mpfSegment())
  put(base.subarray(primaryHead))

  put(gain.subarray(0, gainHead))
  put(gainXmpSeg)
  put(gain.subarray(gainHead))

  patchMpf(file, mpfAt, primarySize, gainSize)
  return file
}
