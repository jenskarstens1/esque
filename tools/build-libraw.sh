#!/usr/bin/env bash
#
# Builds a multithreaded libraw-wasm into vendor/libraw-wasm.
#
# The published libraw-wasm package is single-threaded. Its build script passes
# `--enable-openmp` to LibRaw's configure but never puts `-fopenmp` in CFLAGS,
# so autoconf's AX_OPENMP probe fails, `_OPENMP` is never defined, and LibRaw
# compiles every `#pragma omp` out of existence. The result is a wasm module
# with no OpenMP symbols at all: one core demosaics a 40MP frame while the
# other thirteen idle.
#
# Emscripten only gained OpenMP support in 6.0.3 (July 2026, emscripten-core/
# emscripten#27073), which is why nobody had built this before. With it, the
# tile loops in AHD and three-pass Markesteijn — and the Fuji and Canon CR3
# unpackers — parallelise across every core.
#
# Usage:  tools/build-libraw.sh            (incremental; reuses the static libs)
#         FORCE_LIBS=1 tools/build-libraw.sh   (rebuild LCMS + LibRaw too)
#
# Requires: emsdk >= 6.0.3 on PATH (source emsdk_env.sh), autoconf, automake,
#           libtool, pkg-config.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${LIBRAW_BUILD_DIR:-$ROOT/.libraw-build}"
OUT="$ROOT/vendor/libraw-wasm"

LCMS_TAG=lcms2.19.1
LIBRAW_TAG=0.22.1
WRAPPER_TAG=v1.6.0

command -v emcc >/dev/null || { echo "emcc not on PATH; source emsdk_env.sh first" >&2; exit 1; }

EMVER=$(emcc --version | head -1 | sed -E 's/.* ([0-9]+\.[0-9]+\.[0-9]+).*/\1/')
if [ "$(printf '%s\n6.0.3\n' "$EMVER" | sort -V | head -1)" != "6.0.3" ]; then
  echo "Emscripten $EMVER is too old; OpenMP needs >= 6.0.3" >&2
  exit 1
fi
echo "==> Emscripten $EMVER"

# `-ffast-math` and `-msimd128` match the published build so decoded pixels stay
# comparable; `-flto` is dropped because it interacts badly with the OpenMP
# outlined regions. `-DLIBRAW_FORCE_OPENMP` skips libraw_types.h's platform
# allowlist, which has no Emscripten entry.
OPT="-O3 -ffast-math -msimd128 -DNDEBUG"
OMP="-fopenmp -pthread -DLIBRAW_FORCE_OPENMP"

mkdir -p "$WORK"
cd "$WORK"

if [ "${FORCE_LIBS:-0}" = "1" ] || [ ! -f libs/libraw.a ] || [ ! -f libs/liblcms2.a ]; then
  rm -rf libs includes lcms2 LibRawSource
  mkdir -p libs includes

  echo "==> Building Little-CMS $LCMS_TAG"
  git clone --branch "$LCMS_TAG" --depth 1 https://github.com/mm2/Little-CMS.git lcms2
  pushd lcms2 >/dev/null
  (command -v libtoolize >/dev/null && libtoolize) || glibtoolize
  autoreconf -fi
  emconfigure ./configure --host=wasm32-unknown-emscripten --disable-shared \
    CFLAGS="$OPT $OMP" CXXFLAGS="$OPT $OMP"
  emmake make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
  cp -R src/.libs/* ../libs/
  cp -R include/* ../includes/
  popd >/dev/null

  echo "==> Building LibRaw $LIBRAW_TAG with OpenMP"
  git clone --branch "$LIBRAW_TAG" --depth 1 https://github.com/LibRaw/LibRaw.git LibRawSource
  pushd LibRawSource >/dev/null
  (command -v libtoolize >/dev/null && libtoolize) || glibtoolize
  autoreconf -i
  # USE_JPEG/USE_JPEG8 are forced because LibRaw's configure probe links against
  # libjpeg, which under Emscripten only exists as a port; without them lossy DNG
  # and Kodak JPEG RAWs decode to nothing.
  emconfigure ./configure \
    --host=wasm32-unknown-emscripten \
    --enable-openmp --enable-lcms --enable-jpeg \
    --disable-shared --disable-examples \
    CFLAGS="$OPT $OMP -DUSE_LCMS2 -DUSE_JPEG -DUSE_JPEG8 -sUSE_LIBJPEG=1 -I../includes" \
    CXXFLAGS="$OPT $OMP -DUSE_LCMS2 -DUSE_JPEG -DUSE_JPEG8 -sUSE_LIBJPEG=1 -I../includes" \
    LDFLAGS="$OMP -sUSE_LIBJPEG=1 -L../libs/ -llcms2"
  emmake make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
  cp -R lib/.libs/* ../libs/
  cp -R libraw ../includes/
  popd >/dev/null
else
  echo "==> Reusing $WORK/libs (FORCE_LIBS=1 to rebuild)"
fi

# The OpenMP runtime is only linked in if something references it, and it is the
# proof that the static library really was built with `-fopenmp`.
NM="${EMSDK:-}/upstream/bin/llvm-nm"
[ -x "$NM" ] || NM="$(dirname "$(command -v emcc)")/../bin/llvm-nm"
# `grep -c` rather than `grep -q`: -q exits at the first match, and under
# `pipefail` the resulting SIGPIPE on llvm-nm fails the whole pipeline.
if ! "$NM" libs/libraw.a 2>/dev/null | grep -c "__kmpc_fork_call" >/dev/null; then
  echo "libraw.a has no OpenMP parallel regions — the -fopenmp build did not take" >&2
  exit 1
fi
echo "==> libraw.a contains OpenMP parallel regions"

echo "==> Fetching the embind wrapper ($WRAPPER_TAG)"
rm -rf wrapper && mkdir wrapper
curl -fsSL "https://raw.githubusercontent.com/ybouane/LibRaw-Wasm/$WRAPPER_TAG/libraw_wrapper.cpp" \
  -o wrapper/libraw_wrapper.cpp
for f in index.js worker.js index.d.ts build.js package.json; do
  curl -fsSL "https://raw.githubusercontent.com/ybouane/LibRaw-Wasm/$WRAPPER_TAG/$f" -o "wrapper/$f"
done

# Expose the OpenMP thread count. Every LibRaw instance lives in its own worker
# with its own thread pool, so the app has to divide the machine between them
# rather than let each one assume it owns every core.
python3 - "wrapper/libraw_wrapper.cpp" <<'PY'
import sys, re
path = sys.argv[1]
src = open(path).read()
src = src.replace(
    '#include "libraw/libraw.h"',
    '#include "libraw/libraw.h"\n#ifdef _OPENMP\n#include <omp.h>\n#endif',
    1,
)
helpers = '''
// Thread controls. `maxThreads` reports what the OpenMP runtime is willing to
// use; `setThreads` clamps it, so several decoder instances can share a machine
// without each one spawning a full-width team.
int libraw_max_threads() {
#ifdef _OPENMP
	return omp_get_max_threads();
#else
	return 1;
#endif
}

void libraw_set_threads(int n) {
#ifdef _OPENMP
	if (n > 0) omp_set_num_threads(n);
#else
	(void)n;
#endif
}

EMSCRIPTEN_BINDINGS(libraw_module) {'''
src = src.replace('EMSCRIPTEN_BINDINGS(libraw_module) {', helpers, 1)
src = src.replace(
    '\t\t.function("thumbnailData", &WASMLibRaw::thumbnailData);',
    '\t\t.function("thumbnailData", &WASMLibRaw::thumbnailData);\n'
    '\tfunction("maxThreads", &libraw_max_threads);\n'
    '\tfunction("setThreads", &libraw_set_threads);',
    1,
)
open(path, 'w').write(src)
PY

# Upstream's `gamm` binding requires exactly six elements, but its own type
# declares two and LibRaw only reads the first two — `gamm[2..5]` are scratch
# outputs of gamma_curve(). The practical effect is that `gamm: [1, 1]`, the
# documented way to ask for linear output, is silently discarded and the decode
# comes back with dcraw's default 0.45/4.5 transfer curve applied. Accept any
# length from two upwards.
python3 - "wrapper/libraw_wrapper.cpp" <<'PY'
import sys
path = sys.argv[1]
src = open(path).read()
old = '''			val arr = settings["gamm"];
			if (arr["length"].as<unsigned>() == 6) {
				for (int i = 0; i < 6; i++) {
					params.gamm[i] = arr[i].as<double>();
				}
			}'''
new = '''			val arr = settings["gamm"];
			unsigned len = arr["length"].as<unsigned>();
			if (len >= 2) {
				if (len > 6) len = 6;
				for (unsigned i = 0; i < len; i++) {
					params.gamm[i] = arr[i].as<double>();
				}
				for (unsigned i = len; i < 6; i++) {
					params.gamm[i] = 0.0;
				}
			}'''
assert old in src, 'gamm block not found'
open(path, 'w').write(src.replace(old, new, 1))
PY

# The thread controls are module-level embind functions, not methods on the
# LibRaw class, so the shipped wrapper — which only ever forwards to the
# instance — cannot reach them. Teach the plumbing about both.
python3 - "wrapper/worker.js" "wrapper/index.js" "wrapper/index.d.ts" <<'PY'
import sys
worker, index, types = sys.argv[1:4]

src = open(worker).read()
src = src.replace('let raw;', 'let raw;\nlet wasm;', 1)
src = src.replace(
    '\t\tconst module = await LibRawModule();',
    '\t\tconst module = await LibRawModule();\n\t\twasm = module;',
    1,
)
# Module-level exports (setThreads/maxThreads) are not on the instance.
src = src.replace(
    '\t\tconst out = raw[fn](...args);',
    '\t\tconst out = (typeof raw[fn] === "function" ? raw : wasm)[fn](...args);',
    1,
)
assert 'wasm = module' in src and 'typeof raw[fn]' in src, 'worker.js patch missed'
open(worker, 'w').write(src)

src = open(index).read()
src = src.replace(
    """    async thumbnailData() {
        return await this.runFn('thumbnailData');
    }
}""",
    """    async thumbnailData() {
        return await this.runFn('thumbnailData');
    }

	/**
	 * Largest OpenMP team this build will form, which Emscripten seeds from
	 * navigator.hardwareConcurrency. Returns 1 on a single-threaded build.
	 */
	async maxThreads() {
		return await this.runFn('maxThreads');
	}

	/**
	 * Caps the OpenMP team size for this instance. Several decoders share one
	 * machine, so each has to be told its share rather than assume all of it.
	 */
	async setThreads(n) {
		return await this.runFn('setThreads', n);
	}
}""",
    1,
)
assert 'maxThreads' in src, 'index.js patch missed'
open(index, 'w').write(src)

src = open(types).read()
src = src.replace(
    '  thumbnailData(): Promise<LibRawThumbnailData | undefined>;',
    '''  thumbnailData(): Promise<LibRawThumbnailData | undefined>;

  /**
   * Largest OpenMP team this build will form. 1 on a single-threaded build.
   */
  maxThreads(): Promise<number>;

  /**
   * Cap the OpenMP team size for this instance.
   */
  setThreads(n: number): Promise<void>;''',
    1,
)
assert 'maxThreads()' in src, 'index.d.ts patch missed'
open(types, 'w').write(src)
PY

cd wrapper

# PTHREAD_POOL_SIZE has to be pre-warmed: an OpenMP parallel region blocks the
# thread that opened it, so a team member created on demand would never get a
# chance to start. STRICT=0 keeps late spawns legal rather than fatal.
echo "==> Linking libraw.js"
emcc \
  --bind \
  -I../includes \
  -sUSE_LIBPNG=1 \
  -sUSE_LIBJPEG=1 \
  -sUSE_ZLIB=1 \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sDISABLE_EXCEPTION_CATCHING=0 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=64MB \
  -sMAXIMUM_MEMORY=4GB \
  -sPTHREAD_POOL_SIZE="Math.min(navigator.hardwareConcurrency||4,16)" \
  -sPTHREAD_POOL_SIZE_STRICT=0 \
  -sENVIRONMENT="web,worker" \
  $OPT $OMP \
  libraw_wrapper.cpp \
  ../libs/liblcms2.a \
  ../libs/libraw.a \
  -o libraw.js

# The final module is minified, so its symbol table is no help. The LLVM OpenMP
# runtime's own source paths survive in the data section, and they only get there
# if libomp was actually linked.
"$NM" libraw.wasm 2>/dev/null | grep -c "omp_get_max_threads" >/dev/null \
  || strings libraw.wasm | grep -c "lib/openmp/src/kmp_runtime.cpp" >/dev/null \
  || { echo "linked wasm does not contain the OpenMP runtime" >&2; exit 1; }
strings libraw.wasm | grep -c "^setThreads$" >/dev/null \
  || { echo "linked wasm is missing the setThreads binding" >&2; exit 1; }
echo "==> libraw.wasm links the OpenMP runtime"

echo "==> Bundling"
npm install --silent --no-audit --no-fund esbuild@^0.28.1
node build.js

mkdir -p "$OUT"
rm -rf "$OUT/dist"
cp -R dist "$OUT/dist"

cat > "$OUT/package.json" <<JSON
{
  "name": "libraw-wasm",
  "version": "1.6.0-omp",
  "description": "LibRaw compiled to WebAssembly with OpenMP enabled. Built by tools/build-libraw.sh.",
  "main": "dist/index.js",
  "type": "module",
  "types": "dist/index.d.ts",
  "license": "ISC"
}
JSON

echo
echo "==> Done. Artifacts in vendor/libraw-wasm/dist:"
ls -la "$OUT/dist"
