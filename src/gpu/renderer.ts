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
  calibrationMatrix,
  outputGamma,
  outputLuma,
  outputMatrix,
  outputToOutputMatrix,
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
  type Mask,
} from '../core/types'
import { cameraProfile } from '../core/profiles'
import type { SourceImage } from '../core/workingImage'
import { floatToHalf, halfToFloat } from '../core/half'
import { getAlpha } from '../ai/alpha'

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
 * Where HDR expansion begins, as a display value.
 *
 * The render shoulder starts folding highlights at about three quarters of the
 * way up, so that is where re-opening them belongs: below it the picture a
 * photographer graded on an SDR display is left exactly alone, and only the
 * part that was compressed to fit gets its range back.
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
   * several masks, or a before/after pair — therefore takes a texture per
   * curve, and the pool is rewound when the next frame opens.
   */
  private lutPool: Tex[] = []
  private lutCursor = 0
  private lutData = new Float32Array(LUT_SIZE * 4)
  /** Mask coverage buffers, sized to the framed image. */
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
  /** Framed-space coverage, one per AI component in the current mask. */
  private aiFramed: PingPong | null = null
  /**
   * The geometry stage's uniforms, or null when it was skipped.
   *
   * AI coverage is produced on the *sensor* grid — the network reads the proxy,
   * which knows nothing about the crop — while masks are rasterised in the
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

    let w = chain.width
    let h = chain.height
    let texel: [number, number] = [1 / w, 1 / h]

    // Geometry resizes the image mid-graph, so the passes after it write into a
    // second chain. Everything else just uses whichever is current.
    let active = chain
    let input: Tex = src
    const pass = (program: Pass, setup: (p: Pass) => void) => {
      program.use()
      program.tex('uImage', input)
      setup(program)
      drawPass(this.enc!, active.write, program)
      input = active.write
      active.swap()
    }

    const b = edits.basic
    const tone = edits.tone
    const d = edits.detail
    const lens = edits.lens
    const isRaw = !!this.sourceInfo?.isRaw
    const profile = cameraProfile(edits.profile)
    const gain =
      b.wbMode === 'asShot'
        ? ([1, 1, 1] as [number, number, number])
        : whiteBalanceGain(this.asShot, { temp: b.temp, tint: b.tint })
    const cal = edits.calibration
    const calMat = calibrationMatrix(cal)

    // The tiled export's assembled texture has already passed through these
    // source-to-display stages. It re-enters at retouch/framing below.
    if (!this.graded) {
      // --- 1. Highlight reconstruction ---------------------------------------
      // LibRaw has already applied the as-shot balance. Reconstruction still
      // runs before the user's WB delta, against the decoder's retained ceiling.
      const RECOVERY_MODE: Record<string, number> = { clip: 1, blend: 2, propagate: 3 }
      const recoveryMode = RECOVERY_MODE[tone.recovery] ?? 0
      if (isRaw && recoveryMode > 0) {
        const nb = recoveryMode === 3 ? this.blur(input, 2.0, 4) : input
        pass(this.cache.get('recover', RECOVER_FS), (p) => {
          p.tex('uBlur', nb)
            .set('uMode', recoveryMode)
            .set('uThreshold', tone.recoveryThreshold / 100)
            .set('uWhiteLevel', Math.max(this.sourceInfo?.whiteLevel ?? 1, 1e-6))
        })
      }

      // --- 2. Scene preparation ----------------------------------------------
      pass(this.cache.get('sceneInput', SCENE_INPUT_FS), (p) => {
        p.set('uWbGain', gain)
          .set('uCalibration', toGl(calMat))
          .set('uShadowTint', cal.shadowTint / 100)
      })

      // --- 3. Capture cleanup -------------------------------------------------
      // These passes use an extended, reversible tone encoding internally and
      // never clamp the RAW upper range. Their thresholds therefore stay
      // independent of the user's exposure and profile choices.
      if (d.impulseNR > 0) {
        pass(this.cache.get('impulse', IMPULSE_FS), (p) => {
          p.set('uTexel', texel).set('uAmount', d.impulseNR / 100)
        })
      }
      if (d.luminanceNR > 0 || d.colorNR > 0) {
        const denoise = this.cache.get('denoise', DENOISE_FS)
        const runDenoise = (amount = 1) => pass(denoise, (p) => {
          p.set('uTexel', texel)
            .set('uLuminance', (d.luminanceNR / 100) * amount)
            .set('uLumaDetail', d.luminanceNRDetail / 100)
            .set('uLumaContrast', d.luminanceNRContrast / 100)
            .set('uColor', (d.colorNR / 100) * amount)
            .set('uColorDetail', d.colorNRDetail / 100)
            .set('uColorSmoothness', d.colorNRSmoothness / 100)
        })
        runDenoise()
        const extra = Math.max(
          (d.luminanceNR - 55) / 45,
          (d.colorNR - 60) / 40,
        )
        if (extra > 0) runDenoise(Math.min(1, extra))
      }
      if (d.sharpenAmount > 0) {
        const radius = Math.max(0.5, d.sharpenRadius)
        const blurred = this.blur(input, radius, 1)
        pass(this.cache.get('sharpen', SHARPEN_FS), (p) => {
          p.tex('uBlur', blurred)
            .set('uTexel', texel)
            .set('uAmount', (d.sharpenAmount / 100) * 1.5)
            .set('uDetail', d.sharpenDetail / 100)
            .set('uMasking', d.sharpenMasking / 100)
        })
      }

      // Defringe follows capture sharpening so residual chroma haloes are not
      // made crisper by the sharpener.
      if (lens.defringePurpleAmount > 0 || lens.defringeGreenAmount > 0) {
        const window = (lo: number, hi: number, from: number, to: number): [number, number] => {
          const a = from + (to - from) * (Math.min(lo, hi) / 100)
          const b = from + (to - from) * (Math.max(lo, hi) / 100)
          return [a, Math.max(b, a + 0.01)]
        }
        pass(this.cache.get('defringe', DEFRINGE_FS), (p) => {
          p.set('uTexel', texel)
            .set('uPurple', lens.defringePurpleAmount / 20)
            .set('uPurpleHue', window(lens.defringePurpleHueLo, lens.defringePurpleHueHi, 0.63, 0.97))
            .set('uGreen', lens.defringeGreenAmount / 20)
            .set('uGreenHue', window(lens.defringeGreenHueLo, lens.defringeGreenHueHi, 0.2, 0.45))
        })
      }

      // --- 4. Scene-to-display rendering -------------------------------------
      pass(this.cache.get('render', RENDER_FS), (p) => {
        p.set('uExposure', b.exposure)
          .set('uContrast', b.contrast / 100)
          .set('uHighlights', b.highlights / 100)
          .set('uShadows', b.shadows / 100)
          .set('uWhites', b.whites / 100)
          .set('uBlacks', b.blacks / 100)
          .set('uVibrance', b.vibrance / 100)
          .set('uSaturation', b.saturation / 100)
          .set('uProtectSkin', b.protectSkin ? 1 : 0)
          .set('uAvoidShift', b.avoidColorShift ? 1 : 0)
          .set('uProfileCurve', isRaw ? profile.curve : 0)
          .set('uProfileSat', isRaw ? profile.saturation : 0)
          .set('uShoulder', isRaw ? profile.shoulder : 1)
      })
    }

    // --- 5. Creative tone and colour -----------------------------------------
    // --- Local shadows/highlights + dynamic range compression ----------------
    if (tone.shHighlights || tone.shShadows || tone.drcAmount) {
      // Radius maps to a downscale so a wide setting stays cheap: an eighth-res
      // blur covers eight times the ground at the same kernel cost.
      const downscale = tone.shRadius > 60 ? 16 : tone.shRadius > 25 ? 8 : 4
      const local = this.blur(input, 1.5 + tone.shRadius / 22, downscale)
      pass(this.cache.get('tonemap', TONEMAP_FS), (p) => {
        p.tex('uBlur', local)
          .set('uHighlights', tone.shHighlights / 100)
          .set('uShadows', tone.shShadows / 100)
          .set('uWidth', Math.max(0.1, tone.shTonalWidth / 100))
          .set('uDrc', tone.drcAmount / 100)
          .set('uDrcDetail', tone.drcDetail / 100)
      })
    }

    // --- Contrast by detail levels -------------------------------------------
    if (tone.detailFinest || tone.detailFine || tone.detailCoarse || tone.detailCoarsest) {
      // A four-octave pyramid, each level blurring the one above it so the
      // bands really are successive frequency slices rather than four
      // independent blurs of the original.
      const l0 = this.blur(input, 1.2, 1)
      const l1 = this.blur(l0, 1.6, 2)
      const l2 = this.blur(l1, 1.8, 4)
      const l3 = this.blur(l2, 2.0, 8)
      pass(this.cache.get('detailbands', DETAILBANDS_FS), (p) => {
        p.tex('uL0', l0)
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

    // --- Texture / Clarity / Dehaze -------------------------------------------
    if (b.texture || b.clarity || b.dehaze) {
      const fine = this.blur(input, 1.6, 1)
      const coarse = this.blur(input, 2.4, 8)
      pass(this.cache.get('local', LOCAL_FS), (p) => {
        p.tex('uFine', fine)
          .tex('uCoarse', coarse)
          .set('uTexture', b.texture / 100)
          .set('uClarity', b.clarity / 100)
          .set('uDehaze', b.dehaze / 100)
      })
    }

    // --- Tone curve -----------------------------------------------------------
    const tc = edits.curve
    const hasRgb = !isIdentityParametric(tc.parametric) || !isIdentityPoints(tc.rgb)
    const hasChannels =
      !isIdentityPoints(tc.red) || !isIdentityPoints(tc.green) || !isIdentityPoints(tc.blue)

    if (hasRgb || hasChannels) {
      const lut = this.uploadLut(tc)
      const CURVE_MODE: Record<string, number> = {
        standard: 0,
        weighted: 1,
        filmLike: 2,
        saturationAndValue: 3,
        luminance: 4,
        perceptual: 5,
      }
      pass(this.cache.get('curve', CURVE_FS), (p) => {
        p.tex('uLut', lut)
          .set('uHasRgb', hasRgb ? 1 : 0)
          .set('uHasChannels', hasChannels ? 1 : 0)
          .set('uMode', CURVE_MODE[tc.rgbMode] ?? 0)
      })
    }

    // --- Colour mixer ---------------------------------------------------------
    const mix = edits.colorMixer
    const isBw = b.treatment === 'bw'
    const anyBand =
      !isBw &&
      COLOR_BANDS.some((band) => mix.hue[band] || mix.saturation[band] || mix.luminance[band])
    if (anyBand) {
      const hue = new Float32Array(8)
      const sat = new Float32Array(8)
      const lum = new Float32Array(8)
      COLOR_BANDS.forEach((band, i) => {
        hue[i] = mix.hue[band] / 100
        sat[i] = mix.saturation[band] / 100
        lum[i] = mix.luminance[band] / 100
      })
      pass(this.cache.get('colormix', COLORMIX_FS), (p) => {
        p.set('uHue', hue).set('uSat', sat).set('uLum', lum)
      })
    }

    // --- Black & white --------------------------------------------------------
    if (isBw) {
      const bw = new Float32Array(8)
      COLOR_BANDS.forEach((band, i) => {
        bw[i] = mix.bw[band] / 100
      })
      pass(this.cache.get('bw', BW_FS), (p) => {
        p.set('uMix', bw)
      })
    }

    // --- Colour grading -------------------------------------------------------
    const cg = edits.colorGrading
    const wheels = [cg.shadows, cg.midtones, cg.highlights, cg.global]
    if (wheels.some((x) => x.saturation || x.luminance)) {
      const asVec = (x: (typeof wheels)[number]): [number, number, number] => [
        x.hue / 360,
        x.saturation / 100,
        x.luminance / 100,
      ]
      pass(this.cache.get('grading', GRADING_FS), (p) => {
        p.set('uShadow', asVec(cg.shadows))
          .set('uMidtone', asVec(cg.midtones))
          .set('uHighlight', asVec(cg.highlights))
          .set('uGlobal', asVec(cg.global))
          .set('uBlending', cg.blending / 100)
          .set('uBalance', cg.balance / 100)
      })
    }

    // --- 6. Retouch: spots and red-eye ----------------------------------------
    // Before geometry, because a spot is pinned to the thing it covers: crop or
    // straighten afterwards and it travels with the blemish rather than with
    // the frame.
    const spots = edits.spots.filter((sp) => sp.opacity > 0 && sp.radius > 0)
    if (spots.length) {
      // A heal needs the image's low frequencies. One blur serves every spot.
      const low = this.blurAt(input, w, h, 6, 8)
      const aspect = aspectVec(w, h)
      const prog = this.cache.get('spot', SPOT_FS)
      for (let i = 0; i < spots.length; i += MAX_SPOTS) {
        const batch = spots.slice(i, i + MAX_SPOTS)
        const pos = new Float32Array(MAX_SPOTS * 4)
        const par = new Float32Array(MAX_SPOTS * 4)
        batch.forEach((sp, k) => {
          pos.set([sp.target.x, sp.target.y, sp.source.x, sp.source.y], k * 4)
          par.set(
            [sp.radius, sp.feather / 100, sp.opacity, sp.mode === 'clone' ? 1 : 0],
            k * 4,
          )
        })
        pass(prog, (p) => {
          p.tex('uBlur', low)
            .set('uCount', batch.length)
            .setVectors('uSpots', pos, 4)
            .setVectors('uParams', par, 4)
            .set('uAspect', aspect)
        })
      }
    }

    const eyes = edits.redEye.filter((r) => r.radius > 0)
    if (eyes.length) {
      const aspect = aspectVec(w, h)
      const prog = this.cache.get('redEye', RED_EYE_FS)
      for (let i = 0; i < eyes.length; i += MAX_EYES) {
        const batch = eyes.slice(i, i + MAX_EYES)
        const arr = new Float32Array(MAX_EYES * 4)
        const meta = new Float32Array(MAX_EYES * 4)
        batch.forEach((r, k) => {
          arr.set([r.center.x, r.center.y, r.radius, r.darken / 100], k * 4)
          meta.set([r.kind === 'pet' ? 1 : 0, 0, 0, 0], k * 4)
        })
        pass(prog, (p) => {
          p.set('uCount', batch.length)
            .setVectors('uEyes', arr, 4)
            .setVectors('uMeta', meta, 4)
            .set('uAspect', aspect)
        })
      }
    }

    // --- Geometry & optics ----------------------------------------------------
    // Last of the pixel-moving work and first of the framing: everything above
    // reads neighbours, so it has to happen while the pixels are still on the
    // sensor grid. Vignette and grain come after, because a post-crop vignette
    // is defined on the crop.
    if (!isIdentityGeometry(edits)) {
      const out = geometryOutputSize(chain.width, chain.height, edits)
      const geom = this.geometryChain(out.width, out.height)
      const c = edits.crop
      const t = edits.transform
      const lensG = lens

      const turned = c.quarterTurns % 2 === 1

      // Kept so AI coverage can be replayed through the identical mapping
      // below. Chromatic aberration and lens vignetting are excluded when it
      // is: both are optical corrections on colour, and coverage has none.
      const uniforms: Record<string, number | number[]> = {
        uInAspect: aspectVec(chain.width, chain.height),
        uFrameAspect: aspectVec(
          turned ? chain.height : chain.width,
          turned ? chain.width : chain.height,
        ),
        uCrop: [c.left, c.top, c.right, c.bottom],
        uAngle: ((c.angle + t.rotate) * Math.PI) / 180,
        uQuarter: c.quarterTurns & 3,
        uFlip: [c.flipH ? -1 : 1, c.flipV ? -1 : 1],
        // Lightroom's ±100 keystone is roughly a half-frame shift at the edge.
        uPerspective: [t.horizontal / 220, t.vertical / 220],
        uAspectStretch: [
          t.aspect > 0 ? 1 + t.aspect / 100 : 1,
          t.aspect < 0 ? 1 - t.aspect / 100 : 1,
        ],
        uScale: Math.max(0.05, t.scale / 100),
        uOffset: [t.offsetX / 100, -t.offsetY / 100],
        uDistortion: [-lensG.distortion / 100, 0],
        uEdgeFill: 0,
      }
      this.frameGeom = uniforms

      const prog = this.cache.get('geometry', GEOMETRY_FS)
      prog.use()
      prog.tex('uImage', input)
      for (const [name, value] of Object.entries(uniforms)) prog.set(name, value)
      prog.set('uCa', [lensG.caRed / 2000, lensG.caBlue / 2000])
      prog.set('uLensVignette', lensG.vignetting / 100)
      drawPass(this.enc!, geom.write, prog)

      input = geom.write
      geom.swap()
      active = geom
      w = out.width
      h = out.height
      texel = [1 / w, 1 / h]
    } else {
      this.frameGeom = null
    }

    // --- Local adjustments ----------------------------------------------------
    // After geometry, because a mask is drawn on the photo the user can see:
    // its coordinates are the cropped, straightened frame's, not the sensor's.
    const masks = edits.masks.filter((m) => m.visible && m.components.length > 0)
    if (masks.length) {
      const apply = this.cache.get('maskApply', MASK_APPLY_FS)
      for (const mask of masks) {
        const cov = this.buildMask(mask, input, w, h)
        if (!cov) continue
        const a = mask.adjustments
        // Recomputed per mask: the previous mask may have changed the pixels
        // these are measured against.
        const fine = this.blurAt(input, w, h, 1.6, 2)
        const coarse = this.blurAt(input, w, h, 3.0, 8)
        const hasCurve = a.curve.length > 0 && !isIdentityPoints(a.curve)
        const maskLut = hasCurve ? this.uploadMaskLut(a.curve) : null

        pass(apply, (p) => {
          p.tex('uMask', cov)
            .tex('uFine', fine)
            .tex('uCoarse', coarse)
            .tex('uLut', maskLut)
            .set('uHasCurve', hasCurve ? 1 : 0)
            .set('uLutSize', LUT_SIZE)
            .set('uOpacity', mask.opacity)
            .set('uExposure', a.exposure)
            .set('uContrast', a.contrast / 100)
            .set('uHighlights', a.highlights / 100)
            .set('uShadows', a.shadows / 100)
            .set('uWhites', a.whites / 100)
            .set('uBlacks', a.blacks / 100)
            .set('uTexture', a.texture / 100)
            .set('uClarity', a.clarity / 100)
            .set('uDehaze', a.dehaze / 100)
            .set('uTemp', a.temp / 100)
            .set('uTint', a.tint / 100)
            .set('uSaturation', a.saturation / 100)
            .set('uHue', a.hue)
            .set('uHueStrength', a.hueStrength / 100)
            .set('uColorize', a.colorize / 100)
            .set('uSharpness', a.sharpness / 100)
            .set('uNoise', a.noise / 100)
            .set('uMoire', a.moire / 100)
            .set('uDefringe', a.defringe / 100)
        })
      }
    }

    // --- Effects --------------------------------------------------------------
    const fx = edits.effects
    if (fx.vignetteAmount || fx.grainAmount) {
      const f = active === chain ? this.frame : { resolution: [w, h] as [number, number], offset: [0, 0] as [number, number], scale: [1, 1] as [number, number] }
      pass(this.cache.get('effects', EFFECTS_FS), (p) => {
        p.set('uVignette', fx.vignetteAmount / 100)
          .set('uMidpoint', fx.vignetteMidpoint / 100)
          .set('uRoundness', fx.vignetteRoundness / 100)
          .set('uFeather', fx.vignetteFeather / 100)
          .set('uVignetteHighlights', fx.vignetteHighlights / 100)
          .set('uGrain', fx.grainAmount / 100)
          .set('uGrainSize', fx.grainSize / 100)
          .set('uGrainRough', fx.grainRoughness / 100)
          .set('uResolution', f.resolution)
          .set('uFrameOffset', f.offset)
          .set('uFrameScale', f.scale)
          .set('uSeed', 0)
      })
    }

    // --- Mask overlay ---------------------------------------------------------
    // Last of all, so what you see tinted is the finished picture.
    //
    // Kept separately because the colour-range picker must sample the picture,
    // not the tint drawn over it: re-picking a covered pixel would otherwise
    // store the overlay's colour and throw the selection away. The chain has
    // ping-ponged past this texture, so it stays intact until the next frame
    // writes it — exactly as long as `lastResult` does.
    this.lastClean = input
    if (overlay) {
      const mask = edits.masks.find((m) => m.id === overlay.maskId)
      const cov = mask ? this.buildMask(mask, input, w, h) : null
      if (cov) {
        pass(this.cache.get('maskShow', MASK_SHOW_FS), (p) => {
          p.tex('uMask', cov)
            .set('uTint', overlay.tint ?? [0.95, 0.25, 0.3])
            .set('uAmount', overlay.amount ?? 0.55)
            .set('uMode', overlay.mode === 'coverage' ? 1 : 0)
        })
      }
    }

    this.lastResult = input
    this.lastMipped = false
    this.lastSize = { width: w, height: h }
    return input
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
    mask: Mask,
    image: Tex,
    width: number,
    height: number,
  ): Tex | null {
    // An AI component with no coverage yet is dropped rather than rasterised
    // as empty. Detection is asynchronous, and a mask that briefly reads as
    // "everything is selected" would flash the whole photo's adjustments on
    // screen in the second before the network answers.
    const parts = mask.components.filter(
      (c) => c.geometry.kind in MASK_KIND && (!isAiGeometry(c.geometry) || this.aiCoverage(c.geometry.cacheKey)),
    )
    if (!parts.length) return null

    if (!this.maskAcc || this.maskAcc.width !== width || this.maskAcc.height !== height) {
      this.retire(this.maskAcc)
      this.retire(this.maskScratch)
      this.maskAcc = new PingPong(this.ctx, width, height)
      this.maskScratch = new PingPong(this.ctx, width, height)
    }
    const acc = this.maskAcc
    const scratch = this.maskScratch!
    const aspect = aspectVec(width, height)

    const raster = this.cache.get('mask', MASK_FS)
    const merge = this.cache.get('maskMerge', MASK_MERGE_FS)

    let cov: Tex = acc.read
    let first = true

    for (const part of parts) {
      const g = part.geometry
      const kind = MASK_KIND[g.kind as keyof typeof MASK_KIND]

      // -- rasterise into scratch --------------------------------------------
      if (g.kind === 'brush') {
        const dabs = g.dabs
        if (!dabs.length) continue
        const buf = new Float32Array(MAX_DABS * 4)
        for (let i = 0; i < dabs.length; i += MAX_DABS) {
          const chunk = dabs.slice(i, i + MAX_DABS)
          buf.fill(0)
          chunk.forEach((d, j) => {
            buf[j * 4] = d.x
            buf[j * 4 + 1] = d.y
            buf[j * 4 + 2] = d.radius
            // Erase rides in as a negative flow, so the shader needs no branch
            // on a second array.
            buf[j * 4 + 3] = d.erase ? -Math.max(d.flow, 0.001) : Math.max(d.flow, 0.001)
          })
          raster.use()
          raster.tex('uImage', image).tex('uPrev', scratch.read)
          // Bound for the same reason the other kinds bind it below: `uAlpha`
          // is declared unconditionally, and a declared texture that is never
          // bound is an error rather than an empty read.
          raster.tex('uAlpha', null)
          raster.setVectors('uDabs', buf, 4)
          raster
            .set('uKind', kind)
            .set('uAspect', aspect)
            .set('uDabCount', chunk.length)
            .set('uBrushFeather', g.feather)
            .set('uFirstChunk', i === 0 ? 1 : 0)
          drawPass(this.enc!, scratch.write, raster)
          scratch.swap()
        }
      } else {
        // Coverage arrives on the sensor grid, so it is walked through the
        // frame's own geometry before anything samples it. Resolved before the
        // raster pass is configured because it draws a pass of its own.
        const ai = isAiGeometry(g) ? g : null
        const alpha = ai ? this.framedAlpha(ai.cacheKey, width, height) : null

        raster.use()
        raster.tex('uImage', image).tex('uPrev', scratch.read)
        // Bound for every kind, not just the detected ones. The shader declares
        // `uAlpha` unconditionally, and a declared texture that is never bound
        // is an error rather than a placeholder — so a gradient drawn while an
        // AI kind exists in the same build would take the whole mask down.
        raster.tex('uAlpha', alpha)
        raster.set('uKind', kind).set('uAspect', aspect)
        if (g.kind === 'linear') {
          raster.set('uP0', [g.start.x, g.start.y]).set('uP1', [g.end.x, g.end.y])
        } else if (g.kind === 'radial') {
          raster
            .set('uCenter', [g.center.x, g.center.y])
            .set('uRadius', [g.radiusX, g.radiusY])
            .set('uRotation', g.rotation)
            .set('uFeather', g.feather)
        } else if (g.kind === 'colorRange') {
          const buf = new Float32Array(MAX_SAMPLES * 3)
          const n = Math.min(g.samples.length, MAX_SAMPLES)
          for (let i = 0; i < n; i++) {
            buf[i * 3] = g.samples[i].r
            buf[i * 3 + 1] = g.samples[i].g
            buf[i * 3 + 2] = g.samples[i].b
          }
          raster.setVectors('uSamples', buf, 3)
          raster.set('uSampleCount', n).set('uRefine', g.refine)
        } else if (g.kind === 'luminanceRange') {
          raster.set('uRange', g.range).set('uSmoothness', g.smoothness)
        } else if (ai && alpha) {
          raster
            .set('uRefine', ai.refine)
            .set('uTexel', [1 / width, 1 / height])
            .set('uAiInvert', ai.kind === 'aiBackground' ? 1 : 0)
        }
        drawPass(this.enc!, scratch.write, raster)
        scratch.swap()
      }

      // -- fold into the accumulator -----------------------------------------
      merge.use()
      merge.tex('uPrev', cov).tex('uCov', scratch.read)
      merge
        .set('uBlend', MASK_BLEND[part.blend as keyof typeof MASK_BLEND] ?? 0)
        .set('uInvert', part.invert ? 1 : 0)
        .set('uFirst', first ? 1 : 0)
      drawPass(this.enc!, acc.write, merge)
      cov = acc.write
      acc.swap()
      first = false
    }

    if (first) return null

    // The whole-mask invert comes last, so it flips the finished shape rather
    // than each component in turn.
    if (mask.inverted) {
      merge.use()
      merge.tex('uPrev', cov).tex('uCov', cov)
      merge.set('uBlend', 0).set('uInvert', 1).set('uFirst', 1)
      drawPass(this.enc!, acc.write, merge)
      cov = acc.write
      acc.swap()
    }
    return cov
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
    const texture = this.runGraph(edits, !!opts.bypass, opts.maskOverlay ?? null)
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
