![](docs/logo.svg)

# esque

An open-source, web-based Lightroom alternative.

![Top: the Develop module editing a Fujifilm RAW file, with the preset library and history on the left and white balance, tone and presence controls on the right. Bottom: the Library module, a folder of RAW and JPEG pairs in the grid with the histogram, quick actions and capture metadata alongside.](docs/screenshots.jpg)

> **Early days.** esque is under active development and things still move around
> between commits. Proper documentation is **coming soon**, covering the edit
> model, the render pipeline, presets, masking, and export.

## Requirements

- A Chromium browser (Chrome or Edge). Importing uses the File System Access
  API and rendering uses WebGPU.
- Node.js 20 or newer for development.

## Getting started

```sh
npm install
npm run dev
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server, with the headers LibRaw's decode threads need |
| `npm run build` | Type-check, then build to `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run lint` | oxlint |

## Search and sharing

The public site is [esque.dev](https://esque.dev/). Search descriptions, the
canonical URL, Open Graph / Twitter cards and `WebSite` / `WebApplication`
structured data are in `index.html`, so crawlers do not need to run the editor
to read them. The initial HTML also provides a readable product summary and
browser requirements; React replaces it when the editor starts.

`public/robots.txt` points to `public/sitemap.xml`, which lists the one public
page. Catalogs and individual photos are local browser data, not public pages.
The social preview is a 1200 × 630 JPEG cropped from the Develop screenshot in
`docs/screenshots.jpg`. Keep its dimensions and alt text in sync with the
metadata when replacing it.

For a public deployment on a different domain, update the absolute URLs in
`index.html`, `public/robots.txt` and `public/sitemap.xml` together. Preserve the
cross-origin isolation headers in `vercel.json` or `public/_headers`; RAW
decoding needs them.

With `npm run preview` running after a build, run
`node tools/seocheck.mjs http://localhost:4173/`. It covers static metadata,
crawl-discovery files, the share image, the no-JavaScript page and editor
startup. An optional second argument sets the expected canonical URL for a
self-hosted deployment.

## What it does

- **Import.** Every stills RAW format LibRaw can open (Canon, Nikon, Sony,
  Fujifilm, DNG and the rest), compiled to WebAssembly, plus JPEG, PNG, TIFF,
  WebP, AVIF and HEIC. Pick folders and files, or drop them anywhere in the
  window — a drop mixing folders and loose files imports as one job. Photos stay
  where they are on disk.
- **Library.** Folders, ratings, flags, colour labels and stacks, kept in
  IndexedDB with previews cached in OPFS.
- **Develop.** A WebGPU pipeline covering white balance, tone, curves, colour
  mixing and grading, detail, effects, lens, transform and crop, plus masking
  and retouching. Edits are stored as data rather than pixels, so every step is
  reversible, with history and presets, and they round-trip through Lightroom's
  XMP `crs:` namespace.
- **Detected masks.** Subject, background and people masks run a segmentation
  network in the browser, on WebGPU where it is available. Nothing is uploaded:
  the weights are fetched once, cached in OPFS, and everything after that works
  offline. What a mask produces is a coverage map feeding the ordinary mask
  stack, so it stays as editable as one you drew by hand.
- **Export.** JPEG, PNG, WebP, TIFF and DNG, with ICC profiles and metadata.
- **Catalog backup.** Download a portable local catalog and merge it back without
  replacing existing photos or edits, then explicitly reconnect the originals.

### Sharpening defaults

New photos use the Standard profile with sharpening off (Amount **0**) for RAW
and rendered files at every ISO. Reset All, Reset Detail and double-clicking the
Sharpen Amount control return to zero. RAW noise reduction retains its
ISO-calibrated defaults; rendered files still start with noise reduction off.
Saved edits and explicit sharpening in presets or sidecars are preserved, not
migrated to zero. A chosen import preset can still enable sharpening.

With the dev server running, `/checks/sharpeningcheck.html` covers defaults,
resets, imports, saved edits and Auto without needing WebGPU.

### HDR preview

The **HDR** toolbar button and **H** shortcut toggle HDR for the selected photos,
without changing the global default. Develop applies the photo's dynamic-range
limit to its live canvas as well as its loading preview. Enabling HDR restores
the fixed two-stop headroom, including when an older version saved zero headroom.
Visible HDR requires highlight information above SDR white and a compatible
browser and HDR display; it does not simply brighten every SDR image.

With the dev server running, `/checks/hdrcheck.html` exercises the real toolbar,
shortcut and viewport, including per-photo overrides, legacy headroom and GPU
readback of above-white pixels. It needs WebGPU; it checks the output pipeline,
not a physical display's brightness.

### Adjustment performance

Live previews reuse the full-quality, scene-linear result of highlight recovery,
white balance, calibration, noise reduction, sharpening and defringing when those
inputs are unchanged. Exposure, tone, colour, crop and layer adjustments do not
repeat that capture work. Changing an upstream setting or loading another source
invalidates the cache. It holds at most one additional RGBA16F image for the live
pane; static compare panes and offscreen exports do not allocate another capture
cache. Noise reduction also skips the sampling kernel for any disabled channel.

With the dev server running, `/checks/adjustmentcheck.html` checks cache
invalidation, exact 16-bit agreement with uncached rendering, compare views and
source replacement, then measures cached versus uncached slider updates. Add
`?edge=6000` for a 24 MP workload (default: 2560-pixel long edge). The check needs
WebGPU. `/checks/presetpanelcheck.html` also guards against re-rendering the preset
library during slider updates and checks that hover/apply use the latest edits.

## Badges

Status badges, comparison captions, tool readouts, thumbnail markers and library
tags share the compact `Badge` components in `src/design/Badge.tsx`. They use
small rectangular corners, optional icons and divided metadata instead of pill
shapes or dot separators. Image markers keep a dark surface for contrast;
overlay and inline badges follow the app's appearance.

## Built-in photo presets

The 16 photo looks are adapted from actual, publicly available Lightroom
presets, with original curves and reduced tone, colour and grain intensities
for esque's renderer. They are starting points, **not measured film
simulations or Lightroom-equivalent renderings**. Camera profiles such as
Standard and Neutral are separate and remain unchanged.

Choosing a look replaces its creative settings: basic tone/presence, colour
or B&W treatment, all tone curves, colour mixing/grading, grain and vignette.
This makes switching from one look to another predictable instead of mixing
leftover settings. **Exposure, white balance, camera profile/calibration,
highlight recovery, sharpening, noise reduction, crop, lens corrections and
local edits are preserved.** The sparse **Tools** presets still stack; apply
grain or vignette tools after choosing a look. Saved edits are not rewritten;
the new recipes take effect when you apply them.

### Sources and tuning

All references below are pinned to the inspected revisions and published
under MIT. Copyright and permission notices ship in
[`public/preset-licenses.txt`](public/preset-licenses.txt), also available at
`/preset-licenses.txt` in the built app.

| esque looks | Public reference | Main adaptation |
| --- | --- | --- |
| Soft Portrait, Portrait Rich | [Questtion: Preset 10](https://github.com/Questtion/Lightroom-Presets/blob/10e36149ab94e41a702946075ae30195c23af77e/Presets/Preset%2010.xmp) | Retain quiet oranges and a small blue-shadow lift; replace strong scene corrections with separate soft/rich curves and fine grain. |
| Pastel Daylight, Cross Process | [9bic: mecabify](https://github.com/9bic/lrpresets/blob/4151c0b69ba3325b055cb6926d24a40711f3855f/mecabify.xmp) | Replace extreme contrast compression and orange saturation with a restrained cool pastel look; Cross Process is an original rose/cyan channel-curve variation. |
| Golden Print, Golden Hour | [Questtion: Golden_Days](https://github.com/Questtion/Lightroom-Presets/blob/10e36149ab94e41a702946075ae30195c23af77e/Presets/Golden_Days.xmp) | Keep the blue-shadow reduction and gold highlight direction, soften the curves, remove fixed WB and competing black/contrast adjustments. Print adds grain; Hour stays clean. |
| Fine Colour, Landscape | [9bic: 9bichrome](https://github.com/9bic/lrpresets/blob/4151c0b69ba3325b055cb6926d24a40711f3855f/9bichrome.xmp) | Reduce orange saturation and replace extreme parametric corrections with original point curves. Landscape omits toning/grain and adds modest texture. |
| Teal & Orange | [Questtion: Basketball OR/CY](https://github.com/Questtion/Lightroom-Presets/blob/10e36149ab94e41a702946075ae30195c23af77e/Presets/Basketball%201%20%2B1.00%20OR_CY.xmp) | Cyan-shadow/orange-midtone split, with grading reduced from 41/40 to 9/4, no gym-light WB or exposure correction, and a gentler original curve. |
| Night Lights | [karaage: NightFactory](https://github.com/karaage0703/lightroom-presets/blob/33985312c6d5e46cdcb686d5dc21b56e5139f531/NightFactory.lrtemplate) | Retain selective green/aqua suppression; reduce clarity from 40 to 3 and omit fixed 3900 K WB, tint and the camera-profile dependency. |
| Olive Cinema | [Questtion: Preset 4](https://github.com/Questtion/Lightroom-Presets/blob/10e36149ab94e41a702946075ae30195c23af77e/Presets/Preset%204.xmp) | Reduce cyan/gold grading and yellow hue rotation, shift foliage toward olive, and keep highlights bright. |
| Reportage, Silver Print, Soft Monochrome | [Questtion: BW 3](https://github.com/Questtion/Lightroom-Presets/blob/10e36149ab94e41a702946075ae30195c23af77e/Presets/BW%203%20%2B0.00.xmp) | Three original print curves using the real B&W treatment and channel mixer. Silver/Soft retain lighter blues; Reportage reverses the blue bias for darker skies. Grain and paper toning are original additions. |
| Editorial Clean | [Questtion: Preset 8](https://github.com/Questtion/Lightroom-Presets/blob/10e36149ab94e41a702946075ae30195c23af77e/Presets/Preset%208.xmp) | Keep a mild open-shadow curve, ease white compression and remove scene-specific corrections. No colour grading or grain. |
| Portrait | [Questtion: Preset 1](https://github.com/Questtion/Lightroom-Presets/blob/10e36149ab94e41a702946075ae30195c23af77e/Presets/Preset%201.xmp) | Retain restrained warm colours and low microcontrast, without the source's dark midtones or strongly lowered white endpoint. |

With the dev server running, `node tools/headless.mjs /checks/presetcheck.html`
covers field preservation, all look-to-look switches and XMP round-trips.
`node tools/headless.mjs /checks/presetlookcheck.html` needs WebGPU and renders
RAW/rendered grey ramps, colour patches and a portrait contact sheet, checking
tonal ordering, brightness, clipping, B&W mixing and look separation. Pass
`?fixture=/raw-fixtures/fuji-xt5.raf` for a real RAW contact sheet.

## Catalog backup and restore

Open **Settings → Files → Catalog backup**. **Save backup…** first waits for
pending Develop edits to be saved, then takes a consistent snapshot of the
catalog. The downloadable `.esque.json` file is versioned (currently version 1),
stays on your device, and is never uploaded. Keep it somewhere separate from
your browser profile, alongside a separate backup of your original photos.

The backup includes:

- Photo identities, relative paths, file sizes/dates, camera metadata, ratings,
  flags, colour labels, keywords, titles and captions.
- Complete saved Develop settings, including curves, crops, drawn masks,
  detected-mask settings and retouching.
- Virtual copies and their independent edits, master relationships and stacks.
- Regular and smart collections, their membership/rules and collection set IDs.
  The current catalog stores set identities on collections; there is no separate
  collection-set table or additional set metadata.
- Named snapshots and user **Develop** presets, including field-level scopes.
  Built-in presets are already supplied by esque.

**Not included:** original image bytes, filesystem handles or permissions,
preview/proxy caches, detected-mask coverage pixels, downloaded AI models,
session-only undo history, interface preferences, or export presets/settings.
The database's settings table currently holds the export destination handle,
which is deliberately not portable. XMP sidecars are useful for exchanging
photo settings, but **they are not a complete catalog backup**.

### Merge, never replace

Choose **Restore backup…**, review the contents, and select **Merge into catalog**.
The entire JSON document is checked before any restoration writes: format and
version, record and nested edit shapes, finite/bounded numbers, identities,
safe relative paths and all catalog references. Invalid archives change nothing.
Files larger than 64 MB or with more than 100,000 records per table are rejected
to bound the memory needed to validate untrusted JSON. A supported archive is merged in **one atomic IndexedDB
transaction**; a database failure rolls back all of its additions.

Existing record IDs always win, including their metadata, edits, membership and
handles. An original already catalogued at the same full folder-ID/relative-path
is not duplicated; references can be mapped to its existing ID only when its
filename, file size, modification date and RAW/rendered identity also match. No basename
search is used. Conflicting folder identities cannot silently reconnect new
photos to an unrelated existing handle. Existing preset group/name pairs are
also preserved. A collection with any unresolved member is skipped whole rather
than silently restored with missing members. Snapshots and virtual copies with
unresolved source identities are skipped and reported.

The result lists added/skipped records and conflicts, with a downloadable full
merge report. Re-importing the same backup adds nothing twice. Conflicts are
included in the skipped counts; differing records are never silently replaced.
Import, export and mask-detection jobs must finish before using these controls.

### Reconnect the originals

Restored folder/file permissions cannot travel between browsers or machines.
Use **Reconnect originals…** in the same Settings section; unconnected sources
remain listed there after closing or reloading the app. After a merge adds
unconnected photos, this guide opens automatically; you can close it and return
later without losing the restored edits.

1. For a folder, select its original root. esque checks **every exact stored
   relative path, filename, byte size and modification date**, then asks you to
   confirm. The root's displayed name can differ after a disk/folder move.
2. If some paths are missing or changed, no folder connection is saved. Choose
   the correct root, or select each available original individually instead.
   Loose imports—including originals with duplicate display filenames—are
   reconnected individually to the selected catalog record.
3. Confirm the proposed connection. Only missing source handles are added;
   existing connections and all metadata/edits are retained. A file or catalog
   identity changing during review aborts the connection. Signature checks are
   safeguards, **not cryptographic content verification**: choose the unchanged
   original you backed up.

Chrome or Edge is required to retain native file access. Individually connected
originals can be edited and exported; neighbouring XMP writes still require a
folder-root connection. Already connected folders that have lost permission use
**Reconnect** in the Library folder menu instead—backup restore never replaces
their handles.

Previews rebuild from the originals. Reopen an already displayed photo in
Develop if needed. When an edit already references available locally saved
coverage, Develop loads it automatically without downloading a model. Export
also loads referenced coverage in its own worker and refuses active, non-neutral
masks whose coverage is unavailable instead of silently omitting them.

Detected-mask geometry, blend/inversion, adjustments, model tier and any hints
are preserved, but coverage pixels and machine-local cache references are not.
**The restored appearance is
incomplete until coverage is loaded or generated.** Settings keeps a count of
current photo components without loaded coverage, including after reconnecting
the originals. A component may simply be waiting for the automatic load when
its photo opens; this count does not necessarily mean re-detection is needed.
Portable restored components have their cache references cleared, so select
those components in **Develop → Masking** and use **Detect** (or **Detect People**)
with the recorded model tier. Detect first reuses an available local result,
otherwise runs the selected model against the reconnected photo. Model weights
may need downloading if absent; backup, restore and loading saved coverage do
not themselves download models. Merely having a cache key is not considered
recovery; a failed detection still needs attention. Re-detection can vary, so
inspect its coverage before relying on the restored look.

Drawn-mask brush dabs, gradients, ranges and retouch source/target geometry are
ordinary edit data and round-trip without regeneration. Portable restored
snapshots and presets containing detected components require the same coverage
recovery after they are applied. This build
rejects archives containing Sky/Object detections instead of silently dropping
their unavailable coverage; those kinds have no supported regeneration path.

The focused regression harness is `checks/catalogcheck.html`. It uses separate,
uniquely named test databases with the actual catalog schema, synthetic local
files/native handles, and cleans up afterward without clearing the app catalog.
Append `?ui` to leave the Settings interface open for visual inspection after
the checks finish.

## Detected masks

Manage local models in **Settings > AI models**. Downloads are blocked by
default. Each model shows its size, licence and download sources; enable
**Allow downloads** for that model, then choose **Download** or run detection
in Develop. Permission applies only to that model artifact, not other models
or replacement weights. Photos stay on your device.
Downloads and cached weights are checked against the model's SHA-256 checksum;
MODNet and both BiRefNet artifacts are pinned to immutable upstream revisions.

You can cancel a download, revoke permission, or delete a model. Deleting also
revokes its permission and releases its inference session after any current
run finishes; saved masks and edits are preserved. Existing downloaded models
can still run without download permission. If browser storage is cleared, an
approved model can be downloaded again; revoke permission to prevent this.
Settings' **Clear previews** keeps models and saved mask coverage.
Automatic size- and age-based cleanup also protects both: saved masks are part
of edits, not disposable previews. Protected files can keep total storage above
the configured cache limit. Browser/site-data deletion can still remove them.

Detection also loads an ONNX Runtime WebAssembly build (about 5.7 MB compressed)
from this site. The browser caches the runtime, and model weights use the local
binary cache (OPFS, with IndexedDB fallback). Browser eviction or clearing site
data can require downloading again. WebGPU is required to enable the controls;
if an adapter or model session cannot use it, inference falls back to WASM.

| Model | Size | Licence | Notes |
| --- | --- | --- | --- |
| [MODNet](https://huggingface.co/Xenova/modnet) | 12 MB | Apache-2.0 | Default for People. Portrait alpha, including soft edges; replaces the 168 MB U²-Net human model. |
| [BiRefNet-lite, WebGPU export](https://huggingface.co/runes/birefnet-lite-webgpu) | 118 MB | MIT | Default for Subject/Background. 1024px segmentation, replacing U²-Netp's 320px output. Larger download and more computation. |
| U²-Netp (legacy) | 4.4 MB | Apache-2.0 | Available for existing masks only. |
| U²-Net human (legacy) | 168 MB | Apache-2.0 | Available for existing masks only; licensing caveat below. |
| Original BiRefNet-lite export (legacy) | 109 MB | MIT | Saved coverage remains usable. This export can exceed WebGPU binding limits or WASM memory during detection. |

The replacement BiRefNet artifact keeps the lite model's weights, but uses bounded
graph operations and offline constant folding to avoid the old export's oversized
Concat/Split nodes and CPU-only memory bottlenecks. It is **not**
BiRefNet_lite-matting: that newer checkpoint still needs a verified browser export.
MODNet is designed for prominent people and portraits, not every small person
in a crowded scene. These are task-specific upgrades, not universal quality guarantees.

For U²-Net human, Apache-2.0 is the upstream code licence; separate
checkpoint-specific terms have not been independently verified. Its training
labels also limit hair-level accuracy.

Weights are fetched from GitHub and Hugging Face on demand and are not part of
the repository. To self-host them — for an air-gapped deployment, or to avoid
depending on someone else's uptime — run [`tools/fetch-models.sh`](tools/fetch-models.sh),
which downloads and verifies the two active artifacts into `public/models/`,
where the app looks first. Add `--all` to include legacy models.
Same-origin model transfers still require the user's per-model permission.

RMBG-1.4 is not included: its weight licence restricts commercial use. Model
code and weight licences must both permit our intended distribution and use.

MODNet uses aspect-aware resizing (512px short edge, capped at 1024px long edge,
dimensions divisible by 32) and RGB normalization to `[-1,1]`. Its alpha is used
directly, not contrast-stretched or passed through sigmoid. New People masks
start with Refine at zero to preserve soft edges. Rectangular predictions are
resampled into the existing normalized-coordinate square coverage format.

BiRefNet retains square/ImageNet preprocessing and a single sigmoid on logits;
legacy U²-Net retains its original saliency recipe. Existing saved masks, their
model identities and refinement values are not migrated or rerun automatically.
New artifacts have separate model IDs, coverage keys and download permissions:
consent for a legacy artifact never authorizes its replacement. Legacy downloads
remain manageable in Settings without deleting saved masks.

Selecting another model leaves the current coverage and refinement active.
**Replace Mask** applies the new model, coverage and default refinement together
only after detection and storage succeed; custom refinement is preserved.
Failures keep the old result editable, and late completions cannot change a
different photo or a mask that has since changed.

Repeat detections reuse the resident compiled model without rereading, hashing
or transferring its weights. Residency checks, model switches and deletion are
serialized; queued photos are copied only when their turn starts. Stopping the
worker settles pending requests so detection can be retried.

The consent, download lifecycle and Settings checks are in
`checks/aimodelcheck.html` (append `?ui` to inspect the pane). They use isolated
storage and synthetic responses, without downloading models. The real inference
check is `checks/segcheck.html?download`; its explicit `download` flag permits
the legacy Fast model transfer for that diagnostic. To exercise both replacement
models on a real public-domain NASA portrait, install the optional fixture:

```sh
mkdir -p public/raw-fixtures
curl -fL https://raw.githubusercontent.com/scikit-image/scikit-image/v0.19.3/skimage/data/astronaut.png \
  -o public/raw-fixtures/ai-astronaut.png
node tools/headless.mjs 'http://localhost:5173/checks/segcheck.html?model=modnet&download'
node tools/headless.mjs 'http://localhost:5173/checks/segcheck.html?model=birefnet-lite-webgpu&download'
```

These checks cover square, portrait and landscape crops, face/background separation,
continuous edge alpha, and offline reuse of installed weights. They are smoke
checks, not a representative image-quality benchmark.

## Repository layout

```
src/catalog   photo database, import, previews
src/core      the edit model and colour maths
src/raw       RAW decoding workers
src/gpu       WebGPU renderer and WGSL shaders
src/ai        segmentation models, inference worker, coverage cache
src/develop   edit state, presets, XMP
src/export    encoders and the export pipeline
src/modules   the Library, Develop and Export UI
checks/       in-browser test harnesses
tools/        the LibRaw build script, model fetcher and headless drivers
```

## License

esque is licensed under the **GNU Affero General Public License v3.0**. See
[LICENSE](LICENSE). If you run a modified version as a network service, that
version's source has to be offered to its users.

Third-party components keep their own terms: LibRaw
([`vendor/libraw-wasm`](vendor/libraw-wasm), built by
[`tools/build-libraw.sh`](tools/build-libraw.sh)) is used under LGPL 2.1,
Little CMS under MIT, ONNX Runtime under MIT, the U-2-Net weights under
Apache-2.0, the BiRefNet weights under MIT, and the bundled Inter and
JetBrains Mono fonts under the SIL Open Font License 1.1.

Lightroom is a trademark of Adobe. esque is an independent project, neither
affiliated with nor endorsed by Adobe; the name appears here only to describe
what esque is for.
