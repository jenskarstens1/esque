/**
 * Passes: WGSL reflection, uniform packing, pipelines and drawing.
 *
 * WebGL2 sets uniforms one at a time by name; WebGPU wants a single buffer laid
 * out to the uniform address space's alignment rules. Rather than hand-write a
 * struct and a writer for each of the fifteen shaders, this module reads the
 * `struct U` the shader already declares and derives the layout from it. The
 * shader stays the single source of truth, and call sites keep the
 * `.set('uName', value)` shape they had under WebGL2.
 */

import type { Ctx, Tex } from './device'
import {
  parseBindings,
  parseLayout,
  samplerKind,
  type Bindings,
  type Layout,
  type Member,
} from './uniforms'

/**
 * One vertex shader serves every pass: a full-screen triangle, no buffers.
 *
 * The V coordinate is deliberately flipped. WebGPU and GL disagree twice over:
 * clip y = +1 is the *top* of the target in WebGPU but the *bottom* in GL, and
 * texture V = 0 is the *first* row of data in both. Feeding the raw triangle
 * position through as UV therefore samples row 0 while writing to row H-1 —
 * every pass would be a vertical mirror, and a chain of them would alternate.
 *
 * Flipping V here restores the identity GL had, so a pass that samples the
 * pixel it is writing gets the same pixel, and every spatial effect (vignette,
 * gradient masks, geometry) lands where it did before in data space.
 */
export const FULLSCREEN_VS = /* wgsl */ `
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  // 0,1,2 -> a triangle that covers the viewport with no attributes.
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var out: VSOut;
  out.uv = vec2f(p.x, 1.0 - p.y);
  out.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  return out;
}
`

// ---------------------------------------------------------------------------
// Pass
// ---------------------------------------------------------------------------

type UniformValue = number | boolean | Float32Array | number[] | Int32Array

/**
 * One fragment shader, its pipeline, and a staging buffer for its uniforms.
 *
 * A pass is reused across frames: `set` and `tex` accumulate into local state,
 * and the bind group is rebuilt at draw time only when the bound textures have
 * actually changed.
 */
export class Pass {
  readonly pipeline: GPURenderPipeline
  /**
   * Shader compilation diagnostics.
   *
   * WebGPU reports WGSL errors asynchronously, and an invalid pipeline does not
   * throw: it silently turns the whole render pass into a no-op, so the target
   * keeps whatever it held before. That failure mode is almost impossible to
   * read from the pixels, so every pass surfaces its errors here.
   */
  readonly compilation: Promise<string[]>
  private ctx: Ctx
  private layout: Layout
  private bindings: Bindings
  private bindLayout: GPUBindGroupLayout
  private buffer: GPUBuffer
  private data: ArrayBuffer
  private f32: Float32Array
  private i32: Int32Array
  private bound = new Map<string, Tex | null>()
  private group: GPUBindGroup | null = null
  private groupKey = ''
  private label: string
  /** Uniform block size rounded up to the device's dynamic-offset alignment. */
  private slotSize: number
  /** Slots the buffer currently holds. */
  private capacity = 1
  /** Slot the next draw in this frame will use. */
  private cursor = 0
  private frameId = -1

  constructor(ctx: Ctx, source: string, format: GPUTextureFormat, label: string) {
    this.ctx = ctx
    this.label = label
    this.layout = parseLayout(source)
    this.bindings = parseBindings(source)

    const code = `${FULLSCREEN_VS}\n${source}`
    const module = ctx.device.createShaderModule({ code, label })

    this.compilation = module.getCompilationInfo().then((info) => {
      const errs = info.messages
        .filter((m) => m.type === 'error')
        .map((m) => `${label}:${m.lineNum}:${m.linePos}: ${m.message}`)
      for (const e of errs) console.error(`[esque] ${e}`)
      return errs
    })

    const entries: GPUBindGroupLayoutEntry[] = []
    if (this.bindings.uniform >= 0) {
      entries.push({
        binding: this.bindings.uniform,
        visibility: GPUShaderStage.FRAGMENT,
        // See `prepare`: one slot per draw, chosen at bind time.
        buffer: { type: 'uniform', hasDynamicOffset: true },
      })
    }
    for (const s of this.bindings.samplers) {
      entries.push({
        binding: s.binding,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      })
    }
    for (const t of this.bindings.textures) {
      entries.push({
        binding: t.binding,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float', viewDimension: '2d' },
      })
    }

    this.bindLayout = ctx.device.createBindGroupLayout({ entries, label: `${label} bindings` })
    this.pipeline = ctx.device.createRenderPipeline({
      label,
      layout: ctx.device.createPipelineLayout({ bindGroupLayouts: [this.bindLayout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    })

    this.data = new ArrayBuffer(Math.max(this.layout.size, 16))
    this.f32 = new Float32Array(this.data)
    this.i32 = new Int32Array(this.data)
    const align = ctx.device.limits.minUniformBufferOffsetAlignment
    this.slotSize = Math.ceil(this.data.byteLength / align) * align
    this.buffer = ctx.device.createBuffer({
      size: this.slotSize * this.capacity,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: `${label} uniforms`,
    })
  }

  /** Reallocates the uniform buffer to hold `slots` draws. */
  private grow(slots: number) {
    // The outgoing buffer is dropped rather than destroyed: draws already
    // recorded into the current frame still hold a bind group pointing at it,
    // and destroying it here would invalidate them before they ever run.
    // Growth doubles, so this happens a handful of times and then never again.
    this.capacity = slots
    this.buffer = this.ctx.device.createBuffer({
      size: this.slotSize * this.capacity,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: `${this.label} uniforms`,
    })
    this.group = null
  }

  /** Resets nothing; kept so call sites read the same as the WebGL2 version. */
  use(): this {
    return this
  }

  set(name: string, value: UniformValue): this {
    const m = this.layout.members.get(name)
    if (!m) return this
    const at = m.offset >> 2

    if (typeof value === 'boolean') {
      if (m.kind === 'i32' || m.kind === 'u32') this.i32[at] = value ? 1 : 0
      else this.f32[at] = value ? 1 : 0
      return this
    }
    if (typeof value === 'number') {
      if (m.kind === 'i32' || m.kind === 'u32') this.i32[at] = value | 0
      else this.f32[at] = value
      return this
    }

    const v = value as ArrayLike<number>
    if (m.kind === 'mat3x3f') {
      // Nine tightly packed floats become three vec4 columns.
      for (let c = 0; c < 3; c++) {
        this.f32[at + c * 4] = v[c * 3]
        this.f32[at + c * 4 + 1] = v[c * 3 + 1]
        this.f32[at + c * 4 + 2] = v[c * 3 + 2]
        this.f32[at + c * 4 + 3] = 0
      }
      return this
    }
    if (m.count > 0) {
      this.writeArray(m, v)
      return this
    }
    for (let i = 0; i < v.length; i++) this.f32[at + i] = v[i]
    return this
  }

  /**
   * Uploads an array of vectors, e.g. the brush dabs.
   *
   * The uniform address space pads every array element out to sixteen bytes, so
   * a run of `vec2f` cannot simply be memcpy'd — each one has to land on its own
   * sixteen-byte boundary or the values arrive interleaved with garbage.
   */
  setVectors(name: string, data: Float32Array, components: 2 | 3 | 4): this {
    const m = this.layout.members.get(name)
    if (!m) return this
    this.writeArray(m, data, components)
    return this
  }

  private writeArray(m: Member, v: ArrayLike<number>, components?: number) {
    // A scalar array has to be declared `array<vec4f, N>` because the uniform
    // address space demands a sixteen-byte stride. When the caller supplies
    // exactly one value per element it means that shape, so the value goes to
    // `.x` and the padding is left alone.
    const perElement =
      v.length === m.count ? 1 : m.kind === 'vec4f' ? 4 : m.kind === 'vec3f' ? 3 : m.kind === 'vec2f' ? 2 : 1
    const per = components ?? perElement
    const strideF = m.stride >> 2
    const n = Math.min(m.count, Math.floor(v.length / per))
    const base = m.offset >> 2
    for (let e = 0; e < n; e++) {
      const dst = base + e * strideF
      for (let c = 0; c < per; c++) this.f32[dst + c] = v[e * per + c]
    }
  }

  setInt(name: string, value: number): this {
    const m = this.layout.members.get(name)
    if (!m) return this
    if (m.kind === 'i32' || m.kind === 'u32') this.i32[m.offset >> 2] = value | 0
    else this.f32[m.offset >> 2] = value
    return this
  }

  /**
   * Binds a texture to the name the shader declared it under.
   *
   * `null` is a real value here, not a no-op: it means "this draw does not read
   * that texture". A shader that either applies a LUT or does not — `maskApply`
   * is one — guards the sample behind a flag and passes null for the rest, and
   * the binding still has to point at something legal. Never calling `tex` for
   * a declared texture stays an error, so a genuine omission is still caught.
   */
  tex(name: string, texture: Tex | null): this {
    if (this.bound.get(name) !== texture || !this.bound.has(name)) {
      this.bound.set(name, texture)
      this.group = null
    }
    return this
  }

  /**
   * Reserves this draw's uniform slot and returns what to bind.
   *
   * This is the subtle one. `queue.writeBuffer` is ordered on the *queue*, not
   * inside the command encoder — every write issued before a `submit` lands
   * before any command in it runs. A `Frame` records an entire graph and
   * submits once, so a cached pass drawn twice with different uniforms used to
   * have both writes land first and both draws read the second set. The damage
   * was quiet and specific: every brush chunk rasterised with the last chunk's
   * dabs, every mask component merged with the last one's blend mode, and a
   * before/after comparison presented the same pane twice.
   *
   * So each draw takes its own slice of the buffer and binds it by dynamic
   * offset. The cursor resets per frame, and reusing a slot in a later frame is
   * safe for exactly the reason the bug existed: that write is queued after the
   * previous frame's commands were submitted, so it cannot overtake them.
   */
  prepare(frame: Frame): { group: GPUBindGroup; offsets: number[] } {
    if (frame.id !== this.frameId) {
      this.frameId = frame.id
      this.cursor = 0
    }
    if (this.cursor >= this.capacity) this.grow(Math.max(this.capacity * 2, this.cursor + 1))
    const offset = this.cursor * this.slotSize
    this.cursor++

    const key = this.bindings.textures
      .map((t) => {
        if (!this.bound.has(t.name)) return `${t.binding}:_`
        const tex = this.bound.get(t.name)
        return tex ? `${t.binding}:${tex.filter}:${tex.mipsReady ? 'm' : 'f'}` : `${t.binding}:0`
      })
      .join('|')

    this.ctx.device.queue.writeBuffer(this.buffer, offset, this.data)

    const offsets = this.bindings.uniform >= 0 ? [offset] : []
    if (this.group && key === this.groupKey) return { group: this.group, offsets }

    const entries: GPUBindGroupEntry[] = []
    if (this.bindings.uniform >= 0) {
      // `size` is one slot, not the whole buffer: the dynamic offset picks which.
      entries.push({
        binding: this.bindings.uniform,
        resource: { buffer: this.buffer, offset: 0, size: this.data.byteLength },
      })
    }
    // A mip sampler over a texture whose mips were never generated reads
    // uninitialised memory. `mipmapFilter` starts blending level 1 in as soon
    // as the draw minifies at all, so the output pass only has to be a few per
    // cent under 1:1 for that to reach the screen — long before anything
    // decides the view is small enough to be worth building a chain for.
    const mipsReady = this.bindings.textures.some((t) => {
      const tex = this.bound.get(t.name)
      return !!tex && tex.mipLevels > 1 && tex.mipsReady
    })
    for (const s of this.bindings.samplers) {
      const kind = samplerKind(s.name)
      entries.push({
        binding: s.binding,
        resource: this.ctx.samplers[kind === 'mip' && !mipsReady ? 'linear' : kind],
      })
    }
    for (const t of this.bindings.textures) {
      if (!this.bound.has(t.name)) {
        throw new Error(`[esque] ${this.label}: texture "${t.name}" was never bound`)
      }
      const tex = this.bound.get(t.name)
      entries.push({
        binding: t.binding,
        resource: tex ? tex.view : placeholderView(this.ctx.device),
      })
    }

    this.group = this.ctx.device.createBindGroup({
      layout: this.bindLayout,
      entries,
      label: `${this.label} group`,
    })
    this.groupKey = key
    return { group: this.group, offsets }
  }

  dispose() {
    this.buffer.destroy()
    this.bound.clear()
    this.group = null
  }
}

/**
 * A 1x1 view bound wherever a shader declares a texture the draw does not read.
 *
 * A WGSL bind group has to be complete: leaving a declared binding empty makes
 * the pipeline invalid, and an invalid pipeline turns the whole render pass
 * into a silent no-op. WebGL had no such rule — an unbound sampler simply read
 * nothing — so passes that switch a feature off by not binding its texture were
 * previously free. One per device, kept weakly so a disposed device takes it.
 */
const placeholders = new WeakMap<GPUDevice, GPUTextureView>()

function placeholderView(device: GPUDevice): GPUTextureView {
  let view = placeholders.get(device)
  if (!view) {
    view = device
      .createTexture({
        size: [1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        label: 'unbound texture placeholder',
      })
      .createView()
    placeholders.set(device, view)
  }
  return view
}

/**
 * Compiles once per source string and target format.
 *
 * The format is part of the key because a pipeline is tied to the format it
 * renders into, and the presentation surface changes format when HDR is
 * toggled — the same shader then needs a second pipeline, not a rebuild.
 */
export class PassCache {
  private map = new Map<string, Pass>()
  private ctx: Ctx

  constructor(ctx: Ctx) {
    this.ctx = ctx
  }

  get(key: string, source: string, format: GPUTextureFormat = 'rgba16float'): Pass {
    const id = `${key}@${format}`
    let p = this.map.get(id)
    if (!p) {
      p = new Pass(this.ctx, source, format, key)
      this.map.set(id, p)
    }
    return p
  }

  dispose() {
    this.map.forEach((p) => p.dispose())
    this.map.clear()
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

export interface Viewport {
  x: number
  y: number
  width: number
  height: number
}

/**
 * A batch of passes sharing one command encoder.
 *
 * A full edit graph is twenty-odd passes; submitting each on its own would pay
 * the queue cost twenty times over for no reason.
 */
let frameSeq = 0

export class Frame {
  readonly encoder: GPUCommandEncoder
  /** Lets a pass notice it is being drawn into a new frame and reuse slot 0. */
  readonly id = ++frameSeq
  private ctx: Ctx

  constructor(ctx: Ctx) {
    this.ctx = ctx
    this.encoder = ctx.device.createCommandEncoder()
  }

  submit() {
    this.ctx.device.queue.submit([this.encoder.finish()])
  }
}

export interface DrawOptions {
  /** Restricts drawing to part of the target. Used when presenting panes. */
  viewport?: Viewport
  /** Clears first. Presentation clears; graph passes overwrite every pixel. */
  clear?: boolean
}

/**
 * Draws one full-screen pass into `target`.
 *
 * Accepts a `Tex` rather than a view so the level-0 attachment view is chosen
 * here: handing a mipped texture's full-chain view to a colour attachment is
 * invalid, and it is the kind of mistake that only shows up on the one texture
 * that has a chain. A bare view is still allowed for the swap-chain surface,
 * which has no `Tex` behind it.
 */
export function drawPass(
  frame: Frame,
  target: Tex | GPUTextureView,
  pass: Pass,
  opts: DrawOptions = {},
) {
  const view = target instanceof GPUTextureView ? target : target.attach
  const { group, offsets } = pass.prepare(frame)
  const rp = frame.encoder.beginRenderPass({
    colorAttachments: [
      {
        view,
        loadOp: opts.clear ? 'clear' : 'load',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
    ],
  })
  if (opts.viewport) {
    const v = opts.viewport
    // GL clipped a viewport that ran off the attachment; WebGPU rejects it, and
    // a rejected render pass is a *silent* no-op that leaves the target holding
    // its previous contents. Rects arrive here rounded from float layout maths,
    // so one pixel of overhang is entirely reachable — clamp rather than trust.
    const lim =
      target instanceof GPUTextureView ? null : { w: target.width, h: target.height }
    const x = Math.max(0, Math.floor(v.x))
    const y = Math.max(0, Math.floor(v.y))
    const w = Math.max(1, Math.round(v.width))
    const h = Math.max(1, Math.round(v.height))
    const cw = lim ? Math.min(w, Math.max(1, lim.w - x)) : w
    const chh = lim ? Math.min(h, Math.max(1, lim.h - y)) : h
    rp.setViewport(x, y, cw, chh, 0, 1)
    rp.setScissorRect(x, y, cw, chh)
  }
  rp.setPipeline(pass.pipeline)
  rp.setBindGroup(0, group, offsets)
  rp.draw(3)
  rp.end()
  // Any mip chain now describes the previous contents.
  if (!(target instanceof GPUTextureView)) target.mipsReady = false
}
