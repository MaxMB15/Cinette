#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

# validate-release.sh checks that a release's download links work. It checks every
# URL in latest.json and the versionless installer names the README links to.
#
# Usage:
#   ./scripts/validate-release.sh              # checks the latest release
#   ./scripts/validate-release.sh v0.3.7       # checks a specific tag
#
# Exits 0 if every URL resolves (HTTP 200), non-zero otherwise. Releases from
# before the installers lost their version numbers fail the README checks.

set -euo pipefail

REPO="MaxMB15/MaxVideoPlayer"
TAG="${1:-latest}"

echo "=== Validating release: $TAG ==="

# Fetch latest.json
if [[ "$TAG" == "latest" ]]; then
  BASE_URL="https://github.com/$REPO/releases/latest/download"
else
  BASE_URL="https://github.com/$REPO/releases/download/$TAG"
fi
URL="$BASE_URL/latest.json"

echo "Fetching $URL"
LATEST_JSON=$(curl -sL -w "\n%{http_code}" "$URL")
HTTP_CODE=$(echo "$LATEST_JSON" | tail -1)
BODY=$(echo "$LATEST_JSON" | sed '$d')

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "FAIL: latest.json returned HTTP $HTTP_CODE"
  exit 1
fi

echo "latest.json fetched successfully"

# Parse version
VERSION=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])")
echo "Version: $VERSION"

# Extract all platform URLs and signatures
PLATFORMS=$(echo "$BODY" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for platform, info in data.get('platforms', {}).items():
    print(f\"{platform}|{info['url']}|{info.get('signature', '')}\")
")

if [[ -z "$PLATFORMS" ]]; then
  echo "FAIL: No platforms found in latest.json"
  exit 1
fi

FAILED=0

# Check that a URL resolves (HEAD request, follow redirects)
check_url() {
  local label="$1" url="$2" status
  status=$(curl -sI -o /dev/null -w "%{http_code}" -L "$url")
  if [[ "$status" == "200" ]]; then
    echo "  $label: OK (HTTP $status)"
  else
    echo "  $label: FAIL (HTTP $status) $url"
    FAILED=1
  fi
}

while IFS='|' read -r platform url signature; do
  echo ""
  echo "--- Platform: $platform ---"
  echo "  URL: $url"

  check_url "Download" "$url"
  check_url "Signature" "${url}.sig"

  # Verify the signature in latest.json is non-empty
  if [[ -z "$signature" ]]; then
    echo "  Signature field: FAIL (empty in latest.json)"
    FAILED=1
  else
    echo "  Signature field: OK (present)"
  fi

done <<< "$PLATFORMS"

# The packages the in-app updater downloads for .deb and .rpm installs
PACKAGES=$(echo "$BODY" | python3 -c "
import sys, json
for name, url in json.load(sys.stdin).get('packages', {}).items():
    print(f'{name}|{url}')
")

if [[ -n "$PACKAGES" ]]; then
  echo ""
  echo "--- Packages in latest.json ---"
  while IFS='|' read -r name url; do
    check_url "$name" "$url"
  done <<< "$PACKAGES"
fi

# The versionless installers the README's download links point at
echo ""
echo "--- README downloads ---"
for name in MaxVideoPlayer_aarch64.dmg MaxVideoPlayer_amd64.AppImage \
            MaxVideoPlayer_amd64.deb MaxVideoPlayer_x86_64.rpm; do
  check_url "$name" "$BASE_URL/$name"
done

echo ""
if [[ "$FAILED" -eq 0 ]]; then
  echo "=== ALL CHECKS PASSED ==="
  exit 0
else
  echo "=== SOME CHECKS FAILED ==="
  exit 1
fi
