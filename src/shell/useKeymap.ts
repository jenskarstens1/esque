import { useEffect } from 'react'
import { useUI } from '../state/ui'
import { useCatalog } from '../state/catalog'
import { useDevelop } from '../develop/session'
import { chordOf, resolve } from './commands'

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
      if (isTyping(e.target) || isModalUp()) return

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
