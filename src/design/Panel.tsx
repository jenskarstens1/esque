import { useState, type ReactNode } from 'react'
import { cn } from '../lib/cn'
import { useMenu } from './useMenu'
import type { MenuItem } from './Menu'

interface PanelSectionProps {
  title: string
  children: ReactNode
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Rendered on the right of the header — reset buttons, toggles, amount readouts. */
  actions?: ReactNode
  /**
   * When the actions appear. `hover` keeps the header quiet until you're in it,
   * which is right for a Reset that you already know is there. `always` is for
   * the ones that are the only way to reach a feature at all — a hidden control
   * reads as a missing one.
   */
  revealActions?: 'hover' | 'always'
  /** Shows a dot when the section holds non-default values. */
  modified?: boolean
  /** Off for a section that sits on a panel edge, where the chrome already draws one. */
  hairline?: boolean
  /** Off pins the section open: no chevron, no toggle, and the title sits flush with the panel's left edge. */
  collapsible?: boolean
  /**
   * Claims the leftover height of a flex column and hands it to the body, so
   * the section can scroll on its own while its header stays put. Children are
   * responsible for the scrolling; the section only gives them the room.
   */
  fill?: boolean
  /** Right-click menu for the header. Built lazily so it can read live state. */
  menuItems?: () => MenuItem[]
  className?: string
}

export function PanelSection({
  title,
  children,
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
  actions,
  revealActions = 'hover',
  modified,
  hairline = true,
  collapsible = true,
  fill = false,
  menuItems,
  className,
}: PanelSectionProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen)
  const { menu, open: openMenu } = useMenu()
  const open = collapsible ? (controlledOpen ?? uncontrolled) : true
  const toggle = () => {
    onOpenChange?.(!open)
    if (controlledOpen === undefined) setUncontrolled(!open)
  }

  const label = (
    <>
      {collapsible && <Chevron open={open} />}
      <span className="esq-panel-title truncate">{title}</span>
      {modified && (
        <span aria-label="modified" className="size-[5px] shrink-0 rounded-full bg-accent" />
      )}
    </>
  )

  return (
    <section className={cn(hairline && 'hairline-b', fill && 'flex min-h-0 flex-1 flex-col', className)}>
      <header
        className={cn(
          'group/head flex h-8 shrink-0 items-center gap-1.5 px-3 transition-colors duration-[--duration-fast]',
          collapsible && 'hover:bg-white/[0.028]',
        )}
        onContextMenu={menuItems ? (e) => openMenu(e, menuItems()) : undefined}
      >
        {collapsible ? (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            {label}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">{label}</div>
        )}
        {actions && (
          <div
            className={cn(
              'flex shrink-0 items-center gap-1',
              revealActions === 'hover' &&
                'opacity-0 transition-opacity duration-[--duration-fast] group-hover/head:opacity-100 focus-within:opacity-100',
            )}
          >
            {actions}
          </div>
        )}
      </header>
      {fill ? (
        <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">{children}</div>
      ) : (
        <div
          className={cn(
            'grid transition-[grid-template-rows] duration-[--duration-base] ease-[--ease-out]',
            open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
          )}
        >
          <div className="overflow-hidden">
            <div className="px-3 pb-3">{children}</div>
          </div>
        </div>
      )}
      {menu}
    </section>
  )
}

export function Chevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 10 10"
      className={cn(
        'size-2.5 shrink-0 text-icon-tertiary',
        'transition-[transform,color] duration-[--duration-base] ease-[--ease-out]',
        'group-hover/head:text-icon',
        open && 'rotate-90',
        className,
      )}
      aria-hidden
    >
      <path
        d="M3.5 1.5 L7 5 L3.5 8.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** A subtle divider used between related control clusters inside one section. */
export function PanelDivider({ className }: { className?: string }) {
  return <div className={cn('my-2.5 h-px bg-hairline', className)} />
}

/** Small right-aligned text button used for "Reset" / "Auto" affordances. */
export function MiniAction({
  children,
  onClick,
  active,
  title,
  disabled,
}: {
  children: ReactNode
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void
  active?: boolean
  title?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onClick?.(e)
      }}
      className={cn(
        'rounded-xs px-1.5 py-0.5 text-micro font-medium uppercase tracking-[0.05em] transition-colors duration-[--duration-fast]',
        active ? 'bg-accent-soft text-accent' : 'text-icon-tertiary hover:bg-raised hover:text-icon',
        disabled && 'pointer-events-none opacity-30',
      )}
    >
      {children}
    </button>
  )
}
