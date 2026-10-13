#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

"""
Summarize a StrykerJS JSON report as Markdown for a GitHub job summary.

Counts the mutants by status and lists the ones no test caught, by file.
Stryker reports two kinds. A survived mutant ran tests that all passed, and a
mutant with no coverage is in code that no test runs at all. It also lists the
mutants Stryker was told to skip, such as with a comment in the code, and why.

The score counts killed and timed-out mutants out of every mutant that ran or
had no test to run. A timeout usually means the change made a loop run
forever, which a user would notice too. Mutants that didn't compile, or that
crashed the test runner, don't count. That's the same score Stryker prints.

A survived mutant that ran no tests gets a note under the table. A mutant that
stops its module from loading does that, and so does every covered mutant when
Stryker's test name pattern stops matching Vitest's test names.

With --check, it prints a GitHub error annotation for each mutant no test
caught instead, and exits with 1 if there are any. CI runs that on the lines a
pull request changes. A change that does the same thing as the code it
replaces can't be caught by any test. The line before it then gets a comment
that names the mutator and says why, which Stryker reads:

  // Stryker disable next-line EqualityOperator: <why no test can catch it>

--check also fails for a Stryker comment in the mutated files that isn't of
that form. One with no reason, or with "all" for the mutators, or one that
covers every line after it, could hide a mutant that a test should catch.
--path-prefix goes before each file name in the annotations, since Stryker's
names start in apps/player and GitHub's start at the top of the repo.

Usage:
  python3 scripts/stryker-summary.py [--title TITLE] MUTATION_JSON
  python3 scripts/stryker-summary.py --check [--path-prefix PREFIX] MUTATION_JSON
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from html import escape
from pathlib import Path

# The longest code shown for a mutant. A replaced block can run to many lines.
MAX_CODE = 80

# A Stryker comment, read as Stryker reads it, with what follows the colon.
DIRECTIVE = re.compile(
    r"(?://|/\*) ?Stryker (disable|restore)(?: (next-line))? ([a-zA-Z, ]+)(?::(.*))?"
)


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


def escape_data(text: str) -> str:
    """`text` as a workflow command's message, which ends at a line break."""
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def escape_property(text: str) -> str:
    """`text` as a workflow command's property, which also ends at , or :."""
    return escape_data(text).replace(":", "%3A").replace(",", "%2C")


def annotation(path: str, line: int, column: int, title: str, message: str) -> str:
    """A GitHub error annotation on a line of a file."""
    return (
        f"::error file={escape_property(path)},line={line},col={column},"
        f"title={escape_property(title)}::{escape_data(message)}"
    )


def comment_problems(source: str) -> list[tuple[int, int, str]]:
    """The line, column and problem of each Stryker comment not of the allowed form."""
    problems = []
    for match in DIRECTIVE.finditer(source):
        kind, scope, mutators, reason = match.groups()
        names = [name.strip() for name in mutators.split(",") if name.strip()]
        if kind != "disable" or scope != "next-line":
            problem = (
                "Only `// Stryker disable next-line <mutator>: <reason>` is used here,"
                " so that each comment covers one line."
            )
        elif not names or any(name.lower() == "all" for name in names):
            problem = "Name the mutators this comment turns off, rather than all of them."
        elif not (reason or "").strip():
            problem = "Say after a colon why no test can catch the mutants this comment turns off."
        else:
            continue
        line = source.count("\n", 0, match.start()) + 1
        column = match.start() - (source.rfind("\n", 0, match.start()) + 1) + 1
        problems.append((line, column, problem))
    return problems


def check(report: dict, prefix: str) -> int:
    """Prints an annotation for each mutant no test caught, and for each Stryker comment
    not of the allowed form. Returns 1 if there were any."""
    count = 0
    for name, file in sorted(report["files"].items()):
        path = prefix + name
        for line, column, problem in comment_problems(file["source"]):
            print(annotation(path, line, column, "Stryker comment", problem))
            count += 1
        for mutant in file["mutants"]:
            status = mutant["status"]
            if status not in ("Survived", "NoCoverage"):
                continue
            start = mutant["location"]["start"]
            mutator = mutant["mutatorName"]
            before = one_line(original(file["source"], mutant["location"]))
            after = one_line(mutant.get("replacement", ""))
            if status == "Survived":
                title = "Mutant survived"
                message = (
                    f"{mutator} changed `{before}` to `{after}`, and every test still passed."
                    " Add a test that fails on this change. If it does the same thing as the"
                    f" code, put `// Stryker disable next-line {mutator}: <why>` on the line"
                    " before."
                )
            else:
                title = "No test runs this code"
                message = (
                    f"No test runs this code, so none caught {mutator} changing `{before}`"
                    f" to `{after}`. Add a test that runs it."
                )
            print(annotation(path, start["line"], start["column"], title, message))
            count += 1
    if count:
        problems = "problem" if count == 1 else "problems"
        print(f"Stryker found {count} {problems} on the lines this pull request changes.")
        return 1
    print("Every mutant on the lines this pull request changes was caught.")
    return 0


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
    parser.add_argument(
        "--check",
        action="store_true",
        help="print an annotation for each mutant no test caught, and fail if there are any",
    )
    parser.add_argument("--path-prefix", default="", help="goes before each file name")
    parser.add_argument("report", metavar="MUTATION_JSON")
    args = parser.parse_args(argv)

    path = Path(args.report)
    if not path.exists():
        if args.check:
            print(f"No report at {args.report}.")
            return 1
        print(f"## {args.title}\n\nNo report at `{args.report}`.")
        return 0
    report = json.loads(path.read_text(encoding="utf-8"))
    if args.check:
        return check(report, args.path_prefix)

    counts: dict[str, int] = defaultdict(int)
    survived: dict[str, list[str]] = defaultdict(list)
    uncovered: dict[str, list[str]] = defaultdict(list)
    ignored: dict[str, list[str]] = defaultdict(list)
    no_tests = 0
    for name, file in report["files"].items():
        mutants = sorted(
            file["mutants"],
            key=lambda m: (m["location"]["start"]["line"], m["location"]["start"]["column"]),
        )
        for mutant in mutants:
            status = mutant["status"]
            counts[status] += 1
            if status not in ("Survived", "NoCoverage", "Ignored"):
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
            if status == "Ignored":
                reason = one_line(mutant.get("statusReason") or "")
                ignored[name].append(f"{entry}. {escape(reason, quote=False)}" if reason else entry)
            else:
                (survived if status == "Survived" else uncovered)[name].append(entry)

    detected = counts["Killed"] + counts["Timeout"]
    total = detected + counts["Survived"] + counts["NoCoverage"]
    errors = counts["CompileError"] + counts["RuntimeError"]
    score = f"{100 * detected / total:.1f}%" if total else "n/a"

    out = [
        f"## {args.title}",
        "",
        "| Killed | Survived | No coverage | Timed out | Errors | Turned off | Score |",
        "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        f"| {counts['Killed']} | {counts['Survived']} | {counts['NoCoverage']}"
        f" | {counts['Timeout']} | {errors} | {counts['Ignored']} | {score} |",
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
    out += mutant_list("Turned off", ignored)
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
