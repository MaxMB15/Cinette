#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

# Notarize a DMG with Apple and staple the ticket to it. Tauri notarizes the .app
# while bundling, but not the DMG it puts the app in.
#
# Usage: ./scripts/notarize-macos.sh <dmg>
# Needs the App Store Connect API key variables Tauri uses:
#   APPLE_API_KEY (key ID), APPLE_API_ISSUER, APPLE_API_KEY_PATH (.p8 file)

set -euo pipefail

# shellcheck source=lib/retry.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/retry.sh"

file="${1:?usage: $0 <dmg>}"
: "${APPLE_API_KEY:?}" "${APPLE_API_ISSUER:?}" "${APPLE_API_KEY_PATH:?}"
auth=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")

echo "Submitting $(basename "$file") for notarization..."
# notarytool exits non-zero for a rejected submission; read the status instead.
result=$(xcrun notarytool submit "$file" "${auth[@]}" --wait --timeout 1h --output-format json) || true
echo "$result"
status=$(jq -r '.status // empty' <<< "$result" 2>/dev/null || true)

if [[ "$status" != "Accepted" ]]; then
  id=$(jq -r '.id // empty' <<< "$result" 2>/dev/null || true)
  if [[ -n "$id" ]]; then
    # The log says which file failed and why.
    xcrun notarytool log "$id" "${auth[@]}" || true
  fi
  echo "Error: notarization of $(basename "$file") finished with status '${status:-unknown}'" >&2
  exit 1
fi

# Stapling downloads the ticket from Apple, so a dropped connection or a
# ticket that isn't published yet fails it.
if ! retry 5 20 xcrun stapler staple "$file"; then
  echo "Error: could not staple the notarization ticket to $(basename "$file")" >&2
  exit 1
fi
