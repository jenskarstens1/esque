import { EDITS_VERSION, type Edits, type Layer } from '../core/types'
import { profileEdits } from '../core/profiles'
import { withLayerDefaults } from './layers'

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

  let out = adoptMasks(edits)
  if (version < 2) out = { ...out, layers: out.layers.map(flipLocalTint) }
  out = expandProfile(out)
  if (version < 5) out = dropLegacyCaptureSharpening(out)

  return { ...out, version: EDITS_VERSION }
}

/**
 * The same, for a preset: it carries only the sections it touches.
 *
 * A preset with no `layers` key says nothing about masking and must keep saying
 * nothing, so the absent case returns the object untouched rather than
 * inventing an empty list.
 */
export function migratePartialEdits<T extends Partial<Edits>>(edits: T, from?: number): T {
  const version = from ?? (typeof edits.version === 'number' ? edits.version : 1)
  if (version >= EDITS_VERSION) return edits

  let out = adoptMasks(edits)
  if (version < 2 && out.layers) out = { ...out, layers: out.layers.map(flipLocalTint) }
  out = expandProfile(out)
  if (version < 5) out = dropLegacyCaptureSharpening(out)

  return { ...out, version: EDITS_VERSION }
}

/**
 * v2 → v3: masks became layers.
 *
 * A layer is a mask that also knows how to blend, clip, hold pixels and carry
 * children. Every field a mask had means the same thing it always did, so the
 * upgrade is a rename plus the defaults that reproduce the old behaviour
 * exactly: normal blend, no clipping, pixels taken from the picture below.
 *
 * Idempotent by shape rather than by version: a stack that already has
 * `layers` is left alone, which is what a sidecar copied between a new machine
 * and an old one needs.
 */
function adoptMasks<T extends { layers?: Layer[] }>(edits: T): T {
  const legacy = (edits as { masks?: unknown }).masks
  if (!Array.isArray(legacy)) return edits
  const { masks: _legacy, ...rest } = edits as T & { masks?: unknown }
  const adopted = legacy
    .filter((mask): mask is Partial<Layer> => !!mask && typeof mask === 'object')
    .map((mask) => withLayerDefaults(mask))
  return { ...(rest as T), layers: edits.layers ?? adopted }
}

/**
 * v1 → v2: local Tint ran backwards against the global slider.
 *
 * The mask shader tinted green on a positive value while the Basic panel
 * directly above it tinted magenta. Correcting the shader means a value dialled
 * in by eye under the old one now pushes the opposite way, so negating it
 * reproduces exactly the colour that was on screen when it was chosen.
 */
function flipLocalTint(mask: Layer): Layer {
  const tint = mask.adjustments.tint
  if (!tint) return mask
  return { ...mask, adjustments: { ...mask.adjustments, tint: -tint } }
}

/**
 * v4 → v5: remove values matching the old capture-sharpening baseline.
 * Stored stacks cannot distinguish defaults from deliberate identical values;
 * this cleanup intentionally resets both. ISO interpolation produced every
 * integer from 30 through 70; masking also varied with ISO.
 */
function dropLegacyCaptureSharpening<T extends Partial<Edits>>(edits: T): T {
  const detail = edits.detail
  if (!detail) return edits
  const amount = detail.sharpenAmount
  if (!Number.isInteger(amount) || amount < 30 || amount > 70) return edits
  if (detail.sharpenRadius !== 1 || detail.sharpenDetail !== 25) return edits
  return { ...edits, detail: { ...detail, sharpenAmount: 0 } }
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

/**
 * v3 to v4: the camera profile became the three values it always stood for.
 *
 * The named bases are unchanged, so an id expands to exactly the rendering it
 * already produced and no stored picture moves. A stack with no profile key
 * says nothing about the base rendering and must keep saying nothing, which is
 * what a preset that never scoped Profile needs.
 *
 * Idempotent by shape rather than by version, for sidecars that travel between
 * a new machine and an old one.
 */
function expandProfile<T extends { profile?: unknown }>(edits: T): T {
  if (edits.profile === undefined) return edits
  if (typeof edits.profile !== 'string') return edits
  return { ...edits, profile: profileEdits(edits.profile) }
}
