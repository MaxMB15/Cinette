#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAURI_CONF="$REPO_ROOT/apps/desktop/src-tauri/tauri.conf.json"
CARGO_TOML="$REPO_ROOT/apps/desktop/src-tauri/Cargo.toml"
IOS_PROJECT="$REPO_ROOT/apps/desktop/src-tauri/gen/apple/project.yml"
IOS_PLIST="$REPO_ROOT/apps/desktop/src-tauri/gen/apple/max-video-player_iOS/Info.plist"
# The files the version bump changes. The release commit holds these and no others.
BUMPED=("$TAURI_CONF" "$CARGO_TOML" "$IOS_PROJECT" "$IOS_PLIST" "$REPO_ROOT/Cargo.lock")

# ── Git-flow branch guard ─────────────────────────────────────────────────────
cd "$REPO_ROOT"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo ""
  echo "  ERROR: release.sh must be run from the 'main' branch."
  echo "  You are on: $CURRENT_BRANCH"
  echo ""
  echo "  Git-flow release process:"
  echo "    1. Merge dev → main via PR"
  echo "    2. git checkout main && git pull origin main"
  echo "    3. Run this script"
  echo ""
  exit 1
fi

# Ensure main is up-to-date with origin
echo ""
echo "  Fetching origin/main…"
git fetch origin main --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [[ "$LOCAL" != "$REMOTE" ]]; then
  echo ""
  echo "  ERROR: local main is not up-to-date with origin/main."
  echo "  Run: git pull origin main"
  echo ""
  exit 1
fi

# The release commit takes these files whole, so a local edit to one would go
# in with it. Builds and XcodeGen often rewrite the iOS ones.
if ! git diff --quiet HEAD -- "${BUMPED[@]}"; then
  echo ""
  echo "  ERROR: these files have local changes that the release commit would include:"
  git diff --name-only HEAD -- "${BUMPED[@]}" | sed 's/^/    /'
  echo "  Commit or undo them first."
  echo ""
  exit 1
fi
# Other local edits stay out of the release. Remember them so the check after
# the bump can tell them apart from files the bump changed.
DIRTY_BEFORE=$(git diff --name-only)

# ── Read current version from tauri.conf.json ────────────────────────────────
CURRENT=$(python3 -c "import json,sys; print(json.load(open('$TAURI_CONF'))['version'])")
MAJOR=$(echo "$CURRENT" | cut -d. -f1)
MINOR=$(echo "$CURRENT" | cut -d. -f2)
PATCH=$(echo "$CURRENT" | cut -d. -f3)

echo ""
echo "  Max Video Player Release Script"
echo "  ─────────────────────────────"
echo "  Current version: $CURRENT"
echo ""
echo "  Select release type:"
echo "    1) Patch  ($MAJOR.$MINOR.$((PATCH + 1)))"
echo "    2) Minor  ($MAJOR.$((MINOR + 1)).0)"
echo "    3) Major  ($((MAJOR + 1)).0.0)"
echo ""
read -rp "  Choice [1/2/3]: " CHOICE

case "$CHOICE" in
  1) NEW="$MAJOR.$MINOR.$((PATCH + 1))" ;;
  2) NEW="$MAJOR.$((MINOR + 1)).0" ;;
  3) NEW="$((MAJOR + 1)).0.0" ;;
  *) echo "Invalid choice. Aborting."; exit 1 ;;
esac

echo ""
echo "  Bumping $CURRENT → $NEW"
echo ""
read -rp "  Confirm? [y/N]: " CONFIRM
case "$CONFIRM" in
  [yY]) ;;
  *) echo "Aborted."; exit 0 ;;
esac

# ── Bump the version in Tauri, Cargo and the iOS project ─────────────────────
python3 "$REPO_ROOT/scripts/bump-version.py" "$NEW"

# ── Update the app's own entry in Cargo.lock, leaving dependencies as they are ─
( cd "$REPO_ROOT" && cargo update --workspace )
echo "  Updated Cargo.lock"

# ── Commit ───────────────────────────────────────────────────────────────────
cd "$REPO_ROOT"
git add "${BUMPED[@]}"
# Stop if the bump changed a file that BUMPED leaves out.
# comm must compare in the same order sort used, whatever the user's locale.
LEFT_OUT=$(LC_ALL=C comm -13 <(printf '%s\n' "$DIRTY_BEFORE" | LC_ALL=C sort) \
                             <(git diff --name-only | LC_ALL=C sort))
if [[ -n "$LEFT_OUT" ]]; then
  echo ""
  echo "  ERROR: the version bump changed files that aren't staged:"
  printf '%s\n' "$LEFT_OUT" | sed 's/^/    /'
  # The check before the prompts showed these files matched HEAD.
  git checkout HEAD -- "${BUMPED[@]}"
  # The others had no unstaged changes before the bump, so the index still
  # holds them. Putting them back makes a re-run stop here again.
  printf '%s\n' "$LEFT_OUT" | git --literal-pathspecs restore --pathspec-from-file=-
  echo "  Nothing was committed, and every file the bump changed is back as it was."
  echo ""
  exit 1
fi
# Naming the files keeps anything else that was already staged out of the commit.
git commit -m "chore: bump version to $NEW" -- "${BUMPED[@]}"
echo "  Committed version bump"

# ── Tag ──────────────────────────────────────────────────────────────────────
git tag "v$NEW"
echo "  Created tag v$NEW"

# ── Push main + tag (triggers release workflow) ───────────────────────────────
echo ""
read -rp "  Push main and tag to origin now? [y/N]: " PUSH
case "$PUSH" in
  [yY])
    git push origin main
    git push origin "v$NEW"
    echo ""
    echo "  ✓ Release workflow triggered for v$NEW."
    echo "  Watch progress at: https://github.com/MaxMB15/MaxVideoPlayer/actions"
    echo "  Draft release will appear at: https://github.com/MaxMB15/MaxVideoPlayer/releases"
    ;;
  *)
    echo ""
    echo "  Not pushed. When ready, run:"
    echo "    git push origin main && git push origin v$NEW"
    echo ""
    exit 0
    ;;
esac

# ── Merge version bump back to dev (git-flow requirement) ────────────────────
echo ""
echo "  Git-flow requires the version bump to be reflected in dev."
read -rp "  Merge main → dev now? [y/N]: " MERGE_DEV
case "$MERGE_DEV" in
  [yY])
    git checkout dev
    git pull origin dev --quiet
    git merge --no-ff main -m "chore: merge main into dev after v$NEW release"
    git push origin dev
    git checkout main
    echo ""
    echo "  ✓ Version bump merged back to dev."
    ;;
  *)
    echo ""
    echo "  Skipped. Remember to merge main → dev manually:"
    echo "    git checkout dev && git pull origin dev"
    echo "    git merge --no-ff main -m 'chore: merge main into dev after v$NEW release'"
    echo "    git push origin dev"
    ;;
esac

echo ""
