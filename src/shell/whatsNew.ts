/**
 * Opening the release notes from somewhere that doesn't own the dialog.
 *
 * The dialog is mounted once by the shell, so the menus and Settings can't
 * simply set its state. They ask for it on the window instead — the same way
 * the keymap asks for Settings — and this module owns the event name so a typo
 * fails at the build rather than silently doing nothing.
 */

const EVENT = 'esque:whats-new'

/** Shows the What's new face of the welcome dialog. */
export const openWhatsNew = () => window.dispatchEvent(new CustomEvent(EVENT))

/** Subscribes the shell to the request. Returns the unsubscribe. */
export function onWhatsNew(handler: () => void): () => void {
  window.addEventListener(EVENT, handler)
  return () => window.removeEventListener(EVENT, handler)
}
