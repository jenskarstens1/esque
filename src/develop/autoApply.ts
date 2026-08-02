/**
 * Driving Auto from the UI.
 *
 * The maths in `auto.ts` is deliberately pure — it takes pixels and edits and
 * returns numbers. This is the other half: finding the pixels, deciding which
 * photo the answer belongs to, and putting it somewhere that undoes.
 *
 * A photo open in Develop goes through the session so it lands as one named
 * history step; everything else is written straight to the catalog, which is
 * what makes Auto usable on a whole selection in Library.
 */
import { autoDevelop, autoTone, autoWhiteBalance, applyAuto } from './auto'
import { dropProxy, loadProxy, peekProxy, PROXY_EDGE } from './proxy'
import { useDevelop } from './session'
import { db } from '../catalog/db'
import { saveEdits } from '../catalog/actions'
import { cloneEdits, defaultEdits, editsKind } from '../core/defaults'
import { toast } from '../design/toast'
import type { Edits } from '../core/types'
import type { SourceImage } from '../gpu/renderer'

/**
 * Long edge used when auto has to decode a photo of its own accord.
 *
 * Auto only samples forty thousand pixels, but the RAW still receives the same
 * full-quality native demosaic as Develop and export before this reduction.
 * `maxEdge` limits retained memory; it never selects a cheaper interpolation.
 */
const BATCH_EDGE = 1280

/** Only one auto run at a time; the button and the shortcut share this. */
let inFlight: Promise<unknown> | null = null

async function withProxy<T>(
  photoId: string,
  maxEdge: number,
  fn: (image: SourceImage) => T,
): Promise<T | null> {
  const cached = peekProxy(photoId)
  const proxy = cached ?? (await loadProxy(photoId, maxEdge).catch(() => null))
  if (!proxy) return null
  try {
    return fn(proxy)
  } finally {
    // A proxy decoded only to be measured is smaller than the editing one, so
    // leaving it in the cache would make the next Develop entry decode twice.
    if (!cached && Math.max(proxy.width, proxy.height) < PROXY_EDGE) dropProxy(photoId)
  }
}

type Mode = 'all' | 'tone' | 'wb'

const LABEL: Record<Mode, string> = {
  all: 'Auto Settings',
  tone: 'Auto Tone',
  wb: 'Auto White Balance',
}

/** Applies auto to the photo open in Develop. Returns false if it had nothing to work with. */
export async function autoDevelopCurrent(mode: Mode = 'all'): Promise<boolean> {
  const dev = useDevelop.getState()
  const photoId = dev.photoId
  if (!photoId) return false

  const done = await withProxy(photoId, PROXY_EDGE, (image) => {
    const edits = useDevelop.getState().edits
    if (mode === 'wb') {
      const wb = autoWhiteBalance(image, edits)
      if (!wb) return false
      useDevelop.getState().update(
        'basic.wbMode',
        LABEL.wb,
        (e) => {
          e.basic.wbMode = 'auto'
          e.basic.temp = wb.temp
          e.basic.tint = wb.tint
        },
        false,
      )
      return true
    }

    if (mode === 'tone') {
      const tone = autoTone(image, edits)
      useDevelop.getState().update(
        'basic.autoTone',
        LABEL.tone,
        (e) => {
          Object.assign(e.basic, tone)
        },
        false,
      )
      return true
    }

    const result = autoDevelop(image, edits)
    useDevelop.getState().update('basic.auto', LABEL.all, (e) => applyAuto(e, result), false)
    return true
  })

  return done ?? false
}

/** Applies auto to photos by id, whichever module the user is in. */
export async function autoDevelopPhotos(ids: string[], mode: Mode = 'all'): Promise<number> {
  if (inFlight) return 0
  const run = (async () => {
    const openId = useDevelop.getState().photoId
    let count = 0

    for (const id of ids) {
      if (id === openId) {
        if (await autoDevelopCurrent(mode)) count++
        continue
      }
      const photo = await db.photos.get(id)
      if (!photo) continue
      const edits: Edits = photo.edits
        ? cloneEdits(photo.edits)
        : defaultEdits(editsKind(photo.isRaw), undefined, photo.meta.iso)

      const ok = await withProxy(id, BATCH_EDGE, (image) => {
        if (mode === 'wb') {
          const wb = autoWhiteBalance(image, edits)
          if (!wb) return false
          edits.basic.wbMode = 'auto'
          edits.basic.temp = wb.temp
          edits.basic.tint = wb.tint
          return true
        }
        if (mode === 'tone') {
          Object.assign(edits.basic, autoTone(image, edits))
          return true
        }
        applyAuto(edits, autoDevelop(image, edits))
        return true
      })

      if (!ok) continue
      await saveEdits(id, edits)
      count++
    }
    return count
  })()

  inFlight = run
  try {
    return await run
  } finally {
    inFlight = null
  }
}

/**
 * The command behind the Auto button, the ⌘U shortcut and the menus: applies to
 * the selection when there is one, and reports what happened.
 */
export async function runAuto(ids: string[], mode: Mode = 'all'): Promise<void> {
  if (!ids.length) return
  if (inFlight) return
  const many = ids.length > 1
  if (many) toast.show(`Auto-developing ${ids.length} photos…`)

  const count = await autoDevelopPhotos(ids, mode)
  if (!count) {
    toast.error(
      mode === 'wb' ? "This photo doesn't show enough colour to balance" : 'Auto had nothing to read',
      'The photo may still be decoding, or it may be entirely black.',
    )
    return
  }
  toast.show(many ? `${LABEL[mode]} applied to ${count} photos` : `${LABEL[mode]} applied`)
}

/** True while a run is in progress, so the UI can hold the button. */
export const autoRunning = () => inFlight !== null
