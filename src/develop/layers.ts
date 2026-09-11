import type {
  Layer,
  LayerBlend,
  LayerContent,
  MaskComponent,
  MaskGeometry,
  MaskBlend,
  Point2,
  Edits,
} from '../core/types'
import { defaultMaskAdjustments, defaultLayerTransform } from '../core/defaults'
import { defaultModelFor, defaultRefineFor } from '../ai/models'

/**
 * Layer bookkeeping: factories, naming, traversal and the mutations the UI
 * performs.
 *
 * All of it is pure — a caller wraps these in `useDevelop.update()` so every
 * change lands in the history stack like any other edit. Geometry is in
 * normalised coordinates over the *framed* photo, which is what the renderer
 * and the on-canvas overlay both expect.
 *
 * Order is paint order: index 0 is the bottom of the stack, the way the
 * renderer walks it. The panel shows the list reversed, because a stack of
 * layers is read from the top.
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

/**
 * The kinds that are actually implemented.
 *
 * Shapes first, then the detected ones, which is the order they are reached
 * for: a gradient is placed without thinking about it, and a subject mask is a
 * decision — it may cost a download, and it is worth a moment's pause. Sky and
 * Objects stay out until there is a model behind them; a kind that appears in
 * the menu and then does nothing is worse than one that is not there yet.
 */
export const MASK_KINDS: Array<MaskGeometry['kind']> = [
  'linear',
  'radial',
  'brush',
  'colorRange',
  'luminanceRange',
  'aiSubject',
  'aiBackground',
  'aiPerson',
]

/** The subset that runs a model, for menus that separate the two. */
export const DETECTED_KINDS: Array<MaskGeometry['kind']> = [
  'aiSubject',
  'aiBackground',
  'aiPerson',
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
    default: {
      // Detected kinds start with no coverage and no key: the model has not
      // run, and until the user asks for it the mask is a declared intention
      // rather than a shape. The tier is recorded now so the panel opens on
      // the one that will actually be used.
      const model = modelForKind(kind)
      return { kind, cacheKey: null, model, refine: defaultRefineFor(model) }
    }
  }
}

/** The default tier for a detected kind, or undefined for the rest. */
function modelForKind(kind: MaskGeometry['kind']): string | undefined {
  if (kind === 'aiSubject' || kind === 'aiBackground' || kind === 'aiPerson') {
    return defaultModelFor(kind)
  }
  return undefined
}

export function newComponent(kind: MaskGeometry['kind'], at?: Point2, blend: MaskBlend = 'add'): MaskComponent {
  return { id: uid(), blend, invert: false, geometry: newGeometry(kind, at) }
}


export const BLEND_MODE_LABELS: Record<LayerBlend, string> = {
  normal: 'Normal',
  multiply: 'Multiply',
  screen: 'Screen',
  overlay: 'Overlay',
  darken: 'Darken',
  lighten: 'Lighten',
  colorDodge: 'Color Dodge',
  colorBurn: 'Color Burn',
  hardLight: 'Hard Light',
  softLight: 'Soft Light',
  difference: 'Difference',
  exclusion: 'Exclusion',
  hue: 'Hue',
  saturation: 'Saturation',
  color: 'Color',
  luminosity: 'Luminosity',
}

/** Grouped for the blend menu, in the order Photoshop and GIMP both use. */
export const BLEND_MODE_GROUPS: Array<Array<LayerBlend>> = [
  ['normal'],
  ['darken', 'multiply', 'colorBurn'],
  ['lighten', 'screen', 'colorDodge'],
  ['overlay', 'softLight', 'hardLight'],
  ['difference', 'exclusion'],
  ['hue', 'saturation', 'color', 'luminosity'],
]

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

/** Every layer in the tree, parents before their children. */
export function flattenLayers(layers: Layer[]): Layer[] {
  const out: Layer[] = []
  const walk = (list: Layer[]) => {
    for (const layer of list) {
      out.push(layer)
      if (layer.children) walk(layer.children)
    }
  }
  walk(layers)
  return out
}

export function findLayer(edits: Edits, id: string | null): Layer | undefined {
  return id ? flattenLayers(edits.layers).find((l) => l.id === id) : undefined
}

/**
 * Rewrites one layer anywhere in the tree, leaving the rest untouched.
 *
 * Returns the same array when nothing matched, so a caller that ran against a
 * stale id does not push an identical state onto the history stack.
 */
export function updateLayer(layers: Layer[], id: string, fn: (layer: Layer) => Layer): Layer[] {
  let changed = false
  const walk = (list: Layer[]): Layer[] => {
    const next = list.map((layer) => {
      if (layer.id === id) {
        changed = true
        return fn(layer)
      }
      if (!layer.children) return layer
      const children = walk(layer.children)
      return children === layer.children ? layer : { ...layer, children }
    })
    return changed ? next : list
  }
  return walk(layers)
}

/** Drops one layer, and with it anything it was holding. */
export function removeLayer(layers: Layer[], id: string): Layer[] {
  const walk = (list: Layer[]): Layer[] =>
    list
      .filter((layer) => layer.id !== id)
      .map((layer) => (layer.children ? { ...layer, children: walk(layer.children) } : layer))
  return walk(layers)
}

/** The group holding `id`, or null when it sits at the top level. */
export function parentOf(layers: Layer[], id: string): Layer | null {
  for (const layer of flattenLayers(layers)) {
    if (layer.children?.some((child) => child.id === id)) return layer
  }
  return null
}

/** The list `id` lives in, in paint order. */
export function siblingsOf(layers: Layer[], id: string): Layer[] {
  return parentOf(layers, id)?.children ?? layers
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/** "Mask 1", "Mask 2", … skipping names already taken anywhere in the tree. */
export function nextLayerName(layers: Layer[], stem = 'Mask'): string {
  const used = new Set(flattenLayers(layers).map((l) => l.name))
  for (let i = 1; ; i++) {
    const name = `${stem} ${i}`
    if (!used.has(name)) return name
  }
}

interface LayerInit {
  name?: string
  content?: LayerContent
  components?: MaskComponent[]
  children?: Layer[] | null
}

/**
 * Fills in everything a layer carries that a mask never did.
 *
 * Used by the v2 → v3 migration, by the sidecar reader and by fixtures: all
 * three have a mask-shaped object in hand and need it to become a layer that
 * renders exactly as it did before, which means normal blend, no clipping and
 * pixels taken from the picture below.
 */
export function withLayerDefaults(partial: Partial<Layer>): Layer {
  return {
    id: partial.id ?? uid(),
    name: partial.name ?? 'Mask',
    visible: partial.visible ?? true,
    inverted: partial.inverted ?? false,
    opacity: partial.opacity ?? 1,
    blend: partial.blend ?? 'normal',
    components: partial.components ?? [],
    content: partial.content ?? { kind: 'adjust' },
    adjustments: partial.adjustments ?? defaultMaskAdjustments(),
    transform: partial.transform ?? defaultLayerTransform(),
    clipped: partial.clipped ?? false,
    children: partial.children ?? null,
    isolate: partial.isolate ?? false,
  }
}

/** A leaf layer at rest: full coverage, normal blend, nothing dialled in. */
export function newLayer(layers: Layer[], init: LayerInit = {}): Layer {
  return {
    id: uid(),
    name: init.name ?? nextLayerName(layers),
    visible: true,
    inverted: false,
    opacity: 1,
    blend: 'normal',
    components: init.components ?? [],
    content: init.content ?? { kind: 'adjust' },
    adjustments: defaultMaskAdjustments(),
    transform: defaultLayerTransform(),
    clipped: false,
    children: init.children ?? null,
    isolate: false,
  }
}

/** An adjustment layer masked by one component — what the mask tools create. */
export function newMaskLayer(layers: Layer[], kind: MaskGeometry['kind'], at?: Point2): Layer {
  return newLayer(layers, { components: [newComponent(kind, at)] })
}

export function newFillLayer(layers: Layer[], color: [number, number, number] = [0, 0, 0]): Layer {
  return newLayer(layers, { name: nextLayerName(layers, 'Fill'), content: { kind: 'fill', color } })
}

export function newImageLayer(
  layers: Layer[],
  source: string,
  width: number,
  height: number,
  name?: string,
): Layer {
  return newLayer(layers, {
    name: name ?? nextLayerName(layers, 'Image'),
    content: { kind: 'image', source, width, height },
  })
}

/** An empty group, or one wrapped around layers that are already there. */
export function newGroup(layers: Layer[], children: Layer[] = []): Layer {
  return newLayer(layers, { name: nextLayerName(layers, 'Group'), children })
}

export function duplicateLayer(layer: Layer, layers: Layer[]): Layer {
  const freshIds = (l: Layer): Layer => ({
    ...structuredClone(l),
    id: uid(),
    components: l.components.map((c) => ({ ...structuredClone(c), id: uid() })),
    children: l.children ? l.children.map(freshIds) : null,
  })
  return { ...freshIds(layer), name: nextLayerName(layers, layer.name.replace(/ \d+$/, '')) }
}

// ---------------------------------------------------------------------------
// Questions the UI asks
// ---------------------------------------------------------------------------

/**
 * True when a layer's mask is drawn but empty, so the UI can flag it.
 *
 * A layer with no components at all is *not* empty: no mask means the whole
 * frame, which is exactly what a fill layer wants.
 */
export function isEmptyLayer(layer: Layer): boolean {
  if (!layer.components.length) return false
  return !layer.components.some((c) =>
    c.geometry.kind === 'brush'
      ? c.geometry.dabs.length > 0
      : c.geometry.kind === 'colorRange'
        ? c.geometry.samples.length > 0
        : true,
  )
}

/** True when a layer's adjustments are all at rest — it shapes nothing yet. */
export function isNeutralLayer(layer: Layer): boolean {
  const a = layer.adjustments
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

/**
 * True when a stack has at least one layer that would change a pixel.
 *
 * The stage can be skipped entirely otherwise, which matters because a layer
 * with no mask covers the whole frame — counting components is not enough to
 * know whether anything is there.
 */
export function layersRender(layers: Layer[]): boolean {
  return layers.some((layer) => {
    if (!layer.visible || layer.opacity <= 0) return false
    if (!layer.components.length && layer.inverted) return false
    if (layer.children) return layersRender(layer.children)
    return !isInertLayer(layer)
  })
}

/** True when a layer would put nothing on screen, whatever its mask says. */
export function isInertLayer(layer: Layer): boolean {
  if (layer.children) return layer.children.every(isInertLayer)
  if (layer.content.kind !== 'adjust') return false
  return layer.blend === 'normal' && isNeutralLayer(layer)
}

/**
 * Clears the cached-alpha pointers on detected masks.
 *
 * A detected mask stores where its alpha was cached, and that cache is keyed by
 * the photo it was computed from. Copying edits onto a different photo without
 * clearing the pointer makes the target render the *source* photo's subject
 * cut-out — a mask of a picture that isn't on screen, with no visible cause.
 * The pointer is dropped rather than repaired: re-detecting is the only way to
 * get an alpha that matches the new frame, and a null key is what asks for it.
 *
 * Apply this to the settings being *transferred*, never to the merged result.
 * The target's own layers are already keyed to the target, and clearing those
 * would make a photo lose coverage it had computed for itself — including when
 * the transfer didn't involve masking at all.
 */
export function detachDetectedAlpha(edits: Edits): Edits {
  const detached = (list: Layer[]): Layer[] =>
    list.map((layer) => ({
      ...layer,
      components: layer.components.map((component) =>
        'cacheKey' in component.geometry
          ? { ...component, geometry: { ...component.geometry, cacheKey: null } }
          : component,
      ),
      children: layer.children ? detached(layer.children) : null,
    }))

  const hasDetected = flattenLayers(edits.layers).some((l) =>
    l.components.some((c) => 'cacheKey' in c.geometry),
  )
  if (!hasDetected) return edits
  return { ...edits, layers: detached(edits.layers) }
}
