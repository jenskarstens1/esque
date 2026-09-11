import { useEffect, useState, type ReactNode } from 'react'
import { cn } from '../lib/cn'
import { Spinner } from './Spinner'
import { Badge } from './Badge'

/**
 * The status badge that floats over a photo while esque is still resolving it.
 *
 * Deliberately late. Nearly every open is answered from cache inside a frame or
 * two, and an indicator that appears and vanishes faster than it can be read
 * registers as a glitch rather than as progress — so nothing is announced until
 * the wait has lasted long enough to be worth explaining.
 */
export function StatusPill({
  children,
  delay = 420,
  className,
}: {
  children: ReactNode
  /** Milliseconds of silence before the wait is worth naming. */
  delay?: number
  className?: string
}) {
  const [due, setDue] = useState(delay <= 0)

  useEffect(() => {
    if (delay <= 0) return
    const timer = setTimeout(() => setDue(true), delay)
    return () => clearTimeout(timer)
  }, [delay])

  if (!due) return null

  return (
    <Badge
      role="status"
      icon={<Spinner size={12} />}
      className={cn(
        'pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2',
        'animate-[esq-hud-in_var(--duration-base)_var(--ease-out)_both] motion-reduce:animate-none',
        className,
      )}
    >
      {children}
    </Badge>
  )
}
