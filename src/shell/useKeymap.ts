import { useEffect } from 'react'
import { useUI, getGridColumns, type BeforeAfter } from '../state/ui'
import { useCatalog } from '../state/catalog'
import { setFlag, setLabel, setRating } from '../catalog/actions'
import { useImporter } from '../state/importer'
import { useExport } from '../state/exportStore'
import { ALL_SECTIONS, useDevelop } from '../develop/session'
import { zoomCommands } from '../lib/useZoomPan'
import { useMasking } from '../develop/masking'
import { useRetouch } from '../develop/retouch'
import { toast } from '../design/toast'
import type { ColorLabel } from '../core/types'

const LABEL_KEYS: Record<string, ColorLabel> = {
  '6': 'red',
  '7': 'yellow',
  '8': 'green',
  '9': 'blue',
}

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/**
 * A modal owns the keyboard while it is up. Without this the app's own Tab
 * binding eats the key a dialog needs to move focus through its controls, and
 * every bare letter fires a command against the photo behind the scrim.
 */
const isModalUp = () => !!document.querySelector('[role="dialog"]')

/** The Lightroom keymap, minus the modules esque doesn't ship. */
export function useKeymap() {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTyping(e.target) || isModalUp()) return
      const ui = useUI.getState()
      const cat = useCatalog.getState()
      const mod = e.metaKey || e.ctrlKey

      if (mod && e.key === ',') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('esque:settings'))
        return
      }
      const targets = cat.selected.length ? cat.selected : cat.primaryId ? [cat.primaryId] : []
      const dev = useDevelop.getState()
      // Up and down are a row in the grid and the neighbouring photo anywhere
      // else, where the strip and the loupe are a single line of pictures.
      const gridRow = ui.module === 'library' && ui.viewMode === 'grid'

      // ---- Commands with modifiers ----
      if (mod) {
        switch (e.key.toLowerCase()) {
          case 'a':
            e.preventDefault()
            cat.selectAll()
            return
          case 'd':
            e.preventDefault()
            cat.clearSelection()
            return
          case 'z':
            e.preventDefault()
            if (e.shiftKey) dev.redo()
            else dev.undo()
            return
          case 'c':
            if (e.shiftKey && ui.module === 'develop') {
              e.preventDefault()
              dev.copySettings(ALL_SECTIONS)
              toast.show('Settings copied')
            }
            return
          case 'v':
            if (e.shiftKey && ui.module === 'develop') {
              e.preventDefault()
              dev.pasteSettings()
            }
            return
          case 'r':
            if (ui.module === 'develop') {
              e.preventDefault()
              dev.resetAll()
            }
            return
          case 'i':
            if (e.shiftKey) {
              e.preventDefault()
              useImporter.getState().run()
            }
            return
          case 'e':
            if (e.shiftKey && targets.length) {
              e.preventDefault()
              useExport.getState().openDialog(targets)
            }
            return
          // The browser's own zoom is suppressed anyway (see useAppZoomGuard),
          // so the familiar shortcuts are handed to the image instead.
          case '+':
          case '=':
            e.preventDefault()
            zoomCommands()?.zoomIn()
            return
          case '-':
          case '_':
            e.preventDefault()
            zoomCommands()?.zoomOut()
            return
          case '0':
            e.preventDefault()
            zoomCommands()?.fit()
            return
          case '1':
            e.preventDefault()
            zoomCommands()?.actual()
            return
          default:
            return
        }
      }

      switch (e.key) {
        // ---- Modules & views ----
        case 'g':
        case 'G':
          ui.setModule('library')
          ui.setViewMode('grid')
          return
        case 'e':
        case 'E':
          ui.setModule('library')
          ui.setViewMode('loupe')
          return
        case 'c':
        case 'C':
          ui.setModule('library')
          ui.setViewMode('compare')
          return
        case 'n':
        case 'N':
          ui.setModule('library')
          ui.setViewMode('survey')
          return
        case 'd':
        case 'D':
          ui.setModule('develop')
          return

        // ---- Panels & chrome ----
        case 'Tab':
          e.preventDefault()
          if (e.shiftKey) ui.togglePanels()
          else {
            ui.toggleLeftPanel()
            ui.toggleRightPanel()
          }
          return
        case 't':
        case 'T':
          ui.toggleToolbar()
          return
        case 'h':
        case 'H':
          ui.toggleHdr()
          return
        case 'f':
        case 'F':
          if (document.fullscreenElement) document.exitFullscreen()
          else document.documentElement.requestFullscreen().catch(() => {})
          return

        // ---- Navigation ----
        case 'ArrowLeft':
          e.preventDefault()
          cat.step(-1)
          return
        case 'ArrowRight':
          e.preventDefault()
          cat.step(1)
          return
        case 'ArrowUp':
          e.preventDefault()
          cat.step(gridRow ? -getGridColumns() : -1)
          return
        case 'ArrowDown':
          e.preventDefault()
          cat.step(gridRow ? getGridColumns() : 1)
          return
        case 'Enter':
          if (ui.module === 'develop' && ui.developTool !== 'none') {
            e.preventDefault()
            ui.setDevelopTool('none')
          }
          return
        case 'Escape':
          // A tool is the innermost thing open, so it unwinds first.
          if (ui.module === 'develop' && ui.developTool !== 'none') ui.setDevelopTool('none')
          else if (ui.viewMode !== 'grid') ui.setViewMode('grid')
          return

        // ---- Flags, ratings, labels ----
        case 'p':
        case 'P':
          if (targets.length) setFlag(targets, 'pick')
          return
        case 'x':
        case 'X':
          if (targets.length) setFlag(targets, 'reject')
          return
        case 'u':
        case 'U':
          if (targets.length) setFlag(targets, 'unflagged')
          return
        case 'z':
        case 'Z':
          zoomCommands()?.toggle()
          return

        // ---- Zoom ----
        case '+':
        case '=':
          e.preventDefault()
          zoomCommands()?.zoomIn()
          return
        case '-':
        case '_':
          e.preventDefault()
          zoomCommands()?.zoomOut()
          return

        // ---- Develop: crop ----
        case 'r':
        case 'R':
          if (ui.module === 'develop') {
            e.preventDefault()
            ui.setDevelopTool(ui.developTool === 'crop' ? 'none' : 'crop')
          }
          return

        // ---- Develop: retouching ----
        // Q is Lightroom's spot-removal key. Red eye has no Lightroom shortcut
        // and E is already Library loupe, so it takes ⇧Q.
        case 'q':
        case 'Q':
          if (ui.module === 'develop') {
            e.preventDefault()
            ui.setDevelopTool(e.shiftKey ? 'redeye' : 'heal')
          }
          return

        // ---- Develop: masking ----
        case 'm':
        case 'M':
          if (ui.module === 'develop') {
            e.preventDefault()
            ui.setDevelopTool(ui.developTool === 'mask' ? 'none' : 'mask')
          }
          return
        case 'o':
        case 'O':
          if (ui.module === 'develop' && ui.developTool === 'mask') {
            e.preventDefault()
            useMasking.getState().cycleOverlay()
          }
          return
        case '[':
        case ']': {
          if (ui.module !== 'develop') return
          // The same pair sizes whichever round tool is open.
          if (ui.developTool === 'heal' || ui.developTool === 'redeye') {
            e.preventDefault()
            const rt = useRetouch.getState()
            const factor = e.key === '[' ? 1 / 1.15 : 1.15
            const clampR = (v: number) => Math.min(0.4, Math.max(0.005, v))
            if (ui.developTool === 'heal') rt.setSpot({ spotRadius: clampR(rt.spotRadius * factor) })
            else rt.setEye({ eyeRadius: clampR(rt.eyeRadius * factor) })
            return
          }
          if (ui.developTool !== 'mask') return
          e.preventDefault()
          const mk = useMasking.getState()
          // Shift resizes the feather instead, which is how every painting app
          // that has both on one pair of keys does it.
          if (e.shiftKey) {
            const step = e.key === '[' ? -5 : 5
            mk.setBrush({ brushFeather: Math.min(100, Math.max(0, mk.brushFeather + step)) })
          } else {
            // Multiplicative, so the step stays useful at both ends.
            const factor = e.key === '[' ? 1 / 1.15 : 1.15
            mk.setBrush({ brushSize: Math.min(Math.max(mk.brushSize * factor, 0.005), 1) })
          }
          return
        }

        // ---- Develop: before / after ----
        case '\\':
          if (ui.module === 'develop') {
            e.preventDefault()
            // Lightroom's held-style toggle: flip the whole frame to Before.
            ui.setBeforeAfter(ui.beforeAfter === 'before' ? 'off' : 'before')
          }
          return
        case 'y':
        case 'Y':
          if (ui.module === 'develop') {
            e.preventDefault()
            // ⇧ cuts one image, ⌥ stacks the pair — the same two axes
            // Lightroom's Y variants use.
            const want: BeforeAfter = e.shiftKey
              ? e.altKey
                ? 'splitHorizontal'
                : 'splitVertical'
              : e.altKey
                ? 'topBottom'
                : 'sideBySide'
            ui.setBeforeAfter(ui.beforeAfter === want ? 'off' : want)
          }
          return
        case 'j':
        case 'J':
          if (ui.module === 'develop') {
            ui.toggleClipping('shadows')
            ui.toggleClipping('highlights')
          }
          return
      }

      if (/^[0-5]$/.test(e.key) && targets.length) {
        setRating(targets, Number(e.key))
        return
      }
      if (LABEL_KEYS[e.key] && targets.length) {
        setLabel(targets, LABEL_KEYS[e.key])
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useAppZoomGuard()
}

/**
 * esque is an app, not a document — the browser's own zoom would scale the
 * chrome and wreck the 1:1 pixel view. Ctrl/⌘ + wheel, ⌘ +/-, and Safari's
 * gesture events are all swallowed so zoom always means *image* zoom.
 */
function useAppZoomGuard() {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault()
    }
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_' || e.key === '0') {
        e.preventDefault()
      }
    }
    const stop = (e: Event) => e.preventDefault()

    window.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKey)
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      window.addEventListener(type, stop, { passive: false })
    }
    return () => {
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKey)
      for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
        window.removeEventListener(type, stop)
      }
    }
  }, [])
}
