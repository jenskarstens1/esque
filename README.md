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

## What it does

- **Import.** Every stills RAW format LibRaw can open (Canon, Nikon, Sony,
  Fujifilm, DNG and the rest), compiled to WebAssembly, plus JPEG, PNG, TIFF,
  WebP, AVIF and HEIC. Photos stay where they are on disk.
- **Library.** Folders, ratings, flags, colour labels and stacks, kept in
  IndexedDB with previews cached in OPFS.
- **Develop.** A WebGPU pipeline covering white balance, tone, curves, colour
  mixing and grading, detail, effects, lens, transform and crop, plus masking
  and retouching. Edits are non-destructive data, with history and presets, and
  they round-trip through Lightroom's XMP `crs:` namespace.
- **Detected masks.** Subject, background and people masks run a segmentation
  network in the browser, on WebGPU where it is available. Nothing is uploaded:
  the weights are fetched once, cached in OPFS, and everything after that works
  offline. What a mask produces is a coverage map feeding the ordinary mask
  stack, so it stays as editable as one you drew by hand.
- **Export.** JPEG, PNG, WebP, TIFF and DNG, with ICC profiles and metadata.

## Detected masks

The first detection downloads an ONNX Runtime WebAssembly build (5.7 MB
compressed) and the weights for the tier you picked. Both are cached — the
runtime by the browser, the weights in OPFS — so it is a one-time cost, and the
panel says what it will be before you commit to it. WebGPU is required; without
it the detected mask kinds are disabled and say why.

| Tier | Size | Licence | Notes |
| --- | --- | --- | --- |
| U²-Netp | 4.4 MB | Apache-2.0 | The default. 320px, well under a second on a GPU. |
| U²-Net human | 168 MB | Apache-2.0 | Used for People masks. |
| BiRefNet-lite | 109 MB | MIT | 1024px. Resolves hair and foliage; noticeably slower. |

Weights are fetched from GitHub and Hugging Face on demand and are not part of
the repository. To self-host them — for an air-gapped deployment, or to avoid
depending on someone else's uptime — run [`tools/fetch-models.sh`](tools/fetch-models.sh),
which downloads them into `public/models/`, where the app looks first.

RMBG-1.4 is a conspicuous omission. It is the best quality per byte in this
class, and its licence forbids commercial use, which is not a restriction esque
can pass on to people who receive it under the AGPL.

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
