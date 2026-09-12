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
import { useExport } from '../state/exportStore'
import { useImporter } from '../state/importer'
import { useDropZone } from '../state/dropImport'
import { useDevelop } from '../develop/session'
import { dropProxy, peekProxy, proxyEdge, proxyStats } from '../develop/proxy'
import { useMasking } from '../develop/masking'
import { useRetouch } from '../develop/retouch'
import * as wbPicker from '../develop/wbPicker'
import * as geometry from '../gpu/geometry'
import * as layers from '../develop/layers'
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
  useExport: typeof useExport
  useImporter: typeof useImporter
  useDropZone: typeof useDropZone
  useDevelop: typeof useDevelop
  /**
   * The working-proxy tier a photo is currently on.
   *
   * Which tier is on screen is invisible from the outside — the camera's
   * embedded rendering and a full RAW conversion both paint a canvas, and a
   * harness that waits for "a canvas" declares a decode finished before it has
   * started. This is the only honest answer to "has the real thing landed".
   */
  proxy: {
    peek: (photoId: string) => { preview: boolean; quality: string; width: number; height: number } | null
    drop: typeof dropProxy
    stats: typeof proxyStats
    edge: typeof proxyEdge
  }
  useMasking: typeof useMasking
  useRetouch: typeof useRetouch
  wbPicker: typeof wbPicker
  geometry: typeof geometry
  layers: typeof layers
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
    useExport,
    useImporter,
    useDropZone,
    useDevelop,
    proxy: {
      peek: (photoId: string) => {
        const p = peekProxy(photoId)
        return p && { preview: p.preview, quality: p.quality, width: p.width, height: p.height }
      },
      drop: dropProxy,
      stats: proxyStats,
      edge: proxyEdge,
    },
    useMasking,
    useRetouch,
    wbPicker,
    geometry,
    layers,
    menus: { cropMenuItems, maskMenuItems, retouchMenuItems, viewportMenuItems },
  }
}
