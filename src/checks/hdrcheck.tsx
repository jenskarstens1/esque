import { createRoot } from 'react-dom/client'
import { db } from '../catalog/db'
import { cacheDelete, proxyKey } from '../catalog/opfs'
import { defaultEdits } from '../core/defaults'
import { floatToHalf, halfToFloat } from '../core/half'
import { applyDynamicRangeLimit, HEADROOM_STOPS_DEFAULT, hdrCapability } from '../core/hdr'
import type { Photo } from '../core/types'
import { dropProxy, loadProxy, proxyEdge, type Proxy } from '../develop/proxy'
import { writeProxyCache } from '../develop/proxyCache'
import { useDevelop } from '../develop/session'
import { Renderer } from '../gpu/renderer'
import { Viewport } from '../modules/develop/Viewport'
import { activeRenderer } from '../modules/develop/activeRenderer'
import { Toolbar } from '../shell/Toolbar'
import { useKeymap } from '../shell/useKeymap'
import { useCatalog } from '../state/catalog'
import { photoHdr, useUI } from '../state/ui'
import { runCheck } from './checkreport'
import '../styles/index.css'

const tick = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
async function until(test: () => boolean, label: string) {
  const deadline = performance.now() + 5000
  while (!test()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`)
    await tick()
  }
}

export function Harness({ photo }: { photo: Photo }) {
  useKeymap()
  return (
    <div style={{ width: 640, height: 440, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0 }}><Viewport photo={photo} /></div>
      <Toolbar />
    </div>
  )
}

async function run() {
  const failures: string[] = []
  let assertions = 0
  const check = (condition: boolean, message: string) => {
    assertions++
    if (!condition) failures.push(message)
  }
  const savedUI = useUI.getState()
  const savedCatalog = useCatalog.getState()
  const savedDevelop = useDevelop.getState()
  const id = `hdrcheck-${crypto.randomUUID()}`
  const photo: Photo = {
    id, folderId: id, relPath: 'hdr.dng', filename: 'hdr.dng', ext: 'dng', isRaw: true,
    hdr: true, fileSize: 1, modifiedAt: 0, addedAt: 0, width: 64, height: 64,
    meta: {
      cameraMake: '', cameraModel: '', lens: '', iso: 100, shutter: 0, aperture: 0,
      focalLength: 0, captureTime: null, artist: '', copyright: '', gps: null, flip: 0,
      camMul: null, preMul: null, camXyz: null, black: null, maximum: null,
    },
    rating: 0, flag: 'unflagged', label: 'none', keywords: [], title: '', caption: '',
    edits: defaultEdits('raw'), thumbKey: null, proxyKey: null,
    masterId: null, copyName: null, stackId: null, stackPosition: 0, stackCollapsed: false,
  }
  const data = new Uint16Array(64 * 64 * 4)
  for (let i = 0; i < data.length; i += 4) {
    data.fill(floatToHalf(0.5), i, i + 3)
    data[i + 3] = floatToHalf(4)
  }
  const proxy: Proxy = {
    photoId: id, width: 64, height: 64, fullWidth: 64, fullHeight: 64, scale: 1,
    isRaw: true, asShot: { temp: 5500, tint: 0 }, whiteLevel: 1,
    preview: false, quality: 'full', data, bytes: data.byteLength,
  }

  // Copy the presented pixel within the render task. drawImage can return a
  // stale SDR frame after switching to an extended-range swap chain.
  const configure = GPUCanvasContext.prototype.configure
  const render = Renderer.prototype.render
  let sample = Promise.resolve(0)
  GPUCanvasContext.prototype.configure = function (configuration) {
    configure.call(this, {
      ...configuration,
      usage: (configuration.usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.COPY_SRC,
    })
  }
  Renderer.prototype.render = function (edits, options) {
    const ran = render.call(this, edits, options)
    const { device, surface, format, canvas } = this.ctx
    if (surface && this.hasImage()) {
      const buffer = device.createBuffer({
        size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      })
      const encoder = device.createCommandEncoder()
      encoder.copyTextureToBuffer(
        { texture: surface.getCurrentTexture(), origin: [canvas.width >> 1, canvas.height >> 1] },
        { buffer, bytesPerRow: 256 },
        [1, 1],
      )
      device.queue.submit([encoder.finish()])
      sample = buffer.mapAsync(GPUMapMode.READ).then(() => {
        const range = buffer.getMappedRange()
        const value = format === 'rgba16float'
          ? halfToFloat(new Uint16Array(range)[0])
          : new Uint8Array(range)[0] / 255
        buffer.unmap()
        buffer.destroy()
        return value
      })
    }
    return ran
  }

  const root = createRoot(document.getElementById('root')!)
  let edge = 0
  try {
    useUI.setState({
      module: 'develop', beforeAfter: 'off', developTool: 'none', wbPicking: false,
      hdrByPhoto: {}, hdrHeadroom: HEADROOM_STOPS_DEFAULT,
    })
    useUI.getState().setHdr(false)
    useCatalog.setState({ primaryId: id, selected: [id] })
    await db.photos.put(photo)
    edge = proxyEdge()
    await writeProxyCache(photo, proxy, edge)
    if (!await loadProxy(id)) throw new Error('HDR fixture proxy did not load')
    await useDevelop.getState().load(photo)
    root.render(<Harness photo={photo} />)
    await until(() => !!activeRenderer()?.frames, 'initial preview')
    const renderer = activeRenderer()!
    const canvas = renderer.ctx.canvas as HTMLCanvasElement
    const button = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((element) => element.textContent?.trim() === 'HDR')
    await until(() => !!button(), 'HDR toolbar button')
    const sdr = await sample
    const frames = renderer.frames
    button()!.click()
    await until(() => renderer.frames > frames && renderer.hdrPresenting, 'HDR repaint')
    const hdr = await sample
    check(button()!.getAttribute('aria-pressed') === 'true', 'HDR button reflects the photo override')
    check(!useUI.getState().hdr && photoHdr(id)(useUI.getState()), 'The photo enables HDR without changing the global default')
    if (hdrCapability().css) {
      check(getComputedStyle(document.documentElement).getPropertyValue('dynamic-range-limit') === 'standard',
        'The document stays SDR by default')
      check(getComputedStyle(canvas).getPropertyValue('dynamic-range-limit') === 'no-limit',
        'The live canvas overrides the inherited SDR limit')
    }
    check(renderer.ctx.surface?.getConfiguration()?.toneMapping?.mode === 'extended',
      'The button configures an extended-range surface')
    check(hdr > 1 && hdr > sdr + 0.1, `HDR emits real above-white pixels (${sdr} -> ${hdr})`)
    const onFrames = renderer.frames
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true }))
    await until(() => renderer.frames > onFrames && !renderer.hdrPresenting, 'keyboard SDR repaint')
    const back = await sample
    check(button()!.getAttribute('aria-pressed') === 'false', 'H toggles the same photo back to SDR')
    check(Math.abs(back - sdr) <= 1 / 255, 'Turning HDR off restores the SDR output')
    if (hdrCapability().css) {
      check(getComputedStyle(canvas).getPropertyValue('dynamic-range-limit') === 'standard',
        'Turning HDR off restores the canvas SDR limit')
    }

    useUI.setState({ hdrHeadroom: 0 })
    const offFrames = renderer.frames
    button()!.click()
    await until(() => renderer.frames > offFrames && renderer.hdrPresenting, 'legacy-headroom repaint')
    check(useUI.getState().hdrHeadroom === HEADROOM_STOPS_DEFAULT,
      'A per-photo enable repairs a legacy zero-headroom preference')
    check(await sample > 1, 'A legacy zero-headroom setting does not make the HDR button inert')

    useUI.getState().setHdr(true)
    useUI.getState().setPhotoHdr([id], false)
    await until(() => !renderer.hdrPresenting, 'per-photo SDR override')
    if (hdrCapability().css) {
      check(getComputedStyle(canvas).getPropertyValue('dynamic-range-limit') === 'standard',
        'A photo can stay SDR when the document default is HDR')
    }
    useUI.getState().setPhotoHdr([id, `${id}-other`], true)
    check(photoHdr(id)(useUI.getState()) && photoHdr(`${id}-other`)(useUI.getState()),
      'Selection HDR enabling keeps a consistent state')
    return { ok: failures.length === 0, assertions, failures, pixels: { sdr, hdr, back } }
  } finally {
    root.unmount()
    await sample
    Renderer.prototype.render = render
    GPUCanvasContext.prototype.configure = configure
    dropProxy(id)
    await cacheDelete(proxyKey(id, 0, 1, edge))
    await db.photos.delete(id)
    useDevelop.setState(savedDevelop)
    useCatalog.setState(savedCatalog)
    useUI.setState(savedUI)
    applyDynamicRangeLimit(savedUI.hdr)
  }
}

runCheck(run, { print: true })
