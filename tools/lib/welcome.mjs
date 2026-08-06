/**
 * Every harness launches a throwaway browser profile, so `seenVersion` is always
 * empty and the welcome dialog is always up. It is modal: it covers the app, and
 * its Escape handler runs in the capture phase and stops propagation, so any
 * harness that sends a key or a click is really talking to the dialog. Left in
 * place it doesn't just add noise — it makes a passing run meaningless.
 *
 * Dismiss it the way a person would, by pressing its own button, falling back to
 * Escape only if no button matches.
 */
export async function dismissWelcome(page, tries = 3) {
  const isOpen = () => page.evaluate(() => !!document.querySelector('[role="dialog"]'))

  for (let i = 0; i < tries; i++) {
    if (!(await isOpen())) return true
    const clicked = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]')
      const button = [...(dialog?.querySelectorAll('button') ?? [])].find((b) =>
        /not now|continue|close|done|got it/i.test(b.textContent || ''),
      )
      if (!button) return false
      button.click()
      return true
    })
    if (!clicked) await page.keyboard.press('Escape')
    await new Promise((r) => setTimeout(r, 400))
  }
  return !(await isOpen())
}
