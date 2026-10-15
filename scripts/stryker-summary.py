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
caught on the lines --lines names instead, and exits with 1 if there are any.
CI runs that on the lines a pull request changes. --lines takes them as
Stryker's --mutate does, like src/lib/a.ts:3-5,src/lib/b.ts. A change that does
the same thing as the code it replaces can't be caught by any test. The line
before it then gets a comment that names the mutator and says why, which
Stryker reads:

  // Stryker disable next-line EqualityOperator: <why no test can catch it>

Stryker only makes the mutants whose code lies wholly inside one of the
ranges, so the check only looks at those too. It prints a warning for each
mutant Stryker ignored there, as for a comment, so a reviewer can check that
the reason still holds for the changed code. The mutants that
apps/player/stryker.class-names.mjs leaves out, which only change class
names, get none.

--check also fails for any other Stryker comment in the files --lines names.
One with no reason, or with "all" for the mutators, or one that covers every
line after it, could hide a mutant that a test should catch. So could one with
another Stryker comment in its reason, or one that gives the class-names
plugin's reason, which would hide its mutants from the warnings. It fails, too,
when there's no report.
Stryker writes none when no test loads the files it mutates. --no-mutants says
Stryker made no mutants at all, as for a change to types alone, and then a
missing report is fine. --path-prefix goes before each file name, since
Stryker's names start in apps/player, and GitHub's, like the working folder's,
at the top of the repo.

Usage:
  python3 scripts/stryker-summary.py [--title TITLE] MUTATION_JSON
  python3 scripts/stryker-summary.py --check --lines LINES [--no-mutants]
      [--path-prefix PREFIX] MUTATION_JSON
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

# Where a line ends in JavaScript, and so in Stryker's line numbers.
LINE_BREAK = re.compile(r"\r\n|[\n\r\u2028\u2029]")

# Text that Stryker could read as a comment that turns mutants off or on.
# Stryker reads it at the start of a comment, after at most one space of any
# kind, so this looks for it anywhere.
MENTION = re.compile(r"Stryker (?:disable|restore)")

# The one Stryker comment allowed, alone on its line, with the mutators it
# names and its reason.
ALLOWED = re.compile(r"[ \t]*// Stryker disable next-line ([A-Za-z]+(?:, ?[A-Za-z]+)*):(.*)")

# The reason apps/player/stryker.class-names.mjs gives for the mutants it leaves
# out.
CLASS_NAMES = "Only changes class names."


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
    lines = LINE_BREAK.split(source)
    start, end = location["start"], location["end"]
    first, last = start["line"] - 1, end["line"] - 1
    if first == last:
        return lines[first][start["column"] - 1 : end["column"] - 1]
    head, tail = lines[first][start["column"] - 1 :], lines[last][: end["column"] - 1]
    return "\n".join([head, *lines[first + 1 : last], tail])


def escape_data(text: str) -> str:
    """`text` as a workflow command's message, which ends at a line break."""
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def escape_property(text: str) -> str:
    """`text` as a workflow command's property, which also ends at , or :."""
    return escape_data(text).replace(":", "%3A").replace(",", "%2C")


def annotation(
    path: str, line: int, column: int, title: str, message: str, kind: str = "error"
) -> str:
    """A GitHub annotation on a line of a file, an error unless `kind` says otherwise."""
    return (
        f"::{kind} file={escape_property(path)},line={line},col={column},"
        f"title={escape_property(title)}::{escape_data(message)}"
    )


def same_reason(text: str, reason: str) -> bool:
    """Whether `text` reads as `reason`, apart from case, spacing and final periods."""

    def plain(words: str) -> str:
        return " ".join(words.split()).casefold().rstrip(". ")

    return plain(text) == plain(reason)


def comment_problems(source: str) -> list[tuple[int, int, str]]:
    """The line, column and problem of each Stryker comment not of the allowed form."""
    problems = []
    for number, line in enumerate(LINE_BREAK.split(source), start=1):
        mention = MENTION.search(line)
        if not mention:
            continue
        allowed = ALLOWED.fullmatch(line)
        if not allowed:
            problem = (
                "Only `// Stryker disable next-line <mutator>: <reason>`, alone on its line,"
                " is used here, so that each comment covers one line."
            )
        elif MENTION.search(allowed[2]):
            problem = (
                "Leave other Stryker comments out of the reason. If this line sits inside a"
                " block comment or a template string, Stryker could read one there."
            )
        elif any(name.strip().lower() == "all" for name in allowed[1].split(",")):
            problem = "Name the mutators this comment turns off, rather than all of them."
        elif not allowed[2].strip():
            problem = (
                "Say after the colon why no test can catch the mutants this comment turns off."
            )
        elif same_reason(allowed[2], CLASS_NAMES):
            problem = (
                f'"{CLASS_NAMES}" is the reason stryker.class-names.mjs gives, and the check'
                " doesn't warn about those mutants. Say in your own words why no test can"
                " catch these."
            )
        else:
            continue
        problems.append((number, mention.start() + 1, problem))
    return problems


def changed_lines(spec: str) -> dict[str, list[tuple[int, int]] | None]:
    """The files and ranges of lines in `spec`, as Stryker's --mutate takes them.
    None stands for the whole file."""
    files: dict[str, list[tuple[int, int]] | None] = {}
    for part in filter(None, spec.split(",")):
        match = re.fullmatch(r"(.+):(\d+)-(\d+)", part)
        if not match:
            files[part] = None
        elif files.get(match[1], []) is not None:
            files.setdefault(match[1], []).append((int(match[2]), int(match[3])))
    return files


def within(location: dict, ranges: list[tuple[int, int]] | None) -> bool:
    """Whether a mutant's code lies wholly inside one of `ranges`. Those are the
    mutants Stryker makes when --mutate names the ranges."""
    if ranges is None:
        return True
    first, last = location["start"]["line"], location["end"]["line"]
    return any(start <= first and last <= end for start, end in ranges)


def check(
    report: dict | None,
    prefix: str,
    lines: dict[str, list[tuple[int, int]] | None],
    no_mutants: bool = False,
) -> int:
    """Prints an annotation for each mutant no test caught on `lines`, and for each
    Stryker comment not of the allowed form in their files. Returns 1 if there were
    any, or if there's no report and Stryker made mutants. Also prints a warning for
    each mutant Stryker ignored on `lines`."""
    count = 0
    for name in sorted(lines):
        path = prefix + name
        source = Path(path).read_bytes().decode("utf-8")
        for line, column, problem in comment_problems(source):
            print(annotation(path, line, column, "Stryker comment", problem))
            count += 1
    if report is None and not no_mutants:
        message = (
            f"No test loads {', '.join(sorted(lines))}, so Stryker had nothing to run."
            " Add tests for the changes."
        )
        print(f"::error title={escape_property('No tests')}::{escape_data(message)}")
        count += 1
    for name, file in sorted((report or {"files": {}})["files"].items()):
        if name not in lines:
            continue
        path = prefix + name
        for mutant in file["mutants"]:
            status = mutant["status"]
            if status not in ("Survived", "NoCoverage", "Ignored") or not within(
                mutant["location"], lines[name]
            ):
                continue
            start = mutant["location"]["start"]
            mutator = mutant["mutatorName"]
            before = one_line(original(file["source"], mutant["location"]))
            after = one_line(mutant.get("replacement", ""))
            if status == "Ignored":
                reason = one_line(mutant.get("statusReason") or "")
                if reason == CLASS_NAMES:
                    continue
                message = (
                    f"Stryker ignored {mutator} changing `{before}` to `{after}` here,"
                    f' for the reason "{reason}". Check that it still holds for the changed code.'
                )
                title = "Mutant ignored"
                print(annotation(path, start["line"], start["column"], title, message, "warning"))
                continue
            if status == "Survived":
                title = "Mutant survived"
                message = (
                    f"{mutator} changed `{before}` to `{after}`, and no test failed."
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
        print(f"Stryker found {count} {problems} in the files this pull request changes.")
        if count > 10:
            print("GitHub shows at most 10 of them as annotations, and this log lists them all.")
        return 1
    if report is None:
        print("Stryker found no code to mutate on the lines this pull request changes.")
    else:
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
    parser.add_argument(
        "--lines",
        default="",
        help="with --check, the lines to check, as Stryker's --mutate takes them",
    )
    parser.add_argument(
        "--no-mutants",
        action="store_true",
        help="with --check, Stryker made no mutants, so a missing report is fine",
    )
    parser.add_argument("--path-prefix", default="", help="goes before each file name")
    parser.add_argument("report", metavar="MUTATION_JSON")
    args = parser.parse_args(argv)

    path = Path(args.report)
    if args.check:
        lines = changed_lines(args.lines)
        if not lines:
            parser.error("--check needs --lines")
        report = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
        return check(report, args.path_prefix, lines, args.no_mutants)
    if not path.exists():
        print(f"## {args.title}\n\nNo report at `{args.report}`.")
        return 0
    report = json.loads(path.read_text(encoding="utf-8"))

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
        "| Killed | Survived | No coverage | Timed out | Errors | Ignored | Score |",
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
    out += mutant_list("Ignored", ignored)
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
