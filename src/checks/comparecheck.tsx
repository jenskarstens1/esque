/**
 * Headless smoke check for the compare renderer.
 *
 * Drives `Renderer.renderPanes` directly against a synthetic image so the
 * split, paired and single layouts can be verified without a catalog, a RAW
 * decode or a browser file picker. Run through `tools/headless.mjs`.
 */
import { Renderer } from '../gpu/renderer'
import { defaultEdits } from '../core/defaults'
import { geometryOutputSize } from '../gpu/geometry'
import { defaultMaskAdjustments } from '../core/defaults'
import { MAX_DABS } from '../gpu/wgsl/mask'
import { MAX_SPOTS } from '../gpu/wgsl/retouch'
import type { Edits, Mask, MaskGeometry } from '../core/types'
import type { SourceImage } from '../gpu/renderer'
import { RENDERED_WHITE_POINT } from '../core/workingImage'
import { runCheck } from './checkreport'

const RENDERED_SOURCE = {
  isRaw: false,
  asShot: RENDERED_WHITE_POINT,
  whiteLevel: 1,
} as const

declare global {
  interface Window {
    __done?: boolean
    __result?: unknown
  }
}

/** Half-float bit pattern for a value in [0,1]; good enough for test pixels. */
function toHalf(value: number): number {
  const f = new Float32Array(1)
  const i = new Uint32Array(f.buffer)
  f[0] = value
  const x = i[0]
  const sign = (x >>> 16) & 0x8000
  let exp = ((x >>> 23) & 0xff) - 127 + 15
  const mant = x & 0x7fffff
  if (exp <= 0) return sign
  if (exp >= 31) return sign | 0x7c00
  return sign | (exp << 10) | (mant >> 13)
}

function synthetic(width: number, height: number): SourceImage {
  const data = new Uint16Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      // A flat mid grey: any tonal edit shows up as a uniform shift, so pixel
      // comparisons stay unambiguous.
      data[i] = toHalf(0.18)
      data[i + 1] = toHalf(0.18)
      data[i + 2] = toHalf(0.18)
      data[i + 3] = toHalf(1)
    }
  }
  return { width, height, data, ...RENDERED_SOURCE }
}

/**
 * A source whose pixel value encodes its own position: red ramps left to right,
 * green ramps top to bottom. Any geometric map can then be read back off the
 * rendered pixels — a crop that reframes really does move the ramp.
 */
function ramped(width: number, height: number): SourceImage {
  const data = new Uint16Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      data[i] = toHalf(0.05 + 0.9 * ((x + 0.5) / width))
      data[i + 1] = toHalf(0.05 + 0.9 * ((y + 0.5) / height))
      data[i + 2] = toHalf(0.5)
      data[i + 3] = toHalf(1)
    }
  }
  return { width, height, data, ...RENDERED_SOURCE }
}

/** A flat colour, for reading a mask's shape straight off the frame. */
function solid(width: number, height: number, rgb: [number, number, number]): SourceImage {
  const data = new Uint16Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = toHalf(rgb[0])
    data[i * 4 + 1] = toHalf(rgb[1])
    data[i * 4 + 2] = toHalf(rgb[2])
    data[i * 4 + 3] = toHalf(1)
  }
  return { width, height, data, ...RENDERED_SOURCE }
}

const CW = 400
const CH = 300

/**
 * Reads the canvas one frame at a time.
 *
 * A WebGPU canvas is only readable within the task that submitted the frame,
 * and WebKit will not reliably serve several small `drawImage` crops out of a
 * single presented texture — the second and later samples can come back as the
 * previous frame, or as black. Sampling the split view that way reported the
 * "before" pane's value on the "after" side, which reads exactly like a
 * renderer bug and is not one.
 *
 * So the whole canvas is copied once per presented frame and every sample is
 * read out of that snapshot. One `drawImage` per frame is the case both
 * browsers agree on, and the samples then cost nothing.
 */
let _snap: { ctx: CanvasRenderingContext2D; data: ImageData; frame: number } | null = null
let _renderer: Renderer | null = null

function snapshot(canvas: HTMLCanvasElement) {
  const frame = _renderer?.frames ?? -1
  if (_snap && _snap.frame === frame && _snap.data.width === canvas.width) return _snap.data

  if (!_snap || _snap.ctx.canvas.width !== canvas.width || _snap.ctx.canvas.height !== canvas.height) {
    const c = document.createElement('canvas')
    c.width = canvas.width
    c.height = canvas.height
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    _snap = { ctx, data: new ImageData(canvas.width, canvas.height), frame: -1 }
  }
  _snap.ctx.clearRect(0, 0, canvas.width, canvas.height)
  _snap.ctx.drawImage(canvas, 0, 0)
  _snap.data = _snap.ctx.getImageData(0, 0, canvas.width, canvas.height)
  _snap.frame = frame
  return _snap.data
}

// Both the source canvas and the 2D context count y downward from the
// top-left corner, so no coordinate flip is needed.
function pixelAt(canvas: HTMLCanvasElement, x: number, y: number) {
  const data = snapshot(canvas)
  const i = (Math.round(y) * data.width + Math.round(x)) * 4
  return [data.data[i], data.data[i + 1], data.data[i + 2]] as const
}

async function run() {
  const canvas = document.createElement('canvas')
  canvas.width = CW
  canvas.height = CH
  document.body.appendChild(canvas)

  const renderer = await Renderer.create(canvas)
  _renderer = renderer
  renderer.setImage(synthetic(64, 48))

  const before: Edits = defaultEdits()
  const after: Edits = defaultEdits()
  after.basic.exposure = 2

  const full = { x: 0, y: 0, width: CW, height: CH }
  const out: Record<string, unknown> = {}

  // -- single pane ----------------------------------------------------------
  renderer.render(before, { rect: full })
  const singleBefore = pixelAt(canvas, CW / 2, CH / 2)
  renderer.render(after, { rect: full })
  const singleAfter = pixelAt(canvas, CW / 2, CH / 2)
  out.singleBefore = singleBefore
  out.singleAfter = singleAfter
  out.exposureChangedImage = singleAfter[0] > singleBefore[0] + 20

  // -- vertical split -------------------------------------------------------
  const cut = Math.round(CW * 0.5)
  const drawSplit = () =>
    renderer.renderPanes(
      [
        {
          edits: before,
          rect: full,
          clip: { x: 0, y: 0, width: cut, height: CH },
          cacheKey: 'before:1',
        },
        { edits: after, rect: full, clip: { x: cut, y: 0, width: CW - cut, height: CH } },
      ],
      {},
    )
  drawSplit()
  const left = pixelAt(canvas, 40, CH / 2)
  const right = pixelAt(canvas, CW - 40, CH / 2)
  out.splitLeft = left
  out.splitRight = right
  out.splitLeftMatchesBefore = Math.abs(left[0] - singleBefore[0]) <= 2
  out.splitRightMatchesAfter = Math.abs(right[0] - singleAfter[0]) <= 2

  // Second pass exercises the cache hit path; the picture must not move.
  drawSplit()
  const leftCached = pixelAt(canvas, 40, CH / 2)
  out.cacheStable = Math.abs(leftCached[0] - left[0]) <= 1

  // -- paired side by side --------------------------------------------------
  const gutter = 10
  const half = (CW - gutter) / 2
  const paneW = Math.round(half * 0.8)
  const paneH = Math.round(CH * 0.8)
  renderer.renderPanes(
    [
      {
        edits: before,
        rect: { x: (half - paneW) / 2, y: (CH - paneH) / 2, width: paneW, height: paneH },
        clip: { x: 0, y: 0, width: half, height: CH },
        cacheKey: 'before:1',
      },
      {
        edits: after,
        rect: { x: half + gutter + (half - paneW) / 2, y: (CH - paneH) / 2, width: paneW, height: paneH },
        clip: { x: half + gutter, y: 0, width: half, height: CH },
      },
    ],
    {},
  )
  out.pairedLeft = pixelAt(canvas, Math.round(half / 2), CH / 2)
  out.pairedRight = pixelAt(canvas, Math.round(half + gutter + half / 2), CH / 2)
  // The gutter must stay black — nothing may bleed across it.
  out.pairedGutter = pixelAt(canvas, Math.round(half + gutter / 2), CH / 2)

  const p = out as Record<string, number[]>
  out.pairedLeftMatchesBefore = Math.abs(p.pairedLeft[0] - singleBefore[0]) <= 2
  out.pairedRightMatchesAfter = Math.abs(p.pairedRight[0] - singleAfter[0]) <= 2
  out.pairedGutterIsBlack = p.pairedGutter[0] <= 2

  // -- clip must not move the image ----------------------------------------
  // Clipping is a window, not a transform: a pixel visible through a narrow
  // clip has to hold exactly the value the unclipped draw put there.
  renderer.render(after, { rect: full })
  const reference = pixelAt(canvas, 300, 100)
  renderer.renderPanes(
    [{ edits: after, rect: full, clip: { x: 280, y: 80, width: 60, height: 60 } }],
    {},
  )
  const clipped = pixelAt(canvas, 300, 100)
  out.clipDoesNotShiftImage = Math.abs(clipped[0] - reference[0]) <= 1
  out.outsideClipIsBlack = pixelAt(canvas, 100, 100)[0] <= 2

  const failures = Object.entries(out)
    .filter(([, v]) => v === false)
    .map(([k]) => k)

  // -- every pass compiles and runs -----------------------------------------
  // Each new feature is switched on one at a time so a shader that fails to
  // compile names itself instead of hiding in a pile of enabled options.
  const features: Record<string, (e: Edits) => void> = {
    recoveryClip: (e) => {
      e.tone.recovery = 'clip'
    },
    recoveryBlend: (e) => {
      e.tone.recovery = 'blend'
      e.tone.recoveryThreshold = 90
    },
    recoveryPropagate: (e) => {
      e.tone.recovery = 'propagate'
      e.tone.recoveryThreshold = 85
    },
    shadowsHighlights: (e) => {
      e.tone.shHighlights = 60
      e.tone.shShadows = 40
    },
    drc: (e) => {
      e.tone.drcAmount = 50
    },
    detailLevels: (e) => {
      e.tone.detailFinest = 40
      e.tone.detailCoarsest = -30
    },
    curveWeighted: (e) => {
      e.curve.rgbMode = 'weighted'
      e.curve.parametric.lights = 30
    },
    curveFilmLike: (e) => {
      e.curve.rgbMode = 'filmLike'
      e.curve.parametric.lights = 30
    },
    curveSatValue: (e) => {
      e.curve.rgbMode = 'saturationAndValue'
      e.curve.parametric.lights = 30
    },
    curveLuminance: (e) => {
      e.curve.rgbMode = 'luminance'
      e.curve.parametric.lights = 30
    },
    curvePerceptual: (e) => {
      e.curve.rgbMode = 'perceptual'
      e.curve.parametric.lights = 30
    },
    blackAndWhite: (e) => {
      e.basic.treatment = 'bw'
      e.colorMixer.bw.red = 60
      e.colorMixer.bw.blue = -40
    },
    vibranceOptions: (e) => {
      e.basic.vibrance = 60
      e.basic.protectSkin = false
      e.basic.avoidColorShift = true
    },
    impulseNR: (e) => {
      e.detail.impulseNR = 70
    },
    defringe: (e) => {
      e.lens.defringePurpleAmount = 12
      e.lens.defringeGreenAmount = 8
    },
    crop: (e) => {
      e.crop.left = 0.2
      e.crop.top = 0.15
      e.crop.right = 0.8
      e.crop.bottom = 0.9
    },
    straighten: (e) => {
      e.crop.angle = 7.5
    },
    quarterTurn: (e) => {
      e.crop.quarterTurns = 1
    },
    quarterTurnTwice: (e) => {
      e.crop.quarterTurns = 2
    },
    flips: (e) => {
      e.crop.flipH = true
      e.crop.flipV = true
    },
    perspective: (e) => {
      e.transform.vertical = 40
      e.transform.horizontal = -25
    },
    transformFrame: (e) => {
      e.transform.rotate = 3
      e.transform.aspect = 30
      e.transform.scale = 120
      e.transform.offsetX = 10
      e.transform.offsetY = -8
    },
    distortion: (e) => {
      e.lens.distortion = 45
    },
    chromaticAberration: (e) => {
      e.lens.caRed = 60
      e.lens.caBlue = -40
    },
    lensVignette: (e) => {
      e.lens.vignetting = 70
    },
  }

  /** Records a named assertion, so a failure says which one and by how much. */
  const check = (name: string, ok: boolean, detail = '') => {
    if (!ok) failures.push(`${name}${detail ? `(${detail})` : ''}`)
  }

  const passes: Record<string, boolean> = {}
  for (const [name, apply] of Object.entries(features)) {
    const e = defaultEdits()
    apply(e)
    renderer.render(e, { rect: full })
    const px = pixelAt(canvas, CW / 2, CH / 2)
    const ok = Number.isFinite(px[0])
    passes[name] = ok
    if (!ok) failures.push(name)
  }
  out.passes = passes

  // Everything at once, which is also the worst case for the pass chain length.
  const all = defaultEdits()
  for (const apply of Object.values(features)) apply(all)
  all.basic.treatment = 'color'
  all.tone.recovery = 'propagate'
  renderer.render(all, { rect: full })
  const allPx = pixelAt(canvas, CW / 2, CH / 2)
  out.allFeatures = Number.isFinite(allPx[0])
  if (!out.allFeatures) failures.push('allFeatures')
  out.allFeaturesPixel = allPx

  // -- the geometry map, read off the pixels ---------------------------------
  // With a position-encoding source, the rendered byte says where in the source
  // each output pixel came from — so the map can be checked, not just run.
  renderer.setImage(ramped(129, 97))

  /** Renders `edits` and reads the ramp at a normalised output point. */
  const probe = (e: Edits, nx: number, ny: number) => {
    renderer.render(e, { rect: full })
    return pixelAt(canvas, Math.round(nx * (CW - 1)), Math.round(ny * (CH - 1)))
  }

  // The output transform is monotonic but not linear, so positions are compared
  // by round-tripping through the identity render rather than by arithmetic.
  const identity = defaultEdits()
  renderer.render(identity, { rect: full })
  const rowX: number[] = []
  const colY: number[] = []
  for (let i = 0; i < CW; i++) rowX.push(pixelAt(canvas, i, Math.round(CH / 2))[0])
  for (let i = 0; i < CH; i++) colY.push(pixelAt(canvas, Math.round(CW / 2), i)[1])

  // Gamut compression must not put a reversal into a smooth channel ramp.
  renderer.renderOffscreen(defaultEdits('rendered'))
  const gamutRamp = (await renderer.readPixels('srgb', 16, null))!
  let gamutDrop = 0
  let gamutDropAt = -1
  let gamutDropPixels: [number, number] = [0, 0]
  const rampX = Math.round(gamutRamp.width / 2)
  for (let y = 1; y < gamutRamp.height; y++) {
    const previous = gamutRamp.data[((y - 1) * gamutRamp.width + rampX) * 4 + 1]
    const current = gamutRamp.data[(y * gamutRamp.width + rampX) * 4 + 1]
    if (previous - current > gamutDrop) {
      gamutDrop = previous - current
      gamutDropAt = y
      gamutDropPixels = [previous, current]
    }
  }
  out.gamutMonotonicDrop = gamutDrop
  out.gamutMonotonicAt = gamutDropAt
  out.gamutMonotonicPixels = gamutDropPixels
  check('gamutMonotonic', gamutDrop <= 128, `drop ${gamutDrop}`)

  /** Inverts a ramp: which normalised position produced this byte? */
  const invert = (table: number[], value: number) => {
    let best = 0
    let bestErr = Infinity
    for (let i = 0; i < table.length; i++) {
      const err = Math.abs(table[i] - value)
      if (err < bestErr) {
        bestErr = err
        best = i
      }
    }
    return best / (table.length - 1)
  }

  const near = (a: number, b: number, tol = 0.05) => Math.abs(a - b) <= tol
  const geom: Record<string, unknown> = {}
  const expectX = (name: string, e: Edits, nx: number, want: number) => {
    const got = invert(rowX, probe(e, nx, 0.5)[0])
    geom[name] = Number(got.toFixed(3))
    if (!near(got, want)) failures.push(`${name}(got ${got.toFixed(3)} want ${want})`)
  }

  // Identity: the output is the source.
  expectX('identityMap', defaultEdits(), 0.3, 0.3)

  // A half-width centred crop: output 0.3 is source 0.25 + 0.3 × 0.5 = 0.4.
  const cropped = defaultEdits()
  cropped.crop.left = 0.25
  cropped.crop.right = 0.75
  expectX('cropReframes', cropped, 0.3, 0.4)
  expectX('cropLeftEdge', cropped, 0.02, 0.26)

  // A full-frame crop is the identity.
  const fullCrop = defaultEdits()
  fullCrop.crop.left = 0
  fullCrop.crop.right = 1
  expectX('identityCropIsNoop', fullCrop, 0.3, 0.3)

  // A horizontal flip mirrors the ramp.
  const flipped = defaultEdits()
  flipped.crop.flipH = true
  expectX('flipMirrors', flipped, 0.25, 0.75)

  // Two quarter turns are a 180° rotation, which also mirrors x.
  const halfTurn = defaultEdits()
  halfTurn.crop.quarterTurns = 2
  expectX('halfTurnMirrors', halfTurn, 0.25, 0.75)

  // A single quarter turn puts the *vertical* ramp along the output's x axis.
  // Turning the photo clockwise sends its bottom edge to the left, so the
  // output's left column reads the source's bottom rows.
  const quarter = defaultEdits()
  quarter.crop.quarterTurns = 1
  const qpx = probe(quarter, 0.25, 0.5)
  geom.quarterTurnReadsGreen = Number(invert(colY, qpx[1]).toFixed(3))
  if (!near(invert(colY, qpx[1]), 0.75, 0.08)) {
    failures.push(`quarterTurnReadsGreen(${geom.quarterTurnReadsGreen})`)
  }

  // Scale is a zoom about the centre: at 200% the frame covers half the source.
  const zoomed = defaultEdits()
  zoomed.transform.scale = 200
  expectX('scaleZooms', zoomed, 0.25, 0.375)

  out.geometry = geom
  renderer.setImage(synthetic(64, 48))

  // A quarter turn swaps the output's proportions.
  const turned = defaultEdits()
  turned.crop.quarterTurns = 1
  const size = geometryOutputSize(600, 400, turned)
  out.quarterTurnSwapsSize = size.width === 400 && size.height === 600
  if (!out.quarterTurnSwapsSize) failures.push('quarterTurnSwapsSize')

  const halfCrop = defaultEdits()
  halfCrop.crop.left = 0.25
  halfCrop.crop.right = 0.75
  const halfSize = geometryOutputSize(600, 400, halfCrop)
  out.cropShrinksSize = halfSize.width === 300 && halfSize.height === 400
  if (!out.cropShrinksSize) failures.push('cropShrinksSize')

  // -- masks, read off the pixels -------------------------------------------
  // A mask that only sets exposure turns coverage into brightness, so the
  // rendered frame *is* the mask and every shape can be measured directly.
  {
    const flat = solid(80, 60, [0.18, 0.18, 0.18])
    renderer.setImage(flat)

    const maskEdits = (geometry: MaskGeometry, extra: Partial<Mask> = {}): Edits => {
      const e = defaultEdits()
      e.masks = [
        {
          id: 'm1',
          name: 'Mask 1',
          visible: true,
          inverted: false,
          opacity: 1,
          components: [{ id: 'c1', blend: 'add', invert: false, geometry }],
          adjustments: { ...defaultMaskAdjustments(), exposure: 2 },
          ...extra,
        },
      ]
      return e
    }

    /** Brightness at a normalised point, 0..255. */
    const at = (e: Edits, nx: number, ny: number) => {
      renderer.render(e, { rect: full })
      return pixelAt(canvas, Math.round(nx * (CW - 1)), Math.round(ny * (CH - 1)))[0]
    }

    const base = at(defaultEdits(), 0.5, 0.5)
    const masks: Record<string, unknown> = { base }

    // Linear: dark at the start handle, bright at the end, monotone between.
    {
      const e = maskEdits({
        kind: 'linear',
        start: { x: 0, y: 0.5 },
        end: { x: 1, y: 0.5 },
      })
      const l = at(e, 0.02, 0.5)
      const m = at(e, 0.5, 0.5)
      const r = at(e, 0.98, 0.5)
      masks.linear = [l, m, r]
      check('linearStartsUnmasked', Math.abs(l - base) < 4, `${l} vs ${base}`)
      check('linearEndsFullyMasked', r > base + 40, `${r} vs ${base}`)
      check('linearRampsMonotonically', l < m && m < r, `${l},${m},${r}`)
      check('linearMidIsHalfway', Math.abs(m - (l + r) / 2) < (r - l) * 0.25, `${m}`)
    }

    // Radial: bright in the middle, untouched at the corners.
    {
      const e = maskEdits({
        kind: 'radial',
        center: { x: 0.5, y: 0.5 },
        radiusX: 0.25,
        radiusY: 0.25,
        rotation: 0,
        feather: 30,
      })
      const c = at(e, 0.5, 0.5)
      const edge = at(e, 0.98, 0.98)
      masks.radial = [c, edge]
      check('radialCentreMasked', c > base + 40, `${c} vs ${base}`)
      check('radialCornerClean', Math.abs(edge - base) < 4, `${edge} vs ${base}`)
    }

    // A radial that is wide but short must be an ellipse, not a circle.
    {
      const e = maskEdits({
        kind: 'radial',
        center: { x: 0.5, y: 0.5 },
        radiusX: 0.45,
        radiusY: 0.12,
        rotation: 0,
        feather: 10,
      })
      const side = at(e, 0.82, 0.5)
      const above = at(e, 0.5, 0.82)
      masks.ellipse = [side, above]
      check('radialIsElliptical', side > above + 30, `side=${side} above=${above}`)
    }

    // Whole-mask invert flips the shape, not each component.
    {
      const geo: MaskGeometry = {
        kind: 'radial',
        center: { x: 0.5, y: 0.5 },
        radiusX: 0.25,
        radiusY: 0.25,
        rotation: 0,
        feather: 10,
      }
      const plain = maskEdits(geo)
      const inv = maskEdits(geo, { inverted: true })
      const pc = at(plain, 0.5, 0.5)
      const ic = at(inv, 0.5, 0.5)
      const ie = at(inv, 0.98, 0.98)
      masks.inverted = [pc, ic, ie]
      check('invertClearsCentre', Math.abs(ic - base) < 4, `${ic} vs ${base}`)
      check('invertMasksCorner', ie > base + 40, `${ie} vs ${base}`)
    }

    // Opacity scales the whole mask.
    {
      const geo: MaskGeometry = {
        kind: 'radial',
        center: { x: 0.5, y: 0.5 },
        radiusX: 0.4,
        radiusY: 0.4,
        rotation: 0,
        feather: 0,
      }
      const fullOn = at(maskEdits(geo), 0.5, 0.5)
      const half = at(maskEdits(geo, { opacity: 0.5 }), 0.5, 0.5)
      masks.opacity = [fullOn, half]
      check('opacityScalesMask', half > base + 10 && half < fullOn - 10, `${base},${half},${fullOn}`)
    }

    // Brush: a dab paints where it lands and nowhere else.
    {
      const e = maskEdits({
        kind: 'brush',
        feather: 40,
        autoMask: false,
        dabs: [
          { x: 0.3, y: 0.3, radius: 0.12, flow: 1, erase: false },
          { x: 0.7, y: 0.7, radius: 0.12, flow: 1, erase: false },
        ],
      })
      const d1 = at(e, 0.3, 0.3)
      const d2 = at(e, 0.7, 0.7)
      const gap = at(e, 0.3, 0.7)
      masks.brush = [d1, d2, gap]
      check('brushPaintsDabs', d1 > base + 40 && d2 > base + 40, `${d1},${d2}`)
      check('brushLeavesGap', Math.abs(gap - base) < 5, `${gap} vs ${base}`)
    }

    // Erase takes paint back off.
    {
      const e = maskEdits({
        kind: 'brush',
        feather: 20,
        autoMask: false,
        dabs: [
          { x: 0.5, y: 0.5, radius: 0.35, flow: 1, erase: false },
          { x: 0.5, y: 0.5, radius: 0.15, flow: 1, erase: true },
        ],
      })
      const hole = at(e, 0.5, 0.5)
      const ring = at(e, 0.5, 0.76)
      masks.erase = [hole, ring]
      check('eraseCutsHole', Math.abs(hole - base) < 5, `${hole} vs ${base}`)
      check('eraseKeepsRing', ring > base + 40, `${ring} vs ${base}`)
    }

    // More dabs than fit in one uniform array: the chunking must be seamless.
    {
      const dabs = []
      for (let i = 0; i < MAX_DABS * 2 + 7; i++) {
        dabs.push({ x: 0.05 + (0.9 * i) / (MAX_DABS * 2 + 6), y: 0.5, radius: 0.05, flow: 1, erase: false })
      }
      const e = maskEdits({ kind: 'brush', feather: 30, autoMask: false, dabs })
      const a = at(e, 0.1, 0.5)
      const b2 = at(e, 0.5, 0.5)
      const c = at(e, 0.9, 0.5)
      const off = at(e, 0.5, 0.05)
      masks.chunked = [a, b2, c, off]
      check(
        'brushChunksAreSeamless',
        a > base + 40 && b2 > base + 40 && c > base + 40,
        `${a},${b2},${c}`,
      )
      check('brushChunksStayInStroke', Math.abs(off - base) < 5, `${off} vs ${base}`)
    }

    // Luminance range: only the tones inside the window move.
    {
      // A neutral ramp, not the position-encoding one: a luminance mask needs
      // luma to track position, and a red-green ramp's luma is mostly green.
      const w = 80
      const h = 60
      const data = new Uint16Array(w * h * 4)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4
          const v = 0.004 + 0.55 * ((x + 0.5) / w)
          data[i] = toHalf(v)
          data[i + 1] = toHalf(v)
          data[i + 2] = toHalf(v)
          data[i + 3] = toHalf(1)
        }
      }
      renderer.setImage({ width: w, height: h, data, ...RENDERED_SOURCE })
      const e = maskEdits({ kind: 'luminanceRange', range: [0, 0.02, 0.35, 0.4], smoothness: 20 })
      const plainDark = at(defaultEdits(), 0.05, 0.5)
      const plainBright = at(defaultEdits(), 0.95, 0.5)
      const darkOn = at(e, 0.05, 0.5)
      const brightOn = at(e, 0.95, 0.5)
      masks.luminance = [plainDark, darkOn, plainBright, brightOn]
      check('lumRangeLiftsShadows', darkOn > plainDark + 20, `${plainDark}→${darkOn}`)
      check('lumRangeSparesHighlights', Math.abs(brightOn - plainBright) < 5, `${plainBright}→${brightOn}`)
      renderer.setImage(flat)
    }

    // Colour range: picks the sampled colour and leaves the rest alone.
    {
      const w = 80
      const h = 60
      const data = new Uint16Array(w * h * 4)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4
          const left = x < w / 2
          data[i] = toHalf(left ? 0.4 : 0.05)
          data[i + 1] = toHalf(0.05)
          data[i + 2] = toHalf(left ? 0.05 : 0.4)
          data[i + 3] = toHalf(1)
        }
      }
      renderer.setImage({ width: w, height: h, data, ...RENDERED_SOURCE })
      const e = maskEdits({ kind: 'colorRange', samples: [{ r: 0.4, g: 0.05, b: 0.05 }], refine: 35 })
      const plainRed = at(defaultEdits(), 0.2, 0.5)
      const plainBlue = at(defaultEdits(), 0.8, 0.5)
      const redOn = at(e, 0.2, 0.5)
      const blueOn = at(e, 0.8, 0.5)
      masks.colorRange = [plainRed, redOn, plainBlue, blueOn]
      check('colorRangePicksSample', redOn > plainRed + 20, `${plainRed}→${redOn}`)
      check('colorRangeSparesOthers', Math.abs(blueOn - plainBlue) < 5, `${plainBlue}→${blueOn}`)
      renderer.setImage(flat)
    }

    // Components combine: subtract cuts one shape out of another.
    {
      const e = defaultEdits()
      e.masks = [
        {
          id: 'm1',
          name: 'Mask 1',
          visible: true,
          inverted: false,
          opacity: 1,
          components: [
            {
              id: 'c1',
              blend: 'add',
              invert: false,
              geometry: { kind: 'radial', center: { x: 0.5, y: 0.5 }, radiusX: 0.45, radiusY: 0.45, rotation: 0, feather: 0 },
            },
            {
              id: 'c2',
              blend: 'subtract',
              invert: false,
              geometry: { kind: 'radial', center: { x: 0.5, y: 0.5 }, radiusX: 0.15, radiusY: 0.15, rotation: 0, feather: 0 },
            },
          ],
          adjustments: { ...defaultMaskAdjustments(), exposure: 2 },
        },
      ]
      const hole = at(e, 0.5, 0.5)
      const ring = at(e, 0.5, 0.72)
      masks.subtract = [hole, ring]
      check('subtractCutsHole', Math.abs(hole - base) < 5, `${hole} vs ${base}`)
      check('subtractKeepsRing', ring > base + 40, `${ring} vs ${base}`)
    }

    // A hidden mask does nothing.
    {
      const e = maskEdits(
        { kind: 'radial', center: { x: 0.5, y: 0.5 }, radiusX: 0.4, radiusY: 0.4, rotation: 0, feather: 0 },
        { visible: false },
      )
      const v = at(e, 0.5, 0.5)
      masks.hidden = v
      check('hiddenMaskIsInert', Math.abs(v - base) < 3, `${v} vs ${base}`)
    }

    // The overlay tints coverage without changing what is underneath.
    {
      const e = maskEdits({ kind: 'radial', center: { x: 0.5, y: 0.5 }, radiusX: 0.4, radiusY: 0.4, rotation: 0, feather: 0 })
      e.masks[0].adjustments.exposure = 0
      renderer.render(e, { rect: full, maskOverlay: { maskId: 'm1', mode: 'coverage' } })
      const inside = pixelAt(canvas, Math.round(0.5 * (CW - 1)), Math.round(0.5 * (CH - 1)))
      const outside = pixelAt(canvas, 2, 2)
      masks.overlay = [inside[0], outside[0]]
      check('overlayShowsCoverage', inside[0] > 200 && outside[0] < 40, `${inside[0]},${outside[0]}`)
    }

    // Every adjustment, on at once — the chain has to survive its own length.
    {
      const e = maskEdits({ kind: 'radial', center: { x: 0.5, y: 0.5 }, radiusX: 0.6, radiusY: 0.6, rotation: 0, feather: 40 })
      Object.assign(e.masks[0].adjustments, {
        exposure: 0.5, contrast: 30, highlights: -40, shadows: 40, whites: 20, blacks: -20,
        texture: 40, clarity: 35, dehaze: 25, temp: 20, tint: -15, saturation: 30,
        hue: 210, hueStrength: 40, colorize: 30, sharpness: 40, noise: 25, moire: 20, defringe: 30,
        curve: [{ x: 0, y: 0 }, { x: 0.5, y: 0.58 }, { x: 1, y: 1 }],
      })
      renderer.render(e, { rect: full })
      const px = pixelAt(canvas, Math.round(0.5 * (CW - 1)), Math.round(0.5 * (CH - 1)))
      masks.allAdjustments = px
      check('allMaskAdjustments', Number.isFinite(px[0]))
    }

    // Two masks stack.
    {
      const e = defaultEdits()
      const mk = (id: string, cx: number): Mask => ({
        id, name: id, visible: true, inverted: false, opacity: 1,
        components: [{
          id: id + 'c', blend: 'add', invert: false,
          geometry: { kind: 'radial', center: { x: cx, y: 0.5 }, radiusX: 0.2, radiusY: 0.2, rotation: 0, feather: 0 },
        }],
        adjustments: { ...defaultMaskAdjustments(), exposure: 1.5 },
      })
      e.masks = [mk('a', 0.25), mk('b', 0.75)]
      const l = at(e, 0.25, 0.5)
      const r = at(e, 0.75, 0.5)
      const mid = at(e, 0.5, 0.5)
      masks.twoMasks = [l, mid, r]
      check('bothMasksApply', l > base + 30 && r > base + 30, `${l},${r}`)
      check('gapBetweenMasksIsClean', Math.abs(mid - base) < 5, `${mid} vs ${base}`)
    }

    out.masks = masks
  }

  // -- Retouch: spots and red-eye ---------------------------------------------
  {
    const retouch: Record<string, unknown> = {}

    // A two-tone image: a dark blob on the left half, clean mid-grey on the
    // right. Cloning the right onto the blob should erase it.
    const W = 80
    const H = 60
    const patchy = () => {
      const data = new Uint16Array(W * H * 4)
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4
          const inBlob = Math.hypot(x / W - 0.25, y / H - 0.5) < 0.09
          const v = inBlob ? 0.03 : 0.18
          data[i] = toHalf(v)
          data[i + 1] = toHalf(v)
          data[i + 2] = toHalf(v)
          data[i + 3] = toHalf(1)
        }
      }
      return { width: W, height: H, data, ...RENDERED_SOURCE }
    }
    renderer.setImage(patchy())

    const spotAt = (nx: number, ny: number, e: Edits) => {
      renderer.render(e, { rect: full })
      return pixelAt(canvas, Math.round(nx * (CW - 1)), Math.round(ny * (CH - 1)))[0]
    }

    const plainBlob = spotAt(0.25, 0.5, defaultEdits())
    const plainClean = spotAt(0.75, 0.5, defaultEdits())
    retouch.plain = [plainBlob, plainClean]
    check('blobIsDarker', plainBlob < plainClean - 40, `${plainBlob} vs ${plainClean}`)

    // Clone: copy the clean right half over the blob.
    {
      const e = defaultEdits()
      e.spots = [
        {
          id: 's1',
          mode: 'clone',
          target: { x: 0.25, y: 0.5 },
          source: { x: 0.75, y: 0.5 },
          radius: 0.16,
          feather: 40,
          opacity: 1,
        },
      ]
      const covered = spotAt(0.25, 0.5, e)
      const elsewhere = spotAt(0.75, 0.2, e)
      retouch.clone = [covered, elsewhere]
      check('cloneCoversBlob', Math.abs(covered - plainClean) < 12, `${covered} vs ${plainClean}`)
      check('cloneIsLocal', Math.abs(elsewhere - plainClean) < 6, `${elsewhere} vs ${plainClean}`)
    }

    // Heal: same coverage, and it must also land near the surrounding tone.
    {
      const e = defaultEdits()
      e.spots = [
        {
          id: 's1',
          mode: 'heal',
          target: { x: 0.25, y: 0.5 },
          source: { x: 0.75, y: 0.5 },
          radius: 0.16,
          feather: 40,
          opacity: 1,
        },
      ]
      const covered = spotAt(0.25, 0.5, e)
      retouch.heal = covered
      check('healCoversBlob', covered > plainBlob + 40, `${plainBlob}→${covered}`)
    }

    // Opacity 0 and radius 0 are inert, so an in-progress spot cannot flash.
    {
      const e = defaultEdits()
      e.spots = [
        { id: 's1', mode: 'clone', target: { x: 0.25, y: 0.5 }, source: { x: 0.75, y: 0.5 }, radius: 0.16, feather: 40, opacity: 0 },
        { id: 's2', mode: 'clone', target: { x: 0.25, y: 0.5 }, source: { x: 0.75, y: 0.5 }, radius: 0, feather: 40, opacity: 1 },
      ]
      const v = spotAt(0.25, 0.5, e)
      retouch.inert = v
      check('inertSpotsDoNothing', Math.abs(v - plainBlob) < 5, `${v} vs ${plainBlob}`)
    }

    // More spots than fit in one uniform array.
    {
      const e = defaultEdits()
      e.spots = []
      for (let i = 0; i < MAX_SPOTS + 5; i++) {
        e.spots.push({
          id: `s${i}`,
          mode: 'clone',
          target: { x: 0.02 + (0.96 * i) / (MAX_SPOTS + 4), y: 0.15 },
          source: { x: 0.75, y: 0.5 },
          radius: 0.02,
          feather: 30,
          opacity: 1,
        })
      }
      renderer.render(e, { rect: full })
      const last = pixelAt(canvas, Math.round(0.98 * (CW - 1)), Math.round(0.15 * (CH - 1)))[0]
      retouch.chunked = [0, last]
      check('spotChunkingRuns', Number.isFinite(last))
      check('spotChunkingCoversLast', Math.abs(last - plainClean) < 20, `${last} vs ${plainClean}`)
    }

    // Red-eye: a red disc on grey. The human key has to find it and kill the
    // red without touching the grey around it.
    {
      const data = new Uint16Array(W * H * 4)
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4
          const red = Math.hypot(x / W - 0.5, y / H - 0.5) < 0.12
          data[i] = toHalf(red ? 0.45 : 0.18)
          data[i + 1] = toHalf(red ? 0.03 : 0.18)
          data[i + 2] = toHalf(red ? 0.03 : 0.18)
          data[i + 3] = toHalf(1)
        }
      }
      renderer.setImage({ width: W, height: H, data, ...RENDERED_SOURCE })

      const redPx = (e: Edits, nx: number, ny: number) => {
        renderer.render(e, { rect: full })
        return pixelAt(canvas, Math.round(nx * (CW - 1)), Math.round(ny * (CH - 1)))
      }
      const before = redPx(defaultEdits(), 0.5, 0.5)
      const e = defaultEdits()
      e.redEye = [
        { id: 'r1', kind: 'human', center: { x: 0.5, y: 0.5 }, radius: 0.2, darken: 50 },
      ]
      const after = redPx(e, 0.5, 0.5)
      const outside = redPx(e, 0.08, 0.5)
      retouch.redEye = [before[0], after[0], outside[0]]
      check('redEyeKillsRed', after[0] < before[0] - 60, `${before[0]}→${after[0]}`)
      check('redEyeSparesSurround', Math.abs(outside[0] - 118) < 40, `${outside[0]}`)

      // Pet mode desaturates instead of keying on hue.
      const pet = defaultEdits()
      pet.redEye = [
        { id: 'r1', kind: 'pet', center: { x: 0.5, y: 0.5 }, radius: 0.2, darken: 30 },
      ]
      const petPx = redPx(pet, 0.5, 0.5)
      // Display-referred channels are a poor saturation proxy on their own —
      // the ProPhoto→sRGB matrix clips — so compare the spread before and after.
      const spread = (p: ArrayLike<number>) =>
        Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2])
      retouch.pet = [...petPx, spread(before), spread(petPx)]
      check(
        'petModeDesaturates',
        spread(petPx) < spread(before) * 0.4,
        `${spread(before)}→${spread(petPx)}`,
      )
    }

    renderer.setImage(solid(80, 60, [0.18, 0.18, 0.18]))
    out.retouch = retouch
  }

  // -- HDR presentation ------------------------------------------------------
  // The whole reason the pipeline moved to WebGPU. `toneMapping: extended` and
  // an `rgba16float` surface are core WebGPU in both browsers, where the WebGL2
  // route existed in neither, so this is the check that the port paid for
  // itself. Values in range must survive the round trip unchanged: an extended
  // surface widens the headroom above white, it does not rescale what is below.
  {
    renderer.setImage(solid(80, 60, [0.18, 0.18, 0.18]))
    const flat = defaultEdits()
    const hdr: Record<string, unknown> = { capable: renderer.hdrCapable }
    check('hdrCapable', renderer.hdrCapable, String(renderer.hdrCapable))

    renderer.render(flat, { rect: full })
    const sdrPx = pixelAt(canvas, CW / 2, CH / 2)

    renderer.setHdr(true)
    renderer.render(flat, { rect: full })
    hdr.presenting = renderer.hdrPresenting
    hdr.format = renderer.ctx.format
    const hdrPx = pixelAt(canvas, CW / 2, CH / 2)
    check('hdrPresents', renderer.hdrPresenting, String(renderer.hdrPresenting))
    check('hdrSurfaceIsHalfFloat', renderer.ctx.format === 'rgba16float', renderer.ctx.format)
    check(
      'hdrKeepsInRangeValues',
      Math.abs(hdrPx[0] - sdrPx[0]) <= 2,
      `${sdrPx[0]}→${hdrPx[0]}`,
    )

    renderer.setHdr(false)
    renderer.render(flat, { rect: full })
    const backPx = pixelAt(canvas, CW / 2, CH / 2)
    check('hdrTogglesBack', !renderer.hdrPresenting && Math.abs(backPx[0] - sdrPx[0]) <= 2,
      `${renderer.ctx.format} ${backPx[0]}`)
    hdr.pixels = [sdrPx[0], hdrPx[0], backPx[0]]
    out.hdr = hdr
  }

  out.failures = failures
  out.pass = failures.length === 0

  renderer.dispose()
  return out
}

runCheck(run)
