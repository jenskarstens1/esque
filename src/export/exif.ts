/**
 * EXIF for exported files.
 *
 * Lightroom users expect camera, lens, exposure and copyright to survive an
 * export, and the browser's encoders drop everything. The fields are built once
 * here as plain IFD entries, then serialised by whichever container asked for
 * them: a big-endian APP1 block for JPEG, or a sub-IFD inside the TIFF and DNG
 * writers. The values are whatever esque actually knows, rather than a blind
 * copy of the source file's bytes.
 */
import type { Photo } from '../core/types'
import {
  IfdType,
  ascii,
  assembleTiff,
  long,
  rational,
  short,
  undefinedBytes,
  type IfdEntry,
} from './ifd'
import type { MetadataPolicy, ResolutionUnit } from './types'

const Tag = {
  imageDescription: 0x010e,
  make: 0x010f,
  model: 0x0110,
  orientation: 0x0112,
  xResolution: 0x011a,
  yResolution: 0x011b,
  resolutionUnit: 0x0128,
  software: 0x0131,
  dateTime: 0x0132,
  artist: 0x013b,
  copyright: 0x8298,
  exifIfd: 0x8769,
  gpsIfd: 0x8825,
} as const

export const EXIF_IFD_TAG = Tag.exifIfd
export const GPS_IFD_TAG = Tag.gpsIfd

/** ResolutionUnit tag values: 2 = inch, 3 = centimetre. */
export const resolutionUnitCode = (unit: ResolutionUnit) => (unit === 'cm' ? 3 : 2)

const exifDate = (ms: number) => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export interface ExifInput {
  photo: Photo
  width: number
  height: number
  policy: MetadataPolicy
  removeLocation: boolean
  /** 1 = sRGB, 65535 = uncalibrated (anything with an embedded profile). */
  srgb: boolean
  resolution: number
  resolutionUnit: ResolutionUnit
  software: string
}

interface Policy {
  /** Camera body, lens and exposure values. */
  camera: boolean
  /** Title, caption, keywords, rating, label and the capture date. */
  descriptive: boolean
  /** GPS coordinates. */
  location: boolean
  /** Creator and contact details. */
  contact: boolean
  /** The copyright notice itself. */
  copyright: boolean
}

/**
 * Mirrors Lightroom's Include menu: each step down the list drops a further
 * layer, until only the copyright notice survives.
 */
export function policyFlags(policy: MetadataPolicy): Policy {
  switch (policy) {
    case 'all':
      return { camera: true, descriptive: true, location: true, contact: true, copyright: true }
    case 'noCamera':
      return { camera: false, descriptive: true, location: true, contact: true, copyright: true }
    case 'copyrightContact':
      return { camera: false, descriptive: false, location: false, contact: true, copyright: true }
    case 'copyrightOnly':
      return { camera: false, descriptive: false, location: false, contact: false, copyright: true }
    case 'none':
      return {
        camera: false,
        descriptive: false,
        location: false,
        contact: false,
        copyright: false,
      }
  }
}

/** IFD0's descriptive tags — the ones a container does not own itself. */
export function descriptiveFields(input: ExifInput): IfdEntry[] {
  const { photo, policy } = input
  const flags = policyFlags(policy)
  if (policy === 'none') return []

  const m = photo.meta
  const out: IfdEntry[] = []
  if (flags.camera) {
    if (m.cameraMake) out.push(ascii(Tag.make, m.cameraMake))
    if (m.cameraModel) out.push(ascii(Tag.model, m.cameraModel))
  }
  if (flags.descriptive && photo.title) out.push(ascii(Tag.imageDescription, photo.title))
  if (flags.contact && m.artist) out.push(ascii(Tag.artist, m.artist))
  if (flags.copyright && m.copyright) out.push(ascii(Tag.copyright, m.copyright))
  if (flags.descriptive && m.captureTime) out.push(ascii(Tag.dateTime, exifDate(m.captureTime)))
  return out
}

/** The EXIF sub-IFD's own fields. */
export function exifFields(input: ExifInput): IfdEntry[] {
  const { photo, policy } = input
  if (policy === 'none') return []
  const flags = policyFlags(policy)
  const m = photo.meta

  const out: IfdEntry[] = [
    long(0xa002, input.width),
    long(0xa003, input.height),
    short(0xa001, input.srgb ? 1 : 0xffff),
    undefinedBytes(0x9000, new Uint8Array([0x30, 0x32, 0x33, 0x30])),
  ]
  if (!flags.camera) {
    // The capture date is descriptive rather than technical, so it survives
    // "except camera info" even though the exposure values do not.
    if (flags.descriptive && m.captureTime) {
      out.push(ascii(0x9003, exifDate(m.captureTime)))
      out.push(ascii(0x9004, exifDate(m.captureTime)))
    }
    return out
  }

  if (m.captureTime) {
    out.push(ascii(0x9003, exifDate(m.captureTime)))
    out.push(ascii(0x9004, exifDate(m.captureTime)))
  }
  if (m.shutter > 0) out.push(rational(0x829a, m.shutter))
  if (m.aperture > 0) out.push(rational(0x829d, m.aperture))
  if (m.iso > 0) out.push(short(0x8827, Math.min(65535, Math.round(m.iso))))
  if (m.focalLength > 0) out.push(rational(0x920a, m.focalLength))
  if (m.lens) out.push(ascii(0xa434, m.lens))
  return out
}

/** The GPS sub-IFD, or an empty list when location is stripped or absent. */
export function gpsFields(input: ExifInput): IfdEntry[] {
  const m = input.photo.meta
  const flags = policyFlags(input.policy)
  if (!flags.location || input.removeLocation || !m.gps) return []

  const sexagesimal = (v: number): number[] => {
    const a = Math.abs(v)
    const d = Math.floor(a)
    const mm = Math.floor((a - d) * 60)
    const s = Math.round((a - d - mm / 60) * 3600 * 1000)
    return [d, 1, mm, 1, s, 1000]
  }

  const out: IfdEntry[] = [
    undefinedBytes(0x0000, new Uint8Array([2, 3, 0, 0])),
    ascii(0x0001, m.gps.lat >= 0 ? 'N' : 'S'),
    { tag: 0x0002, type: IfdType.RATIONAL, value: sexagesimal(m.gps.lat) },
    ascii(0x0003, m.gps.lon >= 0 ? 'E' : 'W'),
    { tag: 0x0004, type: IfdType.RATIONAL, value: sexagesimal(m.gps.lon) },
  ]
  if (m.gps.alt) {
    out.push(undefinedBytes(0x0005, new Uint8Array([m.gps.alt < 0 ? 1 : 0])))
    out.push(rational(0x0006, Math.abs(m.gps.alt)))
  }
  return out
}

/**
 * IFD0 for a TIFF-family container: descriptive tags plus the EXIF and GPS
 * sub-IFD pointers. The caller adds its own structural tags.
 */
export function metadataIfdEntries(input: ExifInput): IfdEntry[] {
  if (input.policy === 'none') return []
  const out = descriptiveFields(input)
  const exif = exifFields(input)
  const gps = gpsFields(input)
  if (exif.length) out.push({ tag: Tag.exifIfd, type: IfdType.LONG, subIfd: exif })
  if (gps.length) out.push({ tag: Tag.gpsIfd, type: IfdType.LONG, subIfd: gps })
  return out
}

/** Builds the APP1 segment, or null when the policy asks for no metadata. */
export function buildExifApp1(input: ExifInput): Uint8Array | null {
  if (input.policy === 'none') return null

  const ifd0: IfdEntry[] = [
    // Pixels are already rotated on export, so orientation is always normal.
    short(Tag.orientation, 1),
    rational(Tag.xResolution, Math.round(input.resolution)),
    rational(Tag.yResolution, Math.round(input.resolution)),
    short(Tag.resolutionUnit, resolutionUnitCode(input.resolutionUnit)),
    ascii(Tag.software, input.software),
    ...metadataIfdEntries(input),
  ]

  // EXIF inside JPEG is conventionally big-endian, and enough readers assume it
  // that writing 'II' here is not worth the compatibility risk.
  const tiff = assembleTiff({ entries: ifd0, littleEndian: false })

  const header = 'Exif\0\0'
  const length = tiff.length + header.length + 2
  const seg = new Uint8Array(length + 2)
  seg[0] = 0xff
  seg[1] = 0xe1
  seg[2] = length >> 8
  seg[3] = length & 0xff
  for (let i = 0; i < header.length; i++) seg[4 + i] = header.charCodeAt(i)
  seg.set(tiff, 4 + header.length)
  return seg
}
