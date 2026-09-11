import { createRef } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Badge, BadgeButton, BadgeDetail } from '../design/Badge'
import { StatusPill } from '../design/StatusPill'
import { GridIcon, MaskIcon, StackIcon, WarningIcon } from '../design/icons'
import { CompareLabels } from '../modules/develop/CompareOverlay'
import type { BeforeAfter } from '../state/ui'
import { runCheck } from './checkreport'
import '../styles/index.css'

const failures: string[] = []
let assertions = 0
function check(condition: unknown, message: string) {
  assertions++
  if (!condition) failures.push(message)
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const MODES: BeforeAfter[] = ['off', 'before', 'sideBySide', 'topBottom', 'splitVertical', 'splitHorizontal']

function rgba(color: string) {
  const context = new OffscreenCanvas(1, 1).getContext('2d')
  if (!context) throw new Error('2D canvas unavailable for badge colour checks')
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  return context.getImageData(0, 0, 1, 1).data
}

runCheck(async () => {
  const root = createRoot(document.getElementById('root')!)
  const ref = createRef<HTMLSpanElement>()
  let selected = 0
  flushSync(() => root.render(
    <main className="min-h-screen bg-base p-6 text-label">
      <div className="flex flex-wrap items-center gap-3">
        <Badge ref={ref} id="count" icon={<GridIcon size={12} />}>
          24 photos<BadgeDetail>3 selected</BadgeDetail>
        </Badge>
        <Badge id="stack" surface="image" size="sm" icon={<StackIcon size={12} />} role="img" aria-label="Stacked" title="Stacked" />
        <Badge id="warning" surface="image" size="sm" tone="warning" icon={<WarningIcon size={12} />} role="img" aria-label="Original unavailable" title="Original unavailable" />
        <Badge id="keyword" surface="inline" size="sm">Landscape</Badge>
        <BadgeButton id="mask" tone="accent" icon={<MaskIcon size={12} />} aria-pressed onClick={() => selected++}>Subject</BadgeButton>
        <BadgeButton id="disabled" disabled onClick={() => selected++}>Unavailable</BadgeButton>
      </div>
      <div className="mt-6 grid grid-cols-3 gap-4">
        {MODES.map((mode) => (
          <section key={mode}>
            <h2 className="mb-2 text-mini">{mode}</h2>
            <div id={mode} className="relative h-40 bg-canvas">
              <CompareLabels mode={mode} split={0.5} />
            </div>
          </section>
        ))}
        <div id="status" className="relative h-24 bg-canvas"><StatusPill delay={100}>Resolving photo</StatusPill></div>
        <div id="immediate" className="relative h-24 bg-canvas"><StatusPill delay={0}>Preparing photo</StatusPill></div>
      </div>
    </main>,
  ))

  check(ref.current?.id === 'count', 'Badge forwards its measurable element ref')
  check(!document.querySelector('#status [role="status"]'), 'Delayed status stays silent on initial mount')
  check(!!document.querySelector('#immediate [role="status"][data-badge]'), 'Immediate status uses shared badge chrome')
  check(document.querySelector('#stack')?.getAttribute('aria-label') === 'Stacked', 'Icon-only marker retains its accessible name')
  check(document.querySelector('#warning')?.getAttribute('title') === 'Original unavailable', 'Warning detail remains available on hover')
  check(document.querySelector('#stack [aria-hidden] svg'), 'Decorative badge icon is hidden from assistive technology')
  check(document.querySelector('#count [class*="border-l"]'), 'Metadata is separated with a hairline')

  for (const mode of MODES) {
    const captions = [...document.querySelectorAll<HTMLElement>(`#${mode} [data-badge]`)]
    const expected = mode === 'off' ? 0 : mode === 'before' ? 1 : 2
    check(captions.length === expected, `${mode}: every standard comparison caption uses Badge`)
    check(captions.every((caption) => !!caption.querySelector('svg')), `${mode}: comparison captions have icons`)
    if (expected > 0) check(captions[0].textContent === 'Before', `${mode}: before label is preserved`)
    if (expected > 1) check(captions[1].textContent === 'After', `${mode}: after label is preserved`)
  }

  const mask = document.getElementById('mask')!
  mask.focus()
  check(document.activeElement === mask && mask.tagName === 'BUTTON', 'Interactive badge remains a focusable native button')
  check(mask.getAttribute('aria-pressed') === 'true', 'Active mask remains exposed as pressed')
  mask.click()
  document.getElementById('disabled')!.click()
  check(selected === 1, 'Badge button calls its action and disabled badges do not')
  await wait(140)
  check(!!document.querySelector('#status [role="status"][data-badge]'), 'Delayed status appears with shared badge chrome')

  const appearance = document.documentElement.getAttribute('data-appearance')
  try {
    for (const theme of ['dark', 'dim', 'light']) {
      document.documentElement.setAttribute('data-appearance', theme)
      await wait(30)
      const badges = [...document.querySelectorAll<HTMLElement>('[data-badge]')]
      check(badges.every((badge) => {
        const style = getComputedStyle(badge)
        const radius = parseFloat(style.borderTopLeftRadius)
        return radius > 0 && radius <= 7 && radius < badge.getBoundingClientRect().height / 2 && style.textTransform !== 'uppercase'
      }), `${theme}: all badges have compact rectangular corners and normal case`)
      check(badges.every((badge) => !badge.textContent?.includes('\u00b7')), `${theme}: badges contain no middle-dot separators`)
      const marker = getComputedStyle(document.getElementById('stack')!)
      const background = rgba(marker.backgroundColor)
      const foreground = rgba(marker.color)
      check(background.slice(0, 3).every((channel) => channel === 0) && Math.abs(background[3] - 166) <= 1
        && foreground.slice(0, 3).every((channel) => channel >= 254) && Math.abs(foreground[3] - 230) <= 1,
      `${theme}: image markers retain dark chrome and light foreground`)
      check(document.getElementById('stack')!.getBoundingClientRect().width === 16, `${theme}: icon markers stay 16px wide`)
    }
  } finally {
    if (appearance === null) document.documentElement.removeAttribute('data-appearance')
    else document.documentElement.setAttribute('data-appearance', appearance)
  }
  return { ok: failures.length === 0, assertions, failures }
})
