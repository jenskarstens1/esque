import { createContext, useContext, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'

const FOCUSABLE =
  'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"], audio[controls], video[controls]'

export function canFocus(element: HTMLElement): boolean {
  return (
    element.isConnected &&
    !element.matches(':disabled') &&
    !element.closest('[inert], [hidden]') &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== 'hidden'
  )
}

export function focusableElements(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.tabIndex >= 0 && canFocus(element),
  )
}

interface ModalScope {
  root: RefObject<HTMLDivElement | null>
  branches: Set<HTMLElement>
  dismiss?: () => void
  lastFocused: HTMLElement | null
}

export const ModalFocusContext = createContext<ModalScope | null>(null)

const scopes: ModalScope[] = []
const previousInert = new Map<HTMLElement, boolean>()

function contains(scope: ModalScope, target: Node): boolean {
  return (
    !!scope.root.current?.contains(target) ||
    [...scope.branches].some((branch) => branch.contains(target))
  )
}

function syncIsolation() {
  const scope = scopes.at(-1)
  if (!scope) {
    for (const [element, inert] of previousInert) element.inert = inert
    previousInert.clear()
    return
  }

  // Menus portal beside their dialog, not inside it. Registered branches stay
  // interactive; live regions remain exposed so failures can still be announced.
  for (const element of document.body.children) {
    if (!(element instanceof HTMLElement) || element.matches('script, style, link')) continue
    if (!previousInert.has(element)) previousInert.set(element, element.inert)
    const allowed =
      (scope.root.current && element.contains(scope.root.current)) ||
      [...scope.branches].some((branch) => element.contains(branch)) ||
      element.matches('[aria-live], [role="tooltip"]')
    element.inert = allowed ? (previousInert.get(element) ?? false) : true
  }
}

function scopeElements(scope: ModalScope): HTMLElement[] {
  return [
    ...(scope.root.current ? focusableElements(scope.root.current) : []),
    ...[...scope.branches].flatMap(focusableElements),
  ]
}

function focusInside(scope: ModalScope) {
  const previous = scope.lastFocused
  const target =
    previous && contains(scope, previous) && canFocus(previous)
      ? previous
      : (scopeElements(scope)[0] ?? scope.root.current)
  target?.focus({ preventScroll: true })
}

function onFocus(event: FocusEvent) {
  const scope = scopes.at(-1)
  if (!scope || !(event.target instanceof HTMLElement)) return
  if (contains(scope, event.target)) scope.lastFocused = event.target
  else focusInside(scope)
}

function onKey(event: KeyboardEvent) {
  const scope = scopes.at(-1)
  if (!scope || event.defaultPrevented) return
  // The menu handles its own Tab/Escape, including returning to this dialog.
  if (event.target instanceof Element && event.target.closest('[role="menu"]')) return

  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopImmediatePropagation()
    scope.dismiss?.()
  } else if (event.key === 'Tab') {
    const elements = scopeElements(scope)
    const active = document.activeElement
    const first = elements[0]
    const last = elements.at(-1)
    if (
      !first ||
      !(active instanceof HTMLElement) ||
      !contains(scope, active) ||
      active === scope.root.current ||
      (event.shiftKey ? active === first : active === last)
    ) {
      event.preventDefault()
      ;(event.shiftKey ? last : first)?.focus({ preventScroll: true })
      if (!first) scope.root.current?.focus({ preventScroll: true })
    }
  }
}

let observer: MutationObserver | null = null

/** Shared by dialogs and touch panels, so only the top surface owns focus. */
export function useModalFocus(open: boolean, dismiss?: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  const scope = useMemo<ModalScope>(
    () => ({ root: ref, branches: new Set(), lastFocused: null }),
    [],
  )

  useLayoutEffect(() => {
    scope.dismiss = dismiss
  }, [scope, dismiss])

  useLayoutEffect(() => {
    if (!open || !ref.current) return
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null
    scopes.push(scope)
    if (scopes.length === 1) {
      document.addEventListener('focusin', onFocus, true)
      window.addEventListener('keydown', onKey)
      observer = new MutationObserver(syncIsolation)
      observer.observe(document.body, { childList: true })
    }
    syncIsolation()
    const preferred = ref.current.querySelector<HTMLElement>('[autofocus], [data-autofocus]')
    if (preferred && canFocus(preferred)) preferred.focus({ preventScroll: true })
    else focusInside(scope)

    return () => {
      scopes.splice(scopes.indexOf(scope), 1)
      syncIsolation()
      if (!scopes.length) {
        document.removeEventListener('focusin', onFocus, true)
        window.removeEventListener('keydown', onKey)
        observer?.disconnect()
        observer = null
      }
      queueMicrotask(() => {
        // StrictMode can register this scope again; a newly opened dialog must
        // also keep the focus it just claimed.
        if (scopes.includes(scope)) return
        const top = scopes.at(-1)
        if (restore && canFocus(restore) && (!top || contains(top, restore)))
          restore.focus({ preventScroll: true })
        else if (top) focusInside(top)
      })
    }
  }, [open, scope])

  return { ref, scope }
}

export function useModalBranch(ref: RefObject<HTMLDivElement | null>) {
  const scope = useContext(ModalFocusContext)
  useLayoutEffect(() => {
    const element = ref.current
    if (!scope || !element) return
    scope.branches.add(element)
    syncIsolation()
    return () => {
      scope.branches.delete(element)
      syncIsolation()
    }
  }, [ref, scope])
  return scope !== null
}
