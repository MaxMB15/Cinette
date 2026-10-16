#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

# Checks a built macOS app on the machine that built it, as the Build & Bundle
# workflow does on its Apple Silicon and Intel runners. It fails when:
#
# - a binary in the app has no code for this Mac's CPU
# - a binary links a library from Homebrew, MacPorts or /usr/local by its full
#   path, which a user's Mac won't have
# - the app quits within SMOKE_SECONDS of starting, 20 by default
# - the running app loaded libmpv from anywhere but its own Frameworks folder,
#   or loaded any library from Homebrew, MacPorts or /usr/local
#
# The CI runners have Homebrew, and the Intel one has MacPorts too, so an app
# that only works with them installed would pass a launch on its own.
# The app starts with no saved playlists, so it plays nothing. It opens a
# window and checks for an update, as it does on any start.
#
# Usage: ./scripts/smoke-test-macos-app.sh path/to/MaxVideoPlayer.app

set -euo pipefail

APP="${1:?Usage: $0 path/to/App.app}"
# lsof reports real paths, so resolve any symbolic links on the way.
APP="$(cd "$APP" && pwd -P)"
SECONDS_TO_RUN="${SMOKE_SECONDS:-20}"
ARCH="$(uname -m)"
# Package manager folders that a shipped app must not use.
OUTSIDE='^(/opt/homebrew|/opt/local|/usr/local)/'

failed=0
fail() {
  echo "Error: $*" >&2
  failed=1
}

machos=()
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -q '^Mach-O'; then
    machos+=("$f")
  fi
done < <(find "$APP/Contents" -type f -print0)
if (( ${#machos[@]} == 0 )); then
  echo "Error: found no binaries in $APP" >&2
  exit 1
fi
echo "Checking ${#machos[@]} binaries in $(basename "$APP") for $ARCH"

for f in "${machos[@]}"; do
  rel="${f#"$APP"/}"
  archs="$(lipo -archs "$f")"
  if [[ " $archs " != *" $ARCH "* ]]; then
    fail "$rel is built for $archs, not $ARCH"
  fi
  # The first line names the file, and fat files name each slice too.
  while IFS= read -r lib; do
    fail "$rel links $lib"
  done < <(otool -L "$f" | awk '/^\t/ { print $1 }' | grep -E "$OUTSIDE" || true)
done
if (( failed )); then
  exit 1
fi

EXE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
LOG="$(mktemp)"
echo "Starting $EXE for $SECONDS_TO_RUN seconds"
# A library path left in the environment could hide a missing library.
env -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH -u DYLD_FRAMEWORK_PATH \
  "$APP/Contents/MacOS/$EXE" > "$LOG" 2>&1 &
pid=$!
stop_app() {
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}
trap stop_app EXIT

for (( i = 0; i < SECONDS_TO_RUN; i++ )); do
  if ! kill -0 "$pid" 2>/dev/null; then
    status=0
    wait "$pid" || status=$?
    trap - EXIT
    echo "Error: the app quit after about $i seconds with status $status. Its output:" >&2
    cat "$LOG" >&2
    exit 1
  fi
  /bin/sleep 1
done

# lsof lists each library the app mapped. The system's own come from the
# shared cache, so they don't show up by name.
loaded="$(lsof -n -P -p "$pid" -Fn | sed -n 's/^n//p' | grep '\.dylib$' | sort -u || true)"
libmpv="$(grep '/libmpv[^/]*\.dylib$' <<< "$loaded" || true)"
if [[ -z "$libmpv" ]]; then
  fail "the running app hasn't loaded libmpv"
fi
while IFS= read -r lib; do
  [[ -n "$lib" ]] || continue
  if [[ "$lib" != "$APP/Contents/Frameworks/"* ]]; then
    fail "the app loaded libmpv from $lib"
  fi
done <<< "$libmpv"
while IFS= read -r lib; do
  [[ -n "$lib" ]] || continue
  fail "the app loaded $lib"
done < <(grep -E "$OUTSIDE" <<< "$loaded" || true)

echo "Libraries the app loaded by name:"
while IFS= read -r lib; do
  echo "  $lib"
done <<< "$loaded"
if (( failed )); then
  echo "The app's output:" >&2
  cat "$LOG" >&2
  exit 1
fi
echo "The app ran for $SECONDS_TO_RUN seconds with only its own libraries."
