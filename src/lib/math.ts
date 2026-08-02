export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** Rounds to a step, avoiding float dust like 0.30000000000000004. */
export function quantize(v: number, step: number): number {
  if (!step) return v
  const r = Math.round(v / step) * step
  const decimals = (String(step).split('.')[1] ?? '').length
  return Number(r.toFixed(decimals))
}

export const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

export const nextId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)

/** Formats a shutter speed the way a camera does: 1/250, 1.6s, 30s. */
export function formatShutter(s: number): string {
  if (!s || !isFinite(s)) return '—'
  if (s >= 1) return `${Number.isInteger(s) ? s : s.toFixed(1)}s`
  return `1/${Math.round(1 / s)}`
}

export function formatAperture(a: number): string {
  if (!a || !isFinite(a)) return '—'
  return `ƒ/${a % 1 === 0 ? a.toFixed(0) : a.toFixed(1)}`
}

export function formatFocal(f: number): string {
  if (!f || !isFinite(f)) return '—'
  return `${Math.round(f)}mm`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

export function formatDimensions(w: number, h: number): string {
  if (!w || !h) return '—'
  const mp = (w * h) / 1e6
  return `${w} × ${h}  ·  ${mp.toFixed(1)} MP`
}
