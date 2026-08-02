import { create } from 'zustand'
import { clamp01, nextId } from '../lib/math'
import type { Point2, RedEyeEdit, SpotEdit } from '../core/types'

/**
 * View state for retouching.
 *
 * The spots themselves live in `Edits` — they are part of the photo. What lives
 * here is everything that describes the *tool*: which spot is selected, the
 * size the next one will be created at, and whether the existing ones are
 * being shown. None of it belongs in history and none of it is exported.
 */

export interface RetouchState {
  selectedSpotId: string | null
  selectedEyeId: string | null
  /** Radius, normalised to the image's longer side, for the next spot. */
  spotRadius: number
  spotFeather: number
  spotOpacity: number
  spotMode: SpotEdit['mode']
  eyeRadius: number
  eyeKind: RedEyeEdit['kind']
  eyeDarken: number
  /** Existing spots are drawn as outlines; off while judging the result. */
  showSpots: boolean
  cursor: Point2 | null

  selectSpot: (id: string | null) => void
  selectEye: (id: string | null) => void
  setSpot: (patch: Partial<Pick<RetouchState, 'spotRadius' | 'spotFeather' | 'spotOpacity' | 'spotMode'>>) => void
  setEye: (patch: Partial<Pick<RetouchState, 'eyeRadius' | 'eyeKind' | 'eyeDarken'>>) => void
  toggleSpots: () => void
  setCursor: (p: Point2 | null) => void
  reset: () => void
}

const INITIAL = {
  selectedSpotId: null,
  selectedEyeId: null,
  spotRadius: 0.04,
  spotFeather: 50,
  spotOpacity: 1,
  spotMode: 'heal' as const,
  eyeRadius: 0.03,
  eyeKind: 'human' as const,
  eyeDarken: 50,
  showSpots: true,
  cursor: null,
}

export const useRetouch = create<RetouchState>((set) => ({
  ...INITIAL,
  selectSpot: (selectedSpotId) => set({ selectedSpotId }),
  selectEye: (selectedEyeId) => set({ selectedEyeId }),
  setSpot: (patch) => set(patch),
  setEye: (patch) => set(patch),
  toggleSpots: () => set((s) => ({ showSpots: !s.showSpots })),
  setCursor: (cursor) => set({ cursor }),
  reset: () => set(INITIAL),
}))

/**
 * A source point for a new spot.
 *
 * Lightroom hunts for a clean patch; picking one properly needs the pixels,
 * which the overlay does not have. Offsetting by two and a bit radii along a
 * direction that stays inside the frame is a reasonable first guess, and the
 * user drags it anyway.
 */
export function guessSource(target: Point2, radius: number): Point2 {
  const step = radius * 2.4
  const x = target.x > 0.5 ? target.x - step : target.x + step
  const y = target.y > 0.5 ? target.y - step * 0.35 : target.y + step * 0.35
  return { x: clamp01(x), y: clamp01(y) }
}

export function newSpot(target: Point2, opts: {
  radius: number
  feather: number
  opacity: number
  mode: SpotEdit['mode']
}): SpotEdit {
  return {
    id: nextId(),
    mode: opts.mode,
    target: { ...target },
    source: guessSource(target, opts.radius),
    radius: opts.radius,
    feather: opts.feather,
    opacity: opts.opacity,
  }
}

export function newRedEye(center: Point2, opts: {
  radius: number
  kind: RedEyeEdit['kind']
  darken: number
}): RedEyeEdit {
  return {
    id: nextId(),
    kind: opts.kind,
    center: { ...center },
    radius: opts.radius,
    darken: opts.darken,
  }
}

export const SPOT_MODE_LABELS: Record<SpotEdit['mode'], string> = {
  heal: 'Heal',
  clone: 'Clone',
}

export const EYE_KIND_LABELS: Record<RedEyeEdit['kind'], string> = {
  human: 'Human',
  pet: 'Pet',
}
