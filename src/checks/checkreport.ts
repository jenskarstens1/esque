/**
 * Result channel shared by every diagnostic check page.
 *
 * The pages used to be driven entirely by `tools/headless.mjs`, which polls
 * `window.__done` over the CDP connection. That stopped being enough once the
 * pipeline moved to WebGPU: headless Chromium reports `navigator.gpu` as
 * undefined under every flag combination tried, so anything that touches the
 * GPU has to run in a browser the user actually has. `tools/browsercheck.mjs`
 * opens one and listens for a POST instead, and this module is what sends it.
 *
 * Both mechanisms are kept because they cost nothing together: the globals
 * still work for the pages puppeteer can drive, and the POST is skipped
 * entirely when no `?report=` parameter is present.
 */

declare global {
  interface Window {
    __done?: boolean
    __result?: unknown
  }
}

/** Publishes a finished result and, when asked to, posts it to the driver. */
export async function publish(result: unknown): Promise<void> {
  window.__result = result
  window.__done = true
  const reportTo = new URLSearchParams(location.search).get('report')
  if (!reportTo) return
  // A driver that has already given up is not worth failing the page over.
  await fetch(reportTo, { method: 'POST', body: JSON.stringify(result) }).catch(() => {})
}

/**
 * Runs a check and publishes whatever comes out of it, including a throw.
 *
 * A page that dies before reporting is indistinguishable from one that is still
 * working, so the driver can only time out — which costs its whole timeout
 * budget and says nothing about what went wrong. Catching here turns that into
 * an immediate answer carrying the stack.
 */
export function runCheck(fn: () => unknown | Promise<unknown>, options?: { print?: boolean }) {
  const print = options?.print ?? false
  void (async () => {
    let result: unknown
    try {
      result = await fn()
    } catch (err) {
      result = {
        ok: false,
        pass: false,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }
    }
    if (print) document.body.textContent = JSON.stringify(result, null, 2)
    await publish(result)
  })()
}
