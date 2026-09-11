import type { Photo } from '../core/types'
import type { ExportSettings, ResizeMode } from './types'

/** Filename without its extension. */
export const stem = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

const pad = (n: number, width: number) => String(n).padStart(width, '0')

function formattedDate(date: Date, pattern?: string) {
  if (!pattern) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`
  }
  return pattern
    .replace(/YYYY/g, String(date.getFullYear()))
    .replace(/MM/g, pad(date.getMonth() + 1, 2))
    .replace(/DD/g, pad(date.getDate(), 2))
    .replace(/HH/g, pad(date.getHours(), 2))
    .replace(/mm/g, pad(date.getMinutes(), 2))
    .replace(/ss/g, pad(date.getSeconds(), 2))
}

function shutterLabel(value: number) {
  if (!value) return ''
  return value >= 1 ? `${value}s` : `1-${Math.round(1 / value)}`
}

function templateValues(
  photo: Photo,
  sequence: number,
  custom: string,
  date: Date,
  argument?: string,
): Record<string, () => string> {
  return {
    name: () => stem(photo.filename),
    original: () => stem(photo.filename),
    seq: () => pad(sequence, argument ? Number(argument) || 1 : 1),
    sequence: () => pad(sequence, argument ? Number(argument) || 1 : 1),
    date: () => formattedDate(date, argument),
    camera: () => photo.meta.cameraModel || photo.meta.cameraMake || '',
    lens: () => photo.meta.lens || '',
    iso: () => photo.meta.iso ? String(photo.meta.iso) : '',
    shutter: () => shutterLabel(photo.meta.shutter),
    aperture: () => photo.meta.aperture ? `f${photo.meta.aperture}` : '',
    title: () => photo.title || stem(photo.filename),
    custom: () => custom,
    customtext: () => custom,
  }
}

/**
 * Expands a filename template.
 *
 * Tokens: {name} {seq} {seq:3} {date} {date:YYYY-MM-DD} {camera} {lens} {iso}
 * {shutter} {aperture} {title} {custom}. Unknown tokens are left alone rather
 * than silently deleted, so a typo is visible instead of mysterious.
 */
export function expandTemplate(
  template: string,
  photo: Photo,
  sequence: number,
  custom = '',
): string {
  const when = new Date(photo.meta.captureTime ?? photo.modifiedAt)

  const out = template.replace(/\{([a-zA-Z]+)(?::([^}]+))?\}/g, (all, key: string, arg?: string) => {
    const value = templateValues(photo, sequence, custom, when, arg)[key.toLowerCase()]
    return value ? value() : all
  })

  const safe = out.replace(/[/\\:*?"<>|]/g, '-').trim()
  return safe || stem(photo.filename)
}

/** Works out the exported pixel dimensions for the chosen resize mode. */
export function targetSize(
  width: number,
  height: number,
  s: Pick<
    ExportSettings,
    | 'resizeMode'
    | 'resizeWidth'
    | 'resizeHeight'
    | 'resizeLongEdge'
    | 'resizeShortEdge'
    | 'megapixels'
    | 'resizePercent'
    | 'dontEnlarge'
  >,
): { width: number; height: number } {
  const mode: ResizeMode = s.resizeMode
  if (mode === 'none' || width <= 0 || height <= 0) return { width, height }

  const aspect = width / height
  const long = Math.max(width, height)
  const short = Math.min(width, height)
  let scale = 1

  switch (mode) {
    case 'longEdge':
      scale = s.resizeLongEdge / long
      break
    case 'shortEdge':
      scale = s.resizeShortEdge / short
      break
    case 'width':
      scale = s.resizeWidth / width
      break
    case 'height':
      scale = s.resizeHeight / height
      break
    case 'fit':
      scale = Math.min(s.resizeWidth / width, s.resizeHeight / height)
      break
    case 'megapixels':
      scale = Math.sqrt((s.megapixels * 1e6) / (width * height))
      break
    case 'percent':
      scale = s.resizePercent / 100
      break
  }

  if (s.dontEnlarge) scale = Math.min(1, scale)
  if (!isFinite(scale) || scale <= 0) return { width, height }

  const w = Math.max(1, Math.round(width * scale))
  // Recomputing height from the aspect ratio avoids a one-pixel drift that
  // would otherwise show up as a sliver of stretched detail.
  const h = Math.max(1, Math.round(w / aspect))
  return { width: w, height: h }
}

/** Rough output size, good enough for a live estimate in the dialog. */
export function estimateBytes(
  width: number,
  height: number,
  s: Pick<ExportSettings, 'format' | 'quality' | 'bitDepth' | 'compress' | 'limitSize' | 'limitSizeKb'>,
): number {
  const px = width * height
  const raw = (() => {
    switch (s.format) {
      case 'jpeg': {
        // Empirical: ~0.09 bytes/px at q50 rising to ~0.55 at q100.
        const q = s.quality / 100
        return Math.round(px * (0.05 + q * q * 0.55))
      }
      case 'webp': {
        const q = s.quality / 100
        return Math.round(px * (0.03 + q * q * 0.36))
      }
      case 'png':
        return Math.round(px * 1.7)
      case 'tiff': {
        const bytes = px * 3 * (s.bitDepth === 16 ? 2 : 1)
        return Math.round(s.compress ? bytes * 0.62 : bytes)
      }
      case 'dng':
        // Uncompressed 16-bit RGB, so the size is exact rather than estimated.
        return px * 6
      default:
        return px * 2
    }
  })()

  const capped =
    s.limitSize && (s.format === 'jpeg' || s.format === 'webp')
      ? Math.min(raw, s.limitSizeKb * 1024)
      : raw
  return capped
}

/** Applies the extension-case preference. */
export const withExtension = (
  name: string,
  ext: string,
  extensionCase: ExportSettings['extensionCase'],
) => `${name}.${extensionCase === 'upper' ? ext.toUpperCase() : ext.toLowerCase()}`
