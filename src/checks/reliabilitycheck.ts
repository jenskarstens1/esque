import { db } from '../catalog/db'
import Dexie from 'dexie'
import { importFolder } from '../catalog/import'
import { defaultEdits } from '../core/defaults'
import type { Photo } from '../core/types'
import { snapshot } from '../design/toast'
import { createEditSaveQueue, installSaveLifecycle, useDevelop, type EditSaveState } from '../develop/session'
import { useExport } from '../state/exportStore'
import { runCheck } from './checkreport'

const failures: string[] = []
let assertions = 0
const ok = (condition: unknown, message: string) => {
  assertions++
  if (!condition) failures.push(message)
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const edits = (exposure: number) => {
  const next = defaultEdits()
  next.basic.exposure = exposure
  return next
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
async function rejects(promise: Promise<unknown>, message: string) {
  let rejected = false
  try {
    await promise
  } catch {
    rejected = true
  }
  ok(rejected, message)
}

async function queueChecks() {
  const started = deferred()
  const release = deferred()
  const writes: string[] = []
  const states: EditSaveState[] = []
  let active = 0
  let maxActive = 0
  const queue = createEditSaveQueue(async (id, value) => {
    active++
    maxActive = Math.max(maxActive, active)
    writes.push(`${id}:${value.basic.exposure}`)
    if (writes.length === 1) {
      started.resolve()
      await release.promise
    }
    active--
  }, (state) => states.push(state), 0)

  queue.schedule('a', edits(1))
  ok(states.at(-1)?.saveStatus === 'pending', 'a scheduled save must be pending')
  await started.promise
  let flushed = false
  const firstFlush = queue.flush().then(() => { flushed = true })
  await tick()
  ok(!flushed, 'flush returned before the timer-started write committed')
  queue.schedule('a', edits(2))
  queue.schedule('b', edits(3))
  const secondFlush = queue.flush()
  release.resolve()
  await Promise.all([firstFlush, secondFlush])
  ok(writes.join(',') === 'a:1,a:2,b:3', `newer/per-photo edits were lost: ${writes}`)
  ok(maxActive === 1, 'saves overlapped')
  ok(states.at(-1)?.saveStatus === 'saved', 'successful drain was not acknowledged')
  ok(states.at(-1)?.pendingSaveCount === 0, 'acknowledged work remained dirty')

  let failing = true
  const retried: string[] = []
  let last: EditSaveState | undefined
  const retryQueue = createEditSaveQueue(async (id, value) => {
    if (failing) throw new Error('Storage unavailable')
    retried.push(`${id}:${value.basic.exposure}`)
  }, (state) => { last = state })
  retryQueue.schedule('a', edits(1))
  await rejects(retryQueue.flush(), 'an explicit failed flush must reject')
  ok(last?.saveStatus === 'error' && last.pendingSaveCount === 1, 'a failed save was discarded')
  retryQueue.schedule('a', edits(4))
  retryQueue.schedule('b', edits(5))
  ok(retryQueue.peek('a')?.basic.exposure === 4, 'the latest failed edit was not retained')
  ok(last?.pendingSaveCount === 2, 'failed work from another photo was overwritten')
  failing = false
  await retryQueue.flush()
  ok(retried.join(',') === 'a:4,b:5', 'retry did not write the latest versions only')
  ok(last?.saveStatus === 'saved' && !last.saveError, 'retry did not clear the save error')

  const failedInBackground = deferred()
  let backgroundFailure = true
  const background = createEditSaveQueue(async () => {
    if (backgroundFailure) throw new Error('Background write failed')
  }, (state) => {
    if (state.saveStatus === 'error') failedInBackground.resolve()
  }, 0)
  background.schedule('a', edits(6))
  await failedInBackground.promise
  ok(background.peek('a')?.basic.exposure === 6, 'timer failure lost its queued edit')
  backgroundFailure = false
  await background.flush()
}

function photo(id: string, fileHandle?: FileSystemFileHandle): Photo {
  return {
    id,
    folderId: 'reliabilitycheck-folder',
    relPath: `${id}.jpg`,
    filename: `${id}.jpg`,
    ext: 'jpg',
    isRaw: false,
    fileSize: 7,
    modifiedAt: 0,
    addedAt: 0,
    width: 1,
    height: 1,
    meta: {
      cameraMake: '', cameraModel: '', lens: '', iso: 0, shutter: 0,
      aperture: 0, focalLength: 0, captureTime: null, artist: '', copyright: '',
      gps: null, flip: 0, camMul: null, preMul: null, camXyz: null, black: null, maximum: null,
    },
    rating: 0, flag: 'unflagged', label: 'none', keywords: [],
    title: '', caption: '', edits: null, thumbKey: null, proxyKey: null,
    masterId: null, copyName: null, stackId: null, stackPosition: 0, stackCollapsed: false,
    fileHandle: fileHandle ?? null,
  }
}

async function sessionChecks(a: Photo, b: Photo) {
  await useDevelop.getState().load(a)
  const originalUpdate = db.photos.update
  try {
    db.photos.update = () =>
      Dexie.Promise.reject(new DOMException('Test quota exceeded', 'QuotaExceededError'))
    useDevelop.getState().replace('Exposure', edits(1))
    await rejects(useDevelop.getState().flush(), 'store flush swallowed a failed database write')
    ok(useDevelop.getState().saveStatus === 'error', 'store did not expose the save error')
    await useDevelop.getState().load(b)
    useDevelop.getState().replace('Exposure', edits(2))
    await useDevelop.getState().load(a)
    ok(useDevelop.getState().edits.basic.exposure === 1, 'reopening a photo lost its unsaved edit')
    ok(useDevelop.getState().pendingSaveCount === 2, 'switching photos lost failed queued work')
  } finally {
    db.photos.update = originalUpdate
  }
  await useDevelop.getState().retrySave()
  ok((await db.photos.get(a.id))?.edits?.basic.exposure === 1, 'retry did not persist photo A')
  ok((await db.photos.get(b.id))?.edits?.basic.exposure === 2, 'retry did not persist photo B')
  ok(useDevelop.getState().saveStatus === 'saved', 'store stayed failed after successful retry')

  const cleanup = installSaveLifecycle()
  try {
    useDevelop.getState().replace('Exposure', edits(3))
    const dirtyUnload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirtyUnload)
    ok(dirtyUnload.defaultPrevented, 'unacknowledged edits did not guard unload')
    await useDevelop.getState().flush()
    const cleanUnload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(cleanUnload)
    ok(!cleanUnload.defaultPrevented, 'acknowledged edits still blocked unload')
  } finally {
    cleanup()
  }
  useDevelop.getState().replace('Exposure', edits(4))
  await useDevelop.getState().load(null)
  ok((await db.photos.get(a.id))?.edits?.basic.exposure === 4, 'clearing the session did not flush its edits')
}

function destination() {
  const written = new Map<string, Blob>()
  const attempts: string[] = []
  let failSubfolder = false
  let failName: string | null = null
  let beforeWrite: (() => Promise<void>) | null = null
  const handle = {
    name: 'Test output',
    kind: 'directory',
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getDirectoryHandle: async () => {
      if (failSubfolder) throw new DOMException('The subfolder is a file', 'TypeMismatchError')
      return handle
    },
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      if (!options?.create && !written.has(name)) throw new DOMException('Not found', 'NotFoundError')
      return {
        createWritable: async () => {
          let content: Blob
          return {
            write: async (blob: Blob) => {
              attempts.push(name)
              if (beforeWrite) await beforeWrite()
              if (name === failName) throw new Error('Test disk full')
              content = blob
            },
            close: async () => { written.set(name, content) },
          }
        },
      }
    },
  } as unknown as FileSystemDirectoryHandle
  return {
    handle, written, attempts,
    failSubfolder: (value: boolean) => { failSubfolder = value },
    failName: (value: string | null) => { failName = value },
    beforeWrite: (callback: (() => Promise<void>) | null) => { beforeWrite = callback },
  }
}

async function exportChecks(a: Photo, b: Photo) {
  const prepare = (target: FileSystemDirectoryHandle) => {
    useExport.getState().openDialog([a.id, b.id])
    useExport.setState({
      destination: target,
      destinationName: target.name,
      settings: {
        ...useExport.getState().settings,
        format: 'original', writeSidecar: false, subfolder: '',
        filenameTemplate: '{name}-{seq:3}', startNumber: 7, overwrite: 'rename',
      },
    })
  }

  const broken = destination()
  broken.failSubfolder(true)
  prepare(broken.handle)
  useExport.getState().update({ subfolder: 'blocked' })
  const oldNotices = new Set(snapshot().map((notice) => notice.id))
  await useExport.getState().start()
  ok(!useExport.getState().running && useExport.getState().open, 'batch failure closed or stranded the export')
  ok(!!useExport.getState().batchError, 'batch failure has no persistent explanation')
  ok(useExport.getState().jobs.every((job) => job.state === 'failed'), 'batch failure left nonterminal jobs')
  ok(useExport.getState().progress === 0, 'destination failure reported completed progress')
  ok(!snapshot().some((notice) => !oldNotices.has(notice.id) && notice.tone === 'notice' && /exported/.test(notice.message)), 'destination failure announced export success')
  const jobIds = useExport.getState().jobs.map((job) => job.id).join(',')
  useExport.getState().editSettings()
  ok(useExport.getState().editing && useExport.getState().jobs.length === 2, 'correcting settings discarded the receipt')
  useExport.getState().update({ subfolder: '' })
  await useExport.getState().retryFailed()
  ok(useExport.getState().jobs.every((job) => job.state === 'done'), 'retry did not recover destination failure')
  ok(useExport.getState().jobs.map((job) => job.id).join(',') === jobIds, 'retry replaced the batch history')
  ok(broken.written.has(`${a.id}-007.jpg`) && broken.written.has(`${b.id}-008.jpg`), 'retry changed sequence numbers')

  const partial = destination()
  prepare(partial.handle)
  partial.failName(`${b.id}-008.jpg`)
  await useExport.getState().start()
  ok(useExport.getState().jobs.map((job) => job.state).join(',') === 'done,failed', 'partial export did not retain both outcomes')
  partial.failName(null)
  await useExport.getState().retryFailed()
  ok(partial.attempts.filter((name) => name === `${a.id}-007.jpg`).length === 1, 'retry exported a successful photo again')
  ok(partial.written.size === 2, 'partial retry produced duplicate output files')

  const sidecar = destination()
  prepare(sidecar.handle)
  useExport.getState().update({ writeSidecar: true })
  sidecar.failName(`${a.id}-007.xmp`)
  await useExport.getState().start()
  ok(useExport.getState().jobs[0]?.state === 'done' && useExport.getState().jobs[0]?.error?.includes('sidecar'), 'a missing sidecar was silently reported as complete')
  ok(useExport.getState().open && sidecar.written.has(`${a.id}-007.jpg`), 'a sidecar warning hid the successful image or closed its receipt')

  const cancelled = destination()
  const started = deferred()
  const release = deferred()
  cancelled.beforeWrite(async () => { started.resolve(); await release.promise })
  prepare(cancelled.handle)
  const exporting = useExport.getState().start()
  await started.promise
  const ignoredSecondStart = useExport.getState().start()
  useExport.getState().cancel()
  release.resolve()
  await Promise.all([exporting, ignoredSecondStart])
  ok(useExport.getState().jobs.map((job) => job.state).join(',') === 'done,cancelled', 'cancel left queued/running jobs or hid a completed write')
  ok(cancelled.written.size === 1, 'cancel or concurrent start wrote an extra photo')
  ok(useExport.getState().open && !useExport.getState().running, 'cancel did not leave a recoverable receipt')
  cancelled.beforeWrite(null)
  await useExport.getState().retryFailed()
  ok(cancelled.written.size === 2, 'cancelled remainder could not be retried')

  const denied = {
    ...destination().handle,
    queryPermission: async () => 'denied',
    requestPermission: async () => 'denied',
  } as unknown as FileSystemDirectoryHandle
  prepare(denied)
  await useExport.getState().start()
  ok(!!useExport.getState().batchError && !useExport.getState().running, 'permission preflight failure escaped the batch state')
  ok(useExport.getState().open, 'permission denial closed the dialog')

  const unsaved = destination()
  prepare(unsaved.handle)
  const originalFlush = useDevelop.getState().flush
  try {
    useDevelop.setState({ flush: async () => { throw new Error('Storage unavailable') } })
    await useExport.getState().start()
    ok(useExport.getState().batchError?.includes('Edits could not be saved'), 'export did not identify a failed save')
    ok(!unsaved.attempts.length, 'export wrote stale edits after a failed flush')
  } finally {
    useDevelop.setState({ flush: originalFlush })
  }

  prepare(destination().handle)
  useExport.getState().openDialog(['missing-reliability-photo'])
  await useExport.getState().start()
  ok(useExport.getState().jobs[0]?.state === 'failed', 'a deleted photo did not receive a failed outcome')
  ok(useExport.getState().open, 'a deleted selection was reported as a successful empty export')
}

runCheck(async () => {
  // This diagnostic must never run against someone's working catalog.
  if (await db.photos.count() || await db.folders.count()) {
    throw new Error('Run reliabilitycheck in a new isolated browser context with an empty catalog.')
  }
  const root = await navigator.storage.getDirectory()
  const fixtureName = `reliabilitycheck-${crypto.randomUUID()}`
  const fixture = await root.getDirectoryHandle(fixtureName, { create: true })
  const addedFolders: string[] = []
  const photoIds = ['reliabilitycheck-a', 'reliabilitycheck-b']
  const originalExport = useExport.getState()
  const unhandled: string[] = []
  const onUnhandled = (event: PromiseRejectionEvent) => { unhandled.push(String(event.reason)) }
  window.addEventListener('unhandledrejection', onUnhandled)
  try {
    await queueChecks()
    const parentA = await fixture.getDirectoryHandle('a', { create: true })
    const parentB = await fixture.getDirectoryHandle('b', { create: true })
    const folderA = await parentA.getDirectoryHandle('DCIM', { create: true })
    const folderB = await parentB.getDirectoryHandle('DCIM', { create: true })
    const a = await importFolder(folderA)
    addedFolders.push(a.folder.id)
    const b = await importFolder(folderB)
    addedFolders.push(b.folder.id)
    ok(a.folder.id !== b.folder.id, 'distinct same-name folders were merged')
    const storedA = await db.folders.get(a.folder.id)
    ok(await storedA?.handle?.isSameEntry(folderA), 'importing a same-name folder replaced the old handle')
    const again = await importFolder(await parentA.getDirectoryHandle('DCIM'))
    ok(again.folder.id === a.folder.id, 'reimport did not reuse confirmed directory identity')

    const source = await fixture.getFileHandle('source.jpg', { create: true })
    const writer = await source.createWritable()
    await writer.write('fixture')
    await writer.close()
    const first = photo(photoIds[0])
    const second = photo(photoIds[1])
    await db.photos.bulkPut([first, second])
    await sessionChecks(first, second)
    await db.photos.bulkPut([photo(first.id, source), photo(second.id, source)])
    await exportChecks(first, second)
    await tick()
    ok(!unhandled.length, `unhandled save/export rejection: ${unhandled.join('; ')}`)
  } finally {
    window.removeEventListener('unhandledrejection', onUnhandled)
    await useDevelop.getState().flush()
    await useDevelop.getState().load(null)
    useExport.setState(originalExport)
    await db.photos.bulkDelete(photoIds)
    await db.folders.bulkDelete(addedFolders)
    await root.removeEntry(fixtureName, { recursive: true })
  }
  return { pass: failures.length === 0, assertions, failures }
}, { print: true })
