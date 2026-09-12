/**
 * Reading a design token from JavaScript.
 *
 * Everything the app draws in the DOM gets its colours from the cascade. The
 * two graphs — the histogram and the tone curve — draw into a canvas instead,
 * where there is no cascade to read, so the values have to be fetched by hand.
 * This is the one place that does it, so the tokens stay declared in
 * `theme.css` rather than duplicated as string literals next to every
 * `fillStyle`.
 *
 * Cached, because `getComputedStyle` forces a style recalculation and the
 * graphs repaint on every pointer move. The tokens it is used for are the graph
 * ink, which is deliberately the same in every appearance (see the note in
 * `theme.css`) — so there is nothing to invalidate.
 */
const cache = new Map<string, string>();

export function token(name: string, fallback = "transparent"): string {
  let value = cache.get(name);
  if (value === undefined) {
    value =
      getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
      fallback;
    cache.set(name, value);
  }
  return value;
}
