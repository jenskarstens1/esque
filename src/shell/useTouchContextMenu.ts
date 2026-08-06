/**
 * Long press as a right click, for the whole app at once.
 *
 * esque hangs a great deal on `onContextMenu` — rate, flag, label, stack, reveal,
 * remove, reset a slider, retarget a mask. Touch has no such event, so on a phone
 * every one of those is simply unreachable.
 *
 * Rather than thread a long-press hook through three dozen call sites, a press
 * that stays put dispatches a real `contextmenu` MouseEvent on the element under
 * the finger. React listens for it at the root container, so every existing
 * `onContextMenu` — and every one written later — fires with the right
 * coordinates and no knowledge that a finger was involved.
 */
import { useEffect } from 'react'
import { isCoarsePointer } from '../lib/useViewport'

/** How far a finger may wander before the press is a drag or a scroll instead. */
const SLOP = 10
const DELAY = 450

/** Where the platform's own press-and-hold still belongs: text editing. */
const EXEMPT = 'input, textarea, [contenteditable="true"]'

export function useTouchContextMenu() {
  useEffect(() => {
    let timer: number | null = null
    let origin: { x: number; y: number; target: EventTarget | null } | null = null

    const cancel = () => {
      if (timer !== null) window.clearTimeout(timer)
      timer = null
      origin = null
    }

    const onDown = (e: PointerEvent) => {
      // A mouse has the real event and a pen has its barrel button, so arming
      // either would open the menu twice on a hybrid machine.
      if (e.pointerType !== 'touch' || !isCoarsePointer()) return
      // A second finger is a pinch or a two-finger pan starting, not a press.
      if (!e.isPrimary) return cancel()
      const el = e.target as HTMLElement | null
      if (el?.closest(EXEMPT)) return

      cancel()
      const { clientX: x, clientY: y } = e
      const target = e.target
      origin = { x, y, target }

      timer = window.setTimeout(() => {
        timer = null
        origin = null

        /*
         * A menu appearing under a finger with nothing else marking the moment
         * reads as a glitch, so the press is confirmed the way the OS confirms
         * one. Guarded: Safari has no Vibration API, and Chrome refuses it
         * without a prior gesture. Neither is worth an exception.
         */
        try {
          navigator.vibrate?.(8)
        } catch {
          /* haptics are a nicety, never a requirement */
        }

        ;(target as HTMLElement | null)?.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            // Some handlers branch on the button; a context menu is button 2.
            button: 2,
            buttons: 2,
          }),
        )

        /*
         * The finger is still down, and lifting it would otherwise land a click
         * on whatever the menu was opened over — selecting the thumbnail behind
         * the menu, or jumping the slider the menu belongs to. One capture-phase
         * suppression, removed either way, so a genuine later tap is untouched.
         */
        const swallow = (ev: Event) => {
          ev.stopPropagation()
          ev.preventDefault()
        }
        window.addEventListener('click', swallow, true)
        window.setTimeout(() => window.removeEventListener('click', swallow, true), 700)
      }, DELAY)
    }

    const onMove = (e: PointerEvent) => {
      if (!origin) return
      if (Math.abs(e.clientX - origin.x) > SLOP || Math.abs(e.clientY - origin.y) > SLOP) cancel()
    }

    // Capture, so a handler that stops propagation mid-tree can't strand the
    // timer and fire a menu after the gesture has been claimed by something else.
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('pointermove', onMove, true)
    document.addEventListener('pointerup', cancel, true)
    document.addEventListener('pointercancel', cancel, true)
    // A scroll means the press was the start of a flick.
    document.addEventListener('scroll', cancel, true)
    return () => {
      cancel()
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('pointermove', onMove, true)
      document.removeEventListener('pointerup', cancel, true)
      document.removeEventListener('pointercancel', cancel, true)
      document.removeEventListener('scroll', cancel, true)
    }
  }, [])
}
