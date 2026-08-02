import { SegmentedControl } from '../design/Controls'
import { useMenu } from '../design/useMenu'
import { MoreHorizontalIcon } from '../design/icons'
import { cn } from '../lib/cn'
import { useDevelop } from '../develop/session'
import { toast } from '../design/toast'
import { BEFORE_AFTER_LABELS, useUI, type BeforeAfter } from '../state/ui'

const MODES: Array<{ value: BeforeAfter; icon: React.ReactNode; title: string }> = [
  { value: 'off', icon: <SingleIcon />, title: `${BEFORE_AFTER_LABELS.off}  (\\ toggles Before)` },
  { value: 'sideBySide', icon: <PairIcon />, title: `${BEFORE_AFTER_LABELS.sideBySide}  (Y)` },
  { value: 'splitVertical', icon: <SplitIcon />, title: `${BEFORE_AFTER_LABELS.splitVertical}  (⇧Y)` },
  { value: 'topBottom', icon: <PairIcon stacked />, title: `${BEFORE_AFTER_LABELS.topBottom}  (⌥Y)` },
  {
    value: 'splitHorizontal',
    icon: <SplitIcon stacked />,
    title: `${BEFORE_AFTER_LABELS.splitHorizontal}  (⇧⌥Y)`,
  },
]

/**
 * Develop's Before / After cluster.
 *
 * The layouts sit in a segmented control because they are one exclusive choice
 * — Lightroom buries the same set behind a cycling button and a menu, which
 * means you can never see which one you are in without cycling through them.
 * The overflow menu holds the destructive moves: swapping the two sides and
 * promoting one over the other.
 */
export function CompareControl() {
  const mode = useUI((s) => s.beforeAfter)
  const setMode = useUI((s) => s.setBeforeAfter)
  const photoId = useDevelop((s) => s.photoId)
  const { menu, open } = useMenu()

  const swap = useDevelop((s) => s.swapBeforeAfter)
  const copyAfterToBefore = useDevelop((s) => s.copyAfterToBefore)
  const copyBeforeToAfter = useDevelop((s) => s.copyBeforeToAfter)
  const resetBefore = useDevelop((s) => s.resetBefore)

  if (!photoId) return null

  const actions = (e: React.MouseEvent) =>
    open(e, [
      {
        label: 'Swap Before and After',
        onSelect: () => {
          swap()
          toast.show('Swapped before and after')
        },
      },
      { kind: 'separator' },
      {
        label: "Copy After's Settings to Before",
        onSelect: () => {
          copyAfterToBefore()
          toast.show('Before updated to the current edit')
        },
      },
      {
        label: "Copy Before's Settings to After",
        onSelect: () => copyBeforeToAfter(),
      },
      { kind: 'separator' },
      {
        label: 'Reset Before to Import',
        onSelect: () => {
          resetBefore()
          toast.show('Before reset to the imported settings')
        },
      },
    ])

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <SegmentedControl
        size="sm"
        value={mode === 'before' ? 'off' : mode}
        onChange={setMode}
        options={MODES.map((m) => ({ value: m.value, label: m.icon, title: m.title }))}
      />
      <button
        type="button"
        title="Before / after actions"
        aria-label="Before / after actions"
        onClick={actions}
        className={cn(
          'grid size-[22px] place-items-center rounded-[5px] text-icon-tertiary',
          'transition-[background-color,color] duration-[--duration-fast] ease-[--ease-out]',
          'hover:bg-raised hover:text-label',
        )}
      >
        <MoreHorizontalIcon size={12} />
      </button>
      {menu}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Layout glyphs
//
// Drawn here rather than pulled from the icon set: these need to read as
// *layouts*, and a 13px frame split the same way the canvas is about to be
// split says that far better than any generic symbol.
// ---------------------------------------------------------------------------

function Frame({ children }: { children?: React.ReactNode }) {
  return (
    <svg viewBox="0 0 14 12" className="size-[13px]" aria-hidden>
      <rect
        x="0.75"
        y="0.75"
        width="12.5"
        height="10.5"
        rx="1.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      {children}
    </svg>
  )
}

function SingleIcon() {
  return (
    <Frame>
      <circle cx="7" cy="6" r="1.5" fill="currentColor" />
    </Frame>
  )
}

function PairIcon({ stacked }: { stacked?: boolean }) {
  return (
    <Frame>
      {stacked ? (
        <path d="M1.4 6h11.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      ) : (
        <path d="M7 1.2v9.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      )}
    </Frame>
  )
}

function SplitIcon({ stacked }: { stacked?: boolean }) {
  return (
    <Frame>
      {stacked ? (
        <>
          <path
            d="M1.4 6h11.2"
            stroke="currentColor"
            strokeWidth="1.1"
            strokeDasharray="2 1.4"
            strokeLinecap="round"
          />
          <rect x="1.4" y="1.4" width="11.2" height="4.6" fill="currentColor" opacity="0.32" />
        </>
      ) : (
        <>
          <path
            d="M7 1.2v9.6"
            stroke="currentColor"
            strokeWidth="1.1"
            strokeDasharray="2 1.4"
            strokeLinecap="round"
          />
          <rect x="1.4" y="1.4" width="5.6" height="9.2" fill="currentColor" opacity="0.32" />
        </>
      )}
    </Frame>
  )
}
