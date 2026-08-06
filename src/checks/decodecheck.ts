/**
 * Precision-format decode checks.
 *
 * Run through `tools/headless.mjs /checks/decodecheck.html`.
 */
import { encodePng16 } from '../export/png'
import { encodeTiff } from '../export/tiff'
import { db } from '../catalog/db'
import { cacheDelete, cacheRead, proxyKey } from '../catalog/opfs'
import type { Photo } from '../core/types'
import { readProxyCache, writeProxyCache } from '../develop/proxyCache'

/**
 * The tier this check round-trips under. Any number does — the point is that
 * reader, writer and key agree on one — so it is stated here rather than read
 * from the preference, which would make the check's coverage depend on a
 * setting.
 */
const PROXY_TIER = 2560
import type { Proxy } from '../develop/proxy'
import { createDemandQueue } from '../lib/demandQueue'
import { decodeDeepPng } from '../raw/png16'
import { decodeTiff } from '../raw/tiff16'

declare global {
  interface Window {
    __done?: boolean
    __result?: unknown
  }
}

const failures: string[] = []
const same = (actual: ArrayLike<number>, expected: ArrayLike<number>, label: string, tolerance = 0) => {
  if (actual.length !== expected.length) {
    failures.push(`${label}: length ${actual.length}, expected ${expected.length}`)
    return
  }
  for (let i = 0; i < actual.length; i++) {
    if (Math.abs(actual[i] - expected[i]) > tolerance) {
      failures.push(`${label}: sample ${i} is ${actual[i]}, expected ${expected[i]}`)
      return
    }
  }
}

interface Entry {
  tag: number
  type: 3 | 4
  count: number
  value: number
}

function writeTiff(
  le: boolean,
  entries: Entry[],
  extras: Array<{ offset: number; values: number[] }>,
  payloadOffset: number,
  payload: Uint8Array,
): Uint8Array {
  const bytes = new Uint8Array(payloadOffset + payload.length)
  const view = new DataView(bytes.buffer)
  bytes[0] = le ? 0x49 : 0x4d
  bytes[1] = bytes[0]
  view.setUint16(2, 42, le)
  view.setUint32(4, 8, le)
  view.setUint16(8, entries.length, le)

  entries.forEach((entry, index) => {
    const at = 10 + index * 12
    view.setUint16(at, entry.tag, le)
    view.setUint16(at + 2, entry.type, le)
    view.setUint32(at + 4, entry.count, le)
    if (entry.type === 3 && entry.count === 1) view.setUint16(at + 8, entry.value, le)
    else view.setUint32(at + 8, entry.value, le)
  })
  view.setUint32(10 + entries.length * 12, 0, le)

  for (const extra of extras) {
    extra.values.forEach((value, index) => view.setUint16(extra.offset + index * 2, value, le))
  }
  bytes.set(payload, payloadOffset)
  return bytes
}

function floatPredictorTiff(le: boolean) {
  const width = 3
  const channels = 3
  const values = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1]
  const samples = values.length
  const raw = new Uint8Array(samples * 4)
  const rawView = new DataView(raw.buffer)
  values.forEach((value, index) => rawView.setFloat32(index * 4, value, le))

  // TIFF predictor 3 stores most-significant byte planes first, then applies
  // horizontal differencing independently within each plane.
  const payload = new Uint8Array(raw.length)
  for (let plane = 0; plane < 4; plane++) {
    const sourceByte = le ? 3 - plane : plane
    for (let sample = 0; sample < samples; sample++) {
      payload[plane * samples + sample] = raw[sample * 4 + sourceByte]
    }
    for (let sample = samples - 1; sample >= channels; sample--) {
      const at = plane * samples + sample
      payload[at] = (payload[at] - payload[at - channels]) & 0xff
    }
  }

  const count = 12
  const ifdEnd = 10 + count * 12 + 4
  const bitsOffset = ifdEnd
  const formatOffset = bitsOffset + 6
  const pixelOffset = formatOffset + 6
  const entries: Entry[] = [
    { tag: 256, type: 4, count: 1, value: width },
    { tag: 257, type: 4, count: 1, value: 1 },
    { tag: 258, type: 3, count: 3, value: bitsOffset },
    { tag: 259, type: 3, count: 1, value: 1 },
    { tag: 262, type: 3, count: 1, value: 2 },
    { tag: 273, type: 4, count: 1, value: pixelOffset },
    { tag: 277, type: 3, count: 1, value: channels },
    { tag: 278, type: 4, count: 1, value: 1 },
    { tag: 279, type: 4, count: 1, value: payload.length },
    { tag: 284, type: 3, count: 1, value: 1 },
    { tag: 317, type: 3, count: 1, value: 3 },
    { tag: 339, type: 3, count: 3, value: formatOffset },
  ]

  return {
    bytes: writeTiff(
      le,
      entries,
      [
        { offset: bitsOffset, values: [32, 32, 32] },
        { offset: formatOffset, values: [3, 3, 3] },
      ],
      pixelOffset,
      payload,
    ),
    expected: new Uint16Array(values.map((value) => Math.floor(value * 65535))),
  }
}

function signedPredictorTiff() {
  const values = [-32768, 0, 32767]
  const codes = values.map((value) => value & 0xffff)
  for (let i = codes.length - 1; i > 0; i--) codes[i] = (codes[i] - codes[i - 1]) & 0xffff

  const count = 11
  const pixelOffset = 10 + count * 12 + 4
  const payload = new Uint8Array(codes.length * 2)
  const payloadView = new DataView(payload.buffer)
  codes.forEach((value, index) => payloadView.setUint16(index * 2, value, true))
  const entries: Entry[] = [
    { tag: 256, type: 4, count: 1, value: values.length },
    { tag: 257, type: 4, count: 1, value: 1 },
    { tag: 258, type: 3, count: 1, value: 16 },
    { tag: 259, type: 3, count: 1, value: 1 },
    { tag: 262, type: 3, count: 1, value: 1 },
    { tag: 273, type: 4, count: 1, value: pixelOffset },
    { tag: 277, type: 3, count: 1, value: 1 },
    { tag: 278, type: 4, count: 1, value: 1 },
    { tag: 279, type: 4, count: 1, value: payload.length },
    { tag: 317, type: 3, count: 1, value: 2 },
    { tag: 339, type: 3, count: 1, value: 2 },
  ]
  return writeTiff(true, entries, [], pixelOffset, payload)
}

async function run() {
  const rgb16 = new Uint16Array([
    0, 1, 65535,
    32768, 4096, 60000,
    123, 4567, 8901,
    65534, 50000, 25000,
    42, 2048, 32767,
    999, 1000, 1001,
  ])

  const png = await decodeDeepPng(await encodePng16({ width: 3, height: 2, data: rgb16 }))
  if (!png) failures.push('PNG16 did not decode')
  else {
    same(png.data, rgb16, 'PNG16')
    if (png.width !== 3 || png.height !== 2 || png.channels !== 3) failures.push('PNG16 shape')
  }

  for (const compress of [false, true]) {
    const encoded = await encodeTiff({
      width: 3,
      height: 2,
      depth: 16,
      data: rgb16,
      compress,
    })
    const decoded = await decodeTiff(new Uint8Array(await encoded.arrayBuffer()))
    if (!decoded) failures.push(`TIFF16 ${compress ? 'deflate' : 'plain'} did not decode`)
    else same(decoded.data, rgb16, `TIFF16 ${compress ? 'deflate' : 'plain'}`)
  }

  for (const le of [true, false]) {
    const fixture = floatPredictorTiff(le)
    const decoded = await decodeTiff(fixture.bytes)
    if (!decoded) failures.push(`float TIFF ${le ? 'LE' : 'BE'} did not decode`)
    else same(decoded.data, fixture.expected, `float TIFF ${le ? 'LE' : 'BE'}`, 1)
  }

  const signed = await decodeTiff(signedPredictorTiff())
  if (!signed) failures.push('signed TIFF did not decode')
  else same(signed.data, new Uint16Array([0, 32768, 65535]), 'signed TIFF')

  const cache = new Map<string, { demand: number }>()
  let produced = 0
  const request = createDemandQueue<string, { demand: number }>({
    peek: (key) => cache.get(key) ?? null,
    satisfies: (value, demand) => value.demand >= demand,
    produce: (_key, demand, signal) =>
      new Promise((resolve, reject) => {
        produced++
        const timer = setTimeout(() => resolve({ demand }), 20)
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(signal.reason)
          },
          { once: true },
        )
      }),
    store: (value) => cache.set('photo', value),
  })
  const controller = new AbortController()
  const cancelled = request('photo', 100, controller.signal)
  controller.abort()
  try {
    await cancelled
    failures.push('cancelled demand resolved')
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'AbortError') {
      failures.push('cancelled demand lost its AbortError')
    }
  }
  const replacement = await request('photo', 200)
  if (replacement?.demand !== 200 || produced !== 2) {
    failures.push(`demand queue did not recover after cancellation (${produced})`)
  }

  // A writer creates the OPFS entry before close() publishes its bytes. React
  // StrictMode can mount a second preview consumer inside that interval, so an
  // empty in-progress file must remain a cache miss rather than becoming a
  // permanently broken object URL.
  const emptyKey = 'decodecheck/in-progress.jpg'
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle('decodecheck', { create: true })
  await dir.getFileHandle('in-progress.jpg', { create: true })
  if ((await cacheRead(emptyKey)) !== null) failures.push('empty in-progress cache entry was published')
  await cacheDelete(emptyKey)

  const photo: Photo = {
    id: '__decodecheck_proxy__',
    folderId: '__decodecheck__',
    relPath: 'proxy.raf',
    filename: 'proxy.raf',
    ext: 'raf',
    isRaw: true,
    fileSize: 12345,
    modifiedAt: 67890,
    addedAt: 0,
    width: 2,
    height: 1,
    meta: {
      cameraMake: '',
      cameraModel: '',
      lens: '',
      iso: 0,
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
  const proxy: Proxy = {
    photoId: photo.id,
    width: 2,
    height: 1,
    data: new Uint16Array([1, 2, 3, 4, 5, 6, 7, 8]),
    isRaw: true,
    asShot: { temp: 5234, tint: -7 },
    whiteLevel: 1.75,
    scale: 1,
    fullWidth: 2,
    fullHeight: 1,
    bytes: 16,
    preview: false,
    quality: 'interactive',
  }
  const linearKey = proxyKey(photo.id, photo.modifiedAt, photo.fileSize, PROXY_TIER)
  await db.photos.put(photo)
  try {
    await writeProxyCache(photo, proxy, PROXY_TIER)
    const saved = await db.photos.get(photo.id)
    const hit = saved ? await readProxyCache(saved, PROXY_TIER) : null
    if (
      saved?.proxyKey !== linearKey ||
      !hit ||
      hit.data.join(',') !== proxy.data.join(',') ||
      Math.abs(hit.asShot.temp - proxy.asShot.temp) > 0.01
    ) {
      failures.push('linear proxy cache did not round-trip')
    }
    if (
      saved &&
      (await readProxyCache({ ...saved, fileSize: saved.fileSize + 1 }, PROXY_TIER)) !== null
    ) {
      failures.push('linear proxy cache ignored the source fingerprint')
    }
  } finally {
    await cacheDelete(linearKey)
    await db.photos.delete(photo.id)
  }

  return { pass: failures.length === 0, failures }
}

run()
  .then((result) => {
    window.__result = result
  })
  .catch((error) => {
    window.__result = { pass: false, failures: [error instanceof Error ? error.message : String(error)] }
  })
  .finally(() => {
    window.__done = true
  })
