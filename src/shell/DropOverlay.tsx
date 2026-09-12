import { cn } from '../lib/cn'
import { useDropZone } from '../state/dropImport'

/**
 * What the Library does while photographs are held over the window.
 *
 * The drop itself is the window's — a folder dragged onto a panel or the title
 * bar imports exactly the same — but the answer is drawn around the place the
 * photographs will actually appear: one accent edge just inside the grid.
 * Nothing moves, nothing blooms, and nothing is explained, because a drag
 * already in the air is not a moment for a sentence.
 */
export function DropOverlay() {
  const over = useDropZone((s) => s.over)

  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-2 z-40 rounded-xl',
        'shadow-[inset_0_0_0_1px_var(--color-accent)]',
        'transition-opacity duration-[--duration-base] ease-[--ease-out]',
        over ? 'opacity-100' : 'opacity-0',
      )}
    />
  )
}
