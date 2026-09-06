import { db } from '../catalog/db'
import { parseIccProfile } from '../core/icc'
import { defaultEdits, defaultMaskAdjustments, ALL_SECTIONS } from '../core/defaults'
import { EDITS_VERSION, type Edits, type Mask } from '../core/types'
import { detachDetectedAlpha } from '../develop/masks'
import { migrateEdits, migratePartialEdits, needsMigration } from '../develop/migrate'
import { previewKey } from '../catalog/opfs'
import { parseXmp, editsToSidecar } from '../develop/xmp'
import { Renderer } from '../gpu/renderer'

/*
 * Regression check for the defects found reviewing the readiness fixes.
 *
 * Every one of these got past the existing harnesses, which is the point: they
 * all live on paths nothing exercised. A green suite was not evidence, so each
 * fix gets a test that fails if the old behaviour comes back.
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

// ---------------------------------------------------------------------------
// 1. A pending Develop save must not overwrite freshly imported sidecar edits.
// ---------------------------------------------------------------------------

/**
 * Models the save queue's contract without the develop store around it.
 *
 * The bug was not "pending was never dropped" — it was that `flush` holds the
 * version it is writing on the stack across an await, so dropping the entry
 * mid-write still let the old settings land afterwards. The barrier therefore
 * has to wait for the in-flight write to finish *before* it touches anything.
 */
async function checkSaveBarrier() {
  const { createEditSaveQueue } = await import('../develop/session')

  const store = new Map<string, number>()
  const gate: { release: (() => void) | null; announce: (() => void) | null } = { release: null, announce: null }
  const writeStarted = new Promise<void>((r) => { gate.announce = r })

  const saves = createEditSaveQueue(
    async (photoId, edits) => {
      gate.announce?.()
      // Held open so the barrier is entered while this write is genuinely in
      // flight — the only arrangement in which the bug appears.
      await new Promise<void>((r) => { gate.release = r })
      store.set(photoId, (edits as unknown as { marker: number }).marker)
    },
    () => {},
    0,
  )

  saves.schedule('p1', { marker: 1 } as unknown as Edits)
  await writeStarted

  // A second edit queued behind the one being written.
  saves.schedule('p1', { marker: 2 } as unknown as Edits)

  // The sidecar import: it must be the last thing to touch this photo.
  const barrier = saves.suspend(['p1'], async () => {
    store.set('p1', 99)
  })

  // Let the in-flight write complete. A barrier that did not wait for it has
  // already run `apply`, so this write lands on top and undoes the import.
  await Promise.resolve()
  gate.release?.()
  await barrier
  await saves.flush()

  ok(
    store.get('p1') === 99,
    `save barrier: sidecar value overwritten by a queued save (final marker ${store.get('p1')}, expected 99)`,
  )
}

// ---------------------------------------------------------------------------
// 2. Retired GPU chains survive the frame that replaced them.
// ---------------------------------------------------------------------------

/**
 * A compare view encodes a "before" pane and an "after" pane into one
 * submission, and the two are cropped differently, so the second resizes the
 * chain the first already recorded reads from. Freeing at the resize destroys a
 * texture the submission still references.
 */
let paneTestRan = false

async function checkPaneLifetime() {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  document.body.appendChild(canvas)

  let renderer: Renderer
  try {
    renderer = await Renderer.create(canvas, { presenting: true })
  } catch {
    return  // No WebGPU on this runner; nothing to assert.
  }

  const errors: string[] = []
  const device = (renderer as unknown as { ctx: { device: GPUDevice } }).ctx.device
  device.addEventListener('uncapturederror', (e) => {
    errors.push(String((e as GPUUncapturedErrorEvent).error.message))
  })
  // Dawn reports some of these through the console rather than the event.
  const restoreError = console.error
  const restoreWarn = console.warn
  console.error = (...a: unknown[]) => { errors.push(a.join(' ')); restoreError(...a) }
  console.warn = (...a: unknown[]) => { errors.push(a.join(' ')); restoreWarn(...a) }

  const px = new Uint16Array(128 * 128 * 4).fill(0x3800)
  renderer.setImage({
    width: 128, height: 128, data: px,
    fullWidth: 128, fullHeight: 128, scale: 1, isRaw: false, whiteLevel: 1,
  } as never)
  renderer.setFrame(null)

  // Two panes cropped differently, encoded into one submission. The narrow one
  // resizes the geometry chain the wide one's passes already read from, so a
  // chain freed at the resize is destroyed while still in use.
  // Two panes with *different* non-identity geometry, encoded into one
  // submission. Both need the post-geometry chain and they need it at
  // different sizes, so the second resizes the one the first's passes have
  // already been recorded against. Identity geometry on either side skips the
  // stage entirely and proves nothing.
  const wide = defaultEdits('rendered')
  wide.crop = { ...wide.crop, left: 0.02, right: 0.98, top: 0.02, bottom: 0.98 }
  const narrow = defaultEdits('rendered')
  narrow.crop = { ...narrow.crop, left: 0.25, right: 0.75, top: 0.1, bottom: 0.9 }

  const full = { x: 0, y: 0, width: 128, height: 128 }
  for (let i = 0; i < 3; i++) {
    const drew = renderer.renderPanes([
      { edits: wide, rect: full },
      { edits: narrow, rect: full },
    ] as never)
    paneTestRan ||= drew
    await new Promise((r) => requestAnimationFrame(r))
  }
  await device.queue.onSubmittedWorkDone()
  console.error = restoreError
  console.warn = restoreWarn

  ok(paneTestRan, 'pane lifetime: renderPanes never drew, so this check proved nothing')
  const fatal = errors.find((e) => /destroyed|invalid|error/i.test(e))
  ok(!fatal, `pane lifetime: device error across a two-pane frame — ${fatal ?? ''}`)

  renderer.dispose()
  canvas.remove()
}

// ---------------------------------------------------------------------------
// 3. Detaching AI coverage applies to what is transferred, not to the merge.
// ---------------------------------------------------------------------------

function aiMask(id: string, cacheKey: string | null): Mask {
  return {
    id,
    name: 'Subject',
    visible: true,
    inverted: false,
    opacity: 1,
    components: [{
      id: `${id}-c`,
      blend: 'add',
      invert: false,
      geometry: { kind: 'aiSubject', cacheKey, model: 'subject', refine: 0 },
    }],
    adjustments: defaultMaskAdjustments(),
  } as unknown as Mask
}

const cacheKeyOf = (mask: Mask) =>
  (mask.components[0].geometry as unknown as { cacheKey: string | null }).cacheKey

function checkDetachScope() {
  const source = defaultEdits('raw')
  source.masks = [aiMask('src', 'alpha-src')]

  const detached = detachDetectedAlpha(source)
  ok(cacheKeyOf(detached.masks[0]) === null, 'detach: the transferred settings kept the source photo’s cached coverage')
  ok(cacheKeyOf(source.masks[0]) === 'alpha-src', 'detach: mutated the source instead of copying it')
}

/**
 * The real defect was at the call site, not in the helper: `copyEditsTo`
 * detached the *merged* result, so syncing a look that said nothing about
 * masking still nulled the target's own AI coverage and forced a re-detect.
 */
async function checkCopyEditsScope() {
  const stamp = Date.now()
  const srcId = `sync-src-${stamp}`
  const dstId = `sync-dst-${stamp}`

  const srcEdits = defaultEdits('raw')
  srcEdits.basic.exposure = 1.25
  srcEdits.masks = [aiMask('src', 'alpha-src')]

  const dstEdits = defaultEdits('raw')
  dstEdits.masks = [aiMask('own', 'alpha-own')]

  const row = (id: string, edits: Edits) => ({
    id, folderId: 'f', relPath: `${id}.cr2`, filename: `${id}.cr2`, ext: 'cr2',
    addedAt: stamp, rating: 0, flag: 0, label: '', keywords: [],
    isRaw: true, edits, meta: {}, previewRev: 0,
  })

  await db.photos.bulkAdd([row(srcId, srcEdits), row(dstId, dstEdits)] as never)
  try {
    const { copyEditsTo } = await import('../catalog/actions')

    // A Basic-only sync. Masking is not in scope, so the target's own coverage
    // is none of this transfer's business.
    await copyEditsTo(srcId, [dstId], ['basic'])
    const after = await db.photos.get(dstId)
    ok(
      after?.edits?.basic.exposure === 1.25,
      'copyEditsTo: the selected section was not transferred',
    )
    ok(
      cacheKeyOf(after!.edits!.masks[0]) === 'alpha-own',
      'copyEditsTo: a Basic-only sync dropped the target’s own AI coverage, forcing a needless re-detect',
    )

    // A full sync does carry the masks, and those are the source's — their
    // cached coverage was computed from different pixels and must not follow.
    await copyEditsTo(srcId, [dstId])
    const full = await db.photos.get(dstId)
    ok(
      cacheKeyOf(full!.edits!.masks[0]) === null,
      'copyEditsTo: a full sync carried the source photo’s cached coverage onto another image',
    )
  } finally {
    await db.photos.bulkDelete([srcId, dstId])
  }
}

// ---------------------------------------------------------------------------
// 4. Preview invalidation retires the key, not just the file.
// ---------------------------------------------------------------------------

async function checkPreviewRevision() {
  const id = `revcheck-${Date.now()}`
  await db.photos.add({
    id, folderId: 'f', relPath: 'a.jpg', filename: 'a.jpg', ext: 'jpg',
    addedAt: Date.now(), rating: 0, flag: 0, label: '', keywords: [],
    isRaw: false, edits: null, meta: {}, previewRev: 0,
  } as never)

  try {
    const before = previewKey(id, 0)
    const { invalidateRendered } = await import('../catalog/previews')
    await invalidateRendered(id)

    const row = await db.photos.get(id)
    const after = previewKey(id, row?.previewRev ?? 0)
    ok(after !== before, 'preview revision: the key did not move, so the memoised blob URL survives invalidation')
    ok((row?.previewRev ?? 0) === 1, `preview revision: previewRev is ${row?.previewRev}, expected 1`)
  } finally {
    await db.photos.delete(id)
  }
}

// ---------------------------------------------------------------------------
// 5. An ICC profile with differing per-channel curves decodes per channel.
// ---------------------------------------------------------------------------

/** Minimal matrix/shaper profile with three deliberately different gammas. */
function iccWithCurves(rg: number, gg: number, bg: number): Uint8Array {
  const tags: { sig: string; body: Uint8Array }[] = []
  const xyz = (x: number, y: number, z: number) => {
    const b = new Uint8Array(20)
    const dv = new DataView(b.buffer)
    b.set([0x58, 0x59, 0x5a, 0x20])
    dv.setInt32(8, Math.round(x * 65536))
    dv.setInt32(12, Math.round(y * 65536))
    dv.setInt32(16, Math.round(z * 65536))
    return b
  }
  const curv = (gamma: number) => {
    const b = new Uint8Array(14)
    const dv = new DataView(b.buffer)
    b.set([0x63, 0x75, 0x72, 0x76])
    dv.setUint32(8, 1)
    dv.setUint16(12, Math.round(gamma * 256))
    return b
  }
  tags.push({ sig: 'rXYZ', body: xyz(0.4360, 0.2225, 0.0139) })
  tags.push({ sig: 'gXYZ', body: xyz(0.3851, 0.7169, 0.0971) })
  tags.push({ sig: 'bXYZ', body: xyz(0.1431, 0.0606, 0.7141) })
  tags.push({ sig: 'rTRC', body: curv(rg) })
  tags.push({ sig: 'gTRC', body: curv(gg) })
  tags.push({ sig: 'bTRC', body: curv(bg) })

  const tableSize = 4 + tags.length * 12
  let offset = 128 + tableSize
  const entries: number[][] = []
  for (const t of tags) {
    entries.push([offset, t.body.length])
    offset += t.body.length
  }
  const out = new Uint8Array(offset)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, offset)
  out.set(new TextEncoder().encode('mntrRGB XYZ '), 12)
  dv.setUint32(64, 0)
  dv.setUint32(tableSizeOffset(), tags.length)
  function tableSizeOffset() { return 128 }
  let p = 132
  for (let i = 0; i < tags.length; i++) {
    out.set(new TextEncoder().encode(tags[i].sig), p)
    dv.setUint32(p + 4, entries[i][0])
    dv.setUint32(p + 8, entries[i][1])
    p += 12
  }
  for (let i = 0; i < tags.length; i++) out.set(tags[i].body, entries[i][0])
  return out
}

function checkIccCurves() {
  const profile = parseIccProfile(iccWithCurves(1.8, 2.2, 2.6))
  if (!profile) {
    failures.push('icc: a valid three-curve matrix/shaper profile was rejected')
    return
  }
  ok(Array.isArray(profile.toLinear) && profile.toLinear.length === 3, 'icc: profile exposes fewer than three curves')

  const [r, g, b] = profile.toLinear
  const at = 0.5
  ok(Math.abs(r(at) - Math.pow(at, 1.8)) < 1e-3, 'icc: red channel did not use rTRC')
  ok(Math.abs(g(at) - Math.pow(at, 2.2)) < 1e-3, 'icc: green channel did not use gTRC — the old code applied red to all three')
  ok(Math.abs(b(at) - Math.pow(at, 2.6)) < 1e-3, 'icc: blue channel did not use bTRC')
}

// ---------------------------------------------------------------------------
// 6/7. Tint migration.
// ---------------------------------------------------------------------------

function checkTintMigration() {
  const v1 = defaultEdits('raw')
  v1.version = 1
  v1.masks = [aiMask('m', null)]
  v1.masks[0].adjustments.tint = 30

  ok(needsMigration(v1), 'migration: a v1 stack was not recognised as needing work')

  const v2 = migrateEdits(v1)
  ok(v2.version === EDITS_VERSION, `migration: version is ${v2.version}, expected ${EDITS_VERSION}`)
  ok(v2.masks[0].adjustments.tint === -30, 'migration: local tint was not flipped, so old edits render mirrored')
  ok(v1.masks[0].adjustments.tint === 30, 'migration: mutated the stored object in place')

  // Idempotent: a sidecar copied between machines can be seen twice.
  ok(migrateEdits(v2).masks[0].adjustments.tint === -30, 'migration: running twice flipped the tint back')
  ok(!needsMigration(v2), 'migration: a migrated stack still reports as stale')

  // A preset says nothing about masking unless it carries masks.
  const preset = migratePartialEdits({ version: 1, basic: defaultEdits('raw').basic })
  ok(!('masks' in preset), 'migration: invented a masks list on a preset that had none')
}

/** An XMP written now must declare its version, or it reads back as v1. */
function checkXmpVersion() {
  const e = defaultEdits('raw')
  e.masks = [aiMask('m', null)]
  e.masks[0].adjustments.tint = 20
  const xmp = editsToSidecar(e, ALL_SECTIONS, { filename: 'photo.cr2' })

  ok(/esq:EditVersion="\d+"/.test(xmp), 'xmp: no edit version written, so a future migration cannot tell what the numbers mean')

  const back = parseXmp(xmp)
  ok(
    back?.edits.masks[0]?.adjustments.tint === 20,
    `xmp: a round-trip changed the tint to ${back?.edits.masks[0]?.adjustments.tint} — the sidecar was read as an older version than it was written under`,
  )

  // A sidecar with no version marker is v1 and must be flipped on the way in.
  const legacy = xmp.replace(/ esq:EditVersion="\d+"/, '')
  const old = parseXmp(legacy)
  ok(
    old?.edits.masks[0]?.adjustments.tint === -20,
    'xmp: an unversioned sidecar was not migrated, so pre-fix files render mirrored',
  )
}

// ---------------------------------------------------------------------------

/**
 * The colour-range picker must sample the picture, not the tint drawn over it.
 *
 * `readPixels` reads the finished graph, and the graph ends with the selected
 * mask's overlay. Every pixel the picker is likely to be clicked on is one the
 * mask already covers, so the sample came back as the overlay's own colour —
 * which the mask then narrowed towards, dropping the coverage that produced it.
 */
async function checkPickerSample() {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  document.body.appendChild(canvas)

  let renderer: Renderer
  try {
    renderer = await Renderer.create(canvas, { presenting: true })
  } catch {
    return
  }

  try {
    const px = new Uint16Array(64 * 64 * 4)
    for (let i = 0; i < 64 * 64; i++) {
      px[i * 4] = 0x3555      // half-float ≈ 0.333
      px[i * 4 + 1] = 0x3555
      px[i * 4 + 2] = 0x3555
      px[i * 4 + 3] = 0x3c00
    }
    renderer.setImage({
      width: 64, height: 64, data: px,
      fullWidth: 64, fullHeight: 64, scale: 1, isRaw: false, whiteLevel: 1,
    } as never)
    renderer.setFrame(null)

    const edits = defaultEdits('rendered')
    edits.masks = [{
      id: 'm1', name: 'Gradient', visible: true, inverted: false, opacity: 1,
      components: [{
        id: 'c1', blend: 'add', invert: false,
        geometry: { kind: 'linear', start: { x: 0, y: 0 }, end: { x: 0, y: 1 } },
      }],
      adjustments: defaultMaskAdjustments(),
    } as unknown as Mask]

    const read = async (clean: boolean) => {
      const out = await renderer.readPixels('srgb', 8, { x: 32, y: 40, width: 1, height: 1 }, clean)
      const d = out!.data as Uint8ClampedArray
      return [d[0], d[1], d[2]] as [number, number, number]
    }

    // No overlay at all: the picture as the graph produces it.
    renderer.render(edits, {})
    const plain = await read(false)

    // 'coverage' at full strength replaces the picture with the mask
    // visualisation, so a sample that comes back unchanged can only have come
    // from before the overlay.
    renderer.render(edits, {
      maskOverlay: { maskId: 'm1', mode: 'coverage', tint: [1, 0, 0], amount: 1 },
    })
    const overlaid = await read(false)
    const cleanRead = await read(true)

    const same = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 2)

    ok(!same(plain, overlaid), `picker: the overlay did not change the presented pixel (${overlaid}), so this check proves nothing`)
    ok(
      same(cleanRead, plain),
      `picker: sampled the mask overlay (${cleanRead}) instead of the picture (${plain}) — re-picking a covered pixel would store the tint`,
    )
  } finally {
    renderer.dispose()
    canvas.remove()
  }
}

async function run() {
  await checkSaveBarrier().catch((e) => failures.push(`save barrier threw: ${e}`))
  await checkPaneLifetime().catch((e) => failures.push(`pane lifetime threw: ${e}`))
  await checkPickerSample().catch((e) => failures.push(`picker sample threw: ${e}`))
  checkDetachScope()
  await checkCopyEditsScope().catch((e) => failures.push(`copyEditsTo threw: ${e}`))
  await checkPreviewRevision().catch((e) => failures.push(`preview revision threw: ${e}`))
  checkIccCurves()
  checkTintMigration()
  checkXmpVersion()

  window.__result = { pass: failures.length === 0, failures, paneTestRan }
  window.__done = true
}

void run()
