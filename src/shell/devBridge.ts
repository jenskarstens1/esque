/**
 * Dev-only handle on the live stores, for the headless drive harnesses.
 *
 * Vite serves an HMR-invalidated module as `/src/state/ui.ts?t=...`, so a test
 * that does `await import('/src/state/ui.ts')` can land on a *second* instance
 * of the module with its own store — it writes to one and the app renders from
 * the other, and every assertion quietly reads back what the test itself just
 * wrote. Publishing the app's own instances once, from inside the app's module
 * graph, removes the ambiguity.
 *
 * Stripped from production builds by the `import.meta.env.DEV` guard.
 */
import { useUI } from '../state/ui'
import { zoomCommands } from '../lib/useZoomPan'
import { useCatalog } from '../state/catalog'
import { useDevelop } from '../develop/session'
import { useMasking } from '../develop/masking'
import { useRetouch } from '../develop/retouch'
import * as geometry from '../gpu/geometry'
import * as masks from '../develop/masks'
import {
  cropMenuItems,
  maskMenuItems,
  retouchMenuItems,
  viewportMenuItems,
} from './appMenus'

export interface DevBridge {
  useUI: typeof useUI
  zoomCommands: typeof zoomCommands
  useCatalog: typeof useCatalog
  useDevelop: typeof useDevelop
  useMasking: typeof useMasking
  useRetouch: typeof useRetouch
  geometry: typeof geometry
  masks: typeof masks
  menus: {
    cropMenuItems: typeof cropMenuItems
    maskMenuItems: typeof maskMenuItems
    retouchMenuItems: typeof retouchMenuItems
    viewportMenuItems: typeof viewportMenuItems
  }
}

declare global {
  interface Window {
    __esque?: DevBridge
  }
}

export function installDevBridge() {
  if (!import.meta.env.DEV) return
  window.__esque = {
    useUI,
    zoomCommands,
    useCatalog,
    useDevelop,
    useMasking,
    useRetouch,
    geometry,
    masks,
    menus: { cropMenuItems, maskMenuItems, retouchMenuItems, viewportMenuItems },
  }
}
