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
  ChevronsDownUp,
  ChevronsUpDown,
  ClipboardPaste,
  Contrast,
  Copy,
  CopyPlus,
  Crop,
  Database,
  Download,
  Ellipsis,
  Eraser,
  Eye,
  EyeOff,
  FlipHorizontal,
  FlipVertical,
  Flag,
  FlagOff,
  Folder,
  FolderInput,
  FolderPlus,
  Columns2,
  Funnel,
  FunnelX,
  Grid2x2,
  Grid3x3,
  LayoutDashboard,
  LayoutPanelLeft,
  History,
  Image,
  ImageMinus,
  ImagePlus,
  ImageUp,
  Images,
  Info,
  Keyboard,
  Layers,
  Link2,
  List,
  Lock,
  MapPin,
  Minus,
  Monitor,
  PanelRight,
  PanelsTopLeft,
  Palette,
  Pencil,
  Pipette,
  Plus,
  Proportions,
  Redo2,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Rows3,
  Save,
  ScanEye,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  SquareDashed,
  SquareDashedMousePointer,
  SquareSplitHorizontal,
  Star,
  Sun,
  Tag,
  Trash2,
  TriangleAlert,
  Undo2,
  WandSparkles,
  X,
  ZoomIn,
  type LucideProps,
} from 'lucide-react'

type P = LucideProps

/**
 * A light, fixed stroke keeps small toolbar glyphs open without changing their
 * hit areas. The opaque icon ramp provides contrast independently of weight.
 */
function wrap(C: React.ComponentType<LucideProps>) {
  const Wrapped = (p: P) => <C size={16} strokeWidth={1.4} absoluteStrokeWidth {...p} />
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

/** The full-colour mark. Branding only: the title bar, the welcome dialog, and the favicon. */
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
/** Crop aspect ratio — the submenu of frame proportions. */
export const AspectIcon = wrap(Proportions)
export const DropperIcon = wrap(Pipette)
export const FlipHorizontalIcon = wrap(FlipHorizontal)
export const FlipVerticalIcon = wrap(FlipVertical)
export const HealIcon = wrap(Bandage)
export const HistogramIcon = wrap(ChartNoAxesColumn)
/** Exposure, in the sense the histogram means it — how much light landed. */
export const ExposureIcon = wrap(Sun)
/** Black and white endpoints, and mask inversion: both are "flip the extremes". */
export const ContrastIcon = wrap(Contrast)
export const MaskIcon = wrap(Blend)
export const RedEyeIcon = wrap(ScanEye)
export const RotateLeftIcon = wrap(RotateCcw)
export const RotateRightIcon = wrap(RotateCw)
export const ZoomIcon = wrap(ZoomIn)

// — Library —

export const CollectionIcon = wrap(Images)
/** A collection whose membership is a saved question rather than a list. */
export const SmartCollectionIcon = wrap(Sparkles)
/** The Library's filter row. */
export const FilterIcon = wrap(Funnel)
/** Drop every active filter and show the whole source again. */
export const ClearFilterIcon = wrap(FunnelX)
export const CompareIcon = wrap(Columns2)
export const ExportIcon = wrap(ImageUp)
export const FolderIcon = wrap(Folder)
export const FolderPlusIcon = wrap(FolderPlus)
export const FilePlusIcon = wrap(ImagePlus)
/** Taking photos back out of a collection — the mirror of `FilePlusIcon`. */
export const FileMinusIcon = wrap(ImageMinus)
export const GridIcon = wrap(Grid2x2)
/** Grid layout: uniform tiles, photos cropped to fill them. */
export const TileFillIcon = wrap(Grid3x3)
/** Grid layout: masonry columns, every frame at its own proportions. */
export const WaterfallIcon = wrap(LayoutPanelLeft)
export const ImportIcon = wrap(Download)
export const KeywordIcon = wrap(Tag)
/** The colour label swatch set — the five marks a photo can wear. */
export const ColorLabelIcon = wrap(Palette)
export const LoupeIcon = wrap(Image)
/** Where the shot was taken — the GPS block in Metadata. */
export const LocationIcon = wrap(MapPin)
export const PresetIcon = wrap(WandSparkles)
export const RejectIcon = wrap(FlagOff)
export const StackIcon = wrap(Layers)
export const SurveyIcon = wrap(LayoutDashboard)
/** A second interpretation of one negative, sharing the original file. */
export const VirtualCopyIcon = wrap(CopyPlus)

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
export const CollapseAllIcon = wrap(ChevronsDownUp)
export const CopyIcon = wrap(Copy)
export const DownloadIcon = wrap(Download)
/** Wiping a container's contents without removing the container. */
export const EmptyIcon = wrap(Eraser)
export const ExpandAllIcon = wrap(ChevronsUpDown)
export const HistoryIcon = wrap(History)
export const InfoIcon = wrap(Info)
export const LinkIcon = wrap(Link2)
export const ListIcon = wrap(List)
export const LockIcon = wrap(Lock)
export const MinusIcon = wrap(Minus)
export const MoreHorizontalIcon = wrap(Ellipsis)
/** Filing something under a different heading. */
export const MoveIcon = wrap(FolderInput)
export const PasteIcon = wrap(ClipboardPaste)
export const PencilIcon = wrap(Pencil)
export const PlusIcon = wrap(Plus)
export const RedoIcon = wrap(Redo2)
export const ResetIcon = wrap(RotateCcw)
export const SaveIcon = wrap(Save)
export const SearchIcon = wrap(Search)
export const SelectAllIcon = wrap(SquareDashedMousePointer)
export const SelectNoneIcon = wrap(SquareDashed)
export const SettingsIcon = wrap(Settings)
/** The right-hand inspector — where a photo's metadata is read. */
export const SidePanelIcon = wrap(PanelRight)
export const SlidersIcon = wrap(SlidersHorizontal)
/** Solo mode: one panel open at a time, the rest folded away. */
export const SoloIcon = wrap(Rows3)
export const SyncIcon = wrap(RefreshCw)
export const TrashIcon = wrap(Trash2)
export const UndoIcon = wrap(Undo2)
export const WarningIcon = wrap(TriangleAlert)

// — Settings panes —

export const CacheIcon = wrap(Database)
export const DisplayIcon = wrap(Monitor)
export const InterfaceIcon = wrap(PanelsTopLeft)
export const KeyboardIcon = wrap(Keyboard)

/** Visibility toggle. `off` is the struck-through state. */
const EyeBase = wrap(Eye)
const EyeOffBase = wrap(EyeOff)
export const EyeIcon = ({ off, ...p }: P & { off?: boolean }) =>
  off ? <EyeOffBase {...p} /> : <EyeBase {...p} />

// — Elsewhere —

/**
 * GitHub's mark, drawn here rather than wrapped: Lucide dropped its brand
 * glyphs, and this is the one icon in the app that has to be recognisably
 * somebody else's logo rather than our vocabulary.
 *
 * It renders a pixel under the 16 its neighbours use. A solid silhouette puts
 * far more ink on the same box than a thin outline does, and matching the
 * boxes would leave this one shouting across the title bar. Equal ink, not
 * equal box, for the same reason `wrap()` pins the stroke instead of scaling it.
 */
export function GitHubIcon({ size = 15, ...rest }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden {...rest}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}
