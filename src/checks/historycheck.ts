import { useDevelop } from '../develop/session'
import { defaultEdits } from '../core/defaults'
import { db } from '../catalog/db'
import type { Photo } from '../core/types'

/*
 * History hygiene check.
 *
 * A history step is worth a row only if jumping to it shows something
 * different. Toggling a control on and then off leaves the photo exactly as it
 * was, so the pair has to collapse instead of stacking two entries that undo
 * each other — otherwise a few idle clicks bury the real work.
 */

declare global {
  interface Window {
    __result?: unknown
    __done?: boolean
  }
}

const failures: string[] = []
const ok = (cond: boolean, m: string) => {
  if (!cond) failures.push(m)
}

const PHOTO_ID = 'historycheck-photo'

function fakePhoto(): Photo {
  return {
    id: PHOTO_ID,
    folderId: 'historycheck-folder',
    relPath: 'historycheck.arw',
    filename: 'historycheck.arw',
    ext: 'arw',
    isRaw: true,
    fileSize: 1,
    modifiedAt: 0,
    addedAt: 0,
    width: 6000,
    height: 4000,
    meta: {
      cameraMake: 'Test',
      cameraModel: 'Test',
      lens: '',
      iso: 200,
      shutter: 0,
      aperture: 0,
      focalLength: 0,
      captureTime: null,
      artist: '',
      copyright: '',
      gps: null,
      flip: 0,
      camMul: null,
      preMul: null,
      camXyz: null,
      black: null,
      maximum: null,
    },
    rating: 0,
    flag: 'unflagged',
    label: 'none',
    keywords: [],
    title: '',
    caption: '',
    edits: null,
    thumbKey: null,
    proxyKey: null,
    masterId: null,
    copyName: null,
    stackId: null,
    stackPosition: 0,
    stackCollapsed: false,
  }
}

const labels = () => useDevelop.getState().history.map((h) => h.label)
const depth = () => useDevelop.getState().history.length

async function run() {
  await db.photos.put(fakePhoto())
  await useDevelop.getState().load(fakePhoto())

  ok(depth() === 1, `opened with ${depth()} steps, expected just Import`)

  const toggleProfile = (v: boolean) =>
    useDevelop.getState().update(
      'lens.enableProfile',
      'Lens Profile',
      (e) => {
        e.lens.enableProfile = v
      },
      false,
    )

  // --- A toggle flicked back is not an edit -------------------------------
  toggleProfile(true)
  ok(depth() === 2, `switching a correction on left ${depth()} steps, expected 2`)
  toggleProfile(false)
  ok(depth() === 1, `switching it back off left ${depth()} steps, expected 1: ${labels()}`)
  ok(
    useDevelop.getState().edits.lens.enableProfile === false,
    'the photo did not follow the collapsed step back',
  )
  ok(useDevelop.getState().historyIndex === 0, 'history selection stayed past the end')

  for (let i = 0; i < 10; i++) toggleProfile(i % 2 === 0)
  ok(depth() === 1, `ten flicks left ${depth()} steps, expected 1`)

  // --- Real work survives, and is still what the toggle returns to --------
  toggleProfile(true)
  ok(depth() === 2, `a correction left on did not stick: ${labels()}`)

  useDevelop.getState().update('basic.exposure', 'Exposure', (e) => {
    e.basic.exposure = 1.2
  })
  ok(depth() === 3, `an exposure move left ${depth()} steps, expected 3`)

  // A slider dragged back to where it started is the same no-op, even though
  // it never coalesces with the step it is cancelling.
  await new Promise((r) => setTimeout(r, 1200))
  useDevelop.getState().update('basic.exposure', 'Exposure', (e) => {
    e.basic.exposure = 0
  })
  ok(depth() === 2, `an exposure move and its reversal left ${depth()} steps: ${labels()}`)
  ok(useDevelop.getState().edits.lens.enableProfile === true, 'the collapse ate the earlier edit')

  // --- Undo still walks the steps that are left --------------------------
  useDevelop.getState().undo()
  ok(useDevelop.getState().edits.lens.enableProfile === false, 'undo did not reach Import')
  useDevelop.getState().redo()
  ok(useDevelop.getState().edits.lens.enableProfile === true, 'redo did not return')

  // --- Resetting an already-default section adds nothing ------------------
  const before = depth()
  useDevelop.getState().resetSection('effects')
  ok(depth() === before, `resetting an untouched panel added a step: ${labels()}`)

  // --- Replace still records a genuine change -----------------------------
  const next = defaultEdits('raw', undefined, 200)
  next.effects.grainAmount = 30
  useDevelop.getState().replace('Grain', next)
  ok(depth() === before + 1, `a real replace was swallowed: ${labels()}`)

  await useDevelop.getState().load(null)
  await db.photos.delete(PHOTO_ID)
}

run()
  .catch((e) => failures.push(`threw: ${String(e)}`))
  .finally(() => {
    window.__result = { pass: failures.length === 0, failures }
    window.__done = true
  })
