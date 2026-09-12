import { useEffect } from 'react'
import { useUI } from '../state/ui'
import { useCatalog } from '../state/catalog'
import { useDevelop } from '../develop/session'
import { chordOf, resolve } from './commands'
import { keyboardOverlayOpen } from '../lib/keyboardScope'
import { isPageZoomChord, isPageZoomed } from '../lib/pageZoom'

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/**
 * The Lightroom keymap, minus the modules esque doesn't ship.
 *
 * All this does now is turn an event into a chord and ask the command table
 * what that means here. The table is read on every keystroke rather than
 * captured once, so a remapping in Settings takes effect on the next key
 * press instead of the next reload.
 */
export function useKeymap() {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || isTyping(e.target) || keyboardOverlayOpen()) return
      // ⌘0 is image fit here — but not while the page itself is zoomed, when it
      // is the only way back to 100%. See the guard below.
      if (isPageZoomChord(e) && isPageZoomed()) return

      const ui = useUI.getState()
      const cat = useCatalog.getState()
      const ctx = {
        ui,
        cat,
        dev: useDevelop.getState(),
        targets: cat.selected.length ? cat.selected : cat.primaryId ? [cat.primaryId] : [],
        event: e,
      }

      const command = resolve(chordOf(e), ctx, ui.keyBindings)
      if (!command) return
      if (!command.passive) e.preventDefault()
      command.run(ctx)
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
 *
 * The guard lifts while the page is already zoomed. Page zoom is remembered per
 * origin, so a window can open at 150% without anyone touching a zoom gesture
 * here — and a guard that holds in that state locks the user inside it with no
 * way out but a browser menu they will never think to open. Releasing the
 * chords hands ⌘0 back to the browser until the page is at 100%, where the
 * guard re-arms and ⌘0 goes back to meaning fit in window.
 */
function useAppZoomGuard() {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault()
    }
    const onKey = (e: KeyboardEvent) => {
      if (!isPageZoomChord(e) || isPageZoomed()) return
      e.preventDefault()
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
