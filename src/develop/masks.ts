import type {
  Mask,
  MaskComponent,
  MaskGeometry,
  MaskBlend,
  Point2,
  Edits,
} from '../core/types'
import { defaultMaskAdjustments } from '../core/defaults'

/**
 * Mask bookkeeping: factories, naming and the mutations the UI performs.
 *
 * All of it is pure — a caller wraps these in `useDevelop.update()` so every
 * change lands in the history stack like any other edit. Geometry is in
 * normalised coordinates over the *framed* photo, which is what the renderer
 * and the on-canvas overlay both expect.
 */

const uid = () => Math.random().toString(36).slice(2, 10)

export const MASK_KIND_LABELS: Record<MaskGeometry['kind'], string> = {
  linear: 'Linear Gradient',
  radial: 'Radial Gradient',
  brush: 'Brush',
  colorRange: 'Colour Range',
  luminanceRange: 'Luminance Range',
  aiSubject: 'Subject',
  aiSky: 'Sky',
  aiBackground: 'Background',
  aiPerson: 'People',
  aiObjects: 'Objects',
}

/** The kinds that are actually implemented, in the order Lightroom lists them. */
export const MASK_KINDS: Array<MaskGeometry['kind']> = [
  'linear',
  'radial',
  'brush',
  'colorRange',
  'luminanceRange',
]

export const BLEND_LABELS: Record<MaskBlend, string> = {
  add: 'Add',
  subtract: 'Subtract',
  intersect: 'Intersect',
}

/**
 * A sensible starting shape for each kind.
 *
 * `at` is where the user clicked, so a new gradient or brush starts under the
 * pointer instead of jumping to the middle of the frame.
 */
export function newGeometry(kind: MaskGeometry['kind'], at: Point2 = { x: 0.5, y: 0.5 }): MaskGeometry {
  switch (kind) {
    case 'linear':
      return { kind, start: { x: at.x, y: Math.max(0.05, at.y - 0.18) }, end: { x: at.x, y: Math.min(0.95, at.y + 0.18) } }
    case 'radial':
      return { kind, center: { ...at }, radiusX: 0.22, radiusY: 0.22, rotation: 0, feather: 50 }
    case 'brush':
      return { kind, dabs: [], feather: 50, autoMask: false }
    case 'colorRange':
      return { kind, samples: [], refine: 50 }
    case 'luminanceRange':
      return { kind, range: [0, 0.15, 0.85, 1], smoothness: 50 }
    default:
      return { kind, cacheKey: null, refine: 50 }
  }
}

export function newComponent(kind: MaskGeometry['kind'], at?: Point2, blend: MaskBlend = 'add'): MaskComponent {
  return { id: uid(), blend, invert: false, geometry: newGeometry(kind, at) }
}

/** "Mask 1", "Mask 2", … skipping names already taken. */
export function nextMaskName(masks: Mask[]): string {
  const used = new Set(masks.map((m) => m.name))
  for (let i = 1; ; i++) {
    const name = `Mask ${i}`
    if (!used.has(name)) return name
  }
}

export function newMask(masks: Mask[], kind: MaskGeometry['kind'], at?: Point2): Mask {
  return {
    id: uid(),
    name: nextMaskName(masks),
    visible: true,
    inverted: false,
    opacity: 1,
    components: [newComponent(kind, at)],
    adjustments: defaultMaskAdjustments(),
  }
}

export function duplicateMask(mask: Mask, masks: Mask[]): Mask {
  return {
    ...structuredClone(mask),
    id: uid(),
    name: nextMaskName(masks),
    components: mask.components.map((c) => ({ ...structuredClone(c), id: uid() })),
  }
}

/** True when a mask would render nothing, so the UI can flag it as empty. */
export function isEmptyMask(mask: Mask): boolean {
  return !mask.components.some((c) =>
    c.geometry.kind === 'brush'
      ? c.geometry.dabs.length > 0
      : c.geometry.kind === 'colorRange'
        ? c.geometry.samples.length > 0
        : true,
  )
}

/** True when a mask's adjustments are all at rest — it shapes nothing yet. */
export function isNeutralMask(mask: Mask): boolean {
  const a = mask.adjustments
  const d = defaultMaskAdjustments()
  for (const k of Object.keys(d) as Array<keyof typeof d>) {
    if (k === 'curve') continue
    if (a[k] !== d[k]) return false
  }
  return (
    a.curve.length === d.curve.length &&
    a.curve.every((p, i) => p.x === d.curve[i].x && p.y === d.curve[i].y)
  )
}

export function findMask(edits: Edits, id: string | null): Mask | undefined {
  return id ? edits.masks.find((m) => m.id === id) : undefined
}
