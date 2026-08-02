/**
 * Structural comparison of edit values.
 *
 * Not `JSON.stringify`: this runs on every store notification (the modified
 * dots) and on every edit (the no-op check in history), and immer's structural
 * sharing makes the reference fast-path settle most of the tree immediately.
 */
export function sameEdits(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a as object)
  if (ka.length !== Object.keys(b as object).length) return false
  for (const k of ka) {
    if (!sameEdits((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false
    }
  }
  return true
}
