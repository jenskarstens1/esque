import type { Renderer } from '../../gpu/renderer'

/**
 * The renderer currently driving the develop viewport.
 *
 * Overlays occasionally need to read rendered pixels back, and on WebGPU they
 * cannot do it by sampling the canvas: the presented texture is released at the
 * end of the task that submitted the frame, so a pointer handler running later
 * reads a blank one. Readback has to go through the renderer's own output
 * texture, which means the overlays need a handle on the renderer itself.
 *
 * `Viewport` owns the instance and publishes it here rather than threading it
 * down through props, because the only readers are incidental ones like the
 * colour picker — and the alternative they used before, reaching for
 * `document.querySelector('canvas')`, was worse in every way.
 */
let active: Renderer | null = null

export function setActiveRenderer(renderer: Renderer | null) {
  active = renderer
}

export function activeRenderer(): Renderer | null {
  return active
}

// Frame-timing tools need to know how many frames the viewport actually
// presented, and WebGPU offers nothing to patch the way `drawArrays` could be
// patched — every submission goes through a command encoder. So the count is
// published here, in dev builds only.
if (import.meta.env.DEV) {
  ;(globalThis as unknown as { __esqueFrames?: () => number }).__esqueFrames = () =>
    active?.frames ?? 0
}
