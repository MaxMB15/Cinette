#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

"""
Summarize cargo-mutants results as Markdown for a GitHub job summary.

Takes one or more mutants.out folders, such as one from each shard of a run,
adds up their counts and lists the mutants that no test caught, by file.

The score counts caught and timed-out mutants out of every mutant that built.
A timeout usually means the change made a loop run forever, which a user would
notice too. Unviable mutants didn't compile, so they don't count.

Usage:
  python3 scripts/mutants-summary.py MUTANTS_OUT [MUTANTS_OUT ...]
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

COUNTS = ("caught", "missed", "timeout", "unviable")


def read_lines(folder: Path, name: str) -> list[str]:
    path = folder / name
    if not path.exists():
        return []
    return [line for line in path.read_text().splitlines() if line.strip()]


def by_file(mutants: list[str]) -> dict[str, list[tuple[int, int, str]]]:
    """Groups `path:line:col: description` lines by path, sorted by line."""
    files: dict[str, list[tuple[int, int, str]]] = defaultdict(list)
    for mutant in mutants:
        path, line, col, description = mutant.split(":", 3)
        files[path].append((int(line), int(col), description.strip()))
    return {path: sorted(files[path]) for path in sorted(files)}


def mutant_list(title: str, mutants: list[str]) -> list[str]:
    if not mutants:
        return []
    out = ["", f"### {title} ({len(mutants)})", ""]
    for path, entries in by_file(mutants).items():
        out.append(f"<details><summary><code>{path}</code> ({len(entries)})</summary>")
        out.append("")
        out += [f"- `{line}:{col}` {description}" for line, col, description in entries]
        out += ["", "</details>"]
    return out


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__.strip(), file=sys.stderr)
        return 1

    totals = dict.fromkeys(COUNTS, 0)
    missed: list[str] = []
    timeouts: list[str] = []
    absent: list[str] = []
    for arg in argv:
        folder = Path(arg)
        outcomes = folder / "outcomes.json"
        if not outcomes.exists():
            absent.append(arg)
            continue
        data = json.loads(outcomes.read_text())
        for key in COUNTS:
            totals[key] += data.get(key, 0)
        missed += read_lines(folder, "missed.txt")
        timeouts += read_lines(folder, "timeout.txt")

    detected = totals["caught"] + totals["timeout"]
    built = detected + totals["missed"]
    score = f"{100 * detected / built:.1f}%" if built else "n/a"

    out = [
        "## Mutation testing",
        "",
        "| Caught | Missed | Timed out | Unviable | Score |",
        "| ---: | ---: | ---: | ---: | ---: |",
        f"| {totals['caught']} | {totals['missed']} | {totals['timeout']}"
        f" | {totals['unviable']} | {score} |",
    ]
    if absent:
        out += ["", "No results in: " + ", ".join(f"`{a}`" for a in absent)]
    out += mutant_list("Missed", missed)
    out += mutant_list("Timed out", timeouts)
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
