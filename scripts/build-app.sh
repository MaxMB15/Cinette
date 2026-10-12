#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

# Build and bundle the desktop app the way CI does. Updater artifacts are left
# out. Making them needs the updater signing key, and on macOS it races
# bundle_dmg.sh for the .app, so the release workflow makes them afterwards.
#
# On the GitHub-hosted macOS runners, bundle_dmg.sh now and then fails and a
# rerun passes. Of its hdiutil calls, only detach is retried, and hdiutil is
# known to fail there with "Resource busy". So a failed macOS build runs once
# more, with --verbose, which prints the bundler's output if it fails again.
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
  # bundle_dmg.sh writes its temporary image and the DMG next to the app, and
  # Tauri moves the DMG to bundle/dmg when it's done. A failed run can leave
  # either one behind, and hdiutil convert won't write over an existing DMG.
  rm -f "$ROOT"/target/release/bundle/macos/*.dmg
  build --verbose
fi
