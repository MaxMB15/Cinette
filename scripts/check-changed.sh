#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

# Runs the checks of the Changed code workflow on this computer. They are
# changed-line coverage for the frontend and for Rust, and mutation testing of
# the changed lines with StrykerJS and cargo-mutants. The change is the
# working tree, untracked files included, against the commit where it left
# origin/dev. "Changed code" in docs/development.md explains the checks.
#
# Usage: pnpm check:changed [--base REF] [--no-mutation] [--in-place]
#
#   --base REF     Compare with where the branch left REF, not origin/dev.
#   --no-mutation  Only check coverage.
#   --in-place     Run cargo-mutants in the working tree, not in a copy. The
#                  app's mutants need it, since its build reads files that
#                  git ignores. It only runs in a linked worktree whose .rs
#                  changes are all committed, since cargo-mutants edits the
#                  files one mutant at a time. A mutant can make the app's
#                  tests write movies/, recordings/ or series/ into
#                  apps/player/src-tauri, and the script removes the ones
#                  that weren't there when it started.
#
# The checks need Python 3.11 or later as python3. Rust coverage needs
# cargo-llvm-cov and rustup's llvm-tools component, and Rust mutation testing
# needs cargo-mutants when the change adds lines to .rs files. The Rust checks
# find libmpv in libs/<os>, or in MPV_LIB_DIR, which a worktree without libs/
# can point at the main checkout's.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

usage() {
  sed -n '/^# Usage:/,/^# *that weren.t there/s/^# \{0,1\}//p' "$0"
}

BASE_REF=origin/dev
MUTATION=true
IN_PLACE=false
while [ $# -gt 0 ]; do
  case "$1" in
    --base)
      [ $# -ge 2 ] || { usage >&2; exit 2; }
      BASE_REF="$2"
      shift 2
      ;;
    --no-mutation) MUTATION=false; shift ;;
    --in-place) IN_PLACE=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

# changed-code.py reads TOML with tomllib, which came in Python 3.11. macOS's
# own python3 is older.
if ! python3 -I -c 'import sys; sys.exit(sys.version_info < (3, 11))' > /dev/null 2>&1; then
  found="$(python3 --version 2> /dev/null || echo "no python3")"
  echo "The checks need Python 3.11 or later as python3, and this computer has $found." >&2
  echo "Install a newer Python and put it first on the PATH." >&2
  exit 1
fi

SRC_TAURI=apps/player/src-tauri
FIXTURE_DIRS="movies recordings series"
FIXTURES_BEFORE=" "
if [ "$IN_PLACE" = true ]; then
  # A linked worktree has its own git folder inside the main one's.
  if [ "$(git rev-parse --git-dir)" = "$(git rev-parse --git-common-dir)" ]; then
    echo "--in-place only runs in a linked worktree, not in the main checkout." >&2
    exit 1
  fi
  if [ -n "$(git status --porcelain --untracked-files=all -- '*.rs')" ]; then
    echo "--in-place needs every .rs change committed, since cargo-mutants edits the files." >&2
    exit 1
  fi
  for dir in $FIXTURE_DIRS; do
    # -e is false for a link to nothing, which cleanup would still delete.
    if [ -e "$SRC_TAURI/$dir" ] || [ -L "$SRC_TAURI/$dir" ]; then
      FIXTURES_BEFORE+="$dir "
    fi
  done
fi

BASE="$(git merge-base "$BASE_REF" HEAD)"
TMP="$(mktemp -d)"

# A mutant can make the app's tests write their fixture folders into
# src-tauri, where the tests run. This removes the ones the run made.
cleanup() {
  rm -rf "$TMP"
  if [ "$IN_PLACE" = true ]; then
    for dir in $FIXTURE_DIRS; do
      case "$FIXTURES_BEFORE" in
        *" $dir "*) ;;
        *) rm -rf "${SRC_TAURI:?}/$dir" ;;
      esac
    done
  fi
}
trap cleanup EXIT

check() {
  python3 -I scripts/changed-code.py "$@"
}

# Shows GitHub's annotations as "error: file:line: title. message".
readable() {
  python3 -I -c '
import re, sys
command = re.compile(r"::(error|warning|notice) ([^:]*)::(.*)")
def plain(text):
    for code, char in (("%0A", "\n"), ("%0D", ""), ("%3A", ":"), ("%2C", ","), ("%25", "%")):
        text = text.replace(code, char)
    return text
for line in sys.stdin:
    found = command.fullmatch(line.rstrip("\n"))
    if not found:
        sys.stdout.write(line)
        continue
    props = dict(p.split("=", 1) for p in found.group(2).split(",") if "=" in p)
    where = plain(props.get("file", ""))
    if where and "line" in props:
        where += ":" + props["line"]
    title = plain(props.get("title", ""))
    print(f"{found.group(1)}: " + (f"{where}: " if where else "") + f"{title}. {plain(found.group(3))}")
'
}

PASSED=()
FAILED=()
result() {
  if [ "$2" -eq 0 ]; then PASSED+=("$1"); else FAILED+=("$1"); fi
}

# A key's last value in a file of key=value lines, or nothing when the
# command that writes the file stopped before it.
value() {
  if [ -f "$2" ]; then
    sed -n "s/^$1=//p" "$2" | tail -n 1
  fi
}

case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux) OS=linux ;;
  *) OS="" ;;
esac
LIB_DIR="${MPV_LIB_DIR:-${OS:+$ROOT/libs/$OS}}"
if [ -n "$LIB_DIR" ] && [ -d "$LIB_DIR" ]; then
  export DYLD_LIBRARY_PATH="$LIB_DIR${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
  export LD_LIBRARY_PATH="$LIB_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
else
  LIB_DIR=""
fi

echo "Comparing the working tree with $(git rev-parse --short "$BASE"), where it left $BASE_REF."
plan_args=(plan --base "$BASE" --output "$TMP/plan")
if [ "$MUTATION" = true ]; then
  # The plan only runs cargo-mutants, and fails when it's missing, for a
  # change that adds lines to .rs files.
  plan_args+=(--shards "$TMP/rust.diff")
fi
check "${plan_args[@]}" | readable
FRONTEND="$(value frontend "$TMP/plan")"
RUST="$(value rust "$TMP/plan")"
STRYKER="$(value stryker "$TMP/plan")"
PACKAGES="$(value matrix "$TMP/plan" | python3 -I -c '
import json, sys
text = sys.stdin.read().strip()
for package in dict.fromkeys(e["package"] for e in (json.loads(text)["include"] if text else [])):
    print(package)
')"

# The app embeds the built frontend.
build_frontend() {
  if [ ! -d apps/player/dist ]; then
    pnpm run build:desktop
  fi
}

if [ "$FRONTEND" = true ]; then
  echo
  echo "Frontend changed-line coverage"
  code=0
  (cd apps/player && pnpm exec vitest run --coverage --coverage.reporter=lcovonly \
    --coverage.reportsDirectory="$TMP/frontend-coverage") || code=$?
  if [ "$code" -eq 0 ]; then
    check coverage --base "$BASE" --frontend-lcov "$TMP/frontend-coverage/lcov.info" \
      --title "Frontend changed-line coverage" | readable || code=$?
  fi
  result "Frontend coverage" "$code"
fi

if [ "$RUST" = true ]; then
  echo
  echo "Rust changed-line coverage"
  code=0
  components=""
  if command -v rustup > /dev/null; then
    components="$(rustup component list --installed 2>/dev/null || true)"
  fi
  if ! cargo llvm-cov --version > /dev/null 2>&1; then
    echo "cargo-llvm-cov isn't installed. Install it and rustup's llvm-tools component." >&2
    code=1
  elif [ -n "$components" ] && ! grep -q '^llvm-tools' <<< "$components"; then
    # cargo-llvm-cov would otherwise offer to install it.
    echo "Rust coverage needs rustup's llvm-tools component. Add it with rustup component add llvm-tools." >&2
    code=1
  else
    build_frontend
    cargo llvm-cov --locked --workspace --lcov --output-path "$TMP/rust.lcov" || code=$?
    if [ "$code" -eq 0 ]; then
      check coverage --base "$BASE" --rust-lcov "$TMP/rust.lcov" \
        --title "Rust changed-line coverage" | readable || code=$?
    fi
  fi
  result "Rust coverage" "$code"
fi

if [ "$MUTATION" = true ] && [ "$STRYKER" = true ]; then
  echo
  echo "Frontend mutation testing"
  code=0
  check stryker --base "$BASE" --output "$TMP/stryker" | readable || code=$?
  MUTATE="$(value mutate "$TMP/stryker")"
  LINES="$(value lines "$TMP/stryker")"
  FULL="$(value full "$TMP/stryker")"
  if [ "$code" -eq 0 ] && [ -n "$MUTATE" ]; then
    empty=(--allowEmpty)
    if [ "$FULL" = true ]; then
      empty=()
    fi
    rm -rf apps/player/reports/mutation
    (cd apps/player && pnpm exec stryker run --mutate "$MUTATE" ${empty[@]+"${empty[@]}"}) 2>&1 |
      tee "$TMP/stryker.log" || code=$?
    if [ "$code" -eq 0 ]; then
      no_mutants=()
      if grep -q -E 'Instrumented [1-9][0-9]* source file\(s\) with 0 mutant\(s\)' "$TMP/stryker.log"; then
        no_mutants=(--no-mutants)
      fi
      python3 -I scripts/stryker-summary.py --check --lines "$LINES" ${no_mutants[@]+"${no_mutants[@]}"} \
        --path-prefix apps/player/ apps/player/reports/mutation/mutation.json | readable || code=$?
    fi
  fi
  result "Frontend mutation testing" "$code"
fi

if [ "$MUTATION" = true ] && [ -n "$PACKAGES" ]; then
  outs=()
  code=0
  for package in $PACKAGES; do
    echo
    echo "Rust mutation testing in $package"
    out="$TMP/mutants-$package"
    args=(-p "$package" --in-diff "$TMP/rust.diff" --output "$out")
    if [ "$IN_PLACE" = true ]; then
      [ "$package" = max-video-player ] && build_frontend
      args+=(--in-place)
    elif [ "$package" = max-video-player ]; then
      echo "The app's mutants only run with --in-place, since its build reads files that git ignores." >&2
      code=1
      continue
    else
      # The copy leaves out what git ignores, libs/ too, so the plugin's
      # build reads libmpv's folder from MPV_LIB_DIR.
      args+=(--gitignore true)
    fi
    if [ -n "$LIB_DIR" ]; then
      export MPV_LIB_DIR="$LIB_DIR"
    fi
    run=0
    cargo mutants "${args[@]}" || run=$?
    if [ "$run" -ne 0 ] && [ "$run" -ne 2 ] && [ "$run" -ne 3 ]; then
      code=1
      continue
    fi
    outs+=("$out/mutants.out")
  done
  if [ ${#outs[@]} -gt 0 ]; then
    check mutants "${outs[@]}" | readable || code=1
  fi
  result "Rust mutation testing" "$code"
fi

echo
if [ ${#PASSED[@]} -eq 0 ] && [ ${#FAILED[@]} -eq 0 ]; then
  echo "The change has nothing for these checks to look at."
  exit 0
fi
for name in ${PASSED[@]+"${PASSED[@]}"}; do
  echo "Passed: $name"
done
for name in ${FAILED[@]+"${FAILED[@]}"}; do
  echo "Failed: $name"
done
[ ${#FAILED[@]} -eq 0 ]
