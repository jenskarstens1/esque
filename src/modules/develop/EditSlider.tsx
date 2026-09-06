import { useCallback, useMemo } from 'react'
import { SliderRow, type SliderRowProps } from '../../design/Slider'
import { useDevelop } from '../../develop/session'
import { defaultEdits, rawDetailDefaults, type FileKind } from '../../core/defaults'
import { sliderMenuItems } from '../../shell/appMenus'
import type { Edits } from '../../core/types'

type Path = string

// Selectors run on every store notification for every mounted slider, so the
// path is split once and cached rather than re-allocated each time.
const PARTS = new Map<Path, string[]>()
const parts = (path: Path) => {
  let p = PARTS.get(path)
  if (!p) PARTS.set(path, (p = path.split('.')))
  return p
}

function read(obj: unknown, path: Path): number {
  let cur: unknown = obj
  for (const k of parts(path)) {
    if (!cur || typeof cur !== 'object') return undefined as unknown as number
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur as number
}

function write(obj: Record<string, unknown>, path: Path, value: number) {
  const p = parts(path)
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < p.length - 1; i++) cur = cur[p[i]] as Record<string, unknown>
  cur[p[p.length - 1]] = value
}

/**
 * Slider defaults are per-file: capture sharpening and colour noise reduction
 * start at their ISO-calibrated baseline on a RAW, and at 0 on a file
 * that was already rendered. Reading the wrong one makes double-click-to-reset
 * push a JPEG's sharpening up to a RAW's default.
 */
const FALLBACKS: Record<FileKind, Edits> = {
  raw: defaultEdits('raw'),
  rendered: defaultEdits('rendered'),
}

/**
 * Binds a slider to a dotted path inside the edit graph.
 *
 * Everything routes through the session's `update`, so every drag lands in the
 * history stack as a single named step and the change is persisted for free.
 */
export function EditSlider({
  path,
  label,
  side,
  ...rest
}: {
  path: Path
  label: string
  /** Extra mutation applied alongside the value, e.g. flipping WB to Custom. */
  side?: (e: Edits) => void
} & Omit<SliderRowProps, 'value' | 'onChange' | 'label'>) {
  const value = useDevelop((s) => read(s.edits, path) ?? 0)
  const update = useDevelop((s) => s.update)
  const kind = useDevelop((s) => s.kind)
  const iso = useDevelop((s) => s.iso)

  const onChange = useCallback(
    (v: number) => {
      update(path, label, (e) => {
        write(e as unknown as Record<string, unknown>, path, v)
        side?.(e)
      })
    },
    [path, label, update, side],
  )

  const fallback = useMemo(() => {
    if (path.startsWith('detail.') && kind === 'raw' && iso > 0) {
      return read({ detail: rawDetailDefaults(iso) }, path) ?? 0
    }
    return read(FALLBACKS[kind], path) ?? 0
  }, [iso, kind, path])
  // Double-click restores the field's *default*, not the slider's visual zero.
  // The two differ exactly where a RAW needs a non-zero starting point —
  // capture sharpening, colour NR, and the NR detail sliders that sit at 50.
  const initial = rest.defaultValue ?? fallback

  const menuItems = useCallback(
    ({ reset }: { reset: number }) =>
      sliderMenuItems({
        value: value ?? 0,
        defaultValue: reset,
        onReset: () => onChange(reset),
        onSet: (v) => onChange(v),
      }),
    [value, onChange],
  )

  return (
    <SliderRow
      {...rest}
      label={label}
      value={value ?? 0}
      onChange={onChange}
      defaultValue={initial}
      menuItems={menuItems}
      modified={rest.modified ?? Math.abs((value ?? 0) - fallback) > 1e-6}
    />
  )
}
