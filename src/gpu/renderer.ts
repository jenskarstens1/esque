import {
  configureSurface,
  createContext,
  createTarget,
  createTexture,
  PingPong,
  readTexture,
  writeTexture,
  type Ctx,
  type GPUCaps,
  type Tex,
} from './device'
import { drawPass, Frame, Pass, PassCache } from './pass'
import { generateMips } from './mipmap'
import { RENDER_FS, SCENE_INPUT_FS } from './wgsl/basic'
import { BLUR_FS, CLEAR_FS, COPY_FS } from './wgsl/blur'
import { BW_FS, COLORMIX_FS } from './wgsl/colormix'
import { CURVE_FS } from './wgsl/curve'
import { DEFRINGE_FS, DENOISE_FS, IMPULSE_FS, SHARPEN_FS } from './wgsl/detail'
import { EFFECTS_FS } from './wgsl/effects'
import { GEOMETRY_FS } from './wgsl/geometry'
import { GRADING_FS } from './wgsl/grading'
import { LOCAL_FS } from './wgsl/local'
import {
  MASK_APPLY_FS,
  MASK_BLEND,
  MASK_FS,
  MASK_KIND,
  MASK_MERGE_FS,
  MASK_SHOW_FS,
  MAX_DABS,
  MAX_SAMPLES,
} from './wgsl/mask'
import { SPOT_FS, RED_EYE_FS, MAX_SPOTS, MAX_EYES } from './wgsl/retouch'
import { OUTPUT_FS } from './wgsl/output'
import { DETAILBANDS_FS, RECOVER_FS, TONEMAP_FS } from './wgsl/tone'
import {
  apply3,
  calibrationMatrix,
  outputGamma,
  outputLuma,
  outputMatrix,
  outputToOutputMatrix,
  SRGB_D65_TO_PROPHOTO_D50,
  toGl,
  whiteBalanceGain,
  type OutputSpace,
} from './colorspace'
import {
  composeLut,
  isIdentityParametric,
  isIdentityPoints,
  LUT_SIZE,
  parametricLut,
  splineLut,
} from './curves'
import { geometryOutputSize, isIdentityGeometry } from './geometry'
import {
  COLOR_BANDS,
  isAiGeometry,
  type CurvePoint,
  type Edits,
  type Layer,
  type LayerTransform,
} from '../core/types'
import { profileRender } from '../core/profiles'
import type { SourceImage } from '../core/workingImage'
import { floatToHalf, halfToFloat } from '../core/half'
import { getAlpha } from '../ai/alpha'
import { BLEND_MODE_INDEX } from './wgsl/blend'
import { getLayerPixels } from '../develop/layerPixels'
import { findLayer } from '../develop/layers'

export type { SourceImage } from '../core/workingImage'

/** Draws a mask's coverage over the image, so you can see what you painted. */
export interface MaskOverlay {
  maskId: string
  /** 'tint' paints the covered area; 'coverage' shows the mask on its own. */
  mode?: 'tint' | 'coverage'
  tint?: [number, number, number]
  amount?: number
}

export interface RenderOptions {
  /** Destination rect in canvas pixels. */
  rect?: { x: number; y: number; width: number; height: number }
  outputSpace?: OutputSpace
  showShadowClip?: boolean
  showHighlightClip?: boolean
  /**
   * Where the overlays start calling a pixel lost, as display values. Default
   * to the edge of the encodable range, which is the literal reading of
   * "clipped"; the Display pane can bring them in to ask the looser question of
   * what will survive a print.
   */
  clipHighlight?: number
  clipShadow?: number
  /** Renders the unedited image, for before/after. */
  bypass?: boolean
  /** Shows one mask's coverage instead of a clean render. */
  maskOverlay?: MaskOverlay | null
  /**
   * How far above display white the output may reach, as a linear multiple.
   * 1 is SDR and clips at white, which is what export and the histogram want;
   * the viewport passes the display's headroom when HDR viewing is on.
   */
  hdrHeadroom?: number
  /**
   * Stable identity for everything that feeds the edit graph.
   *
   * Panning and zooming move the destination rect and nothing else, so the
   * previous graph result is still exactly right. When this matches the key the
   * last run was given the graph is skipped entirely and a pan costs one output
   * pass instead of the whole stack. Omit it to always re-run.
   */
  graphKey?: string | null
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * One image in a compare layout.
 *
 * `rect` is where the whole image would land if nothing were in the way;
 * `clip` restricts what actually gets drawn, which is how a split view shows
 * two graphs through the same window without either one moving.
 */
export interface Pane {
  edits: Edits
  rect: Rect
  clip?: Rect
  /**
   * Stable identity for this pane's edit graph. When it matches the previous
   * frame's the graph is skipped and the cached result redrawn — which is what
   * keeps a live slider drag at one graph run per frame instead of two.
   */
  cacheKey?: string
}

export interface HistogramBins {
  r: Uint32Array
  g: Uint32Array
  b: Uint32Array
  l: Uint32Array
  max: number
  clipShadow: number
  clipHighlight: number
}

const HIST_W = 320

/**
 * Where HDR expansion fades in, as a display value.
 *
 * The render shoulder starts folding highlights at about three quarters of the
 * way up, so that is where re-opening them belongs: below it the picture a
 * photographer graded on an SDR display is left exactly alone, and only the
 * part that was compressed to fit gets its range back. How *far* it gets back
 * is the scene peak's business, not this constant's.
 */
const HDR_KNEE = 0.75

/**
 * Where the clipping overlays fall when nobody has said otherwise.
 *
 * The literal edges of the encodable range: a channel within half a code value
 * of white is blown, and a pixel whose three channels all sit within the first
 * code value of black is blocked. Anything looser is a judgement about output,
 * which is the caller's to make and the Display pane's to offer.
 */
export const CLIP_HIGHLIGHT_DEFAULT = 0.995
export const CLIP_SHADOW_DEFAULT = 0.0025

/**
 * A frame's shape as a pair whose longer side is 1.
 *
 * Working in these units means a radius is a circle and a rotation doesn't
 * shear, whatever the photo's proportions.
 */
function aspectVec(width: number, height: number): [number, number] {
  const long = Math.max(width, height)
  return [width / long, height / long]
}

/** The sRGB transfer function, for artwork authored in display values. */
function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

/** A fill colour as the working space sees it: linear ProPhoto. */
function linearFill(color: [number, number, number]): [number, number, number] {
  const linear: [number, number, number] = [
    srgbToLinear(color[0]),
    srgbToLinear(color[1]),
    srgbToLinear(color[2]),
  ]
  return apply3(SRGB_D65_TO_PROPHOTO_D50, linear)
}

/**
 * An imported picture's scale, fitted inside the frame without cropping it.
 *
 * The factor is the reciprocal of the drawn size because the shader samples
 * backwards: it asks which pixel of the import lands here, not where this
 * pixel of the import goes.
 */
function containFit(
  imageW: number,
  imageH: number,
  frameW: number,
  frameH: number,
): [number, number] {
  if (imageW <= 0 || imageH <= 0) return [1, 1]
  const frame = aspectVec(frameW, frameH)
  const image = aspectVec(imageW, imageH)
  const scale = Math.min(frame[0] / image[0], frame[1] / image[1])
  return [1 / (image[0] * scale), 1 / (image[1] * scale)]
}

/**
 * A layer transform, inverted, in the form the shader wants.
 *
 * The pass runs per destination pixel and has to find the source, so what goes
 * to the GPU is the inverse of what the user set: undo the move, undo the
 * scale, undo the rotation, undo the flips. Offsets are a percentage of the
 * long edge so a nudge means the same thing on any crop.
 */
function inverseLayerTransform(
  t: LayerTransform,
  aspect: [number, number],
): { matrix: [number, number, number, number]; offset: [number, number] } {
  const scale = t.scale > 0 ? t.scale / 100 : 1
  const theta = (-t.rotate * Math.PI) / 180
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const fx = t.flipH ? -1 : 1
  const fy = t.flipV ? -1 : 1
  // Row-major F * (1/s) * R(-theta).
  return {
    matrix: [
      (fx * cos) / scale,
      (fx * -sin) / scale,
      (fy * sin) / scale,
      (fy * cos) / scale,
    ],
    offset: [(t.offsetX / 100) * aspect[0], (t.offsetY / 100) * aspect[1]],
  }
}

type GraphState = {
  chain: PingPong
  active: PingPong
  input: Tex
  width: number
  height: number
  texel: [number, number]
  pass: (program: Pass, setup: (program: Pass) => void) => void
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export class Renderer {
  /** The underlying WebGPU context; exposed so other modules can reach the device. */
  readonly ctx: Ctx
  readonly caps: GPUCaps
  private canvas: HTMLCanvasElement | OffscreenCanvas
  private cache: PassCache

  /** What the UI asked for, and what the surface is actually doing. */
  private hdrWanted = false
  private hdrOn = false
  /** Size the surface was last configured at; see `resize`. */
  private bufferSize = { width: 0, height: 0 }

  private source: Tex | null = null
  private sourceInfo: SourceImage | null = null
  private asShot = { temp: 5500, tint: 0 }

  /**
   * Main ping-pong chain for the edit graph.
   * Created with mips so a zoomed-out presentation can minify without aliasing.
   */
  private chain: PingPong | null = null
  /** One live pane's scene-linear input, before exposure and creative edits. */
  private captureCache: { inputs: (number | string)[]; target: Tex } | null = null
  /**
   * Scratch blur chains, keyed by downscale factor *and* size.
   *
   * The graph blurs at chain size before geometry and at cropped size after
   * it, so one frame can ask the same factor for two different shapes. Keying
   * on the factor alone made the second request destroy a texture the first
   * request's pass had already been encoded to read.
   */
  private aux = new Map<string, { chain: PingPong; frame: number }>()
  /**
   * Chains replaced inside the frame currently being encoded.
   *
   * A resize is not a safe moment to free the old textures: a compare pass
   * records the "before" pane, resizes for the differently cropped "after"
   * pane, and submits both together. Freeing at the resize would destroy
   * textures the first pane's commands still read. Held until the next frame
   * begins, by which point the submission that could reference them is done.
   */
  private retired: PingPong[] = []
  /** Counts encoded frames, so a chain can be retired once nothing wants it. */
  private frameSeq = 0
  /** Where the graph continues once geometry has changed the image's size. */
  private geom: PingPong | null = null
  /** Full-resolution accumulator for a tiled export; see beginComposite. */
  private composite: Tex | null = null
  /** False when `source` is owned by something else, such as the accumulator. */
  private ownsSource = true
  /** True while the loaded image has already been through the colour graph. */
  private graded = false
  /**
   * Curve LUTs held for the frame being encoded.
   *
   * A queue write lands ahead of the commands the encoder is still collecting,
   * so uploading every curve into one texture makes the last upload the one
   * every draw in the frame reads. Any frame carrying more than one curve —
   * several layers, or a before/after pair — therefore takes a texture per
   * curve, and the pool is rewound when the next frame opens.
   */
  private lutPool: Tex[] = []
  private lutCursor = 0
  private lutData = new Float32Array(LUT_SIZE * 4)
  /** Layer coverage buffers, sized to the framed image. */
  private maskAcc: PingPong | null = null
  private maskScratch: PingPong | null = null
  private maskLutData = new Float32Array(LUT_SIZE * 4)
  /**
   * Segmentation coverage, uploaded once per cache key.
   *
   * The pixels themselves belong to `ai/alpha`, which holds them for the
   * session and persists them to OPFS; this is only the GPU's copy, rebuilt
   * from that whenever a key it has not seen turns up in a mask.
   */
  private aiTex = new Map<string, Tex>()
  /** Uploaded pixels for image layers, keyed by their content hash. */
  private layerTex = new Map<string, Tex>()
  /** Coverage copied out of the shared accumulator so it outlives the next mask. */
  private coverageSlots = new Map<string, PingPong>()
  /** One full-size chain per nesting depth, for groups that render in isolation. */
  private groupChains: (PingPong | undefined)[] = []
  /** Framed-space coverage, one per AI component in the current mask. */
  private aiFramed: PingPong | null = null
  /**
   * The geometry stage's uniforms, or null when it was skipped.
   *
   * AI coverage is produced on the *sensor* grid — the network reads the proxy,
   * which knows nothing about the crop — while layers are rasterised in the
   * framed image the user sees. Replaying the same transform over the coverage
   * is what reconciles the two, and it is exact by construction rather than by
   * a second implementation that has to be kept in step. Detecting a subject
   * therefore survives a later crop or straighten without re-running.
   */
  private frameGeom: Record<string, number | number[]> | null = null

  private histTarget: Tex | null = null

  /** Result of the last edit graph, before the output transform. */
  private lastResult: Tex | null = null
  /** The same, but before any mask overlay was tinted over it. */
  private lastClean: Tex | null = null
  /** Its size, which a crop makes different from the source's. */
  private lastSize = { width: 0, height: 0 }

  /** Size of the rendered image — what `readPixels` crops are measured in. */
  get outputSize() {
    return this.lastSize.width ? { ...this.lastSize } : null
  }
  private lastMipped = false
  /**
   * The `graphKey` `lastResult` was produced for, or `null` when it was made by
   * a path that never claimed one and so can never be reused.
   */
  private lastGraphKey: string | null = null

  /**
   * Counts presented frames.
   *
   * A WebGPU canvas can only be read back — via `drawImage` into a 2D context —
   * within the task that submitted the frame, and WebKit is unreliable about
   * repeated partial reads of one presented texture. Anything sampling the
   * canvas should therefore snapshot it once per frame, and this is how it
   * knows a new frame arrived.
   */
  private _frames = 0
  get frames() {
    return this._frames
  }

  /** Cached graph result for a pane whose edits are holding still. */
  private paneCache: { key: string; target: Tex; mipped: boolean } | null = null

  /** Where the loaded image sits inside the frame it belongs to; see setFrame. */
  private frame: {
    resolution: [number, number]
    offset: [number, number]
    scale: [number, number]
  } = { resolution: [1, 1], offset: [0, 0], scale: [1, 1] }

  /** The encoder the current render is recording into. */
  private enc: Frame | null = null

  private constructor(ctx: Ctx, canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.ctx = ctx
    this.caps = ctx.caps
    this.canvas = canvas
    this.cache = new PassCache(ctx)
  }

  /**
   * `presenting` marks the on-screen canvas — the one that may be asked for HDR
   * later. Without a surface the renderer is useful for offscreen work such as
   * export and auto-tone: it skips surface configuration and readback stays the
   * only route to pixels.
   *
   * Left unset it follows the canvas: an `HTMLCanvasElement` presents, an
   * `OffscreenCanvas` does not. Passing `false` for a canvas in the document
   * makes `render` a no-op, so the flag is only worth setting to disagree.
   */
  static async create(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    opts?: { presenting?: boolean },
  ): Promise<Renderer> {
    const ctx = await createContext(canvas, { presenting: opts?.presenting })
    if (!ctx) throw new Error('WebGPU is unavailable in this browser.')
    return new Renderer(ctx, canvas)
  }

  // -------------------------------------------------------------------------
  // High dynamic range
  // -------------------------------------------------------------------------

  /** Whether this canvas can present above display white at all. */
  get hdrCapable() {
    return this.caps.hdrPresent
  }

  /** Whether it is doing so right now. */
  get hdrPresenting() {
    return this.hdrOn
  }

  /**
   * Asks for — or gives up — an extended-range surface.
   *
   * The surface itself is only reconfigured on the next resize, which every
   * paint goes through, so a toggle costs one reconfigure in the frame that
   * draws it rather than one the moment a menu item is clicked.
   */
  setHdr(on: boolean) {
    if (this.hdrWanted === on) return
    this.hdrWanted = on
    this.bufferSize = { width: 0, height: 0 }
  }

  // -------------------------------------------------------------------------
  // Source
  // -------------------------------------------------------------------------

  setImage(image: SourceImage) {
    this.disposeSource()
    this.graded = false

    this.sourceInfo = image
    this.asShot = image.asShot
    const tex = createTexture(this.ctx, image.width, image.height, {
      format: 'rgba16float',
      filter: 'linear',
    })
    writeTexture(this.ctx, tex, image.data)
    this.source = tex
    // Mips allocated so a minified viewport can present without aliasing.
    this.chain = new PingPong(this.ctx, image.width, image.height, { mips: true })
    this.lastResult = null
    this.lastClean = null
    this.frame = {
      resolution: [image.width, image.height],
      offset: [0, 0],
      scale: [1, 1],
    }
  }

  /**
   * Tells the renderer that the loaded image is a tile of a larger frame.
   *
   * Only the position-dependent passes care — vignette and grain — but without
   * this a tiled export would draw a complete vignette inside every tile.
   * Pass `null` to go back to treating the image as the whole frame.
   */
  setFrame(frame: { width: number; height: number; x: number; y: number } | null) {
    const info = this.sourceInfo
    if (!info) return
    this.frame = frame
      ? {
          resolution: [frame.width, frame.height],
          offset: [frame.x / frame.width, frame.y / frame.height],
          scale: [info.width / frame.width, info.height / frame.height],
        }
      : { resolution: [info.width, info.height], offset: [0, 0], scale: [1, 1] }
    this.lastGraphKey = null
  }

  get imageSize() {
    return this.sourceInfo
      ? { width: this.sourceInfo.width, height: this.sourceInfo.height }
      : { width: 0, height: 0 }
  }

  get asShotWhiteBalance() {
    return this.asShot
  }

  hasImage() {
    return !!this.source
  }

  // -------------------------------------------------------------------------
  // Graph
  // -------------------------------------------------------------------------

  /** Runs the edit passes and leaves the result in `lastResult`. */
  private runGraph(
    edits: Edits,
    bypass: boolean,
    overlay: MaskOverlay | null = null,
    cacheCapture = false,
  ): Tex {
    const src = this.source!
    const chain = this.chain!
    // Whatever `lastResult` was standing for, it isn't standing for it now.
    // `graphFor` re-stamps the key on the way out; every other caller leaves it
    // cleared, which is what stops an export or a compare pane from letting a
    // stale result be reused on screen.
    this.lastGraphKey = null
    if (bypass) {
      this.lastResult = src
      this.lastMipped = false
      this.lastSize = { width: chain.width, height: chain.height }
      return src
    }

    const state: GraphState = {
      chain,
      active: chain,
      input: src,
      width: chain.width,
      height: chain.height,
      texel: [1 / chain.width, 1 / chain.height] as [number, number],
      pass: () => {},
    }
    state.pass = (program, setup) => {
      program.use()
      program.tex('uImage', state.input)
      setup(program)
      drawPass(this.enc!, state.active.write, program)
      state.input = state.active.write
      state.active.swap()
    }

    this.runUngradedStages(edits, state, cacheCapture)
    this.runCreativeStages(edits, state)
    this.runRetouchStages(edits, state)
    this.runGeometryStage(edits, state)
    this.runLocalAdjustments(edits, state)
    this.runEffects(edits, state)

    this.lastClean = state.input
    this.runMaskOverlay(edits, overlay, state)

    this.lastResult = state.input
    this.lastMipped = false
    this.lastSize = { width: state.width, height: state.height }
    return state.input
  }

  private runUngradedStages(edits: Edits, state: GraphState, cacheCapture: boolean) {
    if (this.graded) return
    const { basic, tone, detail, lens, calibration: cal } = edits
    // Snapshot values, not edit-object identities: offscreen callers and checks
    // can mutate an Edits object in place. Only inputs consumed before rendering
    // belong here; exposure, profiles, geometry and local edits are downstream.
    const inputs = cacheCapture && (
      detail.impulseNR > 0 || detail.luminanceNR > 0 || detail.colorNR > 0 ||
      detail.sharpenAmount > 0 || lens.defringePurpleAmount > 0 || lens.defringeGreenAmount > 0 ||
      (this.sourceInfo?.isRaw && tone.recovery !== 'off')
    ) ? [
        tone.recovery, tone.recoveryThreshold,
        basic.wbMode, basic.temp, basic.tint,
        cal.shadowTint, cal.redHue, cal.redSaturation, cal.greenHue,
        cal.greenSaturation, cal.blueHue, cal.blueSaturation,
        detail.impulseNR, detail.luminanceNR, detail.luminanceNRDetail,
        detail.luminanceNRContrast, detail.colorNR, detail.colorNRDetail,
        detail.colorNRSmoothness, detail.sharpenAmount, detail.sharpenRadius,
        detail.sharpenDetail, detail.sharpenMasking,
        lens.defringePurpleAmount, lens.defringePurpleHueLo, lens.defringePurpleHueHi,
        lens.defringeGreenAmount, lens.defringeGreenHueLo, lens.defringeGreenHueHi,
      ] : null
    const cached = this.captureCache
    if (inputs && cached && inputs.length === cached.inputs.length &&
      inputs.every((value, index) => value === cached.inputs[index])) {
      state.input = cached.target
    } else {
      this.runHighlightRecovery(edits, state)
      this.runSceneInput(edits, state)
      this.runCaptureCleanup(edits, state)
      if (inputs) {
        const target = cached?.target ?? createTarget(this.ctx, state.width, state.height)
        this.enc!.encoder.copyTextureToTexture(
          { texture: state.input.texture },
          { texture: target.texture },
          [state.width, state.height],
        )
        this.captureCache = { inputs, target }
      }
    }
    this.runSceneRendering(edits, state)
  }

  private runHighlightRecovery(edits: Edits, state: GraphState) {
    const RECOVERY_MODE: Record<string, number> = { clip: 1, blend: 2, propagate: 3 }
    const mode = RECOVERY_MODE[edits.tone.recovery] ?? 0
    if (!this.sourceInfo?.isRaw || mode === 0) return

    const blurred = mode === 3 ? this.blur(state.input, 2.0, 4) : state.input
    state.pass(this.cache.get('recover', RECOVER_FS), (program) => {
      program.tex('uBlur', blurred)
        .set('uMode', mode)
        .set('uThreshold', edits.tone.recoveryThreshold / 100)
        .set('uWhiteLevel', Math.max(this.sourceInfo?.whiteLevel ?? 1, 1e-6))
    })
  }

  private runSceneInput(edits: Edits, state: GraphState) {
    const b = edits.basic
    const gain =
      b.wbMode === 'asShot'
        ? ([1, 1, 1] as [number, number, number])
        : whiteBalanceGain(this.asShot, { temp: b.temp, tint: b.tint })
    const cal = edits.calibration
    const calMat = calibrationMatrix(cal)
    state.pass(this.cache.get('sceneInput', SCENE_INPUT_FS), (program) => {
      program.set('uWbGain', gain)
        .set('uCalibration', toGl(calMat))
        .set('uShadowTint', cal.shadowTint / 100)
    })
  }

  private runCaptureCleanup(edits: Edits, state: GraphState) {
    this.runImpulseDenoise(edits, state)
    this.runDenoise(edits, state)
    this.runSharpen(edits, state)
    this.runDefringe(edits, state)
  }

  private runImpulseDenoise(edits: Edits, state: GraphState) {
    if (edits.detail.impulseNR <= 0) return
    state.pass(this.cache.get('impulse', IMPULSE_FS), (program) => {
      program.set('uTexel', state.texel).set('uAmount', edits.detail.impulseNR / 100)
    })
  }

  private runDenoise(edits: Edits, state: GraphState) {
    const detail = edits.detail
    if (detail.luminanceNR <= 0 && detail.colorNR <= 0) return
    const denoise = this.cache.get('denoise', DENOISE_FS)
    const apply = (amount = 1) => state.pass(denoise, (program) => {
      program.set('uTexel', state.texel)
        .set('uLuminance', (detail.luminanceNR / 100) * amount)
        .set('uLumaDetail', detail.luminanceNRDetail / 100)
        .set('uLumaContrast', detail.luminanceNRContrast / 100)
        .set('uColor', (detail.colorNR / 100) * amount)
        .set('uColorDetail', detail.colorNRDetail / 100)
        .set('uColorSmoothness', detail.colorNRSmoothness / 100)
    })
    apply()
    const extra = Math.max((detail.luminanceNR - 55) / 45, (detail.colorNR - 60) / 40)
    if (extra > 0) apply(Math.min(1, extra))
  }

  private runSharpen(edits: Edits, state: GraphState) {
    const detail = edits.detail
    if (detail.sharpenAmount <= 0) return
    const blurred = this.blur(state.input, Math.max(0.5, detail.sharpenRadius), 1)
    state.pass(this.cache.get('sharpen', SHARPEN_FS), (program) => {
      program.tex('uBlur', blurred)
        .set('uTexel', state.texel)
        .set('uAmount', (detail.sharpenAmount / 100) * 1.5)
        .set('uDetail', detail.sharpenDetail / 100)
        .set('uMasking', detail.sharpenMasking / 100)
    })
  }

  private runDefringe(edits: Edits, state: GraphState) {
    const lens = edits.lens
    if (lens.defringePurpleAmount <= 0 && lens.defringeGreenAmount <= 0) return
    const window = (lo: number, hi: number, from: number, to: number): [number, number] => {
      const low = from + (to - from) * (Math.min(lo, hi) / 100)
      const high = from + (to - from) * (Math.max(lo, hi) / 100)
      return [low, Math.max(high, low + 0.01)]
    }
    state.pass(this.cache.get('defringe', DEFRINGE_FS), (program) => {
      program.set('uTexel', state.texel)
        .set('uPurple', lens.defringePurpleAmount / 20)
        .set('uPurpleHue', window(lens.defringePurpleHueLo, lens.defringePurpleHueHi, 0.63, 0.97))
        .set('uGreen', lens.defringeGreenAmount / 20)
        .set('uGreenHue', window(lens.defringeGreenHueLo, lens.defringeGreenHueHi, 0.2, 0.45))
    })
  }

  private runSceneRendering(edits: Edits, state: GraphState) {
    const basic = edits.basic
    const isRaw = !!this.sourceInfo?.isRaw
    const profile = profileRender(edits.profile, isRaw)
    const shoulder = profile.shoulder
    state.pass(this.cache.get('render', RENDER_FS), (program) => {
      program.set('uExposure', basic.exposure)
        .set('uContrast', basic.contrast / 100)
        .set('uHighlights', basic.highlights / 100)
        .set('uShadows', basic.shadows / 100)
        .set('uWhites', basic.whites / 100)
        .set('uBlacks', basic.blacks / 100)
        .set('uVibrance', basic.vibrance / 100)
        .set('uSaturation', basic.saturation / 100)
        .set('uProtectSkin', basic.protectSkin ? 1 : 0)
        .set('uAvoidShift', basic.avoidColorShift ? 1 : 0)
        .set('uProfileCurve', profile.curve)
        .set('uProfileSat', profile.saturation)
        .set('uShoulder', shoulder)
    })
  }

  private runCreativeStages(edits: Edits, state: GraphState) {
    this.runToneMapping(edits, state)
    this.runDetailBands(edits, state)
    this.runTextureAdjustments(edits, state)
    this.runToneCurve(edits, state)
    this.runColorMixer(edits, state)
    this.runBlackAndWhite(edits, state)
    this.runColorGrading(edits, state)
  }

  private runToneMapping(edits: Edits, state: GraphState) {
    const tone = edits.tone
    if (!tone.shHighlights && !tone.shShadows && !tone.drcAmount) return
    const downscale = tone.shRadius > 60 ? 16 : tone.shRadius > 25 ? 8 : 4
    const local = this.blur(state.input, 1.5 + tone.shRadius / 22, downscale)
    state.pass(this.cache.get('tonemap', TONEMAP_FS), (program) => {
      program.tex('uBlur', local)
        .set('uHighlights', tone.shHighlights / 100)
        .set('uShadows', tone.shShadows / 100)
        .set('uWidth', Math.max(0.1, tone.shTonalWidth / 100))
        .set('uDrc', tone.drcAmount / 100)
        .set('uDrcDetail', tone.drcDetail / 100)
    })
  }

  private runDetailBands(edits: Edits, state: GraphState) {
    const tone = edits.tone
    if (!tone.detailFinest && !tone.detailFine && !tone.detailCoarse && !tone.detailCoarsest) return
    const l0 = this.blur(state.input, 1.2, 1)
    const l1 = this.blur(l0, 1.6, 2)
    const l2 = this.blur(l1, 1.8, 4)
    const l3 = this.blur(l2, 2.0, 8)
    state.pass(this.cache.get('detailbands', DETAILBANDS_FS), (program) => {
      program.tex('uL0', l0)
        .tex('uL1', l1)
        .tex('uL2', l2)
        .tex('uL3', l3)
        .set('uGain', [
          tone.detailFinest / 100,
          tone.detailFine / 100,
          tone.detailCoarse / 100,
          tone.detailCoarsest / 100,
        ] as [number, number, number, number])
        .set('uThresh', tone.detailThreshold / 100)
    })
  }

  private runTextureAdjustments(edits: Edits, state: GraphState) {
    const basic = edits.basic
    if (!basic.texture && !basic.clarity && !basic.dehaze) return
    const fine = this.blur(state.input, 1.6, 1)
    const coarse = this.blur(state.input, 2.4, 8)
    state.pass(this.cache.get('local', LOCAL_FS), (program) => {
      program.tex('uFine', fine)
        .tex('uCoarse', coarse)
        .set('uTexture', basic.texture / 100)
        .set('uClarity', basic.clarity / 100)
        .set('uDehaze', basic.dehaze / 100)
    })
  }

  private runToneCurve(edits: Edits, state: GraphState) {
    const curve = edits.curve
    const hasRgb = !isIdentityParametric(curve.parametric) || !isIdentityPoints(curve.rgb)
    const hasChannels =
      !isIdentityPoints(curve.red) || !isIdentityPoints(curve.green) || !isIdentityPoints(curve.blue)
    if (!hasRgb && !hasChannels) return
    const CURVE_MODE: Record<string, number> = {
      standard: 0, weighted: 1, filmLike: 2, saturationAndValue: 3, luminance: 4, perceptual: 5,
    }
    state.pass(this.cache.get('curve', CURVE_FS), (program) => {
      program.tex('uLut', this.uploadLut(curve))
        .set('uHasRgb', hasRgb ? 1 : 0)
        .set('uHasChannels', hasChannels ? 1 : 0)
        .set('uMode', CURVE_MODE[curve.rgbMode] ?? 0)
    })
  }

  private runColorMixer(edits: Edits, state: GraphState) {
    const mix = edits.colorMixer
    if (edits.basic.treatment === 'bw') return
    if (!COLOR_BANDS.some((band) => mix.hue[band] || mix.saturation[band] || mix.luminance[band])) return
    const hue = new Float32Array(8)
    const sat = new Float32Array(8)
    const lum = new Float32Array(8)
    COLOR_BANDS.forEach((band, index) => {
      hue[index] = mix.hue[band] / 100
      sat[index] = mix.saturation[band] / 100
      lum[index] = mix.luminance[band] / 100
    })
    state.pass(this.cache.get('colormix', COLORMIX_FS), (program) => {
      program.set('uHue', hue).set('uSat', sat).set('uLum', lum)
    })
  }

  private runBlackAndWhite(edits: Edits, state: GraphState) {
    if (edits.basic.treatment !== 'bw') return
    const bw = new Float32Array(8)
    COLOR_BANDS.forEach((band, index) => { bw[index] = edits.colorMixer.bw[band] / 100 })
    state.pass(this.cache.get('bw', BW_FS), (program) => { program.set('uMix', bw) })
  }

  private runColorGrading(edits: Edits, state: GraphState) {
    const grading = edits.colorGrading
    const wheels = [grading.shadows, grading.midtones, grading.highlights, grading.global]
    if (!wheels.some((wheel) => wheel.saturation || wheel.luminance)) return
    const asVector = (wheel: (typeof wheels)[number]): [number, number, number] => [
      wheel.hue / 360, wheel.saturation / 100, wheel.luminance / 100,
    ]
    state.pass(this.cache.get('grading', GRADING_FS), (program) => {
      program.set('uShadow', asVector(grading.shadows))
        .set('uMidtone', asVector(grading.midtones))
        .set('uHighlight', asVector(grading.highlights))
        .set('uGlobal', asVector(grading.global))
        .set('uBlending', grading.blending / 100)
        .set('uBalance', grading.balance / 100)
    })
  }

  private runRetouchStages(edits: Edits, state: GraphState) {
    this.runSpotRetouch(edits, state)
    this.runRedEyeRetouch(edits, state)
  }

  private runSpotRetouch(edits: Edits, state: GraphState) {
    const spots = edits.spots.filter((spot) => spot.opacity > 0 && spot.radius > 0)
    if (!spots.length) return
    const low = this.blurAt(state.input, state.width, state.height, 6, 8)
    const aspect = aspectVec(state.width, state.height)
    const program = this.cache.get('spot', SPOT_FS)
    for (let i = 0; i < spots.length; i += MAX_SPOTS) {
      const batch = spots.slice(i, i + MAX_SPOTS)
      const positions = new Float32Array(MAX_SPOTS * 4)
      const parameters = new Float32Array(MAX_SPOTS * 4)
      batch.forEach((spot, index) => {
        positions.set([spot.target.x, spot.target.y, spot.source.x, spot.source.y], index * 4)
        parameters.set([spot.radius, spot.feather / 100, spot.opacity, spot.mode === 'clone' ? 1 : 0], index * 4)
      })
      state.pass(program, (pass) => {
        pass.tex('uBlur', low).set('uCount', batch.length)
          .setVectors('uSpots', positions, 4).setVectors('uParams', parameters, 4).set('uAspect', aspect)
      })
    }
  }

  private runRedEyeRetouch(edits: Edits, state: GraphState) {
    const eyes = edits.redEye.filter((eye) => eye.radius > 0)
    if (!eyes.length) return
    const aspect = aspectVec(state.width, state.height)
    const program = this.cache.get('redEye', RED_EYE_FS)
    for (let i = 0; i < eyes.length; i += MAX_EYES) {
      const batch = eyes.slice(i, i + MAX_EYES)
      const values = new Float32Array(MAX_EYES * 4)
      const metadata = new Float32Array(MAX_EYES * 4)
      batch.forEach((eye, index) => {
        values.set([eye.center.x, eye.center.y, eye.radius, eye.darken / 100], index * 4)
        metadata.set([eye.kind === 'pet' ? 1 : 0, 0, 0, 0], index * 4)
      })
      state.pass(program, (pass) => {
        pass.set('uCount', batch.length).setVectors('uEyes', values, 4)
          .setVectors('uMeta', metadata, 4).set('uAspect', aspect)
      })
    }
  }

  private runGeometryStage(edits: Edits, state: GraphState) {
    if (isIdentityGeometry(edits)) {
      this.frameGeom = null
      return
    }
    const out = geometryOutputSize(state.chain.width, state.chain.height, edits)
    const geom = this.geometryChain(out.width, out.height)
    const uniforms = this.geometryUniforms(edits, state.chain)
    this.frameGeom = uniforms

    const lens = edits.lens
    const program = this.cache.get('geometry', GEOMETRY_FS)
    program.use()
    program.tex('uImage', state.input)
    for (const [name, value] of Object.entries(uniforms)) program.set(name, value)
    program.set('uCa', [lens.caRed / 2000, lens.caBlue / 2000])
    program.set('uLensVignette', lens.vignetting / 100)
    drawPass(this.enc!, geom.write, program)

    state.input = geom.write
    geom.swap()
    state.active = geom
    state.width = out.width
    state.height = out.height
    state.texel = [1 / out.width, 1 / out.height]
  }

  private geometryUniforms(edits: Edits, chain: PingPong): Record<string, number | number[]> {
    const crop = edits.crop
    const transform = edits.transform
    const lens = edits.lens
    const turned = crop.quarterTurns % 2 === 1
    return {
      uInAspect: aspectVec(chain.width, chain.height),
      uFrameAspect: aspectVec(
        turned ? chain.height : chain.width,
        turned ? chain.width : chain.height,
      ),
      uCrop: [crop.left, crop.top, crop.right, crop.bottom],
      uAngle: ((crop.angle + transform.rotate) * Math.PI) / 180,
      uQuarter: crop.quarterTurns & 3,
      uFlip: [crop.flipH ? -1 : 1, crop.flipV ? -1 : 1],
      uPerspective: [transform.horizontal / 220, transform.vertical / 220],
      uAspectStretch: [
        transform.aspect > 0 ? 1 + transform.aspect / 100 : 1,
        transform.aspect < 0 ? 1 - transform.aspect / 100 : 1,
      ],
      uScale: Math.max(0.05, transform.scale / 100),
      uOffset: [transform.offsetX / 100, -transform.offsetY / 100],
      uDistortion: [-lens.distortion / 100, 0],
      uEdgeFill: 0,
    }
  }

  // -------------------------------------------------------------------------
  // Layers
  // -------------------------------------------------------------------------

  /**
   * Composites the layer stack over the picture the global edits produced.
   *
   * Layers run in paint order — index 0 at the bottom — and each one is a
   * single pass: its mask becomes a coverage texture, its own pixels are read
   * or computed, its adjustments run, and the result is blended onto what is
   * already there. An adjustment layer with a normal blend is exactly the mask
   * this pipeline has always applied, which is what lets an old edit stack
   * render unchanged.
   */
  private runLocalAdjustments(edits: Edits, state: GraphState) {
    if (!edits.layers.length) return
    const apply = this.cache.get('maskApply', MASK_APPLY_FS)
    this.compositeLayers(edits.layers, apply, state, null, 0)
  }

  /** One level of the stack. `inherited` is the enclosing group's coverage. */
  private compositeLayers(
    layers: Layer[],
    apply: Pass,
    state: GraphState,
    inherited: Tex | null,
    depth: number,
  ) {
    // The coverage a run of clipped layers is confined to: whatever the last
    // unclipped layer under them covered.
    let clipBase: Tex | null = null
    let clipBaseKnown = false
    let index = 0

    for (const layer of layers) {
      const resolved = this.layerCoverage(layer, state)
      if (!resolved) continue
      let coverage = resolved.coverage

      if (layer.clipped && clipBaseKnown) {
        coverage = this.intersectCoverage(coverage, clipBase, `clip${depth}:${index}`, state)
      } else {
        clipBase = this.holdCoverage(coverage, `base${depth}`, state)
        clipBaseKnown = true
      }
      if (inherited) {
        coverage = this.intersectCoverage(coverage, inherited, `group${depth}:${index}`, state)
      }

      if (layer.children) this.compositeGroup(layer, coverage, apply, state, depth)
      else this.applyLayer(layer, coverage, apply, state)
      index++
    }
  }

  /**
   * A layer's coverage, or null when it cannot put anything on screen.
   *
   * The inner `coverage` is null for a layer with no mask at all: that means
   * the whole frame, and a texture full of ones would be a pass and a buffer
   * spent saying so. An *inverted* empty mask covers nothing, which is not a
   * layer at all.
   */
  private layerCoverage(layer: Layer, state: GraphState): { coverage: Tex | null } | null {
    if (!layer.visible || layer.opacity <= 0) return null
    if (layer.children && !layer.children.length) return null
    if (!layer.components.length) return layer.inverted ? null : { coverage: null }
    const coverage = this.buildMask(layer, state.input, state.width, state.height)
    return coverage ? { coverage } : null
  }

  /**
   * Copies coverage somewhere it will survive the next mask being built.
   *
   * `buildMask` hands back a texture inside the shared accumulator, which the
   * following layer overwrites. A clipping base and a group's coverage both
   * have to outlive that, so they are taken out of the accumulator first.
   */
  private holdCoverage(coverage: Tex | null, key: string, state: GraphState): Tex | null {
    if (!coverage) return null
    const slot = this.coverageSlot(key, state.width, state.height)
    const copy = this.cache.get('copy', COPY_FS)
    copy.use()
    copy.tex('uImage', coverage).set('uSrcOffset', [0, 0]).set('uSrcScale', [1, 1])
    drawPass(this.enc!, slot.write, copy)
    const held: Tex = slot.write
    slot.swap()
    return held
  }

  /** Coverage confined to another layer's, for clipping and for groups. */
  private intersectCoverage(
    coverage: Tex | null,
    limit: Tex | null,
    key: string,
    state: GraphState,
  ): Tex | null {
    if (!limit) return coverage
    if (!coverage) return limit
    const slot = this.coverageSlot(key, state.width, state.height)
    const merge = this.cache.get('maskMerge', MASK_MERGE_FS)
    merge.use()
    merge.tex('uPrev', coverage).tex('uCov', limit)
      .set('uBlend', 2).set('uInvert', 0).set('uFirst', 0)
    drawPass(this.enc!, slot.write, merge)
    const out: Tex = slot.write
    slot.swap()
    return out
  }

  private coverageSlot(key: string, width: number, height: number): PingPong {
    const existing = this.coverageSlots.get(key)
    if (existing && existing.width === width && existing.height === height) return existing
    this.retire(existing)
    const slot = new PingPong(this.ctx, width, height)
    this.coverageSlots.set(key, slot)
    return slot
  }

  /**
   * A group, either passing through or in isolation.
   *
   * Pass-through is the cheap and the common case: the children blend straight
   * onto the picture, and the group only contributes its mask. Isolation copies
   * the backdrop, runs the children against the copy and composites the result
   * in one go — which is the only way a group's own blend mode can mean
   * anything, because there is nothing to blend until the children are done.
   */
  private compositeGroup(
    layer: Layer,
    coverage: Tex | null,
    apply: Pass,
    state: GraphState,
    depth: number,
  ) {
    const children = layer.children ?? []
    if (!layer.isolate) {
      this.compositeLayers(children, apply, state, coverage, depth + 1)
      return
    }

    const chain = this.groupChain(depth, state.width, state.height)
    const copy = this.cache.get('copy', COPY_FS)
    copy.use()
    copy.tex('uImage', state.input).set('uSrcOffset', [0, 0]).set('uSrcScale', [1, 1])
    drawPass(this.enc!, chain.write, copy)
    let inner: Tex = chain.write
    chain.swap()

    const sub: GraphState = {
      ...state,
      active: chain,
      input: inner,
      pass: (program, setup) => {
        program.use()
        program.tex('uImage', sub.input)
        setup(program)
        drawPass(this.enc!, chain.write, program)
        sub.input = chain.write
        chain.swap()
      },
    }
    this.compositeLayers(children, apply, sub, null, depth + 1)
    inner = sub.input

    this.applyLayer(layer, coverage, apply, state, inner)
  }

  private groupChain(depth: number, width: number, height: number): PingPong {
    const existing = this.groupChains[depth]
    if (existing && existing.width === width && existing.height === height) return existing
    this.retire(existing)
    const chain = new PingPong(this.ctx, width, height)
    this.groupChains[depth] = chain
    return chain
  }

  /** One layer, one pass: content, adjustments, blend, coverage. */
  private applyLayer(
    layer: Layer,
    coverage: Tex | null,
    apply: Pass,
    state: GraphState,
    groupResult: Tex | null = null,
  ) {
    const content = this.layerContent(layer, state, groupResult)
    if (!content) return
    const adjustments = layer.adjustments
    const fine = this.blurAt(state.input, state.width, state.height, 1.6, 2)
    const coarse = this.blurAt(state.input, state.width, state.height, 3.0, 8)
    const hasCurve = adjustments.curve.length > 0 && !isIdentityPoints(adjustments.curve)
    const lut = hasCurve ? this.uploadMaskLut(adjustments.curve) : null
    const aspect = aspectVec(state.width, state.height)
    const placement = inverseLayerTransform(layer.transform, aspect)

    state.pass(apply, (program) => {
      program.tex('uMask', coverage).tex('uFine', fine).tex('uCoarse', coarse).tex('uLut', lut)
        .tex('uLayer', content.texture)
        .set('uHasCurve', hasCurve ? 1 : 0).set('uLutSize', LUT_SIZE).set('uOpacity', layer.opacity)
        .set('uBlend', BLEND_MODE_INDEX[layer.blend] ?? 0)
        .set('uContent', content.mode).set('uHasMask', coverage ? 1 : 0)
        .set('uFill', content.fill).set('uContentFit', content.fit)
        .set('uXform', placement.matrix).set('uXformOffset', placement.offset)
        .set('uAspect', aspect)
        .set('uExposure', adjustments.exposure).set('uContrast', adjustments.contrast / 100)
        .set('uHighlights', adjustments.highlights / 100).set('uShadows', adjustments.shadows / 100)
        .set('uWhites', adjustments.whites / 100).set('uBlacks', adjustments.blacks / 100)
        .set('uTexture', adjustments.texture / 100).set('uClarity', adjustments.clarity / 100)
        .set('uDehaze', adjustments.dehaze / 100).set('uTemp', adjustments.temp / 100)
        .set('uTint', adjustments.tint / 100).set('uSaturation', adjustments.saturation / 100)
        .set('uHue', adjustments.hue).set('uHueStrength', adjustments.hueStrength / 100)
        .set('uColorize', adjustments.colorize / 100).set('uSharpness', adjustments.sharpness / 100)
        .set('uNoise', adjustments.noise / 100).set('uMoire', adjustments.moire / 100)
        .set('uDefringe', adjustments.defringe / 100)
    })
  }

  /**
   * Where a layer's pixels come from, in the form the apply pass wants.
   *
   * Returns null when the layer has pixels it cannot reach — an import this
   * machine has never cached — because compositing a placeholder into a
   * photograph is worse than leaving the layer out until the file comes back.
   */
  private layerContent(
    layer: Layer,
    state: GraphState,
    groupResult: Tex | null,
  ): { mode: number; texture: Tex | null; fill: number[]; fit: [number, number] } | null {
    const none = { fill: [0, 0, 0], fit: [1, 1] as [number, number] }
    if (groupResult) return { mode: 3, texture: groupResult, ...none }

    const content = layer.content
    if (content.kind === 'fill') {
      return { mode: 1, texture: null, fill: linearFill(content.color), fit: none.fit }
    }
    if (content.kind === 'image') {
      const texture = this.layerTexture(content.source)
      if (!texture) return null
      return {
        mode: 2,
        texture,
        fill: none.fill,
        fit: containFit(content.width, content.height, state.width, state.height),
      }
    }
    return { mode: 0, texture: null, ...none }
  }

  /**
   * An imported layer's pixels on the GPU, uploaded once per source.
   *
   * Stored 8-bit sRGB and linearised here, so the shader sees the same working
   * space everything else in the graph is in.
   */
  private layerTexture(source: string): Tex | null {
    const existing = this.layerTex.get(source)
    if (existing) return existing

    const pixels = getLayerPixels(source)
    if (!pixels) return null

    const tex = createTexture(this.ctx, pixels.width, pixels.height, {
      format: 'rgba16float',
      filter: 'linear',
    })
    const count = pixels.width * pixels.height * 4
    const half = new Uint16Array(count)
    for (let i = 0; i < count; i += 4) {
      half[i] = floatToHalf(srgbToLinear(pixels.data[i] / 255))
      half[i + 1] = floatToHalf(srgbToLinear(pixels.data[i + 1] / 255))
      half[i + 2] = floatToHalf(srgbToLinear(pixels.data[i + 2] / 255))
      half[i + 3] = floatToHalf(pixels.data[i + 3] / 255)
    }
    writeTexture(this.ctx, tex, half)
    this.layerTex.set(source, tex)
    return tex
  }

  private runEffects(edits: Edits, state: GraphState) {
    const effects = edits.effects
    if (!effects.vignetteAmount && !effects.grainAmount) return
    const frame = state.active === state.chain
      ? this.frame
      : { resolution: [state.width, state.height] as [number, number], offset: [0, 0] as [number, number], scale: [1, 1] as [number, number] }
    state.pass(this.cache.get('effects', EFFECTS_FS), (program) => {
      program.set('uVignette', effects.vignetteAmount / 100).set('uMidpoint', effects.vignetteMidpoint / 100)
        .set('uRoundness', effects.vignetteRoundness / 100).set('uFeather', effects.vignetteFeather / 100)
        .set('uVignetteHighlights', effects.vignetteHighlights / 100).set('uGrain', effects.grainAmount / 100)
        .set('uGrainSize', effects.grainSize / 100).set('uGrainRough', effects.grainRoughness / 100)
        .set('uResolution', frame.resolution).set('uFrameOffset', frame.offset).set('uFrameScale', frame.scale)
        .set('uSeed', 0)
    })
  }

  private runMaskOverlay(edits: Edits, overlay: MaskOverlay | null, state: GraphState) {
    if (!overlay) return
    const layer = findLayer(edits, overlay.maskId)
    if (!layer) return
    // No components means the whole frame, which the overlay shows as covered.
    const hasMask = layer.components.length > 0
    const coverage = hasMask
      ? this.buildMask(layer, state.input, state.width, state.height)
      : null
    if (hasMask && !coverage) return
    const aspect = aspectVec(state.width, state.height)
    const placement = inverseLayerTransform(layer.transform, aspect)
    state.pass(this.cache.get('maskShow', MASK_SHOW_FS), (program) => {
      program.tex('uMask', coverage)
        .set('uTint', overlay.tint ?? [0.95, 0.25, 0.3])
        .set('uAmount', overlay.amount ?? 0.55)
        .set('uMode', overlay.mode === 'coverage' ? 1 : 0)
        .set('uHasMask', hasMask ? 1 : 0)
        .set('uXform', placement.matrix)
        .set('uXformOffset', placement.offset)
        .set('uAspect', aspect)
    })
  }

  // -------------------------------------------------------------------------
  // Masking
  // -------------------------------------------------------------------------

  /**
   * Rasterises one mask's components into a coverage texture.
   *
   * Components fold in order, each one either screening onto, cutting out of,
   * or intersecting with what came before. A brush is the awkward case: its
   * dabs cannot all fit in a uniform array, so it is drawn in chunks into the
   * scratch buffer and folded in once at the end.
   */
  private buildMask(
    mask: Layer,
    image: Tex,
    width: number,
    height: number,
  ): Tex | null {
    const parts = this.rasterizableMaskParts(mask)
    if (!parts.length) return null
    const { acc, scratch } = this.maskTargets(width, height)
    const aspect = aspectVec(width, height)
    const raster = this.cache.get('mask', MASK_FS)
    const merge = this.cache.get('maskMerge', MASK_MERGE_FS)
    let coverage: Tex = acc.read
    let first = true

    for (const part of parts) {
      if (!this.rasterMaskPart(part, image, width, height, aspect, scratch, raster)) continue
      coverage = this.mergeMaskPart(part, coverage, first, acc, scratch, merge)
      first = false
    }
    if (first) return null
    return mask.inverted ? this.invertMask(coverage, acc, merge) : coverage
  }

  private rasterizableMaskParts(mask: Layer) {
    return mask.components.filter((component) => {
      const geometry = component.geometry
      return geometry.kind in MASK_KIND && (!isAiGeometry(geometry) || this.aiCoverage(geometry.cacheKey))
    })
  }

  private maskTargets(width: number, height: number) {
    if (!this.maskAcc || this.maskAcc.width !== width || this.maskAcc.height !== height) {
      this.retire(this.maskAcc)
      this.retire(this.maskScratch)
      this.maskAcc = new PingPong(this.ctx, width, height)
      this.maskScratch = new PingPong(this.ctx, width, height)
    }
    return { acc: this.maskAcc, scratch: this.maskScratch! }
  }

  private rasterMaskPart(
    part: Layer['components'][number],
    image: Tex,
    width: number,
    height: number,
    aspect: [number, number],
    scratch: PingPong,
    raster: Pass,
  ) {
    const geometry = part.geometry
    const kind = MASK_KIND[geometry.kind as keyof typeof MASK_KIND]
    if (geometry.kind === 'brush') {
      return this.rasterBrush(geometry, image, aspect, scratch, raster, kind)
    }
    this.rasterNonBrush(geometry, image, width, height, aspect, scratch, raster, kind)
    return true
  }

  private rasterBrush(
    geometry: Extract<Layer['components'][number]['geometry'], { kind: 'brush' }>,
    image: Tex,
    aspect: [number, number],
    scratch: PingPong,
    raster: Pass,
    kind: number,
  ) {
    if (!geometry.dabs.length) return false
    const values = new Float32Array(MAX_DABS * 4)
    for (let i = 0; i < geometry.dabs.length; i += MAX_DABS) {
      const dabs = geometry.dabs.slice(i, i + MAX_DABS)
      values.fill(0)
      dabs.forEach((dab, index) => {
        values[index * 4] = dab.x
        values[index * 4 + 1] = dab.y
        values[index * 4 + 2] = dab.radius
        values[index * 4 + 3] = dab.erase ? -Math.max(dab.flow, 0.001) : Math.max(dab.flow, 0.001)
      })
      raster.use()
      raster.tex('uImage', image).tex('uPrev', scratch.read).tex('uAlpha', null)
      raster.setVectors('uDabs', values, 4)
      raster.set('uKind', kind).set('uAspect', aspect).set('uDabCount', dabs.length)
        .set('uBrushFeather', geometry.feather).set('uFirstChunk', i === 0 ? 1 : 0)
      drawPass(this.enc!, scratch.write, raster)
      scratch.swap()
    }
    return true
  }

  private rasterNonBrush(
    geometry: Exclude<Layer['components'][number]['geometry'], { kind: 'brush' }>,
    image: Tex,
    width: number,
    height: number,
    aspect: [number, number],
    scratch: PingPong,
    raster: Pass,
    kind: number,
  ) {
    const ai = isAiGeometry(geometry) ? geometry : null
    const alpha = ai ? this.framedAlpha(ai.cacheKey, width, height) : null
    raster.use()
    raster.tex('uImage', image).tex('uPrev', scratch.read).tex('uAlpha', alpha)
    raster.set('uKind', kind).set('uAspect', aspect)
    this.configureMaskRaster(geometry, ai, alpha, width, height, raster)
    drawPass(this.enc!, scratch.write, raster)
    scratch.swap()
  }

  private configureMaskRaster(
    geometry: Exclude<Layer['components'][number]['geometry'], { kind: 'brush' }>,
    ai: Extract<Layer['components'][number]['geometry'], { kind: `ai${string}` }> | null,
    alpha: Tex | null,
    width: number,
    height: number,
    raster: Pass,
  ) {
    if (geometry.kind === 'linear') {
      raster.set('uP0', [geometry.start.x, geometry.start.y]).set('uP1', [geometry.end.x, geometry.end.y])
    } else if (geometry.kind === 'radial') {
      raster.set('uCenter', [geometry.center.x, geometry.center.y])
        .set('uRadius', [geometry.radiusX, geometry.radiusY])
        .set('uRotation', geometry.rotation).set('uFeather', geometry.feather)
    } else if (geometry.kind === 'colorRange') {
      this.setColorRangeSamples(geometry, raster)
    } else if (geometry.kind === 'luminanceRange') {
      raster.set('uRange', geometry.range).set('uSmoothness', geometry.smoothness)
    } else if (ai && alpha) {
      raster.set('uRefine', ai.refine).set('uTexel', [1 / width, 1 / height])
        .set('uAiInvert', ai.kind === 'aiBackground' ? 1 : 0)
    }
  }

  private setColorRangeSamples(
    geometry: Extract<Layer['components'][number]['geometry'], { kind: 'colorRange' }>,
    raster: Pass,
  ) {
    const values = new Float32Array(MAX_SAMPLES * 3)
    const count = Math.min(geometry.samples.length, MAX_SAMPLES)
    for (let i = 0; i < count; i++) {
      values[i * 3] = geometry.samples[i].r
      values[i * 3 + 1] = geometry.samples[i].g
      values[i * 3 + 2] = geometry.samples[i].b
    }
    raster.setVectors('uSamples', values, 3)
    raster.set('uSampleCount', count).set('uRefine', geometry.refine)
  }

  private mergeMaskPart(
    part: Layer['components'][number],
    previous: Tex,
    first: boolean,
    acc: PingPong,
    scratch: PingPong,
    merge: Pass,
  ) {
    merge.use()
    merge.tex('uPrev', previous).tex('uCov', scratch.read)
    merge.set('uBlend', MASK_BLEND[part.blend as keyof typeof MASK_BLEND] ?? 0)
      .set('uInvert', part.invert ? 1 : 0).set('uFirst', first ? 1 : 0)
    drawPass(this.enc!, acc.write, merge)
    const coverage = acc.write
    acc.swap()
    return coverage
  }

  private invertMask(coverage: Tex, acc: PingPong, merge: Pass) {
    merge.use()
    merge.tex('uPrev', coverage).tex('uCov', coverage)
    merge.set('uBlend', 0).set('uInvert', 1).set('uFirst', 1)
    drawPass(this.enc!, acc.write, merge)
    const inverted = acc.write
    acc.swap()
    return inverted
  }

  /**
   * The GPU's copy of one detection result, uploaded on first use.
   *
   * Coverage is a square in normalised source coordinates — the network's input
   * was stretched to that square, so the stretch cancels when it is sampled
   * back over the frame and no aspect has to be recorded. `r16float` because
   * one filterable channel is all a mask is, at half the bandwidth of the
   * smallest colour format that would also do.
   */
  private aiCoverage(cacheKey: string | null): Tex | null {
    if (!cacheKey) return null
    const existing = this.aiTex.get(cacheKey)
    if (existing) return existing

    const alpha = getAlpha(cacheKey)
    if (!alpha) return null

    const tex = createTexture(this.ctx, alpha.size, alpha.size, {
      format: 'r16float',
      filter: 'linear',
    })
    const half = new Uint16Array(alpha.data.length)
    for (let i = 0; i < alpha.data.length; i++) half[i] = floatToHalf(alpha.data[i])
    writeTexture(this.ctx, tex, half)
    this.aiTex.set(cacheKey, tex)
    return tex
  }

  /**
   * Coverage moved from the sensor grid onto the framed image.
   *
   * The geometry stage's own program is replayed rather than reimplemented, so
   * a crop, a straighten, a keystone or a distortion correction carries the
   * mask with it exactly. When the frame is untransformed there is nothing to
   * replay and the uploaded square is already in the right coordinates.
   */
  private framedAlpha(cacheKey: string | null, width: number, height: number): Tex | null {
    const source = this.aiCoverage(cacheKey)
    if (!source || !this.frameGeom) return source

    if (!this.aiFramed || this.aiFramed.width !== width || this.aiFramed.height !== height) {
      this.retire(this.aiFramed)
      this.aiFramed = new PingPong(this.ctx, width, height)
    }
    const target = this.aiFramed

    const prog = this.cache.get('geometry', GEOMETRY_FS)
    prog.use()
    prog.tex('uImage', source)
    for (const [name, value] of Object.entries(this.frameGeom)) prog.set(name, value)
    // Coverage has no colour, so the two corrections that act on one are off.
    prog.set('uCa', [0, 0]).set('uLensVignette', 0)
    drawPass(this.enc!, target.write, prog)

    const out = target.write
    target.swap()
    return out
  }

  /** Uploads a mask's point curve into a LUT of its own. */
  private uploadMaskLut(points: CurvePoint[]): Tex {
    const c = splineLut(points)
    for (let i = 0; i < LUT_SIZE; i++) {
      this.maskLutData[i * 4] = c[i]
      this.maskLutData[i * 4 + 1] = c[i]
      this.maskLutData[i * 4 + 2] = c[i]
      this.maskLutData[i * 4 + 3] = c[i]
    }
    const tex = this.nextLut()
    const half = new Uint16Array(this.maskLutData.length)
    for (let i = 0; i < this.maskLutData.length; i++) half[i] = floatToHalf(this.maskLutData[i])
    writeTexture(this.ctx, tex, half)
    return tex
  }

  /** Hands out the next unused LUT texture of the frame, growing the pool. */
  private nextLut(): Tex {
    let tex = this.lutPool[this.lutCursor]
    if (!tex) {
      // RGBA16F keeps linear filtering core-supported; 11-bit mantissa is well
      // below the 1/255 steps the LUT ultimately feeds.
      tex = createTexture(this.ctx, LUT_SIZE, 1, {
        format: 'rgba16float',
        filter: 'linear',
      })
      this.lutPool[this.lutCursor] = tex
    }
    this.lutCursor++
    return tex
  }

  /**
   * Opens the encoder for a frame and rewinds the per-frame scratch.
   *
   * Both the LUT pool and the blur chains are reused across frames but must
   * stay stable *within* one, so the rewind belongs here rather than at any of
   * the several places a frame can be started from.
   */
  private beginFrame(): Frame {
    this.frameSeq++
    this.lutCursor = 0
    // A crop drag asks for a new shape every frame, so chains no draw has
    // wanted for a couple of frames are returned. Retiring them here — before
    // anything is encoded — keeps a destroy from ever landing inside a frame.
    for (const [key, entry] of this.aux) {
      if (this.frameSeq - entry.frame > 2) {
        entry.chain.dispose()
        this.aux.delete(key)
      }
    }
    // Chains replaced *during* the previous frame. Compare renders two panes
    // of different shapes into one submission, so the second pane's resize
    // would otherwise free textures the first pane's recorded draws still read.
    for (const chain of this.retired) chain.dispose()
    this.retired.length = 0
    return new Frame(this.ctx)
  }

  /**
   * Hands a chain back once the frame that may have read it has been submitted.
   *
   * Destroying a texture a recorded-but-unsubmitted command references is a
   * validation error, and the resize that replaces a chain can happen anywhere
   * inside a frame — including between the two halves of a compare.
   */
  private retire(chain: PingPong | null | undefined) {
    if (chain) this.retired.push(chain)
  }

  /** The post-geometry chain, resized when the crop changes shape. */
  private geometryChain(width: number, height: number): PingPong {
    if (!this.geom || this.geom.width !== width || this.geom.height !== height) {
      this.retire(this.geom)
      // Mips allocated so a minified viewport can present the cropped result without aliasing.
      this.geom = new PingPong(this.ctx, width, height, { mips: true })
    }
    return this.geom
  }

  /**
   * Blurs a texture into a scratch chain and returns the result.
   *
   * `downscale` trades resolution for radius: a large clarity halo is cheaper
   * and smoother when computed at 1/8 scale than with a huge kernel at 1:1.
   */
  private blur(texture: Tex, radius: number, downscale: number): Tex {
    const chain = this.chain!
    return this.blurAt(texture, chain.width, chain.height, radius, downscale)
  }

  /**
   * As `blur`, but for a texture that is no longer the chain's size.
   *
   * Everything after the geometry pass lives on the cropped frame, so a blur
   * there has to be told how big its input actually is.
   */
  private blurAt(
    texture: Tex,
    srcW: number,
    srcH: number,
    radius: number,
    downscale: number,
  ): Tex {
    const w = Math.max(1, Math.floor(srcW / downscale))
    const h = Math.max(1, Math.floor(srcH / downscale))

    // Keyed on the shape as well as the factor: a texture the frame has
    // already encoded a read of must survive until that frame is submitted.
    const key = `${downscale}:${w}x${h}`
    let entry = this.aux.get(key)
    if (!entry) {
      entry = { chain: new PingPong(this.ctx, w, h), frame: this.frameSeq }
      this.aux.set(key, entry)
    }
    entry.frame = this.frameSeq
    const aux = entry.chain

    // Downsample into the scratch chain first.
    const copy = this.cache.get('copy', COPY_FS)
    copy.use()
    copy.tex('uImage', texture).set('uSrcOffset', [0, 0]).set('uSrcScale', [1, 1])
    drawPass(this.enc!, aux.write, copy)
    let cur: Tex = aux.write
    aux.swap()

    const blur = this.cache.get('blur', BLUR_FS)
    for (const dir of [
      [1, 0],
      [0, 1],
    ] as Array<[number, number]>) {
      blur.use()
      blur
        .tex('uImage', cur)
        .set('uTexel', [1 / w, 1 / h] as [number, number])
        .set('uDirection', dir)
        .set('uRadius', radius)
      drawPass(this.enc!, aux.write, blur)
      cur = aux.write
      aux.swap()
    }
    return cur
  }

  private uploadLut(tc: Edits['curve']): Tex {
    const composite = composeLut(parametricLut(tc.parametric), splineLut(tc.rgb))
    const r = splineLut(tc.red)
    const g = splineLut(tc.green)
    const bl = splineLut(tc.blue)

    for (let i = 0; i < LUT_SIZE; i++) {
      this.lutData[i * 4] = r[i]
      this.lutData[i * 4 + 1] = g[i]
      this.lutData[i * 4 + 2] = bl[i]
      this.lutData[i * 4 + 3] = composite[i]
    }

    const tex = this.nextLut()
    // `writeTexture` copies raw bytes verbatim, so float32 data has to be
    // down-converted to the half-float the texture format expects.
    const half = new Uint16Array(this.lutData.length)
    for (let i = 0; i < this.lutData.length; i++) half[i] = floatToHalf(this.lutData[i])
    writeTexture(this.ctx, tex, half)
    return tex
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  /**
   * Runs the edit graph without drawing to the canvas.
   *
   * Export needs the graph result but never the on-screen presentation, and
   * binding a 40 MP viewport just to throw it away wastes both time and the
   * driver's patience.
   */
  renderOffscreen(edits: Edits) {
    if (!this.source || !this.sourceInfo) return
    this.enc = this.beginFrame()
    try {
      this.runGraph(edits, false)
      this.enc.submit()
    } finally {
      this.enc = null
    }
  }

  // -------------------------------------------------------------------------
  // Composite export
  // -------------------------------------------------------------------------

  /**
   * Opens a full-resolution accumulator for a tiled export.
   *
   * Tiling only works while every pass is local to its strip. Geometry is not:
   * a rotation reads from the whole frame. So the tiles render the colour graph
   * into this buffer, and geometry runs once over the finished image — which
   * also costs less memory than the old three-frames-in-flight arrangement,
   * since the tile chain stays tile-sized.
   */
  beginComposite(width: number, height: number) {
    if (
      !this.composite ||
      this.composite.width !== width ||
      this.composite.height !== height
    ) {
      this.composite?.destroy()
      this.composite = createTarget(this.ctx, width, height)
    }
    // A clear is a load-op on a render pass, not a standalone call.
    this.enc = this.beginFrame()
    const rp = this.enc.encoder.beginRenderPass({
      colorAttachments: [{
        view: this.composite.attach,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    })
    rp.end()
    this.enc.submit()
    this.enc = null
  }

  /**
   * Renders the loaded slice with `edits` and blits it into the accumulator.
   *
   * `keep` is the part of the slice that is real output rather than halo, in
   * the slice's own pixels; `destY` is the accumulator row its first row
   * belongs to. Both count from the top: images are uploaded in row order, so
   * texture row 0 is the top row throughout the graph.
   */
  compositeTile(
    edits: Edits,
    keep: { y: number; height: number },
    destY: number,
  ) {
    const acc = this.composite
    if (!acc || !this.sourceInfo) return

    this.enc = this.beginFrame()
    try {
      const result = this.runGraph(edits, false)
      const sh = this.lastSize.height || this.sourceInfo.height

      // The viewport places the kept strip at destY (top-left origin), and the
      // sub-rect samples from keep.y within the rendered slice — both measured
      // from the top, consistently with how the image was uploaded.
      const viewport = { x: 0, y: destY, width: acc.width, height: keep.height }
      const copy = this.cache.get('copy', COPY_FS)
      copy.use()
        .tex('uImage', result)
        .set('uSrcOffset', [0, keep.y / sh] as [number, number])
        .set('uSrcScale', [1, keep.height / sh] as [number, number])
      drawPass(this.enc, acc, copy, { viewport, clear: false })
      this.enc.submit()
    } finally {
      this.enc = null
    }
  }

  /**
   * Runs the framing stage over the accumulated image and leaves it in
   * `lastResult`, ready for `readPixels`.
   */
  finishComposite(edits: Edits) {
    const acc = this.composite
    if (!acc) return
    this.disposeSource()
    this.sourceInfo = {
      width: acc.width,
      height: acc.height,
      data: new Uint16Array(0),
      isRaw: false,
      asShot: this.asShot,
      whiteLevel: 1,
    }
    this.source = acc
    this.ownsSource = false
    this.graded = true
    this.chain = new PingPong(this.ctx, acc.width, acc.height, { mips: true })
    this.frame = {
      resolution: [acc.width, acc.height],
      offset: [0, 0],
      scale: [1, 1],
    }
    this.enc = this.beginFrame()
    try {
      this.runGraph(edits, false)
      this.enc.submit()
    } finally {
      this.enc = null
    }
  }

  /**
   * Draws one version of the photo.
   *
   * Returns whether the edit graph actually ran, so a caller that only wanted
   * to move the image — a pan, a zoom, a resize — knows the graph result, and
   * anything derived from it such as the histogram, is unchanged.
   */
  render(edits: Edits, opts: RenderOptions = {}): boolean {
    if (!this.ctx.surface) return this.noSurface()
    if (!this.source || !this.sourceInfo) return false
    this.ensureConfigured()
    const cw = this.canvas.width
    const ch = this.canvas.height
    const rect = opts.rect ?? { x: 0, y: 0, width: cw, height: ch }

    this.enc = this.beginFrame()
    try {
      const graph = this.graphFor(edits, opts)
      // Acquire once per frame; calling getCurrentTexture multiple times within
      // a frame is invalid in WebGPU.
      const view = this.ctx.surface.getCurrentTexture().createView()
      this.clearScreen(view)
      this.present(graph.texture, view, rect, null, opts)
      this.enc.submit()
      this._frames++
      return graph.ran
    } finally {
      this.enc = null
    }
  }

  /**
   * Draws several versions of the same photo into one frame.
   *
   * Panes are drawn in order and the last one's graph is what the histogram
   * reads, so callers put the "after" last. A pane carrying a `cacheKey` keeps
   * its result in a texture of its own: a before/after view then costs one
   * graph run per frame rather than two, and the static side stays free no
   * matter how hard the live side is being dragged.
   */
  renderPanes(panes: Pane[], opts: RenderOptions = {}): boolean {
    if (!this.ctx.surface) return this.noSurface()
    if (!this.source || !this.sourceInfo || !panes.length) return false
    this.ensureConfigured()

    this.enc = this.beginFrame()
    try {
      // Acquire once for the whole frame; all panes share the same surface texture.
      const view = this.ctx.surface.getCurrentTexture().createView()
      this.clearScreen(view)
      let ran = false
      for (const pane of panes) {
        // Only the live pane gets the overlay: a mask drawn over the "before"
        // would be showing a shape that side does not have.
        let texture: Tex
        if (pane.cacheKey) {
          texture = this.cachedGraph(pane.edits, pane.cacheKey)
        } else {
          const graph = this.graphFor(pane.edits, opts)
          texture = graph.texture
          ran ||= graph.ran
        }
        this.present(texture, view, pane.rect, pane.clip ?? null, opts)
      }
      this.enc.submit()
      this._frames++
      return ran
    } finally {
      this.enc = null
    }
  }

  /**
   * The graph result for these edits, re-running the passes only when
   * `opts.graphKey` says something feeding them has moved.
   */
  private graphFor(
    edits: Edits,
    opts: RenderOptions,
  ): { texture: Tex; ran: boolean } {
    const key = opts.graphKey ?? null
    if (key !== null && key === this.lastGraphKey && this.lastResult) {
      return { texture: this.lastResult, ran: false }
    }
    const texture = this.runGraph(edits, !!opts.bypass, opts.maskOverlay ?? null, key !== null)
    this.lastGraphKey = key
    return { texture, ran: true }
  }

  private warnedNoSurface = false

  /**
   * Reports the one way an on-screen draw can do nothing without any symptom.
   *
   * `render` returning false is ordinary — it happens before an image is
   * loaded — so a caller cannot read it as an error. A renderer built without a
   * presentation surface, though, will never draw anything at all, and a blank
   * canvas is the only evidence. Said once, since a paint loop would otherwise
   * repeat it sixty times a second.
   */
  private noSurface(): false {
    if (!this.warnedNoSurface) {
      this.warnedNoSurface = true
      console.error(
        '[esque] This Renderer has no presentation surface, so on-screen draws do nothing. ' +
          'Build it on an HTMLCanvasElement, or pass { presenting: true }.',
      )
    }
    return false
  }

  /**
   * Clears the surface view to opaque black.
   *
   * The load op alone would be the natural way to do this, but a render pass
   * that records no draw calls is not guaranteed to survive: WebKit elides it
   * whole, load op included, so the canvas kept the previous frame everywhere
   * the new one did not paint. The clear therefore rides on a real fullscreen
   * fill. The load op is left set as well — the two agree, and it lets a driver
   * that does honour it skip reading the old contents.
   */
  private clearScreen(view: GPUTextureView) {
    const clear = this.cache.get('clear', CLEAR_FS, this.ctx.format)
    clear.use()
    drawPass(this.enc!, view, clear, { clear: true })
  }

  /** Runs the graph into a private texture, or reuses one still valid. */
  private cachedGraph(edits: Edits, key: string): Tex {
    if (this.paneCache?.key === key) return this.paneCache.target

    const result = this.runGraph(edits, false)
    const { width, height } = this.lastSize
    if (
      !this.paneCache ||
      this.paneCache.target.width !== width ||
      this.paneCache.target.height !== height
    ) {
      this.paneCache?.target.destroy()
      // Mips allocated so the cached result can be presented minified without aliasing.
      this.paneCache = { key, target: createTarget(this.ctx, width, height, { mips: true }), mipped: false }
    }
    const cache = this.paneCache
    cache.key = key
    cache.mipped = false

    const copy = this.cache.get('copy', COPY_FS)
    copy.use()
    copy.tex('uImage', result).set('uSrcOffset', [0, 0]).set('uSrcScale', [1, 1])
    drawPass(this.enc!, cache.target, copy)
    return cache.target
  }

  /**
   * Puts one graph result on screen.
   *
   * Zoomed in, the destination rect is far bigger than the canvas — and bigger
   * than MAX_VIEWPORT_DIMS, which drivers silently clamp, squashing the image.
   * So the rect is clipped to the canvas (and to the pane's own window) and the
   * output pass is told which slice of the source that leaves visible.
   */
  private present(
    result: Tex,
    view: GPUTextureView,
    rect: Rect,
    clip: Rect | null,
    opts: RenderOptions,
  ) {
    const cw = this.canvas.width
    const ch = this.canvas.height

    // Minifying a large proxy without mips aliases badly on fine detail.
    const minifying = rect.width < (this.lastSize.width || this.sourceInfo!.width) * 0.75
    this.setFiltering(result, minifying)

    const bx0 = clip ? Math.max(0, clip.x) : 0
    const by0 = clip ? Math.max(0, clip.y) : 0
    const bx1 = clip ? Math.min(cw, clip.x + clip.width) : cw
    const by1 = clip ? Math.min(ch, clip.y + clip.height) : ch

    const x0 = Math.max(bx0, rect.x)
    const y0 = Math.max(by0, rect.y)
    const x1 = Math.min(bx1, rect.x + rect.width)
    const y1 = Math.min(by1, rect.y + rect.height)
    if (x1 <= x0 || y1 <= y0) return

    // WebGPU's swap-chain row 0 is the top of the screen (top-left origin),
    // and the WGSL output shader no longer flips V. Both axes therefore measure
    // the sub-rect from the same edge — the top-left — the same way x does.
    // This is why the output shader no longer needs to flip the sample UV.
    const src = {
      offset: [(x0 - rect.x) / rect.width, (y0 - rect.y) / rect.height] as [number, number],
      scale: [(x1 - x0) / rect.width, (y1 - y0) / rect.height] as [number, number],
    }

    // Top-left viewport origin; no Y inversion needed. The swap-chain is a bare
    // view, so `drawPass` cannot know its size — clamp here, where it is known.
    const vx = Math.min(cw - 1, Math.max(0, Math.floor(x0)))
    const vy = Math.min(ch - 1, Math.max(0, Math.floor(y0)))
    const vw = Math.min(cw - vx, Math.max(1, Math.round(x1 - x0)))
    const vh = Math.min(ch - vy, Math.max(1, Math.round(y1 - y0)))
    const viewport = { x: vx, y: vy, width: vw, height: vh }

    // A half-float buffer already resolves far finer than a code value, so the
    // anti-banding dither drops to the depth a display actually quantises to.
    const p = this.outputPass(result, opts, [vw, vh], this.hdrOn ? 1 / 1023 : 1 / 255, src, true, this.ctx.format)
    drawPass(this.enc!, view, p, { viewport, clear: false })
  }

  private setFiltering(texture: Tex, mipped: boolean) {
    // The raw source is never the presentation source; it has no mip chain.
    if (texture === this.source) return

    // The cached pane keeps its own mip flag: it survives frames the graph
    // chain does not, so one shared flag would let stale mips through.
    const cache = this.paneCache
    const isCache = !!cache && texture === cache.target

    if (!mipped) return

    if (isCache ? !cache!.mipped : !this.lastMipped) {
      generateMips(this.ctx, texture, this.enc!.encoder)
      if (isCache) cache!.mipped = true
      else this.lastMipped = true
    }
  }

  private outputPass(
    texture: Tex,
    opts: RenderOptions,
    resolution: [number, number],
    dither: number,
    src: { offset: [number, number]; scale: [number, number] } = {
      offset: [0, 0],
      scale: [1, 1],
    },
    proofToCanvas = false,
    format: GPUTextureFormat = 'rgba16float',
  ): Pass {
    const space: OutputSpace = opts.outputSpace ?? 'srgb'
    const canvasSpace: OutputSpace = proofToCanvas ? 'srgb' : space
    // Headroom only exists where it can be presented. Every other target — the
    // histogram readback, an export tile — is a fixed-range buffer, so asking
    // for range it cannot hold would only clip the highlights a second time.
    const headroom = this.hdrOn ? Math.max(1, opts.hdrHeadroom ?? 1) : 1
    const p = this.cache.get('output', OUTPUT_FS, format)
    p.use()
    p.tex('uImage', texture)
      .set('uToOutput', toGl(outputMatrix(space)))
      .set('uOutputLuma', outputLuma(space))
      .set('uToCanvas', toGl(outputToOutputMatrix(space, canvasSpace)))
      .set('uCanvasLuma', outputLuma(canvasSpace))
      .set('uProofToCanvas', proofToCanvas ? 1 : 0)
      .set('uGamma', outputGamma(canvasSpace))
      .set('uDither', dither)
      .set('uResolution', resolution)
      .set('uShowShadowClip', opts.showShadowClip ? 1 : 0)
      .set('uShowHighlightClip', opts.showHighlightClip ? 1 : 0)
      .set('uClipHighlight', opts.clipHighlight ?? CLIP_HIGHLIGHT_DEFAULT)
      .set('uClipShadow', opts.clipShadow ?? CLIP_SHADOW_DEFAULT)
      .set('uOutputGamutCompress', space === 'prophoto' ? 0 : 1)
      .set('uCanvasGamutCompress', proofToCanvas && space !== canvasSpace ? 1 : 0)
      .set('uHdrHeadroom', headroom)
      .set('uHdrKnee', HDR_KNEE)
      .set('uSrcOffset', src.offset)
      .set('uSrcScale', src.scale)
    return p
  }

  // -------------------------------------------------------------------------
  // Histogram
  // -------------------------------------------------------------------------

  /** Reads the display-referred histogram from the last graph result. */
  async readHistogram(outputSpace: OutputSpace = 'srgb'): Promise<HistogramBins | null> {
    if (!this.lastResult || !this.sourceInfo) return null
    const rendered = this.lastSize.width ? this.lastSize : this.sourceInfo
    const aspect = rendered.height / rendered.width
    const w = HIST_W
    const h = Math.max(1, Math.round(HIST_W * aspect))

    if (!this.histTarget || this.histTarget.width !== w || this.histTarget.height !== h) {
      this.histTarget?.destroy()
      this.histTarget = createTarget(this.ctx, w, h, { format: 'rgba8unorm', filter: 'linear' })
    }

    this.enc = this.beginFrame()
    try {
      this.setFiltering(this.lastResult, true)
      const p = this.outputPass(this.lastResult, { outputSpace }, [w, h], 0, undefined, true, 'rgba8unorm')
      drawPass(this.enc, this.histTarget!, p)
      this.enc.submit()
    } finally {
      this.enc = null
    }

    const buf = await readTexture(this.ctx, this.histTarget!)
    const px = new Uint8Array(buf)

    const r = new Uint32Array(256)
    const g = new Uint32Array(256)
    const b = new Uint32Array(256)
    const l = new Uint32Array(256)
    let clipShadow = 0
    let clipHighlight = 0
    // The same code-value thresholds the viewport overlay paints with. Two sets
    // of numbers for one idea is how the readout ends up counting a different
    // set of pixels than the overlay highlights on the very same frame.
    const hi = CLIP_HIGHLIGHT_DEFAULT * 255
    const lo = CLIP_SHADOW_DEFAULT * 255

    for (let i = 0; i < px.length; i += 4) {
      const R = px[i]
      const G = px[i + 1]
      const B = px[i + 2]
      r[R]++
      g[G]++
      b[B]++
      l[(R * 77 + G * 151 + B * 28) >> 8]++
      if (R <= lo && G <= lo && B <= lo) clipShadow++
      if (R >= hi || G >= hi || B >= hi) clipHighlight++
    }

    let max = 0
    for (let i = 1; i < 255; i++) max = Math.max(max, r[i], g[i], b[i], l[i])

    const total = px.length / 4
    return {
      r,
      g,
      b,
      l,
      max: max || 1,
      clipShadow: clipShadow / total,
      clipHighlight: clipHighlight / total,
    }
  }

  /**
   * Display-referred pixels of the current result.
   *
   * `crop` reads back only part of the image, which is how tiled export drops
   * the halo it renders around each tile. 16-bit output goes through an RGBA16F
   * target so the export path can write real 16-bit TIFFs instead of upscaling
   * 8-bit data and calling it deep.
   */
  async readOutput(outputSpace: OutputSpace = 'srgb'): Promise<ImageData | null> {
    const res = await this.readback(outputSpace, 8, null)
    if (!res) return null
    return new ImageData(res.data as Uint8ClampedArray<ArrayBuffer>, res.width, res.height)
  }

  /**
   * @param clean Reads the picture without any mask overlay tinted over it.
   *   The colour-range picker needs this: sampling the presented graph would
   *   feed the overlay's own colour back into the mask that drew it.
   */
  async readPixels(
    outputSpace: OutputSpace,
    depth: 8 | 16,
    crop?: { x: number; y: number; width: number; height: number } | null,
    clean = false,
  ): Promise<{ width: number; height: number; data: Uint8ClampedArray | Uint16Array } | null> {
    return this.readback(outputSpace, depth, crop ?? null, clean)
  }

  private async readback(
    outputSpace: OutputSpace,
    depth: 8 | 16,
    crop: { x: number; y: number; width: number; height: number } | null,
    clean = false,
  ) {
    const result = clean ? (this.lastClean ?? this.lastResult) : this.lastResult
    if (!result || !this.sourceInfo) return null
    // A crop makes the graph's output smaller than the source; the readback is
    // of what was rendered, not of what was loaded.
    const { width, height } = this.lastSize.width ? this.lastSize : this.sourceInfo

    const cx = crop ? Math.max(0, Math.min(width, crop.x)) : 0
    const cy = crop ? Math.max(0, Math.min(height, crop.y)) : 0
    const cw = crop ? Math.max(1, Math.min(width - cx, crop.width)) : width
    const ch = crop ? Math.max(1, Math.min(height - cy, crop.height)) : height

    const deep = depth === 16
    const format: GPUTextureFormat = deep ? 'rgba16float' : 'rgba8unorm'
    const target = createTarget(this.ctx, width, height, { format, filter: 'nearest' })

    this.enc = this.beginFrame()
    try {
      // 16-bit output has no visible banding, so it skips the dither entirely.
      const p = this.outputPass(result, { outputSpace }, [width, height], deep ? 0 : 1 / 255, undefined, false, format)
      drawPass(this.enc, target, p)
      this.enc.submit()
    } finally {
      this.enc = null
    }

    // `readTexture` returns rows top-first, matching how the image was uploaded,
    // so no row flip is needed here. The WebGL2 version had to flip because
    // gl.readPixels returned rows bottom-first from the framebuffer origin.
    const raw = await readTexture(this.ctx, target)
    target.destroy()

    if (deep) {
      // rgba16float stores IEEE 754 half-float values; convert to uint16 [0, 65535].
      const rawU16 = new Uint16Array(raw)
      const u16 = new Uint16Array(cw * ch * 4)
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const si = ((cy + y) * width + cx + x) * 4
          const di = (y * cw + x) * 4
          for (let c = 0; c < 4; c++) {
            u16[di + c] = Math.max(0, Math.min(65535, Math.round(halfToFloat(rawU16[si + c]) * 65535)))
          }
        }
      }
      return { width: cw, height: ch, data: u16 }
    } else {
      const rawU8 = new Uint8Array(raw)
      const out = new Uint8ClampedArray(cw * ch * 4)
      for (let y = 0; y < ch; y++) {
        const si = ((cy + y) * width + cx) * 4
        out.set(rawU8.subarray(si, si + cw * 4), y * cw * 4)
      }
      return { width: cw, height: ch, data: out }
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Sizes the canvas and, when this context presents to screen, reconfigures
   * the surface.
   *
   * WebGPU's surface format is reconfigured here whenever the canvas changes
   * size or the HDR mode changes (the latter is signalled by `setHdr` zeroing
   * `bufferSize`). The surface tracks the canvas size automatically after
   * configuration, so the only reason to call `configureSurface` again is to
   * switch between the SDR and HDR formats.
   */
  resize(width: number, height: number) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    this.ensureConfigured()
  }

  /**
   * Configures the surface unless it already matches the canvas.
   *
   * WebGPU has no implicit default framebuffer: `getCurrentTexture` throws
   * outright until `configure` has been called, and sizing the canvas is not
   * enough. Doing it once is not enough either, because `setHdr` invalidates
   * the format. So every entry point that presents asks, rather than trusting
   * the caller to have come through `resize` — a caller that sets `canvas.width`
   * itself is doing nothing unreasonable, and used to work.
   */
  private ensureConfigured() {
    if (!this.ctx.surface) return
    const { width, height } = this.canvas
    if (this.bufferSize.width === width && this.bufferSize.height === height) return
    this.hdrOn = configureSurface(this.ctx, this.hdrWanted)
    this.bufferSize = { width, height }
  }

  private disposeSource() {
    if (this.source && this.ownsSource) this.source.destroy()
    this.ownsSource = true
    this.source = null
    this.chain?.dispose()
    this.chain = null
    this.captureCache?.target.destroy()
    this.captureCache = null
    for (const entry of this.aux.values()) entry.chain.dispose()
    this.aux.clear()
    // Teardown happens between frames, so anything held for the encoder can go.
    for (const chain of this.retired) chain.dispose()
    this.retired.length = 0
    this.geom?.dispose()
    this.geom = null
    this.maskAcc?.dispose()
    this.maskAcc = null
    this.maskScratch?.dispose()
    this.maskScratch = null
    this.aiFramed?.dispose()
    this.aiFramed = null
    for (const tex of this.aiTex.values()) tex.destroy()
    this.aiTex.clear()
    for (const tex of this.layerTex.values()) tex.destroy()
    this.layerTex.clear()
    for (const slot of this.coverageSlots.values()) slot.dispose()
    this.coverageSlots.clear()
    for (const chain of this.groupChains) chain?.dispose()
    this.groupChains.length = 0
    this.paneCache?.target.destroy()
    this.paneCache = null
    this.lastResult = null
    this.lastClean = null
    this.lastGraphKey = null
  }

  /**
   * Drops a cached coverage texture so the next frame re-reads it.
   *
   * Detection can produce a second answer for a key it has already answered —
   * the user re-runs it, or the proxy is replaced by a sharper decode — and
   * without this the GPU would keep serving the first upload forever.
   */
  invalidateCoverage(cacheKey: string) {
    const tex = this.aiTex.get(cacheKey)
    if (!tex) return
    tex.destroy()
    this.aiTex.delete(cacheKey)
  }

  dispose() {
    this.disposeSource()
    this.composite?.destroy()
    this.composite = null
    for (const tex of this.lutPool) tex.destroy()
    this.lutPool = []
    this.lutCursor = 0
    this.histTarget?.destroy()
    this.histTarget = null
    this.cache.dispose()
  }
}
