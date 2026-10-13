#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

"""
Bump the app version in:
  - apps/desktop/src-tauri/tauri.conf.json
  - apps/desktop/src-tauri/Cargo.toml (the [package] version line)
  - apps/desktop/src-tauri/gen/apple/project.yml (CFBundleShortVersionString
    and CFBundleVersion)
  - apps/desktop/src-tauri/gen/apple/max-video-player_iOS/Info.plist (the same
    two keys)

A Tauri iOS build writes the version from tauri.conf.json into Info.plist, and
running XcodeGen writes the one from project.yml. Keeping both checked-in files
in step means neither leaves a diff behind.

The About section in Settings reads the version at runtime, so it needs no edit.

Each version field has to be found exactly once. If one isn't, the script
changes no file and exits with an error, so a release can't skip one.

Usage:
  python3 scripts/bump-version.py NEW_VERSION

Example:
  python3 scripts/bump-version.py 0.4.0
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import NamedTuple, NoReturn

ROOT = Path(__file__).resolve().parent.parent
SRC_TAURI = ROOT / "apps/desktop/src-tauri"
APPLE = SRC_TAURI / "gen/apple"

SEMVER_RE = re.compile(r"\d+\.\d+\.\d+")


class Field(NamedTuple):
    """One version field. `pattern` captures the text before the value as `pre`."""

    name: str
    pattern: re.Pattern[str]
    template: str


def yaml_value(key: str, template: str) -> Field:
    """A `key: value` line in project.yml, with or without quotes around the value."""
    return Field(
        key,
        re.compile(rf'^(?P<pre>[ \t]+{key}:[ \t]*)(?:"[^"\n]*"|[^\s#]+)', re.MULTILINE),
        template,
    )


def plist_string(key: str) -> Field:
    """The `<string>` that follows `<key>key</key>` in Info.plist."""
    return Field(
        key,
        re.compile(rf"(?P<pre><key>{key}</key>\s*<string>)[^<]*(?=</string>)"),
        "{version}",
    )


FILES: dict[Path, list[Field]] = {
    SRC_TAURI / "tauri.conf.json": [
        # Only the top-level key, which sits one tab in.
        Field(
            "version",
            re.compile(r'^(?P<pre>\t"version"\s*:\s*)"[^"]*"', re.MULTILINE),
            '"{version}"',
        ),
    ],
    SRC_TAURI / "Cargo.toml": [
        # [package] comes first, and the later tables only use inline versions.
        Field(
            "version",
            re.compile(r'^(?P<pre>version\s*=\s*)"[^"]*"', re.MULTILINE),
            '"{version}"',
        ),
    ],
    # The same forms as the project.yml that `tauri ios init` writes.
    APPLE / "project.yml": [
        yaml_value("CFBundleShortVersionString", "{version}"),
        yaml_value("CFBundleVersion", '"{version}"'),
    ],
    APPLE / "max-video-player_iOS/Info.plist": [
        plist_string("CFBundleShortVersionString"),
        plist_string("CFBundleVersion"),
    ],
}


def fail(message: str) -> NoReturn:
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def bump(new: str) -> None:
    if not SEMVER_RE.fullmatch(new):
        fail("version must be semver X.Y.Z (e.g. 0.4.0)")

    # Check every file before writing any of them.
    updated: dict[Path, str] = {}
    for path, fields in FILES.items():
        text = path.read_text(encoding="utf-8")
        for field in fields:
            value = field.template.format(version=new)
            text, count = field.pattern.subn(lambda m: m["pre"] + value, text)
            if count != 1:
                fail(
                    f"expected one {field.name} in {path.relative_to(ROOT)}, "
                    f"found {count}. Nothing was changed."
                )
        updated[path] = text

    for path, text in updated.items():
        path.write_text(text, encoding="utf-8")
        print(f"  Updated {path.relative_to(ROOT)}")


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: bump-version.py NEW_VERSION", file=sys.stderr)
        sys.exit(1)
    bump(sys.argv[1])


if __name__ == "__main__":
    main()
