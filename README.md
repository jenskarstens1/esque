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

The build is static and can be hosted anywhere, as long as the host sends the
two headers in `public/_headers`. Without them the page is not cross-origin
isolated, `SharedArrayBuffer` is unavailable, and RAW decoding drops to a single
core.

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
- **Export.** JPEG, PNG, WebP, TIFF and DNG, with ICC profiles and metadata.

## Repository layout

```
src/catalog   photo database, import, previews
src/core      the edit model and colour maths
src/raw       RAW decoding workers
src/gpu       WebGPU renderer and WGSL shaders
src/develop   edit state, presets, XMP
src/export    encoders and the export pipeline
src/modules   the Library, Develop and Export UI
checks/       in-browser test harnesses
tools/        the LibRaw build script and headless drivers
```

## License

esque is licensed under the **GNU Affero General Public License v3.0**. See
[LICENSE](LICENSE). If you run a modified version as a network service, that
version's source has to be offered to its users.

Third-party components keep their own terms: LibRaw
([`vendor/libraw-wasm`](vendor/libraw-wasm), built by
[`tools/build-libraw.sh`](tools/build-libraw.sh)) is used under LGPL 2.1,
Little CMS under MIT, and the bundled Inter and JetBrains Mono fonts under
the SIL Open Font License 1.1.

Lightroom is a trademark of Adobe. esque is an independent project, neither
affiliated with nor endorsed by Adobe; the name appears here only to describe
what esque is for.
