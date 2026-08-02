/**
 * Whether an edit section still holds its defaults, for the modified dot on
 * each panel header.
 *
 * Comparison is structural (see `sameEdits`): this runs once per section on
 * every store notification, including every frame of a slider drag.
 *
 * The baseline depends on the file: a RAW's Detail panel starts with calibrated
 * capture sharpening and colour NR, while those controls start at zero on a
 * JPEG. Those RAW values are *not* modified, while the same values on a JPEG
 * mean somebody moved the sliders. One shared baseline made the dot lie on one
 * kind or the other.
 */
import { defaultEdits, rawDetailDefaults, type FileKind } from '../core/defaults'
import type { Edits } from '../core/types'
import { sameEdits } from './equal'

const FALLBACK: Record<FileKind, Edits> = {
  raw: defaultEdits('raw'),
  rendered: defaultEdits('rendered'),
}

export function isSectionModified(
  edits: Edits,
  section: keyof Edits,
  kind: FileKind = 'raw',
  iso = 0,
): boolean {
  const a = (edits as unknown as Record<string, unknown>)[section]
  const b =
    section === 'detail' && kind === 'raw' && iso > 0
      ? rawDetailDefaults(iso)
      : (FALLBACK[kind] as unknown as Record<string, unknown>)[section]
  return !sameEdits(a, b)
}
