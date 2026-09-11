#!/usr/bin/env bash
#
# Fetches the segmentation weights into public/models for self-hosting.
#
# Detection works without this: the model cache falls back to the upstream URL
# in src/ai/models.ts when a local copy is missing, and caches whatever it gets
# in OPFS. This script exists for the two cases where that is not good enough —
# deploying esque somewhere the browser cannot reach GitHub or Hugging Face,
# and not wanting a user's first mask to depend on someone else's uptime.
#
# The weights are not committed. The active models total about 130 MiB, which is
# not a reasonable thing to put in a git history for an app that will fetch
# them on demand anyway.
#
# Usage:  tools/fetch-models.sh              (MODNet + optimized BiRefNet-lite)
#         tools/fetch-models.sh --all        (also includes legacy artifacts)
#
# Active weights: MODNet Apache-2.0 (code/models/demos); BiRefNet-lite MIT.
# Legacy U2Net human has Apache-2.0 code, but separately documented checkpoint
# terms have not been independently verified. See README before redistributing.

set -euo pipefail

if [ "$#" -gt 1 ] || { [ -n "${1:-}" ] && [ "$1" != "--all" ]; }; then
  echo "Usage: tools/fetch-models.sh [--all]" >&2
  exit 2
fi

cd "$(dirname "$0")/.."
dest="public/models"
mkdir -p "$dest"

rembg="https://github.com/danielgatis/rembg/releases/download/v0.0.0"

checksum() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

fetch() {
  local name="$1" url="$2" expected="$3" out="$dest/$1.onnx"

  if [ -s "$out" ] && [ "$(checksum "$out")" = "$expected" ]; then
    echo "  $name - checksum verified, skipping"
    return
  fi

  echo "  $name — downloading"
  # Two-step so a failed transfer never leaves a truncated file behind that
  # the next run would then treat as a completed download.
  if ! curl -fL --progress-bar -o "$out.part" "$url"; then
    rm -f "$out.part"
    echo "  $name — FAILED" >&2
    return 1
  fi
  if [ "$(checksum "$out.part")" != "$expected" ]; then
    rm -f "$out.part"
    echo "  $name - SHA-256 mismatch" >&2
    return 1
  fi
  mv "$out.part" "$out"
}

echo "Fetching segmentation models into $dest"

fetch modnet \
  "https://huggingface.co/Xenova/modnet/resolve/fa2fa546052fba4c08921230a26cc69a333fca12/onnx/model_fp16.onnx" \
  "25f165da9bfd30830a575f1f0490f1acd995975cb349bc02f3d79332e1fe5cf6"
fetch birefnet-lite-webgpu \
  "https://huggingface.co/runes/birefnet-lite-webgpu/resolve/d553b221039609f1ab170e3c2e651b59f363c98a/birefnet_lite_webgpu_fp16.onnx" \
  "348c075771a9f6631d6ac991a1ac613d33910390cf943afa752f3a73c36fca03"

if [ "${1:-}" = "--all" ]; then
  fetch u2netp "$rembg/u2netp.onnx" \
    "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8"
  fetch u2net-human "$rembg/u2net_human_seg.onnx" \
    "01eb6a29a5c4d8edb30b56adad9bb3a2a0535338e480724a213e0acfd2d1c73c"
  fetch birefnet-lite \
    "https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/de15b22ba131738a16dff04aab8bdf8dc32e3ac1/onnx/model_fp16.onnx" \
    "d39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402"
else
  echo "  Legacy models skipped (pass --all to include them)"
fi

echo
echo "Done. Sizes:"
ls -lh "$dest" | tail -n +2 | awk '{printf "  %-28s %s\n", $9, $5}'
