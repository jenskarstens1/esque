/**
 * Mip chain generation.
 *
 * WebGL2 hands this to the driver via `generateMipmap`. WebGPU has no such
 * call — mip levels are ordinary render targets and the chain has to be walked
 * by hand, each level rendered from the one above it.
 *
 * The pipeline only needs mips in one place: the presentation source, so a
 * zoomed-out view minifies without aliasing. Nothing in the edit graph samples
 * a mip, so this runs once per changed frame rather than per pass.
 *
 * The filter is a plain 2x2 box, taken with `textureLoad` rather than a
 * sampler so the result does not depend on any filtering state. For even
 * dimensions that is exactly what `generateMipmap` produces. For odd ones GL
 * uses a wider weighted kernel and this will differ slightly; the difference
 * lands only in minified preview pixels, never in exported output, which is
 * rendered at full resolution and never samples a mip.
 */
import { FULLSCREEN_VS } from './pass'
import type { Ctx, Tex } from './device'

const DOWNSAMPLE_FS = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let dst = vec2i(pos.xy);
  let dim = vec2i(textureDimensions(src, 0));
  let base = dst * 2;
  // An odd source level leaves the last column or row without a partner;
  // clamping folds it onto itself rather than reading out of bounds.
  let x1 = min(base.x + 1, dim.x - 1);
  let y1 = min(base.y + 1, dim.y - 1);
  let a = textureLoad(src, vec2i(base.x, base.y), 0);
  let b = textureLoad(src, vec2i(x1, base.y), 0);
  let c = textureLoad(src, vec2i(base.x, y1), 0);
  let d = textureLoad(src, vec2i(x1, y1), 0);
  return (a + b + c + d) * 0.25;
}
`

const pipelines = new WeakMap<GPUDevice, Map<string, GPURenderPipeline>>()

const BLACK = { r: 0, g: 0, b: 0, a: 0 }

function pipelineFor(ctx: Ctx, format: GPUTextureFormat): GPURenderPipeline {
  let byFormat = pipelines.get(ctx.device)
  if (!byFormat) {
    byFormat = new Map()
    pipelines.set(ctx.device, byFormat)
  }
  const hit = byFormat.get(format)
  if (hit) return hit

  const module = ctx.device.createShaderModule({
    code: `${FULLSCREEN_VS}\n${DOWNSAMPLE_FS}`,
    label: 'mipmap',
  })
  const pipeline = ctx.device.createRenderPipeline({
    label: `mipmap:${format}`,
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  })
  byFormat.set(format, pipeline)
  return pipeline
}

/**
 * Fills levels 1..n of `tex` from level 0.
 *
 * A no-op when the texture has no chain or its chain is already current, so
 * callers can invoke it unconditionally before presenting. `writeTexture` and
 * every render into a target clear `mipsReady`, which is what makes that safe.
 */
export function generateMips(ctx: Ctx, tex: Tex, encoder?: GPUCommandEncoder) {
  if (tex.mipLevels <= 1 || tex.mipsReady) return

  const pipeline = pipelineFor(ctx, tex.format)
  const own = !encoder
  const enc = encoder ?? ctx.device.createCommandEncoder({ label: 'mipmap' })

  for (let level = 1; level < tex.mipLevels; level++) {
    const srcView = tex.texture.createView({
      baseMipLevel: level - 1,
      mipLevelCount: 1,
    })
    const dstView = tex.texture.createView({
      baseMipLevel: level,
      mipLevelCount: 1,
    })
    const bind = ctx.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: srcView }],
    })
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: dstView, loadOp: 'clear', storeOp: 'store', clearValue: BLACK }],
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bind)
    pass.draw(3)
    pass.end()
  }

  if (own) ctx.device.queue.submit([enc.finish()])
  tex.mipsReady = true
}
