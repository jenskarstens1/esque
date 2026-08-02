/**
 * WebGPU device layer for the edit pipeline: adapter/device acquisition,
 * capabilities, canvas presentation (including HDR), textures and ping-pong
 * render targets. Everything above this file talks in passes, never in raw
 * WebGPU — the same contract the WebGL2 layer held.
 */

export type TexFormat = 'rgba16float' | 'rgba32float' | 'rgba8unorm' | 'r16float'
export type TexFilter = 'linear' | 'nearest'

export interface GPUCaps {
  /** Largest square texture the device will allocate. Matches WebGL2's 16384. */
  maxTextureSize: number
  maxSampledTextures: number
  maxSamplers: number
  /**
   * The canvas can present values above display white. Unlike the WebGL2
   * route this is core WebGPU, so it is true wherever WebGPU itself is.
   */
  hdrPresent: boolean
  adapter: string
}

export interface Ctx {
  device: GPUDevice
  caps: GPUCaps
  canvas: HTMLCanvasElement | OffscreenCanvas
  /** Null for offscreen work that never presents (export, histogram). */
  surface: GPUCanvasContext | null
  /** Presentation format; flips to rgba16float when HDR is on. */
  format: GPUTextureFormat
  samplers: { linear: GPUSampler; nearest: GPUSampler; mip: GPUSampler }
}

export interface ContextOptions {
  /**
   * Configure the canvas for presentation.
   *
   * Defaults to true for an `HTMLCanvasElement` and false otherwise. In WebGL2
   * this flag only chose the drawing-buffer format, so getting it wrong cost a
   * little precision; in WebGPU it decides whether a `GPUCanvasContext` exists
   * at all, and without one every draw to screen is silently skipped. A canvas
   * in the document is there to be looked at, and an `OffscreenCanvas` in an
   * export worker never is, so the default matches the intent and the explicit
   * flag stays available for the exceptions.
   */
  presenting?: boolean
}

/**
 * Requests the adapter's *maximum* limits rather than accepting the defaults.
 *
 * `device.limits` after a bare `requestDevice()` reports the spec defaults —
 * notably `maxTextureDimension2D: 8192` — even when the adapter supports far
 * more. A photo editor that accepted those would refuse images WebGL2 handled
 * without complaint, so every limit the pipeline cares about is asked for
 * explicitly, clamped to what the adapter actually advertises.
 */
function requiredLimits(adapter: GPUAdapter): Record<string, number> {
  const a = adapter.limits
  const want: Record<string, number> = {
    maxTextureDimension2D: a.maxTextureDimension2D,
    maxSampledTexturesPerShaderStage: a.maxSampledTexturesPerShaderStage,
    maxSamplersPerShaderStage: a.maxSamplersPerShaderStage,
    maxUniformBufferBindingSize: Math.min(a.maxUniformBufferBindingSize, 1 << 20),
    maxBufferSize: Math.min(a.maxBufferSize, 1 << 30),
    maxColorAttachmentBytesPerSample: a.maxColorAttachmentBytesPerSample,
  }
  // A limit the adapter does not report at all must not appear in the request.
  for (const k of Object.keys(want)) {
    const v = want[k]
    if (typeof v !== 'number' || !Number.isFinite(v)) delete want[k]
  }
  return want
}

export async function createContext(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  opts: ContextOptions = {},
): Promise<Ctx | null> {
  if (!navigator.gpu) return null
  let adapter: GPUAdapter | null = null
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  } catch {
    return null
  }
  if (!adapter) return null

  let device: GPUDevice
  try {
    device = await adapter.requestDevice({ requiredLimits: requiredLimits(adapter) })
  } catch {
    // A driver that refuses the maximums is still usable at the defaults.
    try {
      device = await adapter.requestDevice()
    } catch {
      return null
    }
  }

  // Losing the device silently would leave a frozen viewport with no clue why.
  device.lost.then((info) => {
    if (info.reason !== 'destroyed') {
      console.error(`[esque] WebGPU device lost: ${info.reason} — ${info.message}`)
    }
  })

  const info = adapter.info
  const adapterName = info
    ? [info.vendor, info.architecture, info.description].filter(Boolean).join(' / ')
    : 'unknown'

  const presenting =
    opts.presenting ??
    (typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement)
  const surface = presenting
    ? ((canvas as HTMLCanvasElement).getContext('webgpu') as GPUCanvasContext | null)
    : null

  const ctx: Ctx = {
    device,
    canvas,
    surface,
    format: navigator.gpu.getPreferredCanvasFormat(),
    caps: {
      maxTextureSize: device.limits.maxTextureDimension2D,
      maxSampledTextures: device.limits.maxSampledTexturesPerShaderStage,
      maxSamplers: device.limits.maxSamplersPerShaderStage,
      hdrPresent: !!surface,
      adapter: adapterName,
    },
    samplers: {
      linear: device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      }),
      nearest: device.createSampler({
        magFilter: 'nearest',
        minFilter: 'nearest',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      }),
      mip: device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      }),
    },
  }
  return ctx
}

/**
 * Configures the presentation surface, in half-float when HDR is wanted.
 *
 * `toneMapping: 'extended'` is what lets the compositor carry values above
 * display white; `rgba16float` is what gives them somewhere to live. Both are
 * core WebGPU — no flag, and no difference between Chromium and WebKit — which
 * is the whole reason the pipeline moved here.
 *
 * The colour space stays sRGB: the output pass encodes with the sRGB transfer
 * curve, whose formula keeps going above 1, and that is exactly how an
 * extended-range surface reads a value over 1 — brighter than white, same
 * chromaticity. Widening the surface without changing that encode would move
 * every colour in the picture.
 *
 * Returns whether HDR is actually in force.
 */
export function configureSurface(ctx: Ctx, hdr: boolean): boolean {
  const { device, surface } = ctx
  if (!surface) return false
  const format: GPUTextureFormat = hdr ? 'rgba16float' : navigator.gpu.getPreferredCanvasFormat()
  try {
    surface.configure({
      device,
      format,
      alphaMode: 'premultiplied',
      colorSpace: 'srgb',
      toneMapping: { mode: hdr ? 'extended' : 'standard' },
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    ctx.format = format
    return hdr
  } catch {
    // Fall back to a plain SDR surface rather than losing the viewport.
    try {
      const fallback = navigator.gpu.getPreferredCanvasFormat()
      surface.configure({ device, format: fallback, alphaMode: 'premultiplied' })
      ctx.format = fallback
    } catch {
      /* nothing left to try */
    }
    return false
  }
}

// ---------------------------------------------------------------------------
// Textures & targets
// ---------------------------------------------------------------------------

export interface TextureOptions {
  format?: TexFormat
  filter?: TexFilter
  /** Allocate a full mip chain. Only the presentation source needs one. */
  mips?: boolean
  /** Allow readback via copyTextureToBuffer. */
  readable?: boolean
}

/**
 * A texture plus the metadata the bind-group builder needs.
 *
 * WebGL carries filtering on the texture object; WebGPU carries it on the
 * sampler. Keeping the wanted filter here lets call sites go on thinking in
 * textures while the pass layer picks the matching shared sampler.
 */
export interface Tex {
  texture: GPUTexture
  /** Sampling view, covering the whole mip chain. */
  view: GPUTextureView
  /**
   * Render-attachment view. A colour attachment must name exactly one mip
   * level, so this cannot be `view` once a chain exists.
   */
  attach: GPUTextureView
  width: number
  height: number
  format: TexFormat
  filter: TexFilter
  mipLevels: number
  /** Set once a mip chain has been generated for the current contents. */
  mipsReady: boolean
  destroy(): void
}

function mipCount(width: number, height: number) {
  return 1 + Math.floor(Math.log2(Math.max(width, height)))
}

export function createTexture(
  ctx: Ctx,
  width: number,
  height: number,
  opts: TextureOptions = {},
): Tex {
  const { format = 'rgba16float', filter = 'linear', mips = false, readable = false } = opts
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const mipLevels = mips ? mipCount(w, h) : 1

  let usage =
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
  if (readable || mips) usage |= GPUTextureUsage.COPY_SRC

  const texture = ctx.device.createTexture({
    size: [w, h],
    format,
    usage,
    mipLevelCount: mipLevels,
  })

  return {
    texture,
    view: texture.createView(),
    attach:
      mipLevels === 1
        ? texture.createView()
        : texture.createView({ baseMipLevel: 0, mipLevelCount: 1 }),
    width: w,
    height: h,
    format,
    filter,
    mipLevels,
    mipsReady: false,
    destroy() {
      texture.destroy()
    },
  }
}

/** Bytes per pixel, for upload row padding. */
function bytesPerPixel(format: TexFormat) {
  if (format === 'rgba32float') return 16
  if (format === 'rgba16float') return 8
  return format === 'rgba8unorm' ? 4 : 2
}

/** Uploads pixel data. `data` must already match the texture's format. */
export function writeTexture(ctx: Ctx, tex: Tex, data: ArrayBufferView) {
  ctx.device.queue.writeTexture(
    { texture: tex.texture },
    data,
    { bytesPerRow: tex.width * bytesPerPixel(tex.format), rowsPerImage: tex.height },
    { width: tex.width, height: tex.height },
  )
  tex.mipsReady = false
}

/** A render target is just a texture we also draw into. */
export type RenderTarget = Tex

/**
 * Copies a texture back to the CPU.
 *
 * `gl.readPixels` was synchronous; this is not, which is the single most
 * invasive consequence of the port — the histogram, auto-tone and export all
 * have to await it. The 256-byte `bytesPerRow` rule applies to buffer copies
 * (unlike `writeTexture`), so rows are padded on the way out and unpacked here
 * rather than making callers deal with stride.
 */
export async function readTexture(ctx: Ctx, tex: Tex): Promise<ArrayBuffer> {
  const bpp = bytesPerPixel(tex.format)
  const tight = tex.width * bpp
  const padded = Math.ceil(tight / 256) * 256

  const buffer = ctx.device.createBuffer({
    size: padded * tex.height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const encoder = ctx.device.createCommandEncoder({ label: 'readback' })
  encoder.copyTextureToBuffer(
    { texture: tex.texture },
    { buffer, bytesPerRow: padded, rowsPerImage: tex.height },
    { width: tex.width, height: tex.height },
  )
  ctx.device.queue.submit([encoder.finish()])

  await buffer.mapAsync(GPUMapMode.READ)
  const src = new Uint8Array(buffer.getMappedRange())
  const out = new Uint8Array(tight * tex.height)
  if (padded === tight) {
    out.set(src.subarray(0, out.length))
  } else {
    for (let y = 0; y < tex.height; y++) {
      out.set(src.subarray(y * padded, y * padded + tight), y * tight)
    }
  }
  buffer.unmap()
  buffer.destroy()
  return out.buffer
}

export function createTarget(
  ctx: Ctx,
  width: number,
  height: number,
  opts: TextureOptions = {},
): RenderTarget {
  return createTexture(ctx, width, height, { readable: true, ...opts })
}

/**
 * Two same-sized targets that alternate as source and destination.
 * `write` is the one to render into; `swap()` makes it the new `read`.
 */
export class PingPong {
  private a: RenderTarget
  private b: RenderTarget
  width: number
  height: number

  constructor(ctx: Ctx, width: number, height: number, opts: TextureOptions = {}) {
    this.width = Math.max(1, Math.round(width))
    this.height = Math.max(1, Math.round(height))
    this.a = createTarget(ctx, this.width, this.height, opts)
    this.b = createTarget(ctx, this.width, this.height, opts)
  }

  get read() {
    return this.a
  }
  get write() {
    return this.b
  }

  swap() {
    const t = this.a
    this.a = this.b
    this.b = t
  }

  dispose() {
    this.a.destroy()
    this.b.destroy()
  }
}
