import type { ColorLabel, Photo, PickFlag } from '../core/types'

type Marks = Pick<Photo, 'rating' | 'label' | 'flag'>

export interface SelectionValues {
  rating: number | null
  label: ColorLabel | null
  flag: PickFlag | null
}

/** Null means mixed, not unset: choosing a value must assign it to everyone. */
export function selectionValues(photos: readonly Marks[]): SelectionValues {
  const first = photos[0]
  return {
    rating: photos.every((p) => p.rating === first?.rating) ? (first?.rating ?? 0) : null,
    label: photos.every((p) => p.label === first?.label) ? (first?.label ?? 'none') : null,
    flag: photos.every((p) => p.flag === first?.flag) ? (first?.flag ?? 'unflagged') : null,
  }
}
