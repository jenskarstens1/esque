// oxlint-disable react/only-export-components -- every export here is a component;
// the rule just can't see through the `wrap()` factory.
/**
 * The icon set.
 *
 * Every glyph comes from **Lucide** (ISC licensed, 24×24 grid, 2px round-cap
 * strokes) rather than being drawn by hand — a real, maintained set stays
 * internally consistent in a way ad-hoc SVG never does.
 *
 * The indirection is deliberate: call sites name icons after what they *mean*
 * in a photo editor (`DropperIcon`, `RejectIcon`, `LoupeIcon`), not after
 * Lucide's generic vocabulary, so swapping a glyph is a one-line change here.
 */
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Bandage,
  Blend,
  ChartNoAxesColumn,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Crop,
  Database,
  Download,
  Ellipsis,
  Eye,
  EyeOff,
  FlipHorizontal,
  FlipVertical,
  Flag,
  FlagOff,
  Folder,
  FolderPlus,
  Columns2,
  Grid2x2,
  Grid3x3,
  LayoutDashboard,
  LayoutPanelLeft,
  History,
  Image,
  ImagePlus,
  ImageUp,
  Images,
  Info,
  Layers,
  Link2,
  Lock,
  Minus,
  Monitor,
  PanelsTopLeft,
  Pencil,
  Pipette,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  ScanEye,
  Search,
  Settings,
  SlidersHorizontal,
  SquareSplitHorizontal,
  Star,
  Tag,
  Trash2,
  TriangleAlert,
  WandSparkles,
  X,
  ZoomIn,
  type LucideProps,
} from 'lucide-react'

type P = LucideProps

/**
 * Lucide scales its 2px stroke with the icon box, so a 13px glyph would render
 * a 1.08px hairline that goes soft on a 1× display. `absoluteStrokeWidth`
 * pins the stroke instead, giving every icon the same optical weight at every
 * size — the trick SF Symbols uses, and what the rest of this UI expects.
 *
 * 1.75px, not the 1.4px this started at: a 12px glyph is mostly negative
 * space, and a stroke thin enough to disappear into the panel makes the icon
 * look half-rendered rather than quiet. Paired with the opaque `--color-icon`
 * ramp, every glyph now has a body.
 */
function wrap(C: React.ComponentType<LucideProps>) {
  const Wrapped = (p: P) => <C size={16} strokeWidth={1.75} absoluteStrokeWidth {...p} />
  Wrapped.displayName = `Icon(${C.displayName ?? 'lucide'})`
  return Wrapped
}

// — App mark —

/*
 * A fan of four shards thrown from one point, the way a lens throws light.
 *
 * The geometry is deliberate rather than drawn. The apex sits low and left of
 * centre; each shard is 11.55° wide with an even 8.35° between them, and every
 * tip lands on one shared arc struck from off to the lower right. That arc is
 * what grades the shards from short to long, and it's why the fan reads as one
 * gesture rather than four spokes. Corners are true inscribed fillets, not a
 * round-linejoin stroke — a stroke would inflate each shard and weld all four
 * together at the shared apex. The apex radius is deliberately tiny (0.12 to
 * the tips' 0.75): at an 11.55° angle a fillet eats ~10× its radius back along
 * the shard, so anything larger would blunt the origin the fan throws from.
 *
 * The whole mark is centred on its own ink centroid, not its bounding box, and
 * nothing touches the artboard edge — so it drops into a rounded chip, a
 * favicon or a text run without needing a nudge.
 *
 * The colour climbs with the length: the accent sits on the shortest shard and
 * the ramp lightens toward the longest, so the fan opens into light and reads
 * cleanly down to the 19px it's drawn at in the title bar.
 */
const SHARDS = [
  {
    d: 'M9.55 22.34A0.12 0.12 0 0 0 9.76 22.46L22.15 5.2A0.75 0.75 0 0 0 21.56 4.01L18.33 3.88A0.75 0.75 0 0 0 17.61 4.33Z',
    ink: 'var(--color-mark-4)',
  },
  {
    d: 'M9.14 22.24A0.12 0.12 0 0 0 9.38 22.29L14 5.92A0.75 0.75 0 0 0 13 5.01L10.77 5.88A0.75 0.75 0 0 0 10.29 6.52Z',
    ink: 'var(--color-mark-3)',
  },
  {
    d: 'M8.73 22.28A0.12 0.12 0 0 0 8.97 22.24L8.01 9.05A0.75 0.75 0 0 0 6.77 8.53L5.6 9.54A0.75 0.75 0 0 0 5.36 10.31Z',
    ink: 'var(--color-mark-2)',
  },
  {
    d: 'M8.35 22.47A0.12 0.12 0 0 0 8.56 22.34L4.31 12.82A0.75 0.75 0 0 0 2.99 12.71L2.49 13.46A0.75 0.75 0 0 0 2.51 14.31Z',
    ink: 'var(--color-mark-1)',
  },
]

/**
 * The mark in one ink, for the places it's an affordance rather than branding
 * and has to take a `text-*` colour — the empty state, where it tints to the
 * accent on drag-over.
 */
export function Mark({ size = 20, ...rest }: LucideProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden {...rest}>
      {SHARDS.map((s) => (
        <path key={s.d} d={s.d} />
      ))}
    </svg>
  )
}

/** The full-colour mark. Branding only: the title bar and the favicon. */
export function Logo({ size = 20, ...rest }: LucideProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden {...rest}>
      {SHARDS.map((s) => (
        <path key={s.d} d={s.d} fill={s.ink} />
      ))}
    </svg>
  )
}

// — Chevrons & sort —

export const ChevronDownIcon = wrap(ChevronDown)
export const ChevronLeftIcon = wrap(ChevronLeft)
export const ChevronRightIcon = wrap(ChevronRight)
export const ChevronUpIcon = wrap(ChevronUp)
export const SortAscIcon = wrap(ArrowUpNarrowWide)
export const SortDescIcon = wrap(ArrowDownWideNarrow)

// — Develop tools —

export const BeforeAfterIcon = wrap(SquareSplitHorizontal)
export const CropIcon = wrap(Crop)
export const DropperIcon = wrap(Pipette)
export const FlipHorizontalIcon = wrap(FlipHorizontal)
export const FlipVerticalIcon = wrap(FlipVertical)
export const HealIcon = wrap(Bandage)
export const HistogramIcon = wrap(ChartNoAxesColumn)
export const MaskIcon = wrap(Blend)
export const RedEyeIcon = wrap(ScanEye)
export const RotateLeftIcon = wrap(RotateCcw)
export const RotateRightIcon = wrap(RotateCw)
export const ZoomIcon = wrap(ZoomIn)

// — Library —

export const CollectionIcon = wrap(Images)
export const CompareIcon = wrap(Columns2)
export const ExportIcon = wrap(ImageUp)
export const FolderIcon = wrap(Folder)
export const FolderPlusIcon = wrap(FolderPlus)
export const FilePlusIcon = wrap(ImagePlus)
export const GridIcon = wrap(Grid2x2)
/** Grid layout: uniform tiles, photos cropped to fill them. */
export const TileFillIcon = wrap(Grid3x3)
/** Grid layout: masonry columns, every frame at its own proportions. */
export const WaterfallIcon = wrap(LayoutPanelLeft)
export const ImportIcon = wrap(Download)
export const KeywordIcon = wrap(Tag)
export const LoupeIcon = wrap(Image)
export const PresetIcon = wrap(WandSparkles)
export const RejectIcon = wrap(FlagOff)
export const StackIcon = wrap(Layers)
export const SurveyIcon = wrap(LayoutDashboard)

/** Pick flag. `filled` marks the photo as picked rather than merely hovered. */
const FlagBase = wrap(Flag)
export const FlagIcon = ({ filled, ...p }: P & { filled?: boolean }) => (
  <FlagBase fill={filled ? 'currentColor' : 'none'} {...p} />
)

/** Rating star. `filled` is the "this star is lit" state. */
const StarBase = wrap(Star)
export const StarIcon = ({ filled, ...p }: P & { filled?: boolean }) => (
  <StarBase fill={filled ? 'currentColor' : 'none'} {...p} />
)

// — Generic UI —

export const CheckIcon = wrap(Check)
export const CloseIcon = wrap(X)
export const CopyIcon = wrap(Copy)
export const DownloadIcon = wrap(Download)
export const HistoryIcon = wrap(History)
export const InfoIcon = wrap(Info)
export const LinkIcon = wrap(Link2)
export const LockIcon = wrap(Lock)
export const MinusIcon = wrap(Minus)
export const MoreHorizontalIcon = wrap(Ellipsis)
export const PencilIcon = wrap(Pencil)
export const PlusIcon = wrap(Plus)
export const ResetIcon = wrap(RotateCcw)
export const SearchIcon = wrap(Search)
export const SettingsIcon = wrap(Settings)
export const SlidersIcon = wrap(SlidersHorizontal)
export const SyncIcon = wrap(RefreshCw)
export const TrashIcon = wrap(Trash2)
export const WarningIcon = wrap(TriangleAlert)

// — Settings panes —

export const CacheIcon = wrap(Database)
export const DisplayIcon = wrap(Monitor)
export const InterfaceIcon = wrap(PanelsTopLeft)

/** Visibility toggle. `off` is the struck-through state. */
const EyeBase = wrap(Eye)
const EyeOffBase = wrap(EyeOff)
export const EyeIcon = ({ off, ...p }: P & { off?: boolean }) =>
  off ? <EyeOffBase {...p} /> : <EyeBase {...p} />
