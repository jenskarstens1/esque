/**
 * Camera profiles.
 *
 * A RAW file holds scene-linear values with no display rendering. The selected
 * profile supplies the highlight shoulder, base contrast, and saturation intent
 * that map that scene into the bounded creative-working range.
 *
 * The profile is explicit edit state rather than a hidden look. `Neutral`
 * removes the base S-curve and saturation trim while retaining a gentle display
 * shoulder so scene headroom is rendered instead of hard-clipped.
 *
 * Rendered files (JPEG/TIFF/PNG) already carry a look, so the profile stage is
 * skipped for them entirely.
 */

export interface CameraProfile {
  id: string
  name: string
  /**
   * Strength of the filmic S applied in tone space. 0 leaves the transfer
   * curve untouched, which is the flat, maximum-latitude rendering.
   */
  curve: number
  /** Saturation trim baked into the profile, -1..1. */
  saturation: number
  /**
   * Where the RGB-ratio-preserving highlight roll-off starts, in scene light. Lower shoulders
   * compress more of the top end, buying headroom for highlight recovery at
   * the cost of a slightly softer white.
   */
  shoulder: number
}

export const CAMERA_PROFILES: CameraProfile[] = [
  {
    id: 'neutral',
    name: 'Neutral',
    curve: 0,
    saturation: 0,
    shoulder: 0.92,
  },
  {
    id: 'standard',
    name: 'Standard',
    curve: 0.115,
    saturation: 0,
    shoulder: 0.82,
  },
  {
    id: 'portrait',
    name: 'Portrait',
    curve: 0.085,
    saturation: -0.04,
    shoulder: 0.86,
  },
  {
    id: 'landscape',
    name: 'Landscape',
    curve: 0.15,
    saturation: 0.1,
    shoulder: 0.8,
  },
  {
    id: 'vivid',
    name: 'Vivid',
    curve: 0.185,
    saturation: 0.22,
    shoulder: 0.78,
  },
]

const BY_ID = new Map(CAMERA_PROFILES.map((p) => [p.id, p]))

/** Falls back to Standard so an unknown id from an old catalog still renders. */
export function cameraProfile(id: string): CameraProfile {
  return BY_ID.get(id) ?? BY_ID.get('standard')!
}
