/**
 * Camera profiles.
 *
 * A RAW file holds scene-linear values with no display rendering. The selected
 * profile supplies the highlight shoulder, base contrast, and saturation intent
 * that map that scene into the bounded creative-working range.
 *
 * The profile is explicit edit state rather than a hidden look, and it is
 * explicit in the panel too: the dropdown only picks the three values, all
 * three are on sliders, and moving one flips the name to Custom. That is the
 * same bargain White balance makes one row below, and for the same reason — a
 * named base that changed the picture without moving anything on screen was
 * indistinguishable from a hidden look however it was documented.
 *
 * `Neutral` removes the base S-curve and saturation trim while retaining a
 * gentle display shoulder so scene headroom is rendered instead of hard-clipped.
 *
 * Rendered files (JPEG/TIFF/PNG) already carry a look, so the profile stage is
 * skipped for them entirely.
 */

import type { ProfileEdits } from './types'

export interface CameraProfile {
  id: string
  name: string
  /**
   * How far below scene white the RGB-ratio-preserving highlight roll-off
   * starts, in percent. Rolling off earlier compresses more of the top end,
   * buying headroom for highlight recovery at the cost of a slightly softer
   * white.
   */
  rolloff: number
  /**
   * Strength of the filmic S applied in tone space. 0 leaves the transfer
   * curve untouched, which is the flat, maximum-latitude rendering.
   */
  contrast: number
  /** Saturation trim baked into the profile. */
  saturation: number
}

/**
 * The named bases.
 *
 * Values are in the units the sliders show, not the units the shader wants, so
 * that what a profile does can be read off the panel and typed back in by hand.
 * Every named base lands on whole numbers on all three.
 */
export const CAMERA_PROFILES: CameraProfile[] = [
  { id: 'neutral', name: 'Neutral', rolloff: 8, contrast: 0, saturation: 0 },
  { id: 'standard', name: 'Standard', rolloff: 18, contrast: 46, saturation: 0 },
  { id: 'portrait', name: 'Portrait', rolloff: 14, contrast: 34, saturation: -4 },
  { id: 'landscape', name: 'Landscape', rolloff: 20, contrast: 60, saturation: 10 },
  { id: 'vivid', name: 'Vivid', rolloff: 22, contrast: 74, saturation: 22 },
]

/** What the name reads as once the values no longer match any named base. */
export const CUSTOM_PROFILE = 'custom'

export const PROFILE_LIMITS = {
  rolloff: { min: 0, max: 40 },
  contrast: { min: 0, max: 100 },
  saturation: { min: -100, max: 100 },
} as const

const BY_ID = new Map(CAMERA_PROFILES.map((p) => [p.id, p]))

/** Falls back to Standard so an unknown id from an old catalog still renders. */
export function cameraProfile(id: string): CameraProfile {
  return BY_ID.get(id) ?? BY_ID.get('standard')!
}

/** The edit state for a named base, ready to drop into `Edits.profile`. */
export function profileEdits(id: string): ProfileEdits {
  const p = cameraProfile(id)
  return { name: p.id, rolloff: p.rolloff, contrast: p.contrast, saturation: p.saturation }
}

/**
 * The name for a set of values: the named base if they still match one exactly,
 * otherwise Custom.
 *
 * Run after every slider change, so dragging Base contrast back to where
 * Landscape left it says Landscape again rather than stranding the photo on
 * Custom. This is how the White balance dropdown already behaves.
 */
export function profileName(p: Omit<ProfileEdits, 'name'>): string {
  const match = CAMERA_PROFILES.find(
    (c) => c.rolloff === p.rolloff && c.contrast === p.contrast && c.saturation === p.saturation,
  )
  return match ? match.id : CUSTOM_PROFILE
}

/** What the profile is called in the UI, including the Custom case. */
export function profileLabel(p: ProfileEdits): string {
  return p.name === CUSTOM_PROFILE ? 'Custom' : cameraProfile(p.name).name
}

/** The three values the tone chain actually wants. */
export interface ProfileRender {
  /** Filmic S strength in tone space. */
  curve: number
  /** Saturation trim, -1..1. */
  saturation: number
  /** Scene-linear highlight knee. */
  shoulder: number
}

/** The stage is skipped for files that already carry a look. */
export const NO_PROFILE: ProfileRender = { curve: 0, saturation: 0, shoulder: 1 }

/**
 * Slider units to shader units.
 *
 * The divisors are the whole of the mapping, chosen so the named bases come out
 * on round slider numbers: contrast 46 is a 0.115 curve, roll-off 18 is a 0.82
 * shoulder.
 */
export function profileRender(p: ProfileEdits, isRaw = true): ProfileRender {
  if (!isRaw) return NO_PROFILE
  return {
    curve: p.contrast / 400,
    saturation: p.saturation / 100,
    shoulder: 1 - p.rolloff / 100,
  }
}
