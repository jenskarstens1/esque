import Dexie, { type EntityTable } from 'dexie'
import { db, type BinaryCacheEntry, type CacheMetadata } from '../catalog/db'
import { createBinaryCache, opfsSupported } from '../catalog/cache'
import { prepareOriginal } from '../catalog/originals'
import { cacheBudget, cacheDelete, cacheRead, cacheWrite, proxyKey } from '../catalog/opfs'
import { requestStorageProtection, storageProtection } from '../catalog/storage'
import type { Photo } from '../core/types'
import { clearProxies, loadProxy, proxyIsReady, type Proxy } from '../develop/proxy'
import { hasProxyCache, readProxyCache, writeProxyCache } from '../develop/proxyCache'
import { rawPool } from '../raw/pool'
import { useUI } from '../state/ui'
import { runCheck } from './checkreport'

const failures: string[] = []
let assertions = 0
const ok = (condition: unknown, message: string) => {
  assertions++
  if (!condition) failures.push(message)
}
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 20))
const sessionKey = 'esque-cachecheck'
interface ReloadState {
  id: string
  assertions: number
  failures: string[]
  coldDecodes: number
  previewQuality: ReturnType<typeof useUI.getState>['previewQuality']
}

function photo(id: string): Photo {
  return {
    id, folderId: id, relPath: 'original.raf', filename: 'original.raf', ext: 'raf',
    isRaw: true, fileSize: 32, modifiedAt: 12345, addedAt: 0, width: 3200, height: 32,
    meta: {
      cameraMake: '', cameraModel: '', lens: '', iso: 0, shutter: 0,
      aperture: 0, focalLength: 0, captureTime: null, artist: '', copyright: '',
      gps: null, flip: 0, camMul: null, preMul: null, camXyz: null,
      black: null, maximum: null, rawCrop: null,
    },
    rating: 0, flag: 'unflagged', label: 'none', keywords: [], title: '', caption: '',
    edits: null, thumbKey: null, proxyKey: null, masterId: null, copyName: null,
    stackId: null, stackPosition: 0, stackCollapsed: false,
  }
}

function pixels(source: Photo, edge: number, quality: Proxy['quality']): Proxy {
  const width = Math.min(source.width, edge)
  const height = Math.max(1, Math.round(source.height * width / source.width))
  const data = new Uint16Array(width * height * 4)
  for (let i = 0; i < data.length; i++) data[i] = (i + (quality === 'full' ? 1000 : 0)) % 65536
  return {
    photoId: source.id, width, height, fullWidth: source.width, fullHeight: source.height,
    scale: width / source.width, data, bytes: data.byteLength,
    isRaw: true, preview: false, quality, asShot: { temp: 5500, tint: -5 }, whiteLevel: 2,
  }
}

class CheckDB extends Dexie {
  cache!: EntityTable<BinaryCacheEntry, 'key'>
  cacheMetadata!: EntityTable<CacheMetadata, 'key'>
  constructor(name: string) {
    super(name)
    this.version(1).stores({ cache: 'key, modifiedAt', cacheMetadata: 'key, accessedAt, raw.sourceId' })
  }
}

async function recencyChecks(id: string) {
  for (const backend of ['idb', 'browser'] as const) {
    const name = `${id}-${backend}`
    const database = new CheckDB(name)
    const storage: { root?: FileSystemDirectoryHandle } = {}
    const getRoot = async () => {
      if (backend === 'idb' || !opfsSupported()) return null
      storage.root = await navigator.storage.getDirectory()
      return storage.root.getDirectoryHandle(name, { create: true })
    }
    try {
      const first = createBinaryCache(database, getRoot)
      await first.cacheWrite('proxy/recent', new Uint8Array(16))
      await delay()
      await first.cacheWrite('proxy/unused', new Uint8Array(16))
      await delay()
      // A fresh instance has no throttled in-memory access history.
      await createBinaryCache(database, getRoot).cacheRead('proxy/recent')
      const saved = await database.cacheMetadata.get('proxy/recent')
      database.close()
      await database.open()
      const reopened = createBinaryCache(database, getRoot)
      await reopened.cacheEvict(16)
      ok(!!await reopened.cacheRead('proxy/recent'), `${backend}: reopening lost the most recently used decode`)
      ok(!await reopened.cacheRead('proxy/unused'), `${backend}: eviction kept the unused decode`)
      const touched = await database.cacheMetadata.get('proxy/recent')
      ok(saved && touched && touched.accessedAt >= saved.accessedAt, `${backend}: access history did not persist`)
      await database.cacheMetadata.toCollection().modify({ accessedAt: 1 })
      await database.cache.toCollection().modify({ modifiedAt: 1 })
      await delay()
      await createBinaryCache(database, getRoot).cacheEvict(1000, 1)
      ok((await reopened.cacheStats()).files === 0, `${backend}: age limits did not expire unused entries`)
      ok(await database.cacheMetadata.count() === 0, `${backend}: eviction left stale cache metadata`)
      for (const key of ['models/keep', 'ai/keep', 'proxy/discard', 'preview/discard']) {
        await reopened.cacheWrite(key, new Uint8Array(16))
      }
      await reopened.cacheEvict(0)
      ok(!!await reopened.cacheRead('models/keep') && !!await reopened.cacheRead('ai/keep'),
        `${backend}: automatic eviction removed models or saved masks`)
      await reopened.cacheWrite('proxy/discard', new Uint8Array(16))
      await reopened.cacheClear({ previewsOnly: true })
      ok(!await reopened.cacheRead('proxy/discard') && !!await reopened.cacheRead('ai/keep'),
        `${backend}: clearing previews did not preserve saved masks`)
      ok(await database.cacheMetadata.count() === 2, `${backend}: clearing previews left decode metadata`)
    } finally {
      await database.delete()
      if (storage.root) await storage.root.removeEntry(name, { recursive: true })
    }
  }
}

async function missingApiChecks(database: CheckDB) {
  const descriptor = Object.getOwnPropertyDescriptor(navigator.storage, 'getDirectory')
  try {
    Object.defineProperty(navigator.storage, 'getDirectory', { configurable: true, value: undefined })
    ok(!opfsSupported(), 'An undefined getDirectory property was reported supported')
    const cache = createBinaryCache(database)
    const bytes = new Uint8Array([99, 1, 2, 3, 99]).subarray(1, 4)
    await cache.cacheWrite('preview/bytes', bytes)
    const file = await cache.cacheRead('preview/bytes')
    ok(file && [...new Uint8Array(await file.arrayBuffer())].join() === '1,2,3',
      'Missing OPFS API or typed-array offsets broke IDB roundtrip')
    ok((await cache.cacheStats()).bytes === 3, 'ArrayBuffer cache statistics used the wrong size')
    // A legacy Blob row can be injected even when this browser cannot store one.
    const legacy = (row: BinaryCacheEntry) => ({
      ...row, blob: new Blob(['legacy'], { type: 'image/legacy' }), type: undefined,
    })
    database.cache.hook('reading', legacy)
    try {
      const old = await cache.cacheRead('preview/bytes')
      ok(old?.type === 'image/legacy' && await old.text() === 'legacy', 'A legacy IDB Blob row became unreadable')
    } finally {
      database.cache.hook('reading').unsubscribe(legacy)
    }
    await cache.cacheDelete('preview/bytes')
  } finally {
    if (descriptor) Object.defineProperty(navigator.storage, 'getDirectory', descriptor)
    else Reflect.deleteProperty(navigator.storage, 'getDirectory')
  }
}

async function fallbackChecks(id: string) {
  const database = new CheckDB(`${id}-failures`)
  const rejects = async (run: () => Promise<unknown>, error: Error, message: string) => {
    let caught: unknown
    try { await run() } catch (failure) { caught = failure }
    // Dexie wraps native DOMExceptions while retaining their name and message.
    ok(caught === error || (caught instanceof Error && caught.name === error.name &&
      caught.message.includes(error.message)), message)
  }
  try {
    for (const name of ['NotSupportedError', 'SecurityError', 'NotAllowedError', 'UnknownError']) {
      const error = new DOMException('Injected root acquisition failure', name)
      let attempts = 0
      let warnings = 0
      const warn = console.warn
      console.warn = (...args: unknown[]) => {
        if (args[0] === '[esque] OPFS cache unavailable; using IndexedDB instead.' && args[1] === error) warnings++
        else warn(...args)
      }
      try {
        const cache = createBinaryCache(database, async () => { attempts++; throw error })
        const key = `preview/${name}`
        const payload = new Blob([new Uint8Array([0, 1, 128, 255])], { type: 'image/test' })
        await Promise.all([cache.cacheWrite(key, payload), cache.cacheRead('preview/missing')])
        const file = await cache.cacheRead(key)
        ok(file?.type === payload.type && file.name === name, `${name}: fallback lost file metadata`)
        ok(file && [...new Uint8Array(await file.arrayBuffer())].join() === '0,1,128,255',
          `${name}: fallback changed binary data`)
        const row = await database.cache.get(key)
        ok(row && row.modifiedAt === file?.lastModified, `${name}: fallback lost modification time`)
        ok(row?.blob instanceof ArrayBuffer && row.type === payload.type, `${name}: fallback requires IDB Blob support`)
        ok(!!await database.cacheMetadata.get(key), `${name}: fallback lost access metadata`)
        ok((await cache.cacheStats()).files === 1, `${name}: fallback statistics lost a blob`)
        database.close()
        await database.open()
        const reopened = await createBinaryCache(database, async () => null).cacheRead(key)
        ok(reopened && await reopened.text() === await payload.text(), `${name}: fallback did not survive reopening IDB`)
        await cache.cacheDelete(key)
        ok(!await cache.cacheRead(key), `${name}: fallback delete left a blob`)
        ok(attempts === 1 && warnings === 1, `${name}: root probing or fallback warning repeated`)
      } finally {
        console.warn = warn
      }
    }

    await missingApiChecks(database)

    for (const name of ['QuotaExceededError', 'AbortError', 'NotReadableError', 'Error']) {
      const error = new DOMException('Root acquisition must fail', name)
      const cache = createBinaryCache(database, async () => { throw error })
      await rejects(() => cache.cacheWrite('proxy/failure', new Uint8Array(4)), error, `${name}: root write failure was hidden`)
      await rejects(() => cache.cacheRead('proxy/failure'), error, `${name}: root read failure became a cache miss`)
    }

    for (const name of ['UnknownError', 'QuotaExceededError', 'NotReadableError']) {
      for (const stage of ['directory', 'handle', 'open', 'write', 'close', 'read'] as const) {
        const error = new DOMException(`Injected ${stage} failure`, name)
        const failAt = (current: typeof stage) => { if (stage === current) throw error }
        let aborted = false
        const file = {
          getFile: async () => { failAt('read'); return new File(['data'], 'failure') },
          createWritable: async () => {
            failAt('open')
            return {
              write: async () => { failAt('write') },
              close: async () => { failAt('close') },
              abort: async () => { aborted = true },
            }
          },
        }
        const directory = {
          getDirectoryHandle: async () => { failAt('directory'); return directory },
          getFileHandle: async () => { failAt('handle'); return file },
        } as unknown as FileSystemDirectoryHandle
        const cache = createBinaryCache(database, async () => directory)
        const operation = stage === 'read'
          ? () => cache.cacheRead('proxy/failure')
          : () => cache.cacheWrite('proxy/failure', new Uint8Array(4))
        await rejects(operation, error, `${name}: ${stage} I/O failure was hidden`)
        if (stage === 'directory' || stage === 'handle') {
          await rejects(() => cache.cacheRead('proxy/failure'), error, `${name}: ${stage} read failure became a cache miss`)
        }
        if (stage === 'write' || stage === 'close') ok(aborted, `${name}: failed writer was not aborted`)
        ok(await database.cache.count() === 0, `${name}: ${stage} I/O failure incorrectly fell back to IDB`)
      }
    }
    const idb = createBinaryCache(database, async () => null)
    const quota = new DOMException('IDB full', 'QuotaExceededError')
    const rejectWrite = () => { throw quota }
    database.cache.hook('creating', rejectWrite)
    try {
      await rejects(() => idb.cacheWrite('proxy/failure', new Uint8Array(4)), quota, 'IDB quota failure was hidden')
    } finally {
      database.cache.hook('creating').unsubscribe(rejectWrite)
    }
    await idb.cacheWrite('proxy/read-failure', new Uint8Array(4))
    const readError = new DOMException('IDB read failed', 'UnknownError')
    const rejectRead = () => { throw readError }
    database.cache.hook('reading', rejectRead)
    try {
      await rejects(() => idb.cacheRead('proxy/read-failure'), readError, 'IDB read failure became a cache miss')
    } finally {
      database.cache.hook('reading').unsubscribe(rejectRead)
    }
  } finally {
    await database.delete()
  }
}

async function integrityChecks(source: Photo) {
  const edge = 800
  const interactive = pixels(source, edge, 'interactive')
  const full = pixels(source, edge, 'full')
  await writeProxyCache(source, interactive, edge)
  ok(!await hasProxyCache(source, edge, { quality: 'full' }), 'Interactive pixels satisfied a full-quality request')
  await writeProxyCache(source, full, edge)
  await writeProxyCache(source, interactive, edge)
  const hit = await readProxyCache(source, edge, undefined, { quality: 'full' })
  ok(hit?.quality === 'full' && hit.data[0] === 1000, 'A later working decode overwrote full quality')
  ok(!await hasProxyCache({ ...source, fileSize: source.fileSize + 1 }, edge), 'A changed source reused cached pixels')
  ok(!await hasProxyCache({ ...source, modifiedAt: source.modifiedAt + 1 }, edge), 'A changed modification date reused cached pixels')
  ok(!await hasProxyCache(source, 1600), 'A smaller cached tier satisfied a larger request')
  ok(!await hasProxyCache(source, 400, { maxCachedEdge: 400 }), 'Lower Display quality loaded an oversized tier')

  const key = proxyKey(source.id, source.modifiedAt, source.fileSize, edge, 'full')
  const file = await cacheRead(key)
  if (!file) throw new Error('Missing integrity fixture')
  const valid = await file.arrayBuffer()
  await cacheWrite(key, valid.slice(0, 32))
  ok(!await hasProxyCache(source, edge, { quality: 'full' }), 'A truncated decode was reported ready')
  ok(!await cacheRead(key), 'A truncated decode was not discarded')
  const obsolete = valid.slice(0)
  new DataView(obsolete).setUint32(4, 1, true)
  await cacheWrite(key, obsolete)
  ok(!await hasProxyCache(source, edge, { quality: 'full' }), 'Old gamma-encoded pixels were reused')
  const controller = new AbortController()
  controller.abort()
  let aborted = false
  try {
    await readProxyCache(source, edge, controller.signal)
  } catch (error) {
    aborted = error instanceof DOMException && error.name === 'AbortError'
  }
  ok(aborted, 'Cache reads swallowed cancellation')
  await writeProxyCache(source, { ...interactive, preview: true }, 400)
  ok(!await cacheRead(proxyKey(source.id, source.modifiedAt, source.fileSize, 400)), 'Camera previews were persisted as RAW')

  // Old v2 payloads are adopted without forcing another demosaic.
  const legacyKey = proxyKey(source.id, source.modifiedAt, source.fileSize, edge)
  await cacheWrite(legacyKey, valid)
  await db.cacheMetadata.delete(legacyKey)
  ok(await hasProxyCache(source, edge, { quality: 'full' }), 'An existing v2 full-quality decode was lost')
  await readProxyCache(source, edge, undefined, { quality: 'full' })
  ok((await db.cacheMetadata.get(legacyKey))?.raw?.quality === 'full', 'Legacy decodes were not added to the durable index')
  await cacheDelete(legacyKey)
}

async function protectionChecks() {
  const storage = navigator.storage
  const persisted = Object.getOwnPropertyDescriptor(storage, 'persisted')
  const persist = Object.getOwnPropertyDescriptor(storage, 'persist')
  const estimate = Object.getOwnPropertyDescriptor(storage, 'estimate')
  const cacheLimit = useUI.getState().cacheLimit
  let calls = 0
  try {
    useUI.setState({ cacheLimit: 0 })
    Object.defineProperty(storage, 'estimate', { configurable: true, value: async () => ({}) })
    ok(await cacheBudget() === 3 * 1024 ** 3, 'An unavailable quota made the automatic cache unbounded')
    Object.defineProperty(storage, 'estimate', { configurable: true, value: async () => ({ quota: 1000 }) })
    ok(await cacheBudget() === 250, 'Automatic cache budget exceeded its quota share')
    useUI.setState({ cacheLimit: 4000 })
    ok(await cacheBudget() === 800, 'A chosen cache budget exceeded the browser quota ceiling')
    useUI.setState({ cacheLimit })
    Object.defineProperty(storage, 'persisted', { configurable: true, value: async () => false })
    Object.defineProperty(storage, 'persist', { configurable: true, value: async () => { calls++; return true } })
    const results = await Promise.all([requestStorageProtection(), requestStorageProtection()])
    ok(calls === 1 && results.every((result) => result === 'persistent'), 'Concurrent protection requests were not coalesced')
    Object.defineProperty(storage, 'persist', { configurable: true, value: async () => false })
    ok(await requestStorageProtection() === 'best-effort', 'Denied protection was described as persistent')
    Object.defineProperty(storage, 'persisted', { configurable: true, value: async () => true })
    ok(await requestStorageProtection() === 'persistent', 'Already protected storage was requested again')
    Object.defineProperty(storage, 'persisted', { configurable: true, value: undefined })
    ok(await requestStorageProtection() === 'unsupported', 'Unsupported persistence had no explicit status')
    Object.defineProperty(storage, 'persisted', { configurable: true, value: async () => { throw new Error('Unavailable') } })
    let rejected = false
    try { await requestStorageProtection() } catch { rejected = true }
    ok(rejected, 'Storage errors were turned into successful protection')
  } finally {
    if (persisted) Object.defineProperty(storage, 'persisted', persisted)
    else Reflect.deleteProperty(storage, 'persisted')
    if (persist) Object.defineProperty(storage, 'persist', persist)
    else Reflect.deleteProperty(storage, 'persist')
    if (estimate) Object.defineProperty(storage, 'estimate', estimate)
    else Reflect.deleteProperty(storage, 'estimate')
    useUI.setState({ cacheLimit })
  }
}

async function prepare(state: ReloadState) {
  const source = photo(state.id)
  const original = new File([new Uint8Array(source.fileSize)], source.filename, { lastModified: source.modifiedAt })
  await db.originals.put(await prepareOriginal(source.id, original))
  await db.photos.put(source)
  await fallbackChecks(state.id)
  await recencyChecks(state.id)
  await integrityChecks(source)
  await protectionChecks()
  const decode = rawPool.decodeLinear
  let decodes = 0
  rawPool.decodeLinear = async (_buffer, _raw, edge, _iso, _crop, quality) => {
    decodes++
    const result = pixels(source, edge ?? 2560, quality ?? 'full')
    return { ...result, fromRaw: true, meta: null }
  }
  try {
    useUI.setState({ previewQuality: 'high' })
    const working = await loadProxy(source.id)
    ok(working?.quality === 'interactive', 'Cold working load used the wrong demosaic tier')
    clearProxies()
    useUI.setState({ previewQuality: 'standard' })
    const smaller = await loadProxy(source.id)
    ok(smaller?.width === 1600, 'Changing Display quality ignored the requested tier')
    clearProxies()
    const detail = await loadProxy(source.id, 3200)
    ok(detail?.quality === 'full' && detail.scale === 1, 'Cold detail did not reach native full quality')
    state.coldDecodes = decodes
    ok(decodes === 3, `Expected three cold decodes; got ${decodes}`)
    // There must be no dependency on the original to reopen a cached tier.
    await db.originals.delete(source.id)
  } finally {
    rawPool.decodeLinear = decode
    clearProxies()
  }
}

async function afterReload(state: ReloadState) {
  const source = (await db.photos.get(state.id))!
  const decode = rawPool.decodeLinear
  let decodes = 0
  rawPool.decodeLinear = async () => {
    decodes++
    throw new Error('A warm reload must not decode or open the original')
  }
  try {
    for (const [quality, edge] of [['high', 2560], ['standard', 1600]] as const) {
      useUI.setState({ previewQuality: quality })
      clearProxies()
      ok(await proxyIsReady(source.id), `${quality}: persisted working tier was not ready after reload`)
      const hit = await loadProxy(source.id)
      const expected = pixels(source, edge, 'interactive')
      ok(hit?.width === edge && hit.quality === 'interactive', `${quality}: reload lost the working tier`)
      ok(hit?.data.every((value, index) => value === expected.data[index]), `${quality}: cached pixels changed`)
      ok(hit?.whiteLevel === expected.whiteLevel, `${quality}: RAW headroom did not survive reload`)
    }
    clearProxies()
    const full = await loadProxy(source.id, 3200)
    const expected = pixels(source, 3200, 'full')
    ok(full?.quality === 'full' && full.scale === 1, 'Native detail did not survive a page reload')
    ok(full?.data.every((value, index) => value === expected.data[index]), 'Full-detail pixels changed on reload')
    clearProxies()
    const copy = { ...source, id: `${source.id}-copy`, masterId: source.id }
    await db.photos.put(copy)
    const shared = await loadProxy(copy.id, 3200)
    ok(shared?.photoId === copy.id && shared.quality === 'full', 'A virtual copy did not reuse its master decode')
    ok(decodes === 0, `Reload repeated ${decodes} RAW decodes`)
    const current = await storageProtection()
    // Native persist() can wait indefinitely for Firefox's permission prompt.
    // Request/denial behavior is covered by protectionChecks without user input.
    ok(['persistent', 'best-effort', 'unsupported'].includes(current), 'Storage protection returned no explicit status')
    return { coldDecodes: state.coldDecodes, reloadDecodes: decodes, storage: current }
  } finally {
    rawPool.decodeLinear = decode
  }
}

async function cleanup(state: ReloadState) {
  const source = photo(state.id)
  const indexed = await db.cacheMetadata.where('raw.sourceId').equals(state.id).primaryKeys()
  const keys = [...indexed]
  for (const edge of [400, 800, 1600, 2560, 3200]) {
    for (const quality of ['interactive', 'full'] as const) {
      keys.push(proxyKey(source.id, source.modifiedAt, source.fileSize, edge, quality))
    }
  }
  await Promise.all([...new Set(keys)].map(cacheDelete))
  await db.photos.bulkDelete([state.id, `${state.id}-copy`])
  await db.originals.delete(state.id)
  clearProxies()
  useUI.setState({ previewQuality: state.previewQuality })
  sessionStorage.removeItem(sessionKey)
}

runCheck(async () => {
  const saved = sessionStorage.getItem(sessionKey)
  if (!saved) {
    const state: ReloadState = {
      id: `cachecheck-${crypto.randomUUID()}`, assertions: 0, failures: [], coldDecodes: 0,
      previewQuality: useUI.getState().previewQuality,
    }
    try {
      await prepare(state)
      state.assertions = assertions
      state.failures = failures
      sessionStorage.setItem(sessionKey, JSON.stringify(state))
      location.reload()
      return await new Promise<never>(() => {})
    } catch (error) {
      await cleanup(state)
      throw error
    }
  }
  const state: ReloadState = JSON.parse(saved)
  assertions = state.assertions
  failures.push(...state.failures)
  try {
    const result = await afterReload(state)
    return { pass: failures.length === 0, assertions, failures, ...result }
  } finally {
    await cleanup(state)
  }
}, { print: true })
