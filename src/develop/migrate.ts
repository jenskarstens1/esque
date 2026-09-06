import { EDITS_VERSION, type Edits, type Mask } from '../core/types'

/**
 * Brings a stored edit stack forward to the current `EDITS_VERSION`.
 *
 * Edits outlive the code that made them. A slider whose meaning changes has to
 * be rewritten on the way in, or every picture edited before the change quietly
 * renders as something the photographer never chose — and the further back the
 * catalogue goes, the more of them there are.
 *
 * Migrations run wherever stored edits enter: the catalogue upgrade, an XMP
 * sidecar, a preset, a snapshot, an imported archive. All of them are
 * idempotent, because "has this already run?" is a question a sidecar copied
 * between machines cannot always answer.
 */
export function migrateEdits<T extends Edits>(edits: T, from?: number): T {
  // An edit stack with no version predates the field, which makes it v1.
  const version = from ?? (typeof edits.version === 'number' ? edits.version : 1)
  if (version >= EDITS_VERSION) return edits

  let out = edits
  if (version < 2) out = { ...out, masks: out.masks.map(flipLocalTint) }

  return { ...out, version: EDITS_VERSION }
}

/**
 * The same, for a preset: it carries only the sections it touches.
 *
 * A preset with no `masks` key says nothing about masking and must keep saying
 * nothing, so the absent case returns the object untouched rather than
 * inventing an empty list.
 */
export function migratePartialEdits<T extends Partial<Edits>>(edits: T, from?: number): T {
  const version = from ?? (typeof edits.version === 'number' ? edits.version : 1)
  if (version >= EDITS_VERSION) return edits

  let out = edits
  if (version < 2 && out.masks) out = { ...out, masks: out.masks.map(flipLocalTint) }

  return { ...out, version: EDITS_VERSION }
}

/**
 * v1 → v2: local Tint ran backwards against the global slider.
 *
 * The mask shader tinted green on a positive value while the Basic panel
 * directly above it tinted magenta. Correcting the shader means a value dialled
 * in by eye under the old one now pushes the opposite way, so negating it
 * reproduces exactly the colour that was on screen when it was chosen.
 */
function flipLocalTint(mask: Mask): Mask {
  const tint = mask.adjustments.tint
  if (!tint) return mask
  return { ...mask, adjustments: { ...mask.adjustments, tint: -tint } }
}

/**
 * True when a stored stack still needs work, so a caller can skip the write.
 *
 * The catalogue upgrade walks every photo; most of them will already be current
 * on a catalogue built after the change, and rewriting an unchanged row costs
 * an IndexedDB put for nothing.
 */
export function needsMigration(edits: { version?: number } | null | undefined): boolean {
  if (!edits) return false
  return (typeof edits.version === 'number' ? edits.version : 1) < EDITS_VERSION
}
