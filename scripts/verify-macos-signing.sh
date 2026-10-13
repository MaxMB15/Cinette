#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

# Check that a Developer ID build will open on other Macs. Every binary and
# library in the app must be signed by the same team with a secure timestamp,
# and executables must use the hardened runtime. With --notarized, the app (and
# DMG, if given) must also carry a stapled ticket that Gatekeeper accepts.
#
# Usage: ./scripts/verify-macos-signing.sh [--notarized] <app> [dmg]

set -euo pipefail

# shellcheck source=SCRIPTDIR/lib/retry.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/retry.sh"

notarized=false
if [[ "${1:-}" == "--notarized" ]]; then
  notarized=true
  shift
fi
app="${1:?usage: $0 [--notarized] <app> [dmg]}"
dmg="${2:-}"

codesign --verify --deep --strict --verbose=2 "$app"

# codesign -d prints to stderr.
signature_of() {
  codesign -dv --verbose=4 "$1" 2>&1
}

team_of() {
  signature_of "$1" | sed -n 's/^TeamIdentifier=//p'
}

team=$(team_of "$app")
if [[ -z "$team" || "$team" == "not set" ]]; then
  echo "Error: $app is not signed with a Developer ID certificate" >&2
  exit 1
fi

problems=""
count=0
while IFS= read -r -d '' f; do
  kind=$(file -b "$f")
  [[ "$kind" == Mach-O* ]] || continue
  count=$((count + 1))
  signature=$(signature_of "$f")
  name=${f#"$app/"}
  file_team=$(sed -n 's/^TeamIdentifier=//p' <<< "$signature")
  if [[ "$file_team" != "$team" ]]; then
    problems+=$'\n'"  $name is signed by team '${file_team:-none}', not $team"
  fi
  if ! grep -q '^Timestamp=' <<< "$signature"; then
    problems+=$'\n'"  $name has no secure timestamp"
  fi
  if [[ "$kind" == *executable* ]] && ! grep -q '^CodeDirectory .*(runtime)' <<< "$signature"; then
    problems+=$'\n'"  $name does not use the hardened runtime"
  fi
done < <(find "$app/Contents" -type f -print0)

if [[ -n "$dmg" ]]; then
  codesign --verify --strict --verbose=2 "$dmg"
  dmg_team=$(team_of "$dmg")
  if [[ "$dmg_team" != "$team" ]]; then
    problems+=$'\n'"  $(basename "$dmg") is signed by team '${dmg_team:-none}', not $team"
  fi
fi

if [[ -n "$problems" ]]; then
  echo "Error: signing problems in $(basename "$app"):$problems" >&2
  exit 1
fi
echo "All $count binaries in $(basename "$app") are signed by team $team with a timestamp."

if $notarized; then
  # stapler validate looks the ticket up on Apple's server, so a dropped
  # connection fails it.
  retry 5 20 xcrun stapler validate "$app"
  spctl --assess --type execute --verbose=2 "$app"
  if [[ -n "$dmg" ]]; then
    retry 5 20 xcrun stapler validate "$dmg"
    spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
  fi
fi
