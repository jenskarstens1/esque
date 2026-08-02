/**
 * Where every thumbnail in the grid sits.
 *
 * The grid plans its own geometry rather than leaning on a row virtualiser,
 * because the two layouts disagree about what a row even is: `fill` lays down
 * uniform tiles in tidy rows, `waterfall` drops each frame into whichever
 * column is currently shortest, so a photo's neighbours above and below are
 * not its neighbours in the catalog. One explicit pass gives both the same
 * shape — an absolutely positioned box per photo — which the view can window,
 * scroll to and hit-test without either layout being a special case.
 *
 * The pass is O(n) and only reruns when the width, size or layout changes;
 * 20 000 photos plan in about a millisecond.
 */
import type { Photo } from '../../core/types'
import type { GridLayout } from '../../state/ui'

/** One photo's box in the planned field. */
export interface PlacedPhoto {
  photo: Photo
  index: number
  x: number
  y: number
  width: number
  height: number
}

export interface GridPlan {
  items: PlacedPhoto[]
  /** Total scrollable height, padding included. */
  height: number
  columns: number
  /** Edge of a tile in `fill`, column width in `waterfall`. */
  tile: number
  gap: number
  /** Item indices bucketed by vertical band, for windowing. */
  buckets: number[][]
  band: number
}

/** Breathing room around the whole field. */
export const PAD_X = 16
export const PAD_TOP = 16
/** Extra room under the last row so the count pill never lands on a photo. */
export const PAD_BOTTOM = 44

/** Windowing granularity. Large enough to stay cheap, small enough to be tight. */
const BAND = 400

/**
 * Gap tracks thumbnail size: 6px between 96px tiles is the same optical
 * separation as 14px between 360px ones, and a fixed value reads cramped at
 * one end of the slider and gappy at the other.
 */
export const gridGap = (thumbSize: number) =>
  Math.round(Math.max(6, Math.min(14, thumbSize * 0.06)))

const aspectOf = (p: Photo) => (p.width > 0 && p.height > 0 ? p.width / p.height : 3 / 2)

export function planGrid(
  photos: Photo[],
  width: number,
  thumbSize: number,
  layout: GridLayout,
): GridPlan {
  const gap = gridGap(thumbSize)
  const inner = Math.max(0, width - PAD_X * 2)
  const columns = Math.max(1, Math.round((inner + gap) / (thumbSize + gap)))
  // Tiles absorb the remainder instead of leaving it as slack at the edges, so
  // the field always meets its own margins.
  const tile = columns > 0 ? (inner - gap * (columns - 1)) / columns : inner

  const items: PlacedPhoto[] = new Array(photos.length)
  let height = PAD_TOP

  if (layout === 'fill') {
    const rows = Math.ceil(photos.length / columns)
    for (let i = 0; i < photos.length; i++) {
      const col = i % columns
      const row = (i - col) / columns
      items[i] = {
        photo: photos[i],
        index: i,
        x: PAD_X + col * (tile + gap),
        y: PAD_TOP + row * (tile + gap),
        width: tile,
        height: tile,
      }
    }
    height = PAD_TOP + rows * (tile + gap) - (rows ? gap : 0)
  } else {
    const ends = new Float64Array(columns).fill(PAD_TOP)
    for (let i = 0; i < photos.length; i++) {
      let col = 0
      for (let c = 1; c < columns; c++) if (ends[c] < ends[col]) col = c
      const photo = photos[i]
      // A 21:9 panorama would otherwise be a 40px sliver in a 300px column and
      // a portrait triptych would run off the screen; both stay recognisable
      // within a stop and a half of square.
      const aspect = Math.min(2.6, Math.max(0.5, aspectOf(photo)))
      const h = Math.round(tile / aspect)
      items[i] = { photo, index: i, x: PAD_X + col * (tile + gap), y: ends[col], width: tile, height: h }
      ends[col] += h + gap
    }
    for (let c = 0; c < columns; c++) height = Math.max(height, ends[c] - gap)
  }

  const buckets: number[][] = []
  for (const item of items) {
    const first = Math.floor(item.y / BAND)
    const last = Math.floor((item.y + item.height) / BAND)
    for (let b = first; b <= last; b++) (buckets[b] ??= []).push(item.index)
  }

  return {
    items,
    height: Math.max(0, height) + PAD_BOTTOM,
    columns,
    tile,
    gap,
    buckets,
    band: BAND,
  }
}

/** Everything intersecting `[top, bottom)`, in catalog order. */
export function windowOf(plan: GridPlan, top: number, bottom: number): PlacedPhoto[] {
  const first = Math.max(0, Math.floor(top / plan.band))
  const last = Math.min(plan.buckets.length - 1, Math.floor(bottom / plan.band))
  const seen = new Set<number>()
  const out: PlacedPhoto[] = []
  for (let b = first; b <= last; b++) {
    const bucket = plan.buckets[b]
    if (!bucket) continue
    for (const i of bucket) {
      if (seen.has(i)) continue
      seen.add(i)
      const item = plan.items[i]
      if (item.y < bottom && item.y + item.height > top) out.push(item)
    }
  }
  // Masonry fills columns independently, so bucket order is not catalog order.
  out.sort((a, b) => a.index - b.index)
  return out
}
