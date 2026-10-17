#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

"""
Writes docs/demo/guide.xml, a made-up XMLTV guide for the live test streams
in docs/demo/playlist.m3u.

Apple's entry is a 10-minute on-demand clip that stops at its end. The other
two are live streams that show the same test content all day. The guide splits
each day into a few blocks whose titles say what the entry shows. It runs from
START to the day before END, in UTC. The output is the same on every run, so
run it again after a change here and commit both files:

    python3 -I scripts/demo-guide.py

It needs only Python's standard library.
"""

import argparse
import datetime
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

START = datetime.date(2026, 10, 15)
END = datetime.date(2028, 1, 1)

OUT = Path(__file__).resolve().parent.parent / "docs" / "demo" / "guide.xml"

# Each channel's id matches the tvg-id of its entry in docs/demo/playlist.m3u.
# A day is split into blocks that start at the given UTC hours. The titles
# take turns, starting one further along each day, so the guide changes from
# day to day.
CHANNELS = [
    {
        "id": "apple.demo",
        "name": "Apple HLS example",
        "hours": [0, 7, 12, 18],
        "shows": [
            (
                "Bip-bop",
                "Apple's HLS example, a 10-minute clip that plays from the start and stops."
                " A circle flashes Bip! and Bop! over a frame counter.",
            ),
            (
                "Bip-bop at 1080p60",
                "The same 10-minute clip, in six sizes up to 1920x1080 at 60 frames a second.",
            ),
            (
                "Bip-bop with subtitles",
                "The same 10-minute clip, with English subtitles and captions.",
            ),
            ("Bip-bop in 5.1", "The same 10-minute clip, with stereo and 5.1 sound."),
        ],
    },
    {
        "id": "ivs.demo",
        "name": "Amazon IVS test stream",
        "hours": [0, 7, 13, 18],
        "shows": [
            (
                "Around Seattle",
                "Amazon IVS's 720p test stream. Short clips of Seattle, one after another.",
            ),
            (
                "Seattle, day and night",
                "The same clips of Seattle's streets, market and waterfront.",
            ),
        ],
    },
    {
        "id": "unified.demo",
        "name": "Unified Streaming live test",
        "hours": [0, 8, 16],
        "shows": [
            (
                "Color bars",
                "Unified Streaming's live test. Color bars with the date and time in UTC.",
            ),
            (
                "Color bars and clock",
                "The same color bars, with a clock that shows the time in UTC.",
            ),
        ],
    },
]


def stamp(moment: datetime.datetime) -> str:
    return moment.strftime("%Y%m%d%H%M%S +0000")


def programmes(channel: dict, start: datetime.date, end: datetime.date):
    """Yields each block of the channel from start to the day before end."""
    hours = channel["hours"]
    shows = channel["shows"]
    day = start
    while day < end:
        midnight = datetime.datetime.combine(day, datetime.time())
        turn = (day - start).days
        for i, hour in enumerate(hours):
            begin = midnight + datetime.timedelta(hours=hour)
            stop = midnight + datetime.timedelta(hours=hours[i + 1] if i + 1 < len(hours) else 24)
            title, desc = shows[(turn + i) % len(shows)]
            yield begin, stop, title, desc
        day += datetime.timedelta(days=1)


def guide(start: datetime.date, end: datetime.date) -> str:
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<!-- A made-up guide for the live test streams in docs/demo/playlist.m3u."
        " scripts/demo-guide.py writes it. -->",
        '<tv generator-info-name="scripts/demo-guide.py">',
    ]
    for channel in CHANNELS:
        lines.append(
            f"<channel id={quoteattr(channel['id'])}>"
            f"<display-name>{escape(channel['name'])}</display-name></channel>"
        )
    for channel in CHANNELS:
        for begin, stop, title, desc in programmes(channel, start, end):
            lines.append(
                f'<programme start="{stamp(begin)}" stop="{stamp(stop)}"'
                f" channel={quoteattr(channel['id'])}>"
                f"<title>{escape(title)}</title><desc>{escape(desc)}</desc></programme>"
            )
    lines.append("</tv>")
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--out", type=Path, default=OUT, help="where to write the guide")
    args = parser.parse_args()
    args.out.write_text(guide(START, END), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
