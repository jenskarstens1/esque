import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'
import { cn } from '../lib/cn'

interface BadgeStyle {
  surface?: 'overlay' | 'image' | 'inline'
  size?: 'sm' | 'md'
  tone?: 'neutral' | 'accent' | 'warning'
  icon?: ReactNode
}

function badgeClasses({
  surface = 'overlay', size = 'md', tone = 'neutral',
}: BadgeStyle, iconOnly: boolean) {
  return cn(
    'inline-flex min-w-0 max-w-full items-center justify-center gap-1.5 font-medium tabular-nums',
    size === 'sm' ? 'rounded-sm text-micro' : 'rounded-md text-mini',
    iconOnly ? 'p-0.5' : size === 'sm' ? 'px-1.5 py-0.5' : 'px-2 py-1',
    tone === 'accent'
      ? 'bg-accent text-(--accent-ink)'
      : cn(
          surface === 'overlay' && 'material shadow-hud',
          surface === 'image' && 'bg-black/65 shadow-hud backdrop-blur-sm',
          surface === 'inline' && 'bg-raised',
          tone === 'warning' ? 'text-orange' : surface === 'image' ? 'text-white/90' : 'text-label-secondary',
        ),
  )
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, BadgeStyle {}

/** Shared compact chrome for status, metadata and on-image readouts. */
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { surface, size, tone, icon, children, className, ...props }, ref,
) {
  return (
    <span ref={ref} data-badge="" className={cn(badgeClasses({ surface, size, tone }, !!icon && children == null), className)} {...props}>
      {icon && <span aria-hidden className="inline-flex shrink-0">{icon}</span>}
      {children}
    </span>
  )
})

export function BadgeButton({
  surface, size, tone, icon, children, className, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & BadgeStyle) {
  return (
    <button
      type="button"
      data-badge=""
      className={cn(
        badgeClasses({ surface, size, tone }, !!icon && children == null),
        'esq-tap transition-[color,background-color,scale] duration-[--duration-fast] active:scale-[0.96]',
        'motion-reduce:transition-none motion-reduce:active:scale-100',
        'hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:pointer-events-none disabled:opacity-35',
        className,
      )}
      {...props}
    >
      {icon && <span aria-hidden className="inline-flex shrink-0">{icon}</span>}
      {children}
    </button>
  )
}

export function BadgeDetail({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('ml-0.5 inline-flex items-center gap-1.5 border-l border-hairline-strong pl-2', className)} {...props} />
}
