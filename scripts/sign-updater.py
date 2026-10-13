#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

"""
Sign an updater archive with the Tauri CLI, which writes <archive>.sig.

The key comes from TAURI_SIGNING_PRIVATE_KEY and the optional password from
TAURI_SIGNING_PRIVATE_KEY_PASSWORD. The secret may hold the minisign key as
plain text, with real or escaped newlines, or base64-encoded once or twice.
`tauri signer sign` only accepts it base64-encoded once, so this script
converts it and passes it to the CLI in the environment. The key never goes
into GITHUB_ENV, a shell variable or a command line.

Run: python3 scripts/sign-updater.py <archive>
Given --check in place of an archive, it only checks that the key can be read.
"""

from __future__ import annotations

import base64
import binascii
import os
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

APP_DIR = Path(__file__).resolve().parent.parent / "apps" / "player"
KEY_MARKER = "untrusted comment:"


def fail(message: str) -> NoReturn:
    print(f"::error::{message}")
    sys.exit(1)


def decode_base64(text: str) -> str | None:
    try:
        return base64.b64decode(text.strip(), validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        return None


def plain_key(secret: str) -> str:
    """Return the minisign key as plain text, whichever form the secret is in."""
    key = secret.replace("\\n", "\n")
    # Plain text, or base64-encoded once or twice.
    for _ in range(3):
        if KEY_MARKER in key:
            return key.rstrip("\n")
        decoded = decode_base64(key)
        if decoded is None:
            break
        key = decoded
    fail("TAURI_SIGNING_PRIVATE_KEY is not a minisign private key.")


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: sign-updater.py <archive> | --check")

    secret = os.environ.get("TAURI_SIGNING_PRIVATE_KEY", "")
    if not secret.strip():
        fail("TAURI_SIGNING_PRIVATE_KEY is not set.")
    key = plain_key(secret)
    if sys.argv[1] == "--check":
        print("The updater signing key is a minisign private key.")
        return

    archive = Path(sys.argv[1]).resolve()
    if not archive.is_file():
        fail(f"{archive} does not exist.")
    env = dict(os.environ)
    env["TAURI_SIGNING_PRIVATE_KEY"] = base64.b64encode(key.encode()).decode()
    result = subprocess.run(
        ["pnpm", "tauri", "signer", "sign", str(archive)], cwd=APP_DIR, env=env
    )
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
