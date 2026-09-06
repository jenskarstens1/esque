/** Floating controls own shortcuts until they close, not the photograph below. */
export function keyboardOverlayOpen(): boolean {
  return !!document.querySelector('[role="dialog"], [role="menu"]')
}
