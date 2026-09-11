import { detect, detectKey, type DetectRequest } from '../../../ai/detect'
import { defaultRefineFor } from '../../../ai/models'
import { isAiGeometry, type AiMaskGeometry, type Edits } from '../../../core/types'
import { useDevelop } from '../../../develop/session'

interface DetectionTarget extends Omit<DetectRequest, 'force'> {
  maskId: string
  componentId: string
}

function geometryFor(edits: Edits, target: DetectionTarget): AiMaskGeometry | null {
  const geometry = edits.masks.find((mask) => mask.id === target.maskId)?.components
    .find((component) => component.id === target.componentId)?.geometry
  return geometry && isAiGeometry(geometry) && geometry.kind === target.kind ? geometry : null
}

function selectModel(geometry: AiMaskGeometry, modelId: DetectionTarget['modelId']) {
  if (geometry.refine === defaultRefineFor(geometry.model)) geometry.refine = defaultRefineFor(modelId)
  geometry.model = modelId
}

/** Commit a replacement only if the photo and original mask are still current. */
export async function runMaskDetection(target: DetectionTarget, detector: typeof detect = detect): Promise<boolean> {
  const session = useDevelop.getState()
  if (session.photoId !== target.photoId) return false
  const original = geometryFor(session.edits, target)
  if (!original) return false
  const key = detectKey(target)
  let expectedKey = original.cacheKey
  let expectedModel = original.model

  if (!original.cacheKey) {
    session.update('masks.ai', 'Detect Mask', (edits) => {
      const geometry = geometryFor(edits, target)
      if (!geometry) return
      selectModel(geometry, target.modelId)
      geometry.cacheKey = key
    })
    expectedKey = key
    expectedModel = target.modelId
  }

  if (!(await detector({ ...target, force: original.cacheKey === key }))) return false
  const current = useDevelop.getState()
  if (current.photoId !== target.photoId) return false
  const geometry = geometryFor(current.edits, target)
  if (!geometry || geometry.model !== expectedModel || geometry.cacheKey !== expectedKey) return false

  current.update('masks.ai', 'Update Detected Mask', (edits) => {
    const next = geometryFor(edits, target)
    if (!next) return
    selectModel(next, target.modelId)
    next.cacheKey = key
  })
  return true
}
