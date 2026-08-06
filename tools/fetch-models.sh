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
# The weights are not committed. Together they are close to 300 MB, which is
# not a reasonable thing to put in a git history for an app that will fetch
# them on demand anyway.
#
# Usage:  tools/fetch-models.sh              (small models only, ~180 MB)
#         tools/fetch-models.sh --all        (adds BiRefNet-lite, ~115 MB more)
#
# Licences, all redistributable and all compatible with esque's AGPL-3.0:
#   u2netp, u2net_human_seg   Apache-2.0   github.com/xuebinqin/U-2-Net
#   BiRefNet_lite             MIT          github.com/ZhengPeng7/BiRefNet
#
# RMBG-1.4 is deliberately absent. It is the best quality per byte of anything
# in this class, and its licence forbids commercial use — which esque cannot
# impose on people who receive the app under the AGPL.

set -euo pipefail

cd "$(dirname "$0")/.."
dest="public/models"
mkdir -p "$dest"

rembg="https://github.com/danielgatis/rembg/releases/download/v0.0.0"

fetch() {
  local name="$1" url="$2" out="$dest/$1.onnx"

  if [ -s "$out" ]; then
    echo "  $name — already present, skipping"
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
  mv "$out.part" "$out"
}

echo "Fetching segmentation models into $dest"

fetch u2netp "$rembg/u2netp.onnx"
fetch u2net-human "$rembg/u2net_human_seg.onnx"

if [ "${1:-}" = "--all" ]; then
  fetch birefnet-lite \
    "https://huggingface.co/onnx-community/BiRefNet_lite/resolve/main/onnx/model_fp16.onnx"
else
  echo "  birefnet-lite — skipped (pass --all to include it)"
fi

echo
echo "Done. Sizes:"
ls -lh "$dest" | tail -n +2 | awk '{printf "  %-28s %s\n", $9, $5}'
