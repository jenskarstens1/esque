/**
 * TIFF/EXIF IFD serialiser.
 *
 * TIFF, DNG and EXIF are the same container in three costumes: a header, one or
 * more IFDs, a value block for anything wider than four bytes, and — for real
 * images — a pixel strip at the end. Writing that layout three times in three
 * files is how offsets drift out of sync, so it is written once here and the
 * format-specific modules only decide which tags to put in.
 */

export const IfdType = {
  BYTE: 1,
  ASCII: 2,
  SHORT: 3,
  LONG: 4,
  RATIONAL: 5,
  UNDEFINED: 7,
  SRATIONAL: 10,
} as const
export type IfdType = (typeof IfdType)[keyof typeof IfdType]

const TYPE_SIZE: Record<number, number> = {
  [IfdType.BYTE]: 1,
  [IfdType.ASCII]: 1,
  [IfdType.SHORT]: 2,
  [IfdType.LONG]: 4,
  [IfdType.RATIONAL]: 8,
  [IfdType.UNDEFINED]: 1,
  [IfdType.SRATIONAL]: 8,
}

/**
 * One IFD entry.
 *
 * `value` is the payload in its natural shape: a string for ASCII, raw bytes
 * for UNDEFINED/BYTE blobs, a flat number list otherwise (rationals as
 * numerator/denominator pairs). `subIfd` makes the entry a pointer whose target
 * is laid out and patched automatically.
 */
export interface IfdEntry {
  tag: number
  type: IfdType
  value?: string | number[] | Uint8Array
  subIfd?: IfdEntry[]
  /** Filled in by {@link assembleTiff} for the strip-offset tag. */
  stripOffset?: boolean
}

/**
 * ASCII fields are nominally 7-bit, but names and copyright lines are not.
 * Every reader that matters treats high bytes in these fields as UTF-8, so
 * that is what gets written rather than silently truncating to latin-1.
 */
const utf8 = new TextEncoder()
const asciiLength = (s: string) => utf8.encode(s).length + 1

function entryCount(e: IfdEntry): number {
  if (e.subIfd) return 1
  const v = e.value
  if (typeof v === 'string') return asciiLength(v)
  if (v instanceof Uint8Array) return v.length
  if (!v) return 0
  return e.type === IfdType.RATIONAL || e.type === IfdType.SRATIONAL ? v.length / 2 : v.length
}

const entrySize = (e: IfdEntry) =>
  e.subIfd ? 4 : TYPE_SIZE[e.type] * entryCount(e)

const even = (n: number) => (n % 2 ? n + 1 : n)

/** Bytes an IFD occupies, not counting its value block. */
const ifdSize = (entries: IfdEntry[]) => 2 + entries.length * 12 + 4

/** Bytes the IFD's out-of-line values occupy, each padded to an even offset. */
function valueBlockSize(entries: IfdEntry[]): number {
  let total = 0
  for (const e of entries) {
    const size = entrySize(e)
    if (size > 4) total = even(total) + size
  }
  return total
}

/** An IFD plus every sub-IFD hanging off it. */
/**
 * Sorted, with duplicate tags dropped. A TIFF IFD must list each tag exactly
 * once, in ascending order. The first writer of a tag wins, so a caller's
 * metadata can never displace the structural fields the container depends on.
 */
function prepare(entries: IfdEntry[]): IfdEntry[] {
  const seen = new Set<number>()
  const out: IfdEntry[] = []
  for (const e of entries) {
    if (seen.has(e.tag)) continue
    seen.add(e.tag)
    out.push(e)
  }
  return out.sort((a, b) => a.tag - b.tag)
}

function treeSize(entries: IfdEntry[]): number {
  const list = prepare(entries)
  let total = ifdSize(list) + valueBlockSize(list)
  for (const e of list) {
    if (e.subIfd) total = even(total) + treeSize(e.subIfd)
  }
  return even(total)
}

interface Cursor {
  at: number
}

class Sink {
  readonly bytes: Uint8Array
  private readonly dv: DataView
  private readonly le: boolean

  constructor(size: number, littleEndian: boolean) {
    this.bytes = new Uint8Array(size)
    this.dv = new DataView(this.bytes.buffer)
    this.le = littleEndian
  }

  u16(at: number, v: number) {
    this.dv.setUint16(at, v, this.le)
  }
  u32(at: number, v: number) {
    this.dv.setUint32(at, v >>> 0, this.le)
  }
  i32(at: number, v: number) {
    this.dv.setInt32(at, v | 0, this.le)
  }

  /** Writes one entry's payload at `base`. */
  payload(e: IfdEntry, base: number) {
    const v = e.value
    if (typeof v === 'string') {
      const bytes = utf8.encode(v)
      this.bytes.set(bytes, base)
      this.bytes[base + bytes.length] = 0
      return
    }
    if (v instanceof Uint8Array) {
      this.bytes.set(v, base)
      return
    }
    if (!v) return
    switch (e.type) {
      case IfdType.BYTE:
      case IfdType.UNDEFINED:
      case IfdType.ASCII:
        v.forEach((n, i) => (this.bytes[base + i] = n & 0xff))
        break
      case IfdType.SHORT:
        v.forEach((n, i) => this.u16(base + i * 2, n))
        break
      case IfdType.RATIONAL:
        for (let i = 0; i < v.length / 2; i++) {
          this.u32(base + i * 8, v[i * 2])
          this.u32(base + i * 8 + 4, v[i * 2 + 1])
        }
        break
      case IfdType.SRATIONAL:
        for (let i = 0; i < v.length / 2; i++) {
          this.i32(base + i * 8, v[i * 2])
          this.i32(base + i * 8 + 4, v[i * 2 + 1])
        }
        break
      default:
        v.forEach((n, i) => this.u32(base + i * 4, n))
    }
  }
}

/**
 * Writes one IFD at `at`, its value block straight after, then recurses into
 * any sub-IFDs. `cursor.at` tracks the end of everything written so far.
 */
function writeIfd(
  sink: Sink,
  entries: IfdEntry[],
  at: number,
  cursor: Cursor,
  stripOffset: number,
) {
  const sorted = prepare(entries)
  sink.u16(at, sorted.length)

  let valueAt = at + ifdSize(sorted)
  cursor.at = Math.max(cursor.at, valueAt + valueBlockSize(sorted))

  const pending: Array<{ slot: number; entries: IfdEntry[] }> = []

  sorted.forEach((e, i) => {
    const field = at + 2 + i * 12
    sink.u16(field, e.tag)
    sink.u16(field + 2, e.subIfd ? IfdType.LONG : e.type)
    sink.u32(field + 4, entryCount(e))

    if (e.subIfd) {
      pending.push({ slot: field + 8, entries: e.subIfd })
      return
    }
    if (e.stripOffset) {
      sink.u32(field + 8, stripOffset)
      return
    }
    const size = entrySize(e)
    if (size <= 4) {
      sink.payload(e, field + 8)
    } else {
      valueAt = even(valueAt)
      sink.u32(field + 8, valueAt)
      sink.payload(e, valueAt)
      valueAt += size
    }
  })

  sink.u32(at + 2 + sorted.length * 12, 0) // no next IFD

  for (const sub of pending) {
    const subAt = even(cursor.at)
    sink.u32(sub.slot, subAt)
    cursor.at = subAt
    writeIfd(sink, sub.entries, subAt, cursor, stripOffset)
  }
}

export interface TiffLayout {
  entries: IfdEntry[]
  /**
   * Length of the pixel strip that will follow. The entry marked
   * `stripOffset` is patched with the position it lands at.
   */
  stripLength?: number
  littleEndian?: boolean
  /** 'II'/'MM' + 42 header. EXIF blocks inside JPEG use the same header. */
  header?: boolean
}

/**
 * Serialises the header and every IFD, stopping where the pixel strip starts.
 *
 * Returning only the head lets the caller hand the strip straight to `Blob`
 * without a second copy, which matters when the strip is a few hundred
 * megabytes of 16-bit pixels.
 */
export function assembleTiff({
  entries,
  stripLength = 0,
  littleEndian = true,
  header = true,
}: TiffLayout): Uint8Array {
  const headerSize = header ? 8 : 0
  const bodySize = treeSize(entries)
  const stripAt = stripLength ? even(headerSize + bodySize) : headerSize + bodySize

  const sink = new Sink(stripAt, littleEndian)
  if (header) {
    sink.u16(0, littleEndian ? 0x4949 : 0x4d4d)
    sink.u16(2, 42)
    sink.u32(4, headerSize)
  }

  const cursor: Cursor = { at: headerSize }
  writeIfd(sink, entries, headerSize, cursor, stripAt)
  return sink.bytes
}

// --- entry helpers ----------------------------------------------------------

export const ascii = (tag: number, value: string): IfdEntry => ({
  tag,
  type: IfdType.ASCII,
  value,
})
export const short = (tag: number, ...value: number[]): IfdEntry => ({
  tag,
  type: IfdType.SHORT,
  value,
})
export const long = (tag: number, ...value: number[]): IfdEntry => ({
  tag,
  type: IfdType.LONG,
  value,
})
export const byte = (tag: number, ...value: number[]): IfdEntry => ({
  tag,
  type: IfdType.BYTE,
  value,
})
export const undefinedBytes = (tag: number, value: Uint8Array): IfdEntry => ({
  tag,
  type: IfdType.UNDEFINED,
  value,
})

/**
 * Real number → numerator/denominator.
 *
 * A fixed 1/1000000 denominator keeps colour matrices exact to six places,
 * which is well past what a DNG reader needs; whole numbers and anything large
 * enough to overflow a u32 fall back to coarser denominators.
 */
export function ratioPair(v: number): [number, number] {
  if (!Number.isFinite(v)) return [0, 1]
  if (Number.isInteger(v)) return [v, 1]
  const scale = Math.abs(v) < 2000 ? 1e6 : 1e3
  return [Math.round(v * scale), scale]
}

export const rational = (tag: number, ...values: number[]): IfdEntry => ({
  tag,
  type: IfdType.RATIONAL,
  value: values.flatMap((v) => {
    const [n, d] = ratioPair(Math.max(0, v))
    return [n, d]
  }),
})

export const srational = (tag: number, ...values: number[]): IfdEntry => ({
  tag,
  type: IfdType.SRATIONAL,
  value: values.flatMap((v) => {
    const [n, d] = ratioPair(v)
    return [n, d]
  }),
})
