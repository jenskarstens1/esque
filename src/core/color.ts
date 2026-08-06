/**
 * Colour science for the decoded working-image and render pipelines.
 *
 * esque works in **linear ProPhoto RGB (D50)** end to end — the same working
 * space Lightroom uses internally. LibRaw hands us linear ProPhoto directly, so
 * nothing is converted until the very last output transform.
 */

export type Mat3 = [number, number, number, number, number, number, number, number, number]

export interface WhitePoint {
  temp: number
  tint: number
}

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9) as Mat3
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
    }
  }
  return out
}

export function apply3(m: Mat3, v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ]
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (!det) throw new Error('singular matrix')
  const s = 1 / det
  return [
    A * s,
    -(b * i - c * h) * s,
    (b * f - c * e) * s,
    B * s,
    (a * i - c * g) * s,
    -(a * f - c * d) * s,
    C * s,
    -(a * h - b * g) * s,
    (a * e - b * d) * s,
  ]
}

/** Column-major copy for `uniformMatrix3fv`, which expects column order. */
export const toGl = (m: Mat3): Float32Array =>
  new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]])

// ---------------------------------------------------------------------------
// Primaries
// ---------------------------------------------------------------------------

export const PROPHOTO_TO_XYZ_D50: Mat3 = [
  0.7976749, 0.1351917, 0.0313534, 0.288_0402, 0.7118741, 0.0000857, 0.0, 0.0, 0.8252100,
]

export const SRGB_TO_XYZ_D65: Mat3 = [
  0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041,
]

export const P3_TO_XYZ_D65: Mat3 = [
  0.4865709, 0.2656677, 0.1982173, 0.2289746, 0.6917385, 0.0792869, 0.0, 0.0451134, 1.0439444,
]

export const ADOBE_TO_XYZ_D65: Mat3 = [
  0.576669, 0.1855582, 0.1882286, 0.297345, 0.6273636, 0.0752915, 0.0270313, 0.0706889, 0.9911085,
]

export const REC2020_TO_XYZ_D65: Mat3 = [
  0.6369580, 0.1446169, 0.1688810, 0.2627002, 0.6779981, 0.0593017, 0.0, 0.0280727, 1.0609851,
]

/** Bradford chromatic adaptation, D50 → D65. */
export const BRADFORD_D50_TO_D65: Mat3 = [
  0.9555766, -0.0230393, 0.0631636, -0.0282895, 1.0099416, 0.0210077, 0.0122982, -0.020483,
  1.3299098,
]

export const BRADFORD_D65_TO_D50: Mat3 = invert3(BRADFORD_D50_TO_D65)

export const XYZ_D50_TO_PROPHOTO = invert3(PROPHOTO_TO_XYZ_D50)

/**
 * Linear sRGB (D65) -> linear ProPhoto (D50).
 *
 * Browser-decoded JPEG/PNG pixels are sRGB. Merely undoing their transfer curve
 * does not make them ProPhoto; the old decode path uploaded those values under
 * the wrong primaries, so every subsequent colour operation and the final
 * ProPhoto->display transform moved them a second time.
 */
export const SRGB_D65_TO_PROPHOTO_D50 = mul3(
  XYZ_D50_TO_PROPHOTO,
  mul3(BRADFORD_D65_TO_D50, SRGB_TO_XYZ_D65),
)
export const PROPHOTO_D50_TO_SRGB_D65 = invert3(SRGB_D65_TO_PROPHOTO_D50)

// ---------------------------------------------------------------------------
// Output spaces
// ---------------------------------------------------------------------------

export type OutputSpace = 'srgb' | 'display-p3' | 'adobe-rgb' | 'prophoto' | 'rec2020'

/** ProPhoto(D50) → target primaries, Bradford-adapted where the white differs. */
export function outputMatrix(space: OutputSpace): Mat3 {
  const toXyzD65 = mul3(BRADFORD_D50_TO_D65, PROPHOTO_TO_XYZ_D50)
  switch (space) {
    case 'srgb':
      return mul3(invert3(SRGB_TO_XYZ_D65), toXyzD65)
    case 'display-p3':
      return mul3(invert3(P3_TO_XYZ_D65), toXyzD65)
    case 'adobe-rgb':
      return mul3(invert3(ADOBE_TO_XYZ_D65), toXyzD65)
    case 'rec2020':
      return mul3(invert3(REC2020_TO_XYZ_D65), toXyzD65)
    case 'prophoto':
      return [1, 0, 0, 0, 1, 0, 0, 0, 1]
  }
}

/** Luminance coefficients in the target RGB primaries. */
export function outputLuma(space: OutputSpace): [number, number, number] {
  switch (space) {
    case 'srgb':
      return [0.2126729, 0.7151522, 0.072175]
    case 'display-p3':
      return [0.2289746, 0.6917385, 0.0792869]
    case 'adobe-rgb':
      return [0.297345, 0.6273636, 0.0752915]
    case 'rec2020':
      return [0.2627002, 0.6779981, 0.0593017]
    case 'prophoto':
      return [0.2880402, 0.7118741, 0.0000857]
  }
}

/** Converts linear values between two supported output-primary sets. */
export function outputToOutputMatrix(from: OutputSpace, to: OutputSpace): Mat3 {
  if (from === to) return [1, 0, 0, 0, 1, 0, 0, 0, 1]
  return mul3(outputMatrix(to), invert3(outputMatrix(from)))
}

/** Encoding gamma per space: 0 selects the piecewise sRGB curve in the shader. */
export function outputGamma(space: OutputSpace): number {
  switch (space) {
    case 'srgb':
    case 'display-p3':
      return 0 // piecewise sRGB transfer function
    case 'adobe-rgb':
      return 1 / 2.19921875
    case 'prophoto':
      return 1 / 1.8
    case 'rec2020':
      return 0 // sRGB transfer; the exported ICC profile declares the same
  }
}

// ---------------------------------------------------------------------------
// White balance
//
// Temp/Tint follow the DNG specification exactly (Robertson's isotherm table,
// CIE 1960 UCS, tint scale -3000), which is what Lightroom and Camera Raw use.
// That means a 5500K reading here matches a 5500K reading there.
// ---------------------------------------------------------------------------

/** Robertson isotherms: [mireds, u, v, isotherm slope]. */
const ROBERTSON: Array<[number, number, number, number]> = [
  [0, 0.18006, 0.26352, -0.24341],
  [10, 0.18066, 0.26589, -0.25479],
  [20, 0.18133, 0.26846, -0.26876],
  [30, 0.18208, 0.27119, -0.28539],
  [40, 0.18293, 0.27407, -0.3047],
  [50, 0.18388, 0.27709, -0.32675],
  [60, 0.18494, 0.28021, -0.35156],
  [70, 0.18611, 0.28342, -0.37915],
  [80, 0.1874, 0.28668, -0.40955],
  [90, 0.1888, 0.28997, -0.44278],
  [100, 0.19032, 0.29326, -0.47888],
  [125, 0.19462, 0.30141, -0.58204],
  [150, 0.19962, 0.30921, -0.70471],
  [175, 0.20525, 0.31647, -0.84901],
  [200, 0.21142, 0.32312, -1.0182],
  [225, 0.21807, 0.32909, -1.2168],
  [250, 0.22511, 0.33439, -1.4512],
  [275, 0.23247, 0.33904, -1.7298],
  [300, 0.2401, 0.34308, -2.0637],
  [325, 0.24792, 0.34655, -2.4681],
  [350, 0.25591, 0.34951, -2.9641],
  [375, 0.264, 0.352, -3.5814],
  [400, 0.27218, 0.35407, -4.3633],
  [425, 0.28039, 0.35577, -5.3762],
  [450, 0.28863, 0.35714, -6.7262],
  [475, 0.29685, 0.35823, -8.5955],
  [500, 0.30505, 0.35907, -11.324],
  [525, 0.3132, 0.35968, -15.628],
  [550, 0.32129, 0.36011, -23.325],
  [575, 0.32931, 0.36038, -40.77],
  [600, 0.33724, 0.36051, -116.45],
]

const TINT_SCALE = -3000

export const TEMP_MIN = 2000
export const TEMP_MAX = 50000
export const TINT_MIN = -150
export const TINT_MAX = 150

/** CIE xy chromaticity → correlated colour temperature and Lightroom tint. */
export function xyToTempTint(x: number, y: number): { temp: number; tint: number } {
  const denom = 1.5 - x + 6 * y
  if (Math.abs(denom) < 1e-9) return { temp: 5500, tint: 0 }
  const u = (2 * x) / denom
  const v = (3 * y) / denom

  let lastDt = 0
  let lastDu = 0
  let lastDv = 0

  for (let i = 1; i < ROBERTSON.length; i++) {
    let du = 1
    let dv = ROBERTSON[i][3]
    const len = Math.hypot(1, dv)
    du /= len
    dv /= len

    let uu = u - ROBERTSON[i][1]
    let vv = v - ROBERTSON[i][2]
    let dt = -uu * dv + vv * du

    if (dt <= 0 || i === ROBERTSON.length - 1) {
      if (dt > 0) dt = 0
      dt = -dt
      const f = i === 1 ? 0 : dt / (lastDt + dt)
      const temp = 1e6 / (ROBERTSON[i - 1][0] * f + ROBERTSON[i][0] * (1 - f))

      uu = u - (ROBERTSON[i - 1][1] * f + ROBERTSON[i][1] * (1 - f))
      vv = v - (ROBERTSON[i - 1][2] * f + ROBERTSON[i][2] * (1 - f))
      let ddu = du * (1 - f) + lastDu * f
      let ddv = dv * (1 - f) + lastDv * f
      const l2 = Math.hypot(ddu, ddv)
      ddu /= l2
      ddv /= l2

      const tint = (uu * ddu + vv * ddv) * TINT_SCALE
      return {
        temp: clamp(temp, TEMP_MIN, TEMP_MAX),
        tint: clamp(tint, TINT_MIN, TINT_MAX),
      }
    }

    lastDt = dt
    lastDu = du
    lastDv = dv
  }
  return { temp: 5500, tint: 0 }
}

/** Correlated colour temperature + Lightroom tint → CIE xy chromaticity. */
export function tempTintToXy(temp: number, tint: number): [number, number] {
  const r = 1e6 / clamp(temp, TEMP_MIN, TEMP_MAX)
  const t = clamp(tint, TINT_MIN, TINT_MAX)

  for (let i = 0; i < ROBERTSON.length - 1; i++) {
    if (r < ROBERTSON[i + 1][0] || i === ROBERTSON.length - 2) {
      const f = (ROBERTSON[i + 1][0] - r) / (ROBERTSON[i + 1][0] - ROBERTSON[i][0])
      let u = ROBERTSON[i][1] * f + ROBERTSON[i + 1][1] * (1 - f)
      let v = ROBERTSON[i][2] * f + ROBERTSON[i + 1][2] * (1 - f)

      const l1 = Math.hypot(1, ROBERTSON[i][3])
      const l2 = Math.hypot(1, ROBERTSON[i + 1][3])
      const uu1 = 1 / l1
      const vv1 = ROBERTSON[i][3] / l1
      const uu2 = 1 / l2
      const vv2 = ROBERTSON[i + 1][3] / l2

      let uu3 = uu1 * f + uu2 * (1 - f)
      let vv3 = vv1 * f + vv2 * (1 - f)
      const l3 = Math.hypot(uu3, vv3)
      uu3 /= l3
      vv3 /= l3

      u += (uu3 * t) / TINT_SCALE
      v += (vv3 * t) / TINT_SCALE

      const d = u - 4 * v + 2
      return [(1.5 * u) / d, v / d]
    }
  }
  return [0.3457, 0.3585]
}

/** Legacy helper kept for the locus preview strip in the WB control. */
export function kelvinToXy(kelvin: number): [number, number] {
  return tempTintToXy(kelvin, 0)
}

export const xyToXyz = (x: number, y: number): [number, number, number] => [
  x / y,
  1,
  (1 - x - y) / y,
]

/**
 * Derives the as-shot colour temperature and tint from LibRaw's camera
 * multipliers and LibRaw's XYZ→camera matrix. This is what lets the Temp slider read
 * in real Kelvin rather than an arbitrary -100..100.
 */
export function asShotTempTint(
  camMul: number[] | null,
  camXyz: number[][] | null,
): WhitePoint {
  const fallback = { temp: 5500, tint: 0 }
  if (!camMul || !camXyz || camMul.length < 3 || camXyz.length < 3) return fallback

  const g = camMul[1] || 1
  // A neutral surface lands on 1/multiplier in raw camera space.
  const cam: [number, number, number] = [g / (camMul[0] || g), 1, g / (camMul[2] || g)]

  // LibRaw's cam_xyz is the DNG ColorMatrix: XYZ → camera. Invert for camera → XYZ.
  const m: Mat3 = [
    camXyz[0][0], camXyz[0][1], camXyz[0][2],
    camXyz[1][0], camXyz[1][1], camXyz[1][2],
    camXyz[2][0], camXyz[2][1], camXyz[2][2],
  ]
  let xyz: [number, number, number]
  try {
    xyz = apply3(invert3(m), cam)
  } catch {
    return fallback
  }

  const sum = xyz[0] + xyz[1] + xyz[2]
  if (!(sum > 0)) return fallback

  const { temp, tint } = xyToTempTint(xyz[0] / sum, xyz[1] / sum)
  return { temp: Math.round(temp), tint: Math.round(tint) }
}

/**
 * Resolves the white balance actually represented by a LibRaw decode.
 *
 * `cam_mul` is the camera's recorded value. Some files do not carry one; in
 * that case LibRaw falls back to its processed `pre_mul`, so the source
 * descriptor must do the same or a nominal 5500 K value is attached to pixels
 * balanced under a different illuminant.
 */
export function decodedAsShotTempTint(
  camMul: number[] | null,
  preMul: number[] | null,
  camXyz: number[][] | null,
): WhitePoint {
  const valid = (mul: number[] | null) =>
    !!mul &&
    mul.length >= 3 &&
    Number.isFinite(mul[0]) &&
    Number.isFinite(mul[1]) &&
    Number.isFinite(mul[2]) &&
    mul[0] > 1e-6 &&
    mul[1] > 1e-6 &&
    mul[2] > 1e-6

  return asShotTempTint(valid(camMul) ? camMul : valid(preMul) ? preMul : null, camXyz)
}

/** Illuminant chromaticity expressed as linear ProPhoto RGB. */
function whitePointRgb(temp: number, tint: number): [number, number, number] {
  const [x, y] = tempTintToXy(temp, tint)
  return apply3(XYZ_D50_TO_PROPHOTO, xyToXyz(x, Math.max(1e-4, y)))
}

/**
 * Per-channel gain that moves the image from its as-shot white to the requested
 * temp/tint. Von Kries adaptation in ProPhoto primaries, which are close enough
 * to sharpened cone primaries that the crosstalk error is negligible — this is
 * the same shortcut Camera Raw takes.
 */
export function whiteBalanceGain(
  asShot: WhitePoint,
  target: WhitePoint,
): [number, number, number] {
  const src = whitePointRgb(asShot.temp, asShot.tint)
  const dst = whitePointRgb(target.temp, target.tint)
  const gain: [number, number, number] = [
    src[0] / Math.max(1e-6, dst[0]),
    src[1] / Math.max(1e-6, dst[1]),
    src[2] / Math.max(1e-6, dst[2]),
  ]
  // Normalise on green so white balance never changes overall brightness.
  const norm = gain[1] || 1
  return [gain[0] / norm, 1, gain[2] / norm]
}

/**
 * The white point that would make the renderer apply a given red/blue gain.
 *
 * This is `whiteBalanceGain` run backwards, and it is what both Auto WB and the
 * dropper need: each measures how far the image still is from neutral, which is
 * a gain, and has to hand the UI a Kelvin and a tint.
 *
 * Kelvin and tint are a two-parameter fit to a three-channel gain, and the
 * Robertson interpolation that maps between them is itself approximate — so the
 * answer is checked against the gain the renderer will actually derive from it
 * and corrected until the two agree. Without this an estimate can be
 * arithmetically perfect and still leave a visible cast on screen.
 */
export function whitePointForGain(
  asShot: WhitePoint,
  gainR: number,
  gainB: number,
): WhitePoint | null {
  const src = whitePointRgb(asShot.temp, asShot.tint)
  let wantR = gainR
  let wantB = gainB
  let result: WhitePoint | null = null

  for (let i = 0; i < 3; i++) {
    const dst: [number, number, number] = [src[0] / wantR, src[1], src[2] / wantB]
    const xyz = apply3(PROPHOTO_TO_XYZ_D50, dst)
    const sum = xyz[0] + xyz[1] + xyz[2]
    if (!(sum > 0)) return result
    const fit = xyToTempTint(xyz[0] / sum, xyz[1] / sum)
    result = {
      temp: Math.round(clamp(fit.temp, TEMP_MIN, TEMP_MAX)),
      tint: Math.round(clamp(fit.tint, TINT_MIN, TINT_MAX)),
    }

    const actual = whiteBalanceGain(asShot, result)
    const errR = gainR / actual[0]
    const errB = gainB / actual[2]
    if (Math.abs(Math.log(errR)) < 2e-3 && Math.abs(Math.log(errB)) < 2e-3) break
    wantR *= errR
    wantB *= errB
  }
  return result
}


// ---------------------------------------------------------------------------
// Camera calibration
// ---------------------------------------------------------------------------

function rgbToHsv(c: [number, number, number]): [number, number, number] {
  const max = Math.max(c[0], c[1], c[2])
  const min = Math.min(c[0], c[1], c[2])
  const d = max - min
  let h = 0
  if (d > 1e-9) {
    if (max === c[0]) h = ((c[1] - c[2]) / d) % 6
    else if (max === c[1]) h = (c[2] - c[0]) / d + 2
    else h = (c[0] - c[1]) / d + 4
    h /= 6
    if (h < 0) h += 1
  }
  return [h, max <= 1e-9 ? 0 : d / max, max]
}

function hsvToRgb([h, s, v]: [number, number, number]): [number, number, number] {
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  switch (i % 6) {
    case 0:
      return [v, t, p]
    case 1:
      return [q, v, p]
    case 2:
      return [p, v, t]
    case 3:
      return [p, q, v]
    case 4:
      return [t, p, v]
    default:
      return [v, p, q]
  }
}

/**
 * Rotates and stretches each primary, then renormalises so neutral stays
 * neutral. This is the Calibration panel: hue moves where a pure sensor
 * primary lands, saturation pushes it away from grey.
 */
export function calibrationMatrix(cal: {
  redHue: number
  redSaturation: number
  greenHue: number
  greenSaturation: number
  blueHue: number
  blueSaturation: number
}): Mat3 {
  const identity: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  if (
    !cal.redHue &&
    !cal.redSaturation &&
    !cal.greenHue &&
    !cal.greenSaturation &&
    !cal.blueHue &&
    !cal.blueSaturation
  ) {
    return identity
  }

  // ±100 spans roughly ±22°, which matches Camera Raw's feel.
  const HUE_TURNS = 0.06

  const column = (
    basis: [number, number, number],
    hue: number,
    sat: number,
  ): [number, number, number] => {
    const hsv = rgbToHsv(basis)
    hsv[0] = (hsv[0] + (hue / 100) * HUE_TURNS + 1) % 1
    const rgb = hsvToRgb(hsv)
    const l = rgb[0] * 0.2880402 + rgb[1] * 0.7118741 + rgb[2] * 0.0000857
    const k = 1 + sat / 100
    return [l + (rgb[0] - l) * k, l + (rgb[1] - l) * k, l + (rgb[2] - l) * k]
  }

  const cr = column([1, 0, 0], cal.redHue, cal.redSaturation)
  const cg = column([0, 1, 0], cal.greenHue, cal.greenSaturation)
  const cb = column([0, 0, 1], cal.blueHue, cal.blueSaturation)

  const m: Mat3 = [
    cr[0], cg[0], cb[0],
    cr[1], cg[1], cb[1],
    cr[2], cg[2], cb[2],
  ]

  // Normalise rows so white stays white — without this, calibration doubles as
  // an accidental white-balance shift.
  for (let r = 0; r < 3; r++) {
    const sum = m[r * 3] + m[r * 3 + 1] + m[r * 3 + 2]
    const k = Math.abs(sum) > 1e-6 ? 1 / sum : 1
    m[r * 3] *= k
    m[r * 3 + 1] *= k
    m[r * 3 + 2] *= k
  }
  return m
}
