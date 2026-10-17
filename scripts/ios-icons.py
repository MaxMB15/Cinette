#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

"""
Removes the alpha channel from the iOS app icons and copies them to
apps/player/src-tauri/icons/ios.

`pnpm tauri icon` writes the iOS icons into the Xcode project's
AppIcon.appiconset with an alpha channel, and App Store Connect rejects a
1024 px icon that has one. Run this after `pnpm tauri icon`:

    python3 -I scripts/ios-icons.py

It stops without writing anything if a pixel isn't fully opaque. It deletes
any PNG in icons/ios that the Xcode set doesn't have, so the two folders hold
the same icons. It needs only Python's standard library.
"""

import struct
import sys
import zlib
from pathlib import Path

TAURI = Path(__file__).resolve().parent.parent / "apps" / "player" / "src-tauri"
XCODE = TAURI / "gen" / "apple" / "Assets.xcassets" / "AppIcon.appiconset"
IOS = TAURI / "icons" / "ios"

SIGNATURE = b"\x89PNG\r\n\x1a\n"
RGB = 2
RGBA = 6


def chunks(data):
    """Yields each chunk's type and body, up to and including IEND."""
    pos = len(SIGNATURE)
    while pos < len(data):
        length = int.from_bytes(data[pos : pos + 4], "big")
        if pos + 12 + length > len(data):
            raise ValueError("it's cut off")
        kind = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        (crc,) = struct.unpack(">I", data[pos + 8 + length : pos + 12 + length])
        if crc != zlib.crc32(kind + body) & 0xFFFFFFFF:
            raise ValueError(f"the {kind.decode('latin-1')} chunk has a bad CRC")
        yield kind, body
        if kind == b"IEND":
            return
        pos += 12 + length
    raise ValueError("there's no IEND chunk")


def chunk(kind, body):
    crc = zlib.crc32(kind + body) & 0xFFFFFFFF
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", crc)


def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def unfilter(raw, width, height, bpp):
    """Returns the rows of a non-interlaced image with the PNG filters undone."""
    stride = width * bpp
    if len(raw) != height * (1 + stride):
        raise ValueError("the image data is the wrong size")
    prev = bytearray(stride)
    rows = []
    pos = 0
    for _ in range(height):
        kind = raw[pos]
        line = bytearray(raw[pos + 1 : pos + 1 + stride])
        pos += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if kind == 1:
                line[x] = (line[x] + a) & 0xFF
            elif kind == 2:
                line[x] = (line[x] + b) & 0xFF
            elif kind == 3:
                line[x] = (line[x] + ((a + b) >> 1)) & 0xFF
            elif kind == 4:
                line[x] = (line[x] + paeth(a, b, c)) & 0xFF
            elif kind != 0:
                raise ValueError(f"unknown filter type {kind}")
        rows.append(line)
        prev = line
    return rows


def flatten(data):
    """Returns the PNG as 8-bit RGB, or None if it's already 8-bit RGB."""
    if data[: len(SIGNATURE)] != SIGNATURE:
        raise ValueError("it isn't a PNG")
    header = None
    idat = b""
    transparency = False
    for kind, body in chunks(data):
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat += body
        elif kind == b"tRNS":
            transparency = True
    if header is None:
        raise ValueError("there's no IHDR chunk")
    width, height, depth, color, _, _, interlace = header
    if depth == 8 and color == RGB and interlace == 0 and not transparency:
        return None
    if depth != 8 or color != RGBA or interlace != 0:
        raise ValueError(
            f"it's depth {depth}, color type {color}, interlace {interlace}"
            f"{' with a tRNS chunk' if transparency else ''}; "
            "expected 8-bit RGB or RGBA without interlacing"
        )
    out = bytearray()
    for y, line in enumerate(unfilter(zlib.decompress(idat), width, height, 4)):
        if min(line[3::4]) != 255:
            raise ValueError(f"a pixel in row {y} isn't fully opaque")
        rgb = bytearray(width * 3)
        rgb[0::3] = line[0::4]
        rgb[1::3] = line[1::4]
        rgb[2::3] = line[2::4]
        out += b"\x00" + rgb
    return (
        SIGNATURE
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, RGB, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(out), 9))
        + chunk(b"IEND", b"")
    )


def main():
    icons = sorted(XCODE.glob("*.png"))
    if not icons:
        sys.exit(f"no icons in {XCODE}")
    if not IOS.is_dir():
        sys.exit(f"{IOS} doesn't exist")
    # Check every icon before writing any, so a bad one leaves both folders as
    # they were.
    flat = {}
    for path in icons:
        data = path.read_bytes()
        try:
            flat[path.name] = flatten(data) or data
        except (ValueError, struct.error, zlib.error) as error:
            sys.exit(f"{path.name}: {error}")
    stale = [path for path in sorted(IOS.glob("*.png")) if path.name not in flat]
    for name, data in flat.items():
        (XCODE / name).write_bytes(data)
        (IOS / name).write_bytes(data)
    for path in stale:
        path.unlink()
        print(f"deleted icons/ios/{path.name}, which the Xcode set doesn't have")
    print(f"wrote {len(flat)} icons without alpha to {XCODE.name} and icons/ios")


if __name__ == "__main__":
    main()
