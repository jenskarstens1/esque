/**
 * Headless check for the export accumulator.
 *
 * `beginComposite` / `compositeTile` / `finishComposite` let a tiled export
 * assemble the colour graph on the GPU before the one stage that cannot be
 * tiled — geometry — runs over the whole frame. The row bookkeeping there
 * crosses GL's bottom-up origin with the export's top-down rows, which is easy
 * to get subtly wrong and impossible to see in a thumbnail, so it is driven
 * directly here on an image small enough to check pixel by pixel.
 *
 * Run through `tools/headless.mjs /checks/compositecheck.html`.
 */
import { withLayerDefaults } from '../develop/layers'
import { Renderer } from '../gpu/renderer'
import { defaultEdits, defaultMaskAdjustments } from '../core/defaults'
import { splitAtGeometry } from '../gpu/geometry'
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

function toHalf(value: number): number {
  const f = new Float32Array(1)
  const i = new Uint32Array(f.buffer)
  f[0] = value
  const x = i[0]
  const sign = (x >>> 16) & 0x8000
  const exp = ((x >>> 23) & 0xff) - 127 + 15
  const mant = x & 0x7fffff
  if (exp <= 0) return sign
  if (exp >= 31) return sign | 0x7c00
  return sign | (exp << 10) | (mant >> 13)
}

/** Green encodes the row, so an assembled image can be read like a ruler. */
function ramped(width: number, height: number): SourceImage {
  const data = new Uint16Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      // A gentle range so nothing clips: a saturated ramp cannot be read back.
      data[i] = toHalf(0.02 + 0.3 * ((x + 0.5) / width))
      data[i + 1] = toHalf(0.02 + 0.3 * ((y + 0.5) / height))
      data[i + 2] = toHalf(0.2)
      data[i + 3] = toHalf(1)
    }
  }
  return { width, height, data, ...RENDERED_SOURCE }
}

const W = 48
const H = 60
const HALO = 4

async function run() {
  const out: Record<string, unknown> = {}
  const failures: string[] = []
  const image = ramped(W, H)
  const renderer = await Renderer.create(new OffscreenCanvas(1, 1))

  const col = (
    plane: { width: number; height: number; data: ArrayLike<number> },
    channel: number,
  ) => {
    const x = Math.round(plane.width / 2)
    const v: number[] = []
    for (let y = 0; y < plane.height; y++) {
      v.push(plane.data[(y * plane.width + x) * 4 + channel] >> 8)
    }
    return v
  }

  // 16-bit readback, because 8-bit output is dithered and two runs of the same
  // image would differ by a code value everywhere for no interesting reason.
  const DEPTH = 16 as const
  /** Renders the whole image in one shot — the answer everything must match. */
  const single = async (edits = defaultEdits('rendered')) => {
    renderer.setImage(image)
    renderer.setFrame(null)
    renderer.renderOffscreen(edits)
    return (await renderer.readPixels('srgb', DEPTH, null))!
  }

  /** Renders through the accumulator in `tiles` horizontal strips. */
  const composited = async (edits = defaultEdits('rendered'), tileHeight = 24) => {
    const { local, framing } = splitAtGeometry(edits)
    renderer.beginComposite(W, H)
    for (let y0 = 0; y0 < H; y0 += tileHeight) {
      const y1 = Math.min(H, y0 + tileHeight)
      const top = Math.max(0, y0 - HALO)
      const bottom = Math.min(H, y1 + HALO)
      const slice = new Uint16Array(W * (bottom - top) * 4)
      slice.set(image.data.subarray(top * W * 4, bottom * W * 4))
      renderer.setImage({ ...image, height: bottom - top, data: slice })
      renderer.setFrame({ width: W, height: H, x: 0, y: top })
      renderer.compositeTile(local, { y: y0 - top, height: y1 - y0 }, y0)
    }
    renderer.finishComposite(framing)
    return (await renderer.readPixels('srgb', DEPTH, null))!
  }

  /**
   * The composite path puts one more 16-bit resample between the pixels and
   * the readback, so an exact match is not on offer. The interior settles well
   * inside half a percent; the outer two-pixel ring is looser because the edge
   * clamp lands differently and a straighten pulls it a texel or so inward,
   * over a ramp whose base curve is steepest there. Both bounds are still
   * orders of magnitude below the failure
   * this check exists to catch — a flipped, shifted or missing tile moves
   * pixels by thousands.
   */
  const INTERIOR = 400
  const BORDER = 2000
  /**
   * `gain` is how much the case's own edits multiply whatever difference is
   * already there. A mask that adds 1.2 stops does not introduce new error, it
   * amplifies the baseline by ~2.3× — so comparing it against the unamplified
   * bound would fail for the wrong reason. Every gain here is the case's own
   * arithmetic, not a number chosen to make the test go green.
   */
  const compare = (name: string, a: Awaited<ReturnType<typeof single>>, b: typeof a, gain = 1) => {
    if (a.width !== b.width || a.height !== b.height) {
      failures.push(`${name}: ${b.width}x${b.height} want ${a.width}x${a.height}`)
      return
    }
    let worst = 0
    let where = -1
    for (let i = 0; i < a.data.length; i++) {
      const px = Math.floor(i / 4)
      const x = px % a.width
      const y = Math.floor(px / a.width)
      const edge = x < 2 || y < 2 || x >= a.width - 2 || y >= a.height - 2
      const d = Math.abs(a.data[i] - b.data[i]) * (edge ? INTERIOR / BORDER : 1)
      if (d > worst) {
        worst = d
        where = i
      }
    }
    worst = Math.round(worst)
    out[`${name}Worst`] = worst
    if (worst > INTERIOR * gain) {
      const px = Math.floor(where / 4)
      failures.push(`${name}: worst ${worst} at (${px % a.width}, ${Math.floor(px / a.width)})`)
    }
  }

  // The plain case isolates the accumulator: nothing but a copy should happen,
  // so any difference is pure row bookkeeping.
  const plainEdits = defaultEdits('rendered')
  const refPlain = await single(plainEdits)
  out.reference = col(refPlain, 1)
  const accPlain = await composited(plainEdits)
  out.accumulated = col(accPlain, 1)
  compare('plain', refPlain, accPlain)

  // A tile height that does not divide the image exactly, so the last strip is
  // short — the case that broke first time round.
  compare('unevenTiles', refPlain, await composited(plainEdits, 25))
  compare('oneTile', refPlain, await composited(plainEdits, H))

  // The assembled frame must not inherit any source/creative adjustments. The
  // tiles already contain them, so carrying one into `framing` applies it twice.
  const colorEdits = defaultEdits('rendered')
  colorEdits.basic.exposure = 0.7
  colorEdits.basic.contrast = 20
  colorEdits.basic.vibrance = 15
  colorEdits.colorGrading.global = { hue: 35, saturation: 10, luminance: 5 }
  const { framing: colorFraming } = splitAtGeometry(colorEdits)
  const neutral = defaultEdits('rendered')
  const colorSections = [
    'profile',
    'basic',
    'tone',
    'curve',
    'colorMixer',
    'colorGrading',
    'detail',
    'calibration',
  ] as const
  const framingNeutral =
    colorSections.every((section) =>
      JSON.stringify(colorFraming[section]) === JSON.stringify(neutral[section])) &&
    colorFraming.lens.defringePurpleAmount === 0 &&
    colorFraming.lens.defringeGreenAmount === 0
  out.framingColorGraphNeutral = framingNeutral
  if (!framingNeutral) failures.push('framingColorGraphNeutral')
  compare('colorGraphOnce', await single(colorEdits), await composited(colorEdits))

  // Geometry in the framing stage must land on the same pixels as the
  // single-shot render, which applies it inside the graph instead.
  const cropEdits = defaultEdits('rendered')
  cropEdits.crop.left = 0.25
  cropEdits.crop.top = 0.2
  cropEdits.crop.right = 0.9
  cropEdits.crop.bottom = 0.8
  compare('crop', await single(cropEdits), await composited(cropEdits))

  const turnEdits = defaultEdits('rendered')
  turnEdits.crop.quarterTurns = 1
  compare('quarterTurn', await single(turnEdits), await composited(turnEdits))

  // Vignette is the other stage that has to run after the tiles are joined.
  const vignetteEdits = defaultEdits('rendered')
  vignetteEdits.effects.vignetteAmount = -60
  compare('vignette', await single(vignetteEdits), await composited(vignetteEdits))

  // Masks are defined on the framed photo, so they too have to run after the
  // tiles are joined — a mask applied per tile would repeat on every one.
  const maskEdits = defaultEdits('rendered')
  maskEdits.layers = [
    withLayerDefaults({
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
          geometry: {
            kind: 'radial',
            center: { x: 0.4, y: 0.55 },
            radiusX: 0.3,
            radiusY: 0.35,
            rotation: 0,
            feather: 40,
          },
        },
      ],
      adjustments: { ...defaultMaskAdjustments(), exposure: 1.2, saturation: 30 },
    }),
  ]
  // +1.2 stops is 2.3× in linear light, tempered by the output transform.
  compare('mask', await single(maskEdits), await composited(maskEdits), 2.0)

  const maskCropEdits = structuredClone(maskEdits)
  maskCropEdits.crop.left = 0.15
  maskCropEdits.crop.bottom = 0.9
  compare('maskAndCrop', await single(maskCropEdits), await composited(maskCropEdits), 2.0)

  // Spots and red-eye read pixels from anywhere in the frame, so the only way
  // they can survive a tiled export is by running on the assembled image.
  const spotEdits = defaultEdits('rendered')
  spotEdits.spots = [
    {
      id: 's1',
      mode: 'heal',
      target: { x: 0.35, y: 0.4 },
      source: { x: 0.7, y: 0.7 },
      radius: 0.12,
      feather: 40,
      opacity: 1,
    },
    {
      id: 's2',
      mode: 'clone',
      target: { x: 0.6, y: 0.25 },
      source: { x: 0.2, y: 0.8 },
      radius: 0.08,
      feather: 20,
      opacity: 0.8,
    },
  ]
  spotEdits.redEye = [
    { id: 'r1', kind: 'human', center: { x: 0.5, y: 0.5 }, radius: 0.1, darken: 60 },
  ]
  compare('retouch', await single(spotEdits), await composited(spotEdits))

  const spotCropEdits = structuredClone(spotEdits)
  spotCropEdits.crop.left = 0.1
  spotCropEdits.crop.right = 0.9
  spotCropEdits.crop.angle = 3
  compare('retouchAndCrop', await single(spotCropEdits), await composited(spotCropEdits))

  const bothEdits = defaultEdits('rendered')
  bothEdits.effects.vignetteAmount = -50
  bothEdits.crop.left = 0.2
  bothEdits.crop.right = 0.85
  bothEdits.crop.angle = 4
  compare('cropAndVignette', await single(bothEdits), await composited(bothEdits))

  renderer.dispose()
  out.failures = failures
  out.pass = failures.length === 0
  return out
}

runCheck(run)
