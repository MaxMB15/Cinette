#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

"""
Summarize a StrykerJS JSON report as Markdown for a GitHub job summary.

Counts the mutants by status and lists the ones no test caught, by file.
Stryker reports two kinds. A survived mutant ran tests that all passed, and a
mutant with no coverage is in code that no test runs at all.

The score counts killed and timed-out mutants out of every mutant that ran or
had no test to run. A timeout usually means the change made a loop run
forever, which a user would notice too. Mutants that didn't compile, or that
crashed the test runner, don't count. That's the same score Stryker prints.

A survived mutant that ran no tests gets a note under the table. A mutant that
stops its module from loading does that, and so does every covered mutant when
Stryker's test name pattern stops matching Vitest's test names.

Usage:
  python3 scripts/stryker-summary.py [--title TITLE] MUTATION_JSON
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from html import escape
from pathlib import Path

# The longest code shown for a mutant. A replaced block can run to many lines.
MAX_CODE = 80


def code(text: str) -> str:
    """Wraps `text` in a Markdown code span.

    GitHub drops anything shaped like an HTML tag from plain Markdown text,
    which TypeScript generics are. A code span shows them as written, and its
    fence is longer than any run of backticks inside.
    """
    longest = run = 0
    for char in text:
        run = run + 1 if char == "`" else 0
        longest = max(longest, run)
    fence = "`" * (longest + 1)
    pad = " " if text.startswith("`") or text.endswith("`") else ""
    return f"{fence}{pad}{text}{pad}{fence}"


def one_line(text: str) -> str:
    """`text` on one line, cut to MAX_CODE characters."""
    flat = " ".join(text.split())
    return flat if len(flat) <= MAX_CODE else flat[: MAX_CODE - 1] + "…"


def original(source: str, location: dict) -> str:
    """The code a mutant replaces. Stryker's lines and columns start at 1."""
    lines = source.splitlines(keepends=True)
    start, end = location["start"], location["end"]
    first, last = start["line"] - 1, end["line"] - 1
    if first == last:
        return lines[first][start["column"] - 1 : end["column"] - 1]
    return (
        lines[first][start["column"] - 1 :]
        + "".join(lines[first + 1 : last])
        + lines[last][: end["column"] - 1]
    )


def mutant_list(title: str, mutants: dict[str, list[str]]) -> list[str]:
    count = sum(len(entries) for entries in mutants.values())
    if not count:
        return []
    out = ["", f"### {title} ({count})", ""]
    for path in sorted(mutants):
        entries = mutants[path]
        out.append(f"<details><summary><code>{escape(path)}</code> ({len(entries)})</summary>")
        out.append("")
        out += entries
        out += ["", "</details>"]
    return out


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Summarize a StrykerJS JSON report as Markdown.",
    )
    parser.add_argument("--title", default="Mutation testing")
    parser.add_argument("report", metavar="MUTATION_JSON")
    args = parser.parse_args(argv)

    path = Path(args.report)
    if not path.exists():
        print(f"## {args.title}\n\nNo report at `{args.report}`.")
        return 0
    report = json.loads(path.read_text(encoding="utf-8"))

    counts: dict[str, int] = defaultdict(int)
    survived: dict[str, list[str]] = defaultdict(list)
    uncovered: dict[str, list[str]] = defaultdict(list)
    no_tests = 0
    for name, file in report["files"].items():
        mutants = sorted(
            file["mutants"],
            key=lambda m: (m["location"]["start"]["line"], m["location"]["start"]["column"]),
        )
        for mutant in mutants:
            status = mutant["status"]
            counts[status] += 1
            if status not in ("Survived", "NoCoverage"):
                continue
            if status == "Survived" and mutant.get("testsCompleted") == 0:
                no_tests += 1
            start = mutant["location"]["start"]
            before = one_line(original(file["source"], mutant["location"]))
            after = one_line(mutant.get("replacement", ""))
            entry = (
                f"- `{start['line']}:{start['column']}` {mutant['mutatorName']}, "
                f"{code(before)} to {code(after)}"
            )
            (survived if status == "Survived" else uncovered)[name].append(entry)

    detected = counts["Killed"] + counts["Timeout"]
    total = detected + counts["Survived"] + counts["NoCoverage"]
    errors = counts["CompileError"] + counts["RuntimeError"]
    score = f"{100 * detected / total:.1f}%" if total else "n/a"

    out = [
        f"## {args.title}",
        "",
        "| Killed | Survived | No coverage | Timed out | Errors | Score |",
        "| ---: | ---: | ---: | ---: | ---: | ---: |",
        f"| {counts['Killed']} | {counts['Survived']} | {counts['NoCoverage']}"
        f" | {counts['Timeout']} | {errors} | {score} |",
    ]
    if no_tests:
        out += [
            "",
            f"{no_tests} of the survived mutants ran no tests. A mutant that stops its module"
            " from loading does that. If most of them did, check that"
            " `apps/player/vitest.stryker.config.ts` still makes Stryker's test name"
            " pattern match Vitest's test names.",
        ]
    out += mutant_list("Survived", survived)
    out += mutant_list("No coverage", uncovered)
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
