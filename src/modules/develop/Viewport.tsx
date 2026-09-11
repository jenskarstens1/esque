import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { Renderer, type Rect, type MaskOverlay as RendererMaskOverlay } from '../../gpu/renderer'
import { geometryOutputSize, uncrop, ungeometry } from '../../gpu/geometry'
import { loadPreview, loadProxy, peekProxy, type Proxy } from '../../develop/proxy'
import { useDevelop } from '../../develop/session'
import { isPairedCompare, isSplitCompare, useUI, type BeforeAfter } from '../../state/ui'
import { headroomFromStops } from '../../core/hdr'
import { useElementSize } from '../../lib/useElementSize'
import { mergeRefs } from '../../lib/mergeRefs'
import { useZoomPan, type ViewState } from '../../lib/useZoomPan'
import { useDevicePixelRatio } from '../../lib/useDevicePixelRatio'
import { usePreviewUrl, useThumbUrl } from '../../catalog/hooks'
import type { OutputSpace } from '../../gpu/colorspace'
import { isAiGeometry, type Edits, type Photo } from '../../core/types'
import { ResolvingImage, RESOLVE_MS } from '../../design/ResolvingImage'
import { StatusPill } from '../../design/StatusPill'
import { setHistogram } from '../../develop/histogramStore'
import { setNavigator } from '../../develop/navigatorStore'
import { useMenu } from '../../design/useMenu'
import { photoMenuItems, retargetSelection } from '../../shell/photoMenu'
import { viewportMenuItems } from '../../shell/appMenus'
import { useCollections } from '../../catalog/hooks'
import { CompareDivider, CompareLabels } from './CompareOverlay'
import { CropOverlay } from './CropOverlay'
import { MaskOverlay } from './MaskOverlay'
import { RetouchOverlay } from './RetouchOverlay'
import { WbDropperOverlay } from './WbDropperOverlay'
import { useMasking } from '../../develop/masking'
import { restoreCoverage, useDetect } from '../../ai/detect'
import { getAlpha } from '../../ai/alpha'
import { toast } from '../../design/toast'
import { setActiveRenderer } from './activeRenderer'

interface Props {
  photo: Photo | null
}

/**
 * Budget for the on-demand detail decode, in bytes of RGBA16F. Rather than a
 * flat pixel ceiling we solve for the largest long edge that fits, so a 24MP
 * frame can escalate all the way to 1:1 while a 100MP one stops short of
 * exhausting GPU memory.
 */
const DETAIL_BUDGET = 192 * 1024 * 1024

/** CSS pixels of breathing room between the two halves of a paired compare. */
export const COMPARE_GUTTER = 10

function detailCeiling(width: number, height: number): number {
  const native = Math.max(width, height)
  const aspect = native / Math.max(1, Math.min(width, height))
  const edge = Math.sqrt((DETAIL_BUDGET / 8) * aspect)
  // Within reach of native? Go all the way rather than stopping just short of 1:1.
  if (edge >= native * 0.85) return native
  return Math.min(native, Math.floor(edge / 512) * 512)
}

/**
 * The area one version of the photo gets to live in.
 *
 * Paired layouts hand each version its own half, and fit is measured against
 * that half — otherwise "Fit" would size both images for a frame neither of
 * them occupies and half the canvas would sit empty.
 */
function paneViewport(mode: BeforeAfter, width: number, height: number) {
  if (mode === 'sideBySide') {
    return { width: Math.max(1, (width - COMPARE_GUTTER) / 2), height }
  }
  if (mode === 'topBottom') {
    return { width, height: Math.max(1, (height - COMPARE_GUTTER) / 2) }
  }
  return { width, height }
}

/** One snapshot of the graph's inputs; see `rebuild`. */
interface Job {
  /** Bumped on every rebuild — the renderer's handle on "this is new". */
  seq: number
  after: Edits
  before: Edits | null
  beforeKey: string
  overlay: RendererMaskOverlay | null
}

/** Everything a paint needs that is neither the view nor the edits. */
interface Scene {
  width: number
  height: number
  dpr: number
  imageSize: { width: number; height: number }
  beforeAfter: BeforeAfter
  compareSplit: number
  outputSpace: OutputSpace
  clipShadow: boolean
  clipHighlight: boolean
  /** Where the overlays call a pixel lost, as display values. */
  clipShadowAt: number
  clipHighlightAt: number
  /** Extended-range viewing, as the linear multiple of display white it reaches. */
  hdrHeadroom: number
}

/**
 * Where each version of the photo goes, in canvas pixels.
 *
 * Split layouts draw both graphs at the same rect and let the clip decide which
 * side of the cut you see, so the seam falls across one continuous image.
 * Paired layouts give each graph its own half to be centred in.
 *
 * A free function on purpose: the paint runs outside React's data flow and must
 * not depend on a callback identity that only changes when React re-renders.
 */
function layoutFor(
  s: Scene,
  cw: number,
  ch: number,
  view: ViewState,
): { before: Rect; after: Rect; beforeClip?: Rect; afterClip?: Rect } {
  const drawW = s.imageSize.width * view.scale * s.dpr
  const drawH = s.imageSize.height * view.scale * s.dpr
  const ox = view.x * s.dpr
  const oy = view.y * s.dpr

  const centred = (box: Rect): Rect => ({
    x: Math.round(box.x + (box.width - drawW) / 2 + ox),
    y: Math.round(box.y + (box.height - drawH) / 2 + oy),
    width: Math.round(drawW),
    height: Math.round(drawH),
  })

  const full: Rect = { x: 0, y: 0, width: cw, height: ch }
  const gutter = COMPARE_GUTTER * s.dpr

  if (s.beforeAfter === 'sideBySide') {
    const half = (cw - gutter) / 2
    const left: Rect = { x: 0, y: 0, width: half, height: ch }
    const right: Rect = { x: half + gutter, y: 0, width: half, height: ch }
    return { before: centred(left), after: centred(right), beforeClip: left, afterClip: right }
  }
  if (s.beforeAfter === 'topBottom') {
    const half = (ch - gutter) / 2
    const top: Rect = { x: 0, y: 0, width: cw, height: half }
    const bottom: Rect = { x: 0, y: half + gutter, width: cw, height: half }
    return { before: centred(top), after: centred(bottom), beforeClip: top, afterClip: bottom }
  }

  const rect = centred(full)
  if (s.beforeAfter === 'splitVertical') {
    const cut = Math.round(cw * s.compareSplit)
    return {
      before: rect,
      after: rect,
      beforeClip: { x: 0, y: 0, width: cut, height: ch },
      afterClip: { x: cut, y: 0, width: cw - cut, height: ch },
    }
  }
  if (s.beforeAfter === 'splitHorizontal') {
    const cut = Math.round(ch * s.compareSplit)
    return {
      before: rect,
      after: rect,
      beforeClip: { x: 0, y: 0, width: cw, height: cut },
      afterClip: { x: 0, y: cut, width: cw, height: ch - cut },
    }
  }
  return { before: rect, after: rect }
}

function useStoredCoverage(
  edits: Edits,
  previewEdits: Edits | null,
  beforeMasks: Edits['layers'],
  beforeAfter: BeforeAfter,
) {
  const keys = useMemo(() => [...new Set([
    ...edits.layers,
    ...(previewEdits?.layers ?? []),
    ...(beforeAfter === 'off' ? [] : beforeMasks),
  ].flatMap((mask) => mask.components.flatMap(({ geometry }) =>
    isAiGeometry(geometry) && geometry.cacheKey ? [geometry.cacheKey] : [],
  )))].sort(), [edits.layers, previewEdits?.layers, beforeMasks, beforeAfter])
  const stored = useRef(keys)
  const changed =
    keys.length !== stored.current.length ||
    keys.some((key, index) => key !== stored.current[index])
  if (changed) stored.current = keys
  return stored.current
}

function sourceSize(photo: Photo | null, proxy: Proxy | null) {
  if (proxy) return { width: proxy.fullWidth, height: proxy.fullHeight }
  if (photo) return { width: photo.width, height: photo.height }
  return { width: 0, height: 0 }
}

function selectedMaskOverlay(
  masking: boolean,
  selectedMaskId: string | null,
  mode: ReturnType<typeof useMasking.getState>['overlay'],
): RendererMaskOverlay | null {
  if (!masking || !selectedMaskId || mode === 'off') return null
  return { maskId: selectedMaskId, mode }
}

function useStableImageSize(size: { width: number; height: number }) {
  const stored = useRef(size)
  if (stored.current.width !== size.width || stored.current.height !== size.height) {
    stored.current = size
  }
  return stored.current
}

function ViewportOverlays({
  comparing,
  beforeAfter,
  dropping,
  cropping,
  masking,
  retouching,
  photoBox,
  compareSplit,
}: {
  comparing: boolean
  beforeAfter: BeforeAfter
  dropping: boolean
  cropping: boolean
  masking: boolean
  retouching: boolean
  photoBox: { x: number; y: number; width: number; height: number }
  compareSplit: number
}) {
  return (
    <>
      {comparing && isPairedCompare(beforeAfter) && (
        <div
          aria-hidden
          className="pointer-events-none absolute bg-hairline"
          style={
            beforeAfter === 'sideBySide'
              ? { left: '50%', top: 0, bottom: 0, width: 1 }
              : { top: '50%', left: 0, right: 0, height: 1 }
          }
        />
      )}
      {dropping && <WbDropperOverlay frame={photoBox} />}
      {cropping && <CropOverlay frame={photoBox} />}
      {masking && <MaskOverlay frame={photoBox} />}
      {retouching && <RetouchOverlay frame={photoBox} />}
      {comparing && isSplitCompare(beforeAfter) && <CompareDivider mode={beforeAfter} />}
      {comparing && <CompareLabels mode={beforeAfter} split={compareSplit} />}
    </>
  )
}

function ViewportContents({
  standIn,
  previewUrl,
  thumbUrl,
  photoBox,
  canvasRef,
  hasProxy,
  loading,
  detailBusy,
  photo,
  error,
  overlays,
}: {
  standIn: boolean
  previewUrl: string | null
  thumbUrl: string | null
  photoBox: { x: number; y: number; width: number; height: number }
  canvasRef: RefObject<HTMLCanvasElement | null>
  hasProxy: boolean
  loading: boolean
  detailBusy: boolean
  photo: Photo | null
  error: string | null
  overlays: ReactNode
}) {
  const source = previewUrl ?? thumbUrl
  return (
    <>
      {standIn && source && (
        <ResolvingImage
          src={source}
          alt=""
          className="pointer-events-none"
          imageClassName="object-contain"
          style={{
            position: 'absolute',
            left: photoBox.x,
            top: photoBox.y,
            width: photoBox.width,
            height: photoBox.height,
          }}
        />
      )}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full transition-opacity duration-[--duration-base] ease-[--ease-out]"
        style={{ opacity: hasProxy ? 1 : 0 }}
      />
      {(loading || detailBusy) && (
        <StatusPill>{photo?.isRaw ? 'Developing RAW' : 'Decoding'}</StatusPill>
      )}
      {error && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center px-8 text-center text-ui text-label-tertiary">
          {error}
        </div>
      )}
      {overlays}
    </>
  )
}

/**
 * The Develop canvas.
 *
 * Renders through the WebGPU graph at device resolution. Edits mutate a store,
 * and a single rAF loop coalesces every change into at most one draw per frame,
 * so dragging a slider never queues work it can't finish.
 *
 * Compare views draw the before and after graphs into the same frame. The
 * before side is cached in a texture of its own, so a live slider drag still
 * costs one graph run per frame however the two are laid out.
 */
export function Viewport({ photo }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<Renderer | null>(null)
  const size = useElementSize(hostRef)
  const dpr = useDevicePixelRatio()

  const [proxy, setProxy] = useState<Proxy | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * Whether the camera preview is still standing in for the render.
   *
   * A cross-fade needs something underneath it for the whole of its length. The
   * canvas rises *over* the stand-in rather than replacing it, and the stand-in
   * is dropped only once the canvas is opaque — unmounting it on the commit
   * that starts the fade is what made the photo dip towards black halfway
   * through every load.
   */
  const [standIn, setStandIn] = useState(true)
  // Dexie hands back a fresh object on every catalog emission, so anything that
  // outlives a render — a decode in flight, say — has to key off the id.
  const photoId = photo?.id ?? null

  const edits = useDevelop((s) => s.edits)
  const previewEdits = useDevelop((s) => s.previewEdits)
  const beforeMasks = useDevelop((s) => s.before.layers)
  const revision = useDevelop((s) => s.revision)
  // Coverage lands outside the edit stack, so a finished detection has to
  // announce itself separately or the mask stays empty until the next edit.
  const detectRevision = useDetect((s) => s.revision)
  const beforeRevision = useDevelop((s) => s.beforeRevision)
  const beforeAfter = useUI((s) => s.beforeAfter)
  const compareSplit = useUI((s) => s.compareSplit)
  const collections = useCollections()
  const { menu, open } = useMenu()
  const clipShadow = useUI((s) => s.showClipping.shadows)
  const clipHighlight = useUI((s) => s.showClipping.highlights)
  const clipShadowAt = useUI((s) => s.clipShadow);
  const clipHighlightAt = useUI((s) => s.clipHighlight);
  const outputSpace = useUI((s) => s.softProof)
  const hdr = useUI((s) => s.hdr)
  const hdrHeadroom = useUI((s) => s.hdrHeadroom)

  const storedCoverage = useStoredCoverage(edits, previewEdits, beforeMasks, beforeAfter)
  const warnedCoverage = useRef<string | null>(null)

  useEffect(() => {
    const keys = storedCoverage.filter((key) => !getAlpha(key))
    if (!keys.length) return
    let live = true
    void Promise.all(keys.map(restoreCoverage)).then((available) => {
      if (!live) return
      for (const key of keys) rendererRef.current?.invalidateCoverage(key)
      useDetect.setState((s) => ({ revision: s.revision + 1 }))
      const missing = keys.filter((_, index) => !available[index])
      const warning = JSON.stringify([photoId, missing])
      if (missing.length && warnedCoverage.current !== warning) {
        warnedCoverage.current = warning
        toast.error(
          'Detected layers need attention',
          'Open Masking and run detection again. Your saved mask adjustments are unchanged.',
        )
      }
    })
    return () => { live = false }
  }, [storedCoverage, photoId])

  // The zoom model always works in *full-resolution* image pixels, so "100%"
  // means one real photo pixel per device pixel no matter which proxy is
  // currently loaded. The output pass samples the proxy with normalised UVs,
  // so swapping in a sharper proxy never moves the image.
  // Zoom and fit are about the *framed* photo, so a crop has to be folded in
  // here: without it the viewport would still lay out the uncropped rectangle.
  const full = sourceSize(photo, proxy)
  const developTool = useUI((s) => s.developTool)
  const cropping = developTool === 'crop'
  const masking = developTool === 'mask'
  const retouching = developTool === 'heal' || developTool === 'redeye'
  // The dropper is not one of the develop tools: it measures rather than edits,
  // and it disarms itself on the first click, so it has to be able to sit over
  // whatever tool the user already had open.
  const dropping = useUI((s) => s.wbPicking) && !!photo
  const maskOverlayMode = useMasking((s) => s.overlay)
  const selectedMaskId = useMasking((s) => s.selectedMaskId)
  // Only show the mask while the tool is open: a tint that stays on after you
  // leave masking makes every other panel look wrong.
  const maskOverlay = selectedMaskOverlay(masking, selectedMaskId, maskOverlayMode)
  const shownEdits = retouching ? ungeometry(edits) : uncrop(edits, cropping)
  const framed = full.width ? geometryOutputSize(full.width, full.height, shownEdits) : full
  const imageSize = useStableImageSize(framed)

  const pane = useMemo(
    () => paneViewport(beforeAfter, size.width, size.height),
    [beforeAfter, size.width, size.height],
  )
  const zp = useZoomPan(pane, imageSize)
  const previewUrl = usePreviewUrl(standIn && photo ? photo : undefined)
  const thumbUrl = useThumbUrl(standIn && photo ? photo : undefined)

  useEffect(() => {
    if (!proxy) {
      setStandIn(true)
      return
    }
    const timer = setTimeout(() => setStandIn(false), RESOLVE_MS)
    return () => clearTimeout(timer)
  }, [proxy])

  // The paint runs outside React, so the things it reads are mirrored into refs
  // rather than closed over: a stale closure here would draw a stale frame.
  const viewRef = useRef(zp.read)
  viewRef.current = zp.read
  const overlayRef = useRef(maskOverlay)
  overlayRef.current = maskOverlay
  const uploadedFor = useRef<string | null>(null)

  // -- renderer lifecycle ----------------------------------------------------
  // Unlike the WebGL2 constructor this cannot finish inside the effect: WebGPU
  // hands out an adapter and a device over promises. So the renderer is absent
  // for the first frames, and `ready` exists to re-run the effects that need it
  // — without it, a proxy that arrived before the device would never upload and
  // the viewport would stay blank until the photo was changed and changed back.
  const [ready, setReady] = useState(false)

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let cancelled = false
    Renderer.create(canvas, { presenting: true })
      .then((r) => {
        // Strict Mode runs this effect twice; the loser owns nothing but still
        // holds a GPU device, so it disposes itself rather than leaking one.
        if (cancelled) {
          r.dispose()
          return
        }
        rendererRef.current = r
        setActiveRenderer(r)
        setReady(true)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
      setReady(false)
      setActiveRenderer(null)
      rendererRef.current?.dispose()
      rendererRef.current = null
    }
  }, [])

  // -- proxy loading ---------------------------------------------------------
  //
  // Two tiers race. The camera's own rendering arrives in a fraction of a second
  // and is fully editable, so Develop is usable almost immediately; the real RAW
  // conversion replaces it when it lands. Only the real one is ever allowed to
  // overwrite the other, which is what makes the order they finish in irrelevant.
  useEffect(() => {
    if (!photoId) {
      setProxy(null)
      return
    }
    const cached = peekProxy(photoId)
    if (cached) {
      setProxy(cached)
      return
    }
    let alive = true
    let real = false
    const controller = new AbortController()
    setProxy(null)
    setError(null)
    setLoading(true)

    loadPreview(photoId, undefined, controller.signal)
      .then((p) => {
        if (alive && p && !real) setProxy(p)
      })
      .catch(() => {})

    loadProxy(photoId, undefined, controller.signal)
      .then((p) => {
        if (!alive) return
        if (!p) setError('This file is no longer where esque left it.')
        real = true
        setProxy(p)
        // A persistent proxy can win before the camera-preview worker has even
        // opened the source. Once real pixels land, that duplicate read/decode
        // has no remaining consumer.
        if (p) controller.abort()
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
      controller.abort()
    }
  }, [photoId])

  // -- sharpen the proxy when the user zooms past what it can resolve --------
  const detailReq = useRef(0)
  const detailAbort = useRef<AbortController | null>(null)
  const currentPhoto = useRef(photoId)
  currentPhoto.current = photoId
  // The escalation is the second half of loading this photo, not a background
  // refinement, so the badge belongs to it too: until it lands the viewport is
  // showing an upscaled working proxy, which is exactly what the badge is there
  // to explain. Set while the request is still debouncing as well as while it
  // is in flight, so the two phases read as one wait rather than two.
  // Claimed in a layout effect so the badge never blinks: the commit that ends
  // the first phase is the same one that starts the second, and a passive effect
  // would let the browser paint the frame in between with neither flag set.
  const [detailBusy, setDetailBusy] = useState(false)

  useLayoutEffect(() => {
    if (!photoId || !proxy) return
    // The embedded tier is a stand-in for a conversion that is already on its
    // way. Escalating from it would order a second, far more expensive decode
    // to answer a question the one in flight is about to answer anyway.
    if (proxy.preview) return
    // How many source pixels the viewport is actually asking for on the long edge.
    const ceiling = detailCeiling(imageSize.width, imageSize.height)
    const needed = Math.min(
      ceiling,
      Math.max(imageSize.width, imageSize.height) * Math.min(1, zp.scale * dpr),
    )
    const have = Math.max(proxy.width, proxy.height)
    // A hair of slack only: the whole point is to be pixel-exact once you zoom.
    if (needed <= have * 1.02 || proxy.scale >= 1) return

    // One escalation, not two. Any sharper RAW proxy buys the same native
    // demosaic and differs only in how far the worker downsamples it. Asking for
    // an intermediate size and then native would pay for that conversion twice,
    // so go straight to this frame's safe ceiling.
    const target = ceiling
    if (target <= have || detailReq.current >= target) return

    let fired = false
    setDetailBusy(true)
    // The watermark is raised only when a request actually goes out. Raising it
    // here would let a zoom that keeps moving — and so keeps resetting the
    // debounce — mark the work as done without ever asking for it.
    const timer = setTimeout(() => {
      if (detailReq.current >= target) return
      fired = true
      detailReq.current = target
      const controller = new AbortController()
      detailAbort.current = controller
      loadProxy(photoId, target, controller.signal)
        .then((p) => {
          // Only a change of photo invalidates the result. A re-render while
          // the decode is in flight must not throw away the pixels it made.
          if (p && currentPhoto.current === photoId) setProxy(p)
        })
        // A failed decode must not leave the watermark poisoned, or the view
        // would stay soft for as long as the photo is open.
        .catch(() => {
          detailReq.current = 0
        })
        .finally(() => {
          if (detailAbort.current === controller) detailAbort.current = null
          if (currentPhoto.current === photoId) setDetailBusy(false)
        })
    }, 180)
    return () => {
      clearTimeout(timer)
      // A zoom that moved back before the debounce elapsed cancels the wait. One
      // that already dispatched leaves the flag to the request it started.
      if (!fired) setDetailBusy(false)
    }
  }, [photoId, proxy, zp.scale, dpr, imageSize.width, imageSize.height])

  useEffect(() => {
    detailReq.current = 0
    setDetailBusy(false)
    detailAbort.current?.abort()
    detailAbort.current = null
    return () => {
      detailAbort.current?.abort()
      detailAbort.current = null
    }
  }, [photoId])

  // -- navigator -------------------------------------------------------------
  //
  // The Navigator lives in the left panel but draws this canvas's view, so the
  // view is pushed to it rather than lifted into shared state: publishing is a
  // few number comparisons, where hoisting zoom and pan would re-render the
  // whole panel tree on every frame of a pan.
  const navScene = useRef({ photoId, imageSize, pane })
  navScene.current = { photoId, imageSize, pane }

  const readView = zp.read
  const subscribeView = zp.subscribe
  const publishNav = useCallback(() => {
    const { photoId: id, imageSize: img, pane: box } = navScene.current
    if (!id || !img.width || !img.height || !box.width || !box.height) {
      setNavigator(null)
      return
    }
    const v = readView()
    setNavigator({
      width: img.width,
      height: img.height,
      paneWidth: box.width,
      paneHeight: box.height,
      scale: v.scale,
      zoom: v.zoom,
      x: v.x,
      y: v.y,
    })
  }, [readView])

  useEffect(() => subscribeView(publishNav), [subscribeView, publishNav])
  // Sizes, crops and photo changes all reshape the view without moving it, and
  // none of them notify the zoom model. The store drops publishes that change
  // nothing, so republishing after every render costs six comparisons.
  useEffect(publishNav)
  useEffect(() => () => setNavigator(null), [])

  // -- render loop -----------------------------------------------------------
  //
  // The canvas is driven from refs, not from props. A pan can then repaint
  // inside the very frame that moved it, instead of waiting for a React commit
  // and then a second animation frame — a wait that is never the same length
  // twice, which is what a jittery viewport actually is.
  const frame = useRef(0)
  const job = useRef<Job | null>(null)
  const jobSeq = useRef(0)
  const histKey = useRef('')

  /** Everything the paint reads that isn't the view or the edits. */
  const scene = useRef<Scene>({
    width: 0,
    height: 0,
    dpr: 1,
    imageSize,
    beforeAfter,
    compareSplit,
    outputSpace,
    clipShadow,
    clipHighlight,
    clipShadowAt,
    clipHighlightAt,
    hdrHeadroom: 1,
  })
  scene.current = {
    width: size.width,
    height: size.height,
    dpr,
    imageSize,
    beforeAfter,
    compareSplit,
    outputSpace,
    clipShadow,
    clipHighlight,
    clipShadowAt,
    clipHighlightAt,
    hdrHeadroom: hdr ? headroomFromStops(hdrHeadroom) : 1,
  }

  const paint = useCallback(() => {
    frame.current = 0
    const renderer = rendererRef.current
    const canvas = canvasRef.current
    const j = job.current
    const s = scene.current
    if (!renderer || !canvas || !j || !renderer.hasImage()) return

    const cw = Math.max(1, Math.round(s.width * s.dpr))
    const ch = Math.max(1, Math.round(s.height * s.dpr))
    // The renderer owns the canvas's backing store: an HDR drawing buffer no
    // longer follows the canvas's own width and height, so sizing it here as
    // well would leave the two disagreeing.
    renderer.resize(cw, ch)

    const box = layoutFor(s, cw, ch, viewRef.current())
    const opts = {
      outputSpace: s.outputSpace,
      showShadowClip: s.clipShadow,
      showHighlightClip: s.clipHighlight,
      clipShadow: s.clipShadowAt,
      clipHighlight: s.clipHighlightAt,
      maskOverlay: j.overlay,
      hdrHeadroom: s.hdrHeadroom,
    }
    // The graph only has to run again when what feeds it has moved, and the
    // job's sequence number is exactly that: it is bumped when, and only when,
    // the edits, the tool or the loaded proxy change. Everything else — pan,
    // zoom, resize — just moves where the same result lands.
    const afterKey = `a${j.seq}`

    let ran: boolean
    if (!j.before) {
      ran = renderer.render(j.after, { ...opts, rect: box.after, graphKey: afterKey })
    } else if (s.beforeAfter === 'before') {
      ran = renderer.render(j.before, { ...opts, rect: box.before, graphKey: `b${j.seq}` })
    } else {
      // After goes last: its graph is the one the histogram reads back.
      ran = renderer.renderPanes(
        [
          { edits: j.before, rect: box.before, clip: box.beforeClip, cacheKey: j.beforeKey },
          { edits: j.after, rect: box.after, clip: box.afterClip },
        ],
        { ...opts, graphKey: afterKey },
      )
    }

    // The bins describe the graph result, not where on screen it was drawn. A
    // pan that re-read them would be paying for a picture that cannot have
    // changed. The readback no longer stalls the pipeline, but it does now land
    // later than the frame that issued it, so a result whose key has since been
    // superseded is dropped rather than shown against the wrong image.
    const hk = `${j.seq}:${s.beforeAfter}:${s.outputSpace}`
    if (ran || hk !== histKey.current) {
      histKey.current = hk
      void renderer.readHistogram(s.outputSpace).then((bins) => {
        if (histKey.current === hk) setHistogram(bins)
      })
    }
  }, [])

  /** Coalesces callers that are not already inside an animation frame. */
  const requestPaint = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(paint)
  }, [paint])

  /**
   * Repaints now.
   *
   * The zoom/pan model calls this from inside the frame that moved the view, so
   * deferring would put the pixels one frame behind the pointer for no reason.
   */
  const paintNow = useCallback(() => {
    if (frame.current) cancelAnimationFrame(frame.current)
    paint()
  }, [paint])

  /**
   * Snapshots what the graph should be run on.
   *
   * The sequence number it stamps is what lets the renderer tell a real change
   * from a change of view, so this must run whenever — and ideally only
   * whenever — the graph's inputs actually move.
   */
  const rebuild = useCallback(() => {
    const s = useDevelop.getState()
    jobSeq.current += 1
    job.current = {
      seq: jobSeq.current,
      after: retouching
        ? ungeometry(s.previewEdits ?? s.edits)
        : uncrop(s.previewEdits ?? s.edits, cropping),
      before:
        beforeAfter === 'off'
          ? null
          : retouching
            ? ungeometry(s.before)
            : uncrop(s.before, cropping),
      // The proxy is part of the identity: a sharper decode has to re-run the
      // before graph even though the settings never moved.
      beforeKey: `${s.photoId}:${s.beforeRevision}:${uploadedFor.current}:${cropping}:${retouching}:${useDetect.getState().revision}`,
      overlay: overlayRef.current,
    }
    requestPaint()
  }, [beforeAfter, cropping, requestPaint, retouching])

  // -- upload the proxy when it changes --------------------------------------
  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer || !proxy) return
    const key = `${proxy.photoId}:${proxy.preview ? 'preview' : 'raw'}:${proxy.width}x${proxy.height}`
    if (uploadedFor.current === key) return
    renderer.setImage(proxy)
    uploadedFor.current = key
    rebuild()
  }, [proxy, rebuild, ready])

  // A moved view is not a changed graph, so it never goes through `rebuild`.
  const { subscribe } = zp
  useEffect(() => subscribe(paintNow), [paintNow, subscribe])

  useEffect(rebuild, [
    rebuild,
    revision,
    detectRevision,
    edits,
    previewEdits,
    beforeAfter,
    beforeRevision,
    cropping,
    retouching,
    maskOverlay?.maskId,
    maskOverlay?.mode,
  ])

  // Presentation-only changes: the same graph result, laid out differently.
  useEffect(requestPaint, [
    requestPaint,
    size.width,
    size.height,
    dpr,
    compareSplit,
    outputSpace,
    clipShadow,
    clipHighlight,
    hdrHeadroom,
  ])

  // The drawing buffer is reallocated by the paint that follows, so the two
  // always change together and no frame is presented through the wrong one.
  useEffect(() => {
    rendererRef.current?.setHdr(hdr)
    requestPaint()
  }, [hdr, requestPaint, ready])

  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current)
      frame.current = 0
    },
    [],
  )

  // -- rendering -------------------------------------------------------------
  const comparing = beforeAfter !== 'off' && !!proxy

  /**
   * The photo's box in CSS pixels, which is what an overlay needs.
   *
   * `layoutFor` works in canvas pixels because that is what the renderer wants;
   * the crop rectangle is a DOM element and lives in the other coordinate
   * system, so the same centring is expressed once more here.
   */
  const photoBox = {
    x: (size.width - imageSize.width * zp.scale) / 2 + zp.offset.x,
    y: (size.height - imageSize.height * zp.scale) / 2 + zp.offset.y,
    width: imageSize.width * zp.scale,
    height: imageSize.height * zp.scale,
  }

  return (
    <div
      {...zp.bind}
      ref={mergeRefs(hostRef, zp.bind.ref)}
      className="relative h-full w-full overflow-hidden bg-black select-none"
      style={{ ...zp.bind.style, cursor: zp.cursor }}
      onContextMenu={(e) => {
        // The canvas commands come first — that is what the user is pointing at
        // — with the photo's own catalog commands folded in underneath.
        const items = viewportMenuItems()
        if (photo) {
          retargetSelection(photo.id)
          items.push(
            { kind: 'separator' },
            ...photoMenuItems(photo, { collections, compact: true }),
          )
        }
        open(e, items)
      }}
    >
      <ViewportContents
        standIn={standIn}
        previewUrl={previewUrl}
        thumbUrl={thumbUrl}
        photoBox={photoBox}
        canvasRef={canvasRef}
        // React dev tracing expands changed props, so keep the proxy's pixel buffer above this boundary.
        hasProxy={!!proxy}
        loading={loading}
        detailBusy={detailBusy}
        photo={photo}
        error={error}
        overlays={(
          <ViewportOverlays
            comparing={comparing}
            beforeAfter={beforeAfter}
            dropping={dropping}
            cropping={cropping}
            masking={masking}
            retouching={retouching}
            photoBox={photoBox}
            compareSplit={compareSplit}
          />
        )}
      />
      {menu}
    </div>
  )
}
