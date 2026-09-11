/**
 * The release notes, newest first.
 *
 * This file is the app's version of record: `APP_VERSION` reads off the top of
 * the list rather than being declared twice, so a release cannot ship notes for
 * a number it doesn't claim. `package.json` carries the same number for the
 * build, and nothing else should hold a copy.
 *
 * A note is written for someone who uses the app, not for someone who reads the
 * diff: it names the thing that changed in the words the interface uses for it,
 * and says what it now does. Entries carry a `term` so a release can be scanned
 * down its left edge for the one line that matters to the reader.
 */

/** Why an entry is here. Sorted in `KIND_ORDER` when a release is grouped. */
export type ChangeKind = 'added' | 'improved' | 'fixed'

export interface Change {
  kind: ChangeKind
  /** The feature this line is about, set as the lead-in. */
  term: string
  text: string
}

export interface Release {
  /** Semver, and the string the app shows for itself. */
  version: string
  /** ISO date, formatted for display where it is shown. */
  date: string
  /** One sentence naming what the release is for, above its entries. */
  summary: string
  changes: Change[]
}

export const KIND_LABELS: Record<ChangeKind, string> = {
  added: 'New',
  improved: 'Better',
  fixed: 'Fixed',
}

/**
 * New before better before fixed: what arrived is the reason to read a release,
 * and what was repaired is the reason to stop.
 */
export const KIND_ORDER: ChangeKind[] = ['added', 'improved', 'fixed']

export const RELEASES: Release[] = [
  {
    version: '0.4.0',
    date: '2026-09-11',
    summary:
      'A shared layer system for local edits, more predictable photo looks, and a quieter, more consistent editing interface.',
    changes: [
      {
        kind: 'added',
        term: 'Local edit layers',
        text: 'Drawn and detected masks now share a layer system. Existing masks are converted when opened, keeping their shapes and adjustments; layers are carried through previews, exports, presets and sidecars.',
      },
      {
        kind: 'improved',
        term: 'Masking',
        text: 'Detection starts automatically once its model is permitted, and download permission can be granted directly in the masking panel. Masks and their components are easier to manage, with adjustments grouped into collapsible sections.',
      },
      {
        kind: 'improved',
        term: 'Photo looks',
        text: 'Sixteen built-in looks have been retuned from credited public recipes. Switching looks replaces the previous colour, curves, grain and vignette instead of mixing leftovers. Exposure, white balance, camera corrections and local edits stay yours; Tools presets still stack.',
      },
      {
        kind: 'improved',
        term: 'White balance',
        text: 'The temperature slider now gives useful lighting ranges more room instead of squeezing them into one end of the track. Temperature and tint ramps mark each photo\'s as-shot balance, while typed values and keyboard steps stay in their original units.',
      },
      {
        kind: 'improved',
        term: 'Editing controls',
        text: 'Dropdowns and grouped controls use the same sentence-case captions as sliders. Tab selections slide quickly into place, with reduced-motion preferences respected.',
      },
      {
        kind: 'improved',
        term: 'Badges',
        text: 'Comparison captions, tool readouts, thumbnail markers and library tags share compact rectangular badges. Icons and divided metadata replace pill shapes and dot separators, while image markers keep their contrast over the photo.',
      },
      {
        kind: 'improved',
        term: 'Context menus',
        text: 'Menus are narrower with tighter pointer spacing, inset highlights and better-aligned submenus. Touch targets keep their larger spacing.',
      },
      {
        kind: 'improved',
        term: 'AI model settings',
        text: 'Settings shows current models with shorter permission and storage explanations. Legacy models remain available to existing saved detections without crowding the list.',
      },
      {
        kind: 'fixed',
        term: 'Switching modules',
        text: 'Moving between Library and Develop no longer briefly shows an incorrectly cropped or empty photo while the view measures itself and reloads catalog data. Returning to Library restores the layout you left.',
      },
      {
        kind: 'fixed',
        term: 'Notifications',
        text: 'Toasts use a solid surface and no longer scale their corners into halos or flicker. Routine saving stays quiet; failed saves still show the error and a retry action.',
      },
    ],
  },
  {
    version: '0.3.0',
    date: '2026-09-06',
    summary:
      'The RAW pipeline is put back on the light a photograph was actually taken in, and the surfaces you make decisions on stop borrowing their tone from the picture behind them.',
    changes: [
      {
        kind: 'improved',
        term: 'RAW rendering',
        text: 'RAW files now arrive as scene-linear light. They were being decoded onto a display curve and then rendered through a second one, which lifted the deepest shadows by about a stop and a third and flattened everything above them. Exposure, white balance and every tone control now act on the light the sensor measured, so a stop is a stop. Photographs will look different: contrast that was being washed out is back, and shadows sit where they were photographed rather than raised.',
      },
      {
        kind: 'improved',
        term: 'Edits you have already made',
        text: 'Nothing has been rewritten. Earlier edits are kept exactly as they were and re-rendered on the corrected pipeline, so a few will want a second look — the shift is largest in the shadows and almost nothing in the highlights, which is also why no automatic correction was applied: there is no single exposure that would put them all back.',
      },
      {
        kind: 'improved',
        term: 'Dialogs',
        text: 'Settings, export and the rest are drawn on a solid surface. A panel you have to read and decide on should not take its colour from whichever frame happens to be behind it, or change contrast when you move to the next photo.',
      },
      {
        kind: 'improved',
        term: 'Colour profiles',
        text: 'JPEG, PNG and TIFF files are converted through all three of an ICC profile\u2019s tone curves instead of the red one applied to every channel. Files whose profile treats the channels differently no longer open with a cast.',
      },
      {
        kind: 'fixed',
        term: 'Copying edits',
        text: 'Pasting settings across a selection could race the sidecar writer and leave a half-written .xmp beside a file. Sidecar writes now wait for the paste to finish.',
      },
      {
        kind: 'fixed',
        term: 'Previews',
        text: 'A thumbnail could go on showing a previous edit after a reset or a paste, when a slower render finished last and published over a newer one.',
      },
      {
        kind: 'fixed',
        term: 'Compare',
        text: 'Showing two frames with different crops side by side could pull a texture out from under the renderer mid-frame and take the view down.',
      },
      {
        kind: 'fixed',
        term: 'White balance dropper',
        text: 'The patch was read after the mask overlay had been drawn, so sampling with a mask on screen measured the overlay tint rather than the photograph.',
      },
      {
        kind: 'fixed',
        term: 'Local adjustments',
        text: 'Tint inside a mask moved the opposite way to the tint outside one. Masks saved before this release are corrected as they are opened.',
      },
      {
        kind: 'fixed',
        term: 'Lens corrections',
        text: 'The profile corrections checkbox did nothing and has been taken out. Any setting already in a file is still read and written back, so nothing is lost round-tripping through Lightroom.',
      },
    ],
  },
  {
    version: '0.2.0',
    date: '2026-08-06',
    summary: 'The app learns to be looked at: on a phone, in a bright room, and by someone who has never opened it before.',
    changes: [
      {
        kind: 'added',
        term: 'Appearance',
        text: 'Dark, dim or light chrome, an accent colour, four text sizes and the tone the photograph sits on. Dark is still what the app opens on, because a near-black surround is what a photograph should be judged against.',
      },
      {
        kind: 'added',
        term: 'Phones and tablets',
        text: 'Below the desktop width the side panels stop taking room from the photo and float over it as sheets and drawers, reached from a bar at the bottom edge. Press and hold stands in for a right click.',
      },
      {
        kind: 'added',
        term: 'Keyboard',
        text: 'Every shortcut in one searchable reference in Settings, grouped the way the app is. Any of them can be rebound from the same row — press the chip, press the keys.',
      },
      {
        kind: 'added',
        term: 'White balance dropper',
        text: 'Click a surface that ought to be neutral and the temperature and tint are measured off that patch, rather than assumed about the frame as a whole.',
      },
      {
        kind: 'added',
        term: 'Location',
        text: 'A frame carrying GPS shows where it was taken, on a map in the info panel.',
      },
      {
        kind: 'added',
        term: 'Import defaults',
        text: 'A preset, an auto tone or a full-size preview can be waiting for everything that lands in the catalogue. All of it is off unless asked for, and it runs after the grid has filled rather than in front of it.',
      },
      {
        kind: 'added',
        term: 'Release notes',
        text: "A welcome on a first run, and this list on an update. Reachable any time from Help.",
      },
      {
        kind: 'improved',
        term: 'Sidecars',
        text: 'Edits, ratings and labels are written back to the .xmp beside the file as they are made, coalesced behind a quiet period so a slider drag lands as one write rather than a hundred.',
      },
      {
        kind: 'improved',
        term: 'Detected masks',
        text: 'Choose the model behind a subject, sky, background, people or object selection. Weights are downloaded once with real progress, cached, and run from there on.',
      },
    ],
  },
  {
    version: '0.1.0',
    date: '2026-08-05',
    summary: 'The first public preview: import, library, develop and export, end to end.',
    changes: [
      {
        kind: 'added',
        term: 'Import',
        text: 'Every stills RAW format LibRaw can open, decoded by WebAssembly, alongside JPEG, PNG, TIFF, WebP, AVIF and HEIC. Photos stay in the folder you point at.',
      },
      {
        kind: 'added',
        term: 'Library',
        text: 'Folders, collections and smart collections, with ratings, flags, colour labels and stacks, a filter bar, and grid, loupe, compare and survey views.',
      },
      {
        kind: 'added',
        term: 'Develop',
        text: 'A WebGPU pipeline covering white balance, tone, curves, colour mixing and grading, detail, effects, lens corrections, transform and crop.',
      },
      {
        kind: 'added',
        term: 'Masking',
        text: 'Linear and radial gradients, a brush, colour and luminance ranges, and subject, sky, background, people and object selections, plus spot removal and red eye.',
      },
      {
        kind: 'added',
        term: 'Presets and history',
        text: 'Every edit is data, so each step is reversible and any state can be kept as a preset and applied to a whole shoot.',
      },
      {
        kind: 'added',
        term: 'Lightroom sidecars',
        text: 'Ratings, keywords and develop settings round-trip through the crs namespace in XMP, read on import and written back out.',
      },
      {
        kind: 'added',
        term: 'Export',
        text: 'JPEG, PNG, WebP, TIFF and DNG, with ICC profiles and metadata carried through.',
      },
      {
        kind: 'added',
        term: 'HDR preview',
        text: 'Highlights climb into whatever headroom the display reports, with soft proofing against sRGB, Display P3, Adobe RGB, ProPhoto and Rec. 2020.',
      },
    ],
  },
]

/** The version the app is running, taken from the newest release. */
export const APP_VERSION = RELEASES[0].version

/*
 * esque is AGPL-3.0, which asks a network-served build to offer its source to
 * the people using it. The URL sits here with the version because it is the
 * same kind of fact, and because a module with no imports of its own can be
 * read by the title bar and by the dialogs without anything looping back.
 */
export const REPO_URL = 'https://github.com/jenskarstens1/esque'

/** Groups a release's entries by kind, dropping the kinds it has none of. */
export function groupChanges(release: Release): Array<[ChangeKind, Change[]]> {
  return KIND_ORDER.map(
    (kind) => [kind, release.changes.filter((c) => c.kind === kind)] as [ChangeKind, Change[]],
  ).filter(([, changes]) => changes.length > 0)
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

export const formatReleaseDate = (iso: string) => DATE_FORMAT.format(new Date(`${iso}T00:00:00`))
