#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

# Build and bundle the desktop app the way CI does. Updater artifacts are left
# out. Making them needs the updater signing key, and on macOS it races
# bundle_dmg.sh for the .app, so the release workflow makes them afterwards.
#
# On the GitHub-hosted macOS runners, bundle_dmg.sh now and then fails and a
# rerun passes. Its hdiutil create has no retry of its own, and hdiutil is
# known to fail there with "Resource busy". So a failed macOS build runs once
# more. The second run reuses the compiled app and passes --verbose, which
# prints the bundler's output if it fails again.
#
# Usage: ./scripts/build-app.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

build() {
  (cd "$ROOT/apps/desktop" && npx tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}' "$@")
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  build
  exit 0
fi

if ! build; then
  echo "::warning::The macOS build failed, so it runs once more."
  # A failed DMG step can leave its temporary image next to the DMG, where
  # the notarize and upload steps would pick it up.
  rm -rf "$ROOT/target/release/bundle/dmg"
  build --verbose
fi
