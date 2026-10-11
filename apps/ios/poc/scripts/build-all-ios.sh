#!/usr/bin/env bash
set -euo pipefail

# Convenience runner: builds ffmpeg + libplacebo + libass (+freetype/fribidi/harfbuzz) + libmpv
# for iOS (aarch64-apple-ios) in dependency order. Re-running reuses the cloned
# sources and skips libass and its dependencies once they're built, but it reruns
# ffmpeg's configure and make and rebuilds libplacebo and libmpv from scratch.
#
# Usage: ./scripts/build-all-ios.sh

HERE="$(cd "$(dirname "$0")" && pwd)"

"$HERE/build-ffmpeg-ios.sh"
"$HERE/build-libass-ios.sh"
"$HERE/build-libplacebo-ios.sh"
"$HERE/build-libmpv-ios.sh"

echo ""
echo "==> All iOS libs ready in libs/ios/"
