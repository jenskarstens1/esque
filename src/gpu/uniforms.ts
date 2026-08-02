/**
 * Uniform and binding reflection for WGSL passes.
 *
 * WebGL2 set uniforms one at a time by name; WebGPU wants a single buffer laid
 * out to the uniform address space's alignment rules. Reading the layout back
 * out of the `struct U` the shader already declares keeps the shader as the
 * single source of truth and lets call sites go on writing `.set('uName', v)`.
 */

export type Kind = 'f32' | 'i32' | 'u32' | 'vec2f' | 'vec3f' | 'vec4f' | 'mat3x3f' | 'mat4x4f'

export interface Member {
  name: string
  kind: Kind
  /** Element count when this member is an array, else 0. */
  count: number
  offset: number
  /** Bytes between array elements. Sixteen minimum in the uniform space. */
  stride: number
}

export interface Layout {
  members: Map<string, Member>
  size: number
}

const SCALAR: Record<Kind, { align: number; size: number }> = {
  f32: { align: 4, size: 4 },
  i32: { align: 4, size: 4 },
  u32: { align: 4, size: 4 },
  vec2f: { align: 8, size: 8 },
  vec3f: { align: 16, size: 12 },
  vec4f: { align: 16, size: 16 },
  // A mat3x3 is three column vectors, each padded out to vec4.
  mat3x3f: { align: 16, size: 48 },
  mat4x4f: { align: 16, size: 64 },
}

const ALIASES: Record<string, Kind> = {
  f32: 'f32',
  i32: 'i32',
  u32: 'u32',
  'vec2<f32>': 'vec2f',
  'vec3<f32>': 'vec3f',
  'vec4<f32>': 'vec4f',
  vec2f: 'vec2f',
  vec3f: 'vec3f',
  vec4f: 'vec4f',
  'mat3x3<f32>': 'mat3x3f',
  'mat4x4<f32>': 'mat4x4f',
  mat3x3f: 'mat3x3f',
  mat4x4f: 'mat4x4f',
}

export const roundUp = (n: number, align: number) => Math.ceil(n / align) * align

/** Bytes one member of this kind occupies, ignoring alignment. */
export const sizeOf = (kind: Kind) => SCALAR[kind].size

/**
 * Splits a struct body into members on top-level commas only.
 *
 * `array<vec4f, 3>` carries a comma of its own, so a plain `split(',')` tears
 * the type in half and produces two members that are each nonsense — one of
 * which still parses far enough to claim an offset.
 *
 * Comments are stripped before the scan rather than after it. A comma inside
 * `// blue, green` would otherwise end a member early and silently drop the
 * rest, shifting every offset after it — a corruption with no error anywhere,
 * caused by nothing but comment wording.
 */
function splitMembers(body: string): string[] {
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]
    if (c === '<') depth++
    else if (c === '>') depth--
    else if (c === ',' && depth === 0) {
      out.push(clean.slice(start, i))
      start = i + 1
    }
  }
  out.push(clean.slice(start))
  return out
}

/**
 * Derives the byte layout of the shader's `struct U`.
 *
 * Array elements are padded to sixteen bytes because that is what the uniform
 * address space requires — an `array<f32, 4>` occupies sixty-four bytes, not
 * sixteen, and writing it densely would scatter the values into the wrong
 * lanes with no error raised anywhere.
 */
export function parseLayout(src: string): Layout {
  const block = /struct\s+U\s*\{([\s\S]*?)\}/.exec(src)
  if (!block) return { members: new Map(), size: 0 }

  const members = new Map<string, Member>()
  let offset = 0
  let maxAlign = 16

  for (const raw of splitMembers(block[1])) {
    const line = raw.replace(/\/\/[^\n]*/g, '').trim()
    if (!line) continue
    const m = /^([A-Za-z_]\w*)\s*:\s*([\s\S]+)$/.exec(line)
    if (!m) continue
    const name = m[1]
    let type = m[2].replace(/\s+/g, '')

    let count = 0
    const arr = /^array<(.+),(\d+)>$/.exec(type)
    if (arr) {
      type = arr[1]
      count = Number(arr[2])
    }

    const kind = ALIASES[type]
    if (!kind) throw new Error(`[esque] unsupported uniform type "${type}" for ${name}`)

    const info = SCALAR[kind]
    const align = count > 0 ? Math.max(info.align, 16) : info.align
    const stride = count > 0 ? roundUp(info.size, 16) : 0
    offset = roundUp(offset, align)
    members.set(name, { name, kind, count, offset, stride })
    offset += count > 0 ? stride * count : info.size
    maxAlign = Math.max(maxAlign, align)
  }

  return { members, size: Math.max(roundUp(offset, maxAlign), 16) }
}

export interface Bindings {
  /** Binding index of the uniform block, or -1 when the pass has no uniforms. */
  uniform: number
  samplers: { name: string; binding: number }[]
  textures: { name: string; binding: number }[]
}

export function parseBindings(src: string): Bindings {
  const out: Bindings = { uniform: -1, samplers: [], textures: [] }
  const re =
    /@group\(0\)\s*@binding\((\d+)\)\s*var(?:<uniform>)?\s+([A-Za-z_]\w*)\s*:\s*([A-Za-z_][\w<>]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const binding = Number(m[1])
    const name = m[2]
    const type = m[3]
    if (type === 'U') out.uniform = binding
    else if (type === 'sampler') out.samplers.push({ name, binding })
    else if (type.startsWith('texture_2d')) out.textures.push({ name, binding })
  }
  return out
}

/** Which shared sampler a declared sampler name wants. */
export function samplerKind(name: string): 'linear' | 'nearest' | 'mip' {
  if (/near/i.test(name)) return 'nearest'
  if (/mip/i.test(name)) return 'mip'
  return 'linear'
}
