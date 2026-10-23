#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

"""
Checks the code a pull request changes, for the Changed code workflow and for
`pnpm check:changed`.

The lines a change adds are the lines of `git diff -U0` on the new side. In CI
that's the diff between the merge commit GitHub checks out and its first
parent, dev. Without --head it's the diff between --base and the working
tree, with untracked files counted as added in full.

The counted files are the frontend's .ts and .tsx files in apps/player/src,
apart from tests, src/test and .d.ts files, and the .rs files in the src
folder of each crate in the workspace, apart from test code. Test code is a
module declared with #[cfg(test)], or with #[cfg(all(test, ...))], in its own
file or inline, the modules it declares, and a #[test] or #[tokio::test]
function. A file named tests.rs counts like any other until a module declares
it that way. scripts/changed-code-exclude.toml leaves out more, each with a
reason.

Subcommands:

  plan       Says which checks have changed lines to look at, for the
             workflow, and splits the files Stryker mutates into shards.
             With --shards, it also counts the Rust mutants in the changed
             lines with `cargo mutants --list` and splits each crate into
             shards. It warns about each exclusion entry that leaves out
             more than the base commit's copy of the file does, about the
             changed lines a function entry leaves out, about each setting
             the change adds to, removes from or changes in
             .cargo/mutants.toml, and about each #[mutants::skip] it adds or
             changes.
  stryker    The lines for Stryker to mutate and to check, as the frontend
             mutation job takes them, and their shards. With --all in place
             of --base, the shards of all of src/lib, for the weekly run.
  rust-diff  The diff that cargo-mutants reads with --in-diff.
  coverage   Changed-line coverage from lcov files. Fails when the covered
             share of the counted lines is under 80%, for the frontend or for
             Rust, and writes a table of the uncovered lines. A frontend file
             missing from the report fails too, and so does a Rust report with
             no data at all.
  mutants    Fails for each mutant cargo-mutants missed, unless a skip comment
             covers it, and when a folder's outcomes.json is missing, lists no
             mutants or has a result this can't read. A missed mutant in a file
             this can't read fails too.

A skip comment says why no test can catch a Rust mutant. It sits alone on the
line before the mutant's line, names the mutant's genre and gives a reason:

  // mutants: skip BinaryOperator: <why no test can catch it>

For a mutant that replaces a whole function body, FnValue, it sits on any
line from the one before the function's doc comments and attributes to the
one before `fn`. The genres are FnValue, BinaryOperator, UnaryOperator,
MatchArm, MatchArmGuard and StructField. cargo-mutants still runs a mutant a
comment covers. The check then prints a warning in place of an error, so a
reviewer can check that the reason still holds.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from fnmatch import fnmatchcase
from pathlib import Path

if sys.version_info < (3, 11):
    raise SystemExit("changed-code.py needs Python 3.11 or later, which has tomllib.")

import tomllib

ROOT = Path(__file__).resolve().parent.parent
EXCLUDE_FILE = "scripts/changed-code-exclude.toml"
MUTANTS_CONFIG = ".cargo/mutants.toml"

# The share of the counted changed lines that tests must run, for the
# frontend and for Rust each.
THRESHOLD = 80.0

FRONTEND = "apps/player/"
FRONTEND_SRC = FRONTEND + "src/"

# The Stryker and Vitest config files, and the two files Vitest loads before
# every test, the setupFiles in vitest.config.ts. A change to them, or to the
# versions of the tools that run the tests, can change the result for any
# mutant, so it gets a run of all of src/lib. The other files in src/test are
# helpers that only some tests import. A change to one is a change to test
# code, like one to a *.test.ts file, so it mutates nothing. A test checks
# that the two names match setupFiles.
STRYKER_SETUP = re.compile(
    r"apps/player/(?:(?:stryker|vitest)\.[^/]*|src/test/(?:polyfills|setup)\.ts)"
)
STRYKER_TOOLS = re.compile(
    r'^[-+][ \t]*"(?:vitest|vite|jsdom|@vitest/[^"]+|@vitejs/[^"]+'
    r'|@testing-library/[^"]+|@stryker-mutator/[^"]+)":',
    re.MULTILINE,
)
# Files whose change has the frontend mutation job check one small file when
# it has no lines of its own, so the job still runs. date.ts has its own
# tests, and every mutant in it is caught or turned off.
STRYKER_CANARY_TRIGGERS = {
    ".github/workflows/changed-code.yml",
    "scripts/changed-code.py",
    "scripts/stryker-summary.py",
}
STRYKER_CANARY = "src/lib/date.ts"

# What Stryker's --mutate can't take in a file name. It splits the list on
# commas and reads the rest as globs.
STRYKER_BAD_NAME = re.compile(r'[,*?{}!()\[\]"\\\x00-\x1f\x7f]')

# Where Stryker's parser ends a line and git doesn't.
STRYKER_BREAKS = re.compile(rb"\xe2\x80[\xa8\xa9]|\r(?!\n)")

# Mutants per shard for each crate. A mutant in mvp-core takes about 15
# seconds in CI, one in the plugin about 13 and one in the app about 30 with
# 16 test threads, so a shard takes about 15 minutes plus its setup.
MUTANTS_PER_SHARD = {"mvp-core": 60, "tauri-plugin-mpv": 55, "max-video-player": 30}
MAX_SHARDS = 8

# Lines per Stryker shard, in at most MAX_SHARDS shards. The weekly run of all
# of src/lib went through about 80 lines a minute, testing 4 mutants at once
# on a 4-core runner, so a shard takes about 20 minutes plus its setup.
LINES_PER_STRYKER_SHARD = 1500

GENRES = ("FnValue", "BinaryOperator", "UnaryOperator", "MatchArm", "MatchArmGuard", "StructField")
SKIP = re.compile(r"[ \t]*// mutants: skip ([A-Za-z]+(?:, ?[A-Za-z]+)*):(.*)")
SKIP_MENTION = re.compile(r"mutants:\s*skip")


# ---------------------------------------------------------------------------
# Annotations, as in stryker-summary.py.


def escape_data(text: str) -> str:
    """`text` as a workflow command's message, which ends at a line break."""
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def escape_property(text: str) -> str:
    """`text` as a workflow command's property, which also ends at , or :."""
    return escape_data(text).replace(":", "%3A").replace(",", "%2C")


def annotation(
    kind: str,
    title: str,
    message: str,
    path: str | None = None,
    line: int | None = None,
    end: int | None = None,
) -> str:
    """A GitHub annotation, on a file and lines when they're given."""
    props = []
    if path is not None:
        props.append(f"file={escape_property(path)}")
    if line is not None:
        props.append(f"line={line}")
    if end is not None and end != line:
        props.append(f"endLine={end}")
    props.append(f"title={escape_property(title)}")
    return f"::{kind} {','.join(props)}::{escape_data(message)}"


def code(text: str) -> str:
    """Wraps `text` in a Markdown code span with a fence longer than any run of
    backticks inside, as stryker-summary.py does."""
    longest = run = 0
    for char in text:
        run = run + 1 if char == "`" else 0
        longest = max(longest, run)
    fence = "`" * (longest + 1)
    pad = " " if text.startswith("`") or text.endswith("`") else ""
    return f"{fence}{pad}{text}{pad}{fence}"


def ranges(lines: list[int]) -> list[tuple[int, int]]:
    """Sorted line numbers as runs of consecutive lines."""
    out: list[tuple[int, int]] = []
    for line in sorted(set(lines)):
        if out and out[-1][1] == line - 1:
            out[-1] = (out[-1][0], line)
        else:
            out.append((line, line))
    return out


def show_ranges(lines: list[int]) -> str:
    return ", ".join(str(a) if a == b else f"{a}-{b}" for a, b in ranges(lines))


# ---------------------------------------------------------------------------
# The diff.


def git(*args: str, ok: tuple[int, ...] = (0,)) -> bytes:
    result = subprocess.run(["git", *args], cwd=ROOT, stdout=subprocess.PIPE)
    if result.returncode not in ok:
        raise SystemExit(f"git {' '.join(args)} failed with exit code {result.returncode}")
    return result.stdout


# The same diff whatever the user's git config says about prefixes, external
# diff tools, colors and folders.
DIFF = (
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--no-relative",
    "--src-prefix=a/",
    "--dst-prefix=b/",
)

HUNK = re.compile(rb"@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")
ESCAPES = {
    ord("a"): 7,
    ord("b"): 8,
    ord("t"): 9,
    ord("n"): 10,
    ord("v"): 11,
    ord("f"): 12,
    ord("r"): 13,
    ord('"'): 34,
    ord("\\"): 92,
}


def unquote(name: bytes) -> bytes:
    """A file name git quoted, with C escapes, as its bytes."""
    body = name[1:-1]
    out = bytearray()
    i = 0
    while i < len(body):
        if body[i] != ord("\\"):
            out.append(body[i])
            i += 1
        elif body[i + 1] in ESCAPES:
            out.append(ESCAPES[body[i + 1]])
            i += 2
        else:
            out.append(int(body[i + 1 : i + 4], 8))
            i += 4
    return bytes(out)


def parse_diff(data: bytes) -> dict[str, list[int]]:
    """The lines each file of a -U0 diff adds, numbered as in the new file.

    A file's "+++" line comes before its first hunk, and an added line that
    starts with "++" looks the same, so this only reads one there. A file
    that only loses lines, or only changes its mode or name, adds none.
    """
    files: dict[str, list[int]] = {}
    current: str | None = None
    header = False
    for raw in data.split(b"\n"):
        if raw.startswith(b"diff --git "):
            header, current = True, None
        elif header and raw.startswith(b"+++ "):
            name = raw[4:]
            if name.endswith(b"\t"):
                name = name[:-1]
            if name.startswith(b'"'):
                name = unquote(name)
            current = os.fsdecode(name[2:]) if name.startswith(b"b/") else None
        elif raw.startswith(b"@@ "):
            header = False
            match = HUNK.match(raw)
            if not match:
                raise SystemExit(f"Can't read the hunk header {raw!r}")
            start, count = int(match[1]), int(match[2] or b"1")
            if current is not None and count:
                files.setdefault(current, []).extend(range(start, start + count))
    return files


def untracked(paths: list[str]) -> list[str]:
    out = git("ls-files", "--others", "--exclude-standard", "-z", "--", *paths)
    return [os.fsdecode(name) for name in out.split(b"\0") if name]


def line_count(path: str) -> int:
    """The number of lines git counts in a file, ended by LF alone."""
    data = (ROOT / path).read_bytes()
    return data.count(b"\n") + (1 if data and not data.endswith(b"\n") else 0)


@dataclass
class Change:
    """What the diff between `base` and `head`, or the working tree, adds."""

    base: str
    head: str | None

    def revs(self) -> list[str]:
        return [self.base] if self.head is None else [self.base, self.head]

    def added(self, *paths: str) -> dict[str, list[int]]:
        """The lines each file under `paths` adds."""
        data = git(
            *DIFF, "--text", "-U0", "-M", "--diff-filter=AMR", *self.revs(), "--", *paths
        )
        files = parse_diff(data)
        if self.head is None:
            for name in untracked(list(paths)):
                files[name] = list(range(1, line_count(name) + 1))
        return files

    def names(self) -> list[str]:
        """Every file the diff touches, including the ones it deletes."""
        out = git(*DIFF, "--name-only", "--no-renames", "-z", *self.revs())
        names = [os.fsdecode(name) for name in out.split(b"\0") if name]
        if self.head is None:
            names += untracked(["."])
        return names

    def text(self, *paths: str) -> bytes:
        """The diff of the files under `paths` with context, for cargo-mutants."""
        data = git(*DIFF, *self.revs(), "--", *paths)
        if self.head is None:
            for name in untracked(list(paths)):
                data += git(*DIFF, "--no-index", "--", "/dev/null", name, ok=(0, 1))
        return data

    def source(self, path: str) -> bytes:
        """The new version of a file."""
        if self.head is None:
            return (ROOT / path).read_bytes()
        return git("show", f"{self.head}:{path}")


# ---------------------------------------------------------------------------
# Exclusions.


def glob_regex(pattern: str) -> re.Pattern[str]:
    """A glob as a regex, where * and ? stay inside one folder and ** crosses them."""
    out = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out))


@dataclass
class Exclusion:
    files: list[str]
    reason: str
    functions: list[str] = field(default_factory=list)

    def matches(self, path: str) -> bool:
        return any(glob_regex(pattern).fullmatch(path) for pattern in self.files)


def load_exclusions() -> list[Exclusion]:
    return parse_exclusions((ROOT / EXCLUDE_FILE).read_text(encoding="utf-8"))


def parse_exclusions(text: str) -> list[Exclusion]:
    data = tomllib.loads(text)
    unknown = set(data) - {"exclude"}
    if unknown:
        raise SystemExit(f"{EXCLUDE_FILE} has unknown keys: {', '.join(sorted(unknown))}")
    entries = data.get("exclude", [])
    if not isinstance(entries, list) or not all(isinstance(e, dict) for e in entries):
        raise SystemExit(f"{EXCLUDE_FILE} needs each entry as an [[exclude]] table")
    out = []
    for number, entry in enumerate(entries, start=1):
        where = f"{EXCLUDE_FILE}, entry {number}"
        unknown = set(entry) - {"files", "reason", "functions"}
        if unknown:
            raise SystemExit(f"{where} has unknown keys: {', '.join(sorted(unknown))}")
        files, reason = entry.get("files"), entry.get("reason")
        functions = entry.get("functions", [])
        if not isinstance(files, list) or not files or not all(isinstance(f, str) and f for f in files):
            raise SystemExit(f"{where} needs a list of file globs in files")
        if not isinstance(reason, str) or not reason.strip():
            raise SystemExit(f"{where} needs a reason")
        if not isinstance(functions, list) or not all(isinstance(f, str) and f for f in functions):
            raise SystemExit(f"{where} needs functions to be a list of names")
        if functions and not all(f.endswith(".rs") for f in files):
            raise SystemExit(f"{where} names functions, which only works for .rs files")
        out.append(Exclusion(files, reason.strip(), functions))
    return out


def file_exclusion(exclusions: list[Exclusion], path: str) -> Exclusion | None:
    """The entry that leaves out all of `path`, if one does."""
    return next((e for e in exclusions if not e.functions and e.matches(path)), None)


def stale_exclusions(exclusions: list[Exclusion]) -> list[str]:
    """Warnings for the globs and functions that match nothing in the repo."""
    tracked = [os.fsdecode(n) for n in git("ls-files", "-z").split(b"\0") if n]
    out = []
    for entry in exclusions:
        for pattern in entry.files:
            regex = glob_regex(pattern)
            found = [name for name in tracked if regex.fullmatch(name)]
            if not found:
                out.append(f"{EXCLUDE_FILE} names {pattern}, which matches no file.")
                continue
            for name in entry.functions:
                if not any(
                    fnmatchcase(fn.name, name)
                    for path in found
                    for fn in scan_rust((ROOT / path).read_text(encoding="utf-8")).functions
                ):
                    out.append(f"{EXCLUDE_FILE} names the function {name} in {pattern}, which has none.")
    return out


def show(rev: str | None, path: str) -> bytes | None:
    """A file as `rev` has it, or as the working tree has it when `rev` is
    None. None when there's no such file."""
    if rev is None:
        file = ROOT / path
        return file.read_bytes() if file.is_file() else None
    result = subprocess.run(
        ["git", "show", f"{rev}:{path}"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    return result.stdout if result.returncode == 0 else None


def base_exclusions(change: Change) -> list[Exclusion]:
    """The exclusion file as the base commit has it. Empty when it has no such
    file or one this can't read, so every entry counts as new."""
    data = show(change.base, EXCLUDE_FILE)
    if data is None:
        return []
    try:
        return parse_exclusions(data.decode("utf-8"))
    except (SystemExit, UnicodeDecodeError, tomllib.TOMLDecodeError):
        return []


def head_files(change: Change) -> list[str]:
    """Every file in the new version."""
    if change.head is None:
        names = git("ls-files", "-z")
    else:
        names = git("ls-tree", "-r", "--name-only", "-z", change.head)
    out = [os.fsdecode(name) for name in names.split(b"\0") if name]
    return out + untracked(["."]) if change.head is None else out


def listing(names: list[str], more: str) -> str:
    """The first three of `names` in a sentence, and how many more there are."""
    shown, rest = names[:3], len(names) - 3
    if rest > 0:
        return f"{', '.join(shown)} and {rest} more {more}"
    return shown[0] if len(shown) == 1 else f"{', '.join(shown[:-1])} and {shown[-1]}"


def widened_exclusions(change: Change, exclusions: list[Exclusion]) -> list[str]:
    """Warnings for each entry that leaves out code the base commit's copy of
    the exclusion file counts, so a reviewer sees what a change stops checking."""
    base = base_exclusions(change)
    rust = crates()
    files = [
        path
        for path in head_files(change)
        if frontend_file(path) or any(crate.owns(path) for crate in rust)
    ]
    out = []
    for number, entry in enumerate(exclusions, start=1):
        new = [path for path in files if entry.matches(path) and file_exclusion(base, path) is None]
        if entry.functions:
            what = [
                f"{name} in {path}"
                for path in new
                for name in entry.functions
                if not any(b.functions and b.matches(path) and name in b.functions for b in base)
            ]
            noun = "the functions" if len(what) > 1 else "the function"
            more = "functions"
        else:
            what = new
            noun = "the files" if len(what) > 1 else "the file"
            more = "files"
        if what:
            out.append(
                f"{EXCLUDE_FILE}, entry {number}, leaves out {noun} {listing(what, more)},"
                " which the base commit's copy counts. Check that no test in CI can run that code."
            )
    return out


def mutants_settings(data: bytes | None) -> dict | None:
    """A copy of .cargo/mutants.toml as a table. Empty when there's no copy,
    and None when this can't read it."""
    if data is None:
        return {}
    try:
        return tomllib.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError):
        return None


def setting_text(value: object) -> str:
    """A setting's value for a warning, cut short when it's long."""
    text = json.dumps(value, default=str, ensure_ascii=False)
    return code(text if len(text) <= 80 else text[:77] + "...")


def string_list(value: object) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


MUTANTS_CHECK = (
    " Check that cargo-mutants still makes the mutants it should and doesn't count"
    " a missed one as caught."
)


def changed_mutants_settings(change: Change) -> list[tuple[str, str]]:
    """A title and a warning for each setting the change adds to, removes from
    or changes in .cargo/mutants.toml. cargo-mutants reads them in this change
    and every later one, and settings like examine_re or timeout_multiplier
    can leave out mutants or count missed ones as caught. An entry the change
    adds to exclude_re or exclude_globs gets a warning of its own, and one it
    removes gets none, since cargo-mutants then makes more mutants. A change
    to comments or spacing alone gets no warning."""
    before, after = show(change.base, MUTANTS_CONFIG), show(change.head, MUTANTS_CONFIG)
    if before == after:
        return []
    base, head = mutants_settings(before), mutants_settings(after)
    if base is None or head is None:
        copy = "the base commit's copy" if base is None else "the new copy"
        return [
            (
                "Mutants settings",
                f"{MUTANTS_CONFIG} changes, and this can't read {copy}, so it can't say"
                " which settings change." + MUTANTS_CHECK,
            )
        ]
    out = []
    for key in sorted(base.keys() | head.keys()):
        old, new = base.get(key), head.get(key)
        if old == new:
            continue
        if key in ("exclude_re", "exclude_globs") and string_list(old or []) and string_list(new or []):
            out += [
                (
                    "Mutants left out",
                    f"{MUTANTS_CONFIG} adds {code(value)} to {key}, which the base commit's copy"
                    " doesn't have, so cargo-mutants makes none of the mutants it matches."
                    " Check that no test can catch them.",
                )
                for value in new or []
                if value not in (old or [])
            ]
        elif key not in base:
            out.append(
                (
                    "Mutants settings",
                    f"{MUTANTS_CONFIG} sets {key} to {setting_text(new)}, which the base"
                    " commit's copy doesn't set." + MUTANTS_CHECK,
                )
            )
        elif key not in head:
            out.append(
                (
                    "Mutants settings",
                    f"{MUTANTS_CONFIG} no longer sets {key}, which the base commit's copy sets"
                    f" to {setting_text(old)}." + MUTANTS_CHECK,
                )
            )
        else:
            out.append(
                (
                    "Mutants settings",
                    f"{MUTANTS_CONFIG} changes {key} from {setting_text(old)} to"
                    f" {setting_text(new)}." + MUTANTS_CHECK,
                )
            )
    return out


def skip_attributes(text: str) -> list[tuple[int, int]]:
    """The first and last lines of each attribute in Rust source that names
    mutants and then skip, like #[mutants::skip] or
    #[cfg_attr(test, mutants::skip)], however it's split across lines or
    broken up by comments."""
    tokens = rust_tokens(text)
    out = []
    for i, (line, tok) in enumerate(tokens):
        if tok != "#":
            continue
        k = i + 1
        if k < len(tokens) and tokens[k][1] == "!":
            k += 1
        if k >= len(tokens) or tokens[k][1] != "[":
            continue
        end = matching(tokens, k)
        words = [word for _, word in tokens[k + 1 : end]]
        if "mutants" in words and "skip" in words[words.index("mutants") + 1 :]:
            out.append((line, tokens[end][0]))
    return out


def new_mutant_skips(change: Change) -> list[tuple[str, int, str]]:
    """Each #[mutants::skip] the change adds to or changes in a crate's .rs
    files, as its file, its first changed line and a warning."""
    out = []
    for crate in crates():
        for path, lines in sorted(change.added(crate.folder).items()):
            if not path.endswith(".rs"):
                continue
            added = set(lines)
            text = change.source(path).decode("utf-8", "replace")
            for first, last in skip_attributes(text):
                changed = [number for number in range(first, last + 1) if number in added]
                if changed:
                    out.append(
                        (
                            path,
                            changed[0],
                            f"{path} adds a mutants::skip on line {changed[0]}, so cargo-mutants"
                            " makes no mutant in the item it marks, in this change or any"
                            " other. Check that no test can catch them.",
                        )
                    )
    return out


# ---------------------------------------------------------------------------
# Rust source.

IDENT = re.compile(r"r#[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*")
RAW_STRING = re.compile(r'[bc]?r(#*)"')
STRING = re.compile(r'[bc]?"')
CHAR = re.compile(r"b?'(?:\\(?:x[0-9A-Fa-f]{2}|u\{[0-9A-Fa-f_]*\}|.)|[^\\'\n])'")


def rust_tokens(text: str) -> list[tuple[int, str]]:
    """The tokens of Rust source with their line numbers, leaving out comments.

    Only identifiers, strings and punctuation matter here. A string comes back
    as its literal, quotes included, and a lifetime's tick is dropped.
    """
    tokens: list[tuple[int, str]] = []
    i, n, line = 0, len(text), 1
    while i < n:
        char = text[i]
        if char == "\n":
            line += 1
            i += 1
        elif char.isspace():
            i += 1
        elif text.startswith("//", i):
            end = text.find("\n", i)
            i = n if end < 0 else end
        elif text.startswith("/*", i):
            depth, j = 1, i + 2
            while j < n and depth:
                if text.startswith("/*", j):
                    depth, j = depth + 1, j + 2
                elif text.startswith("*/", j):
                    depth, j = depth - 1, j + 2
                else:
                    j += 1
            line += text.count("\n", i, j)
            i = j
        elif match := RAW_STRING.match(text, i):
            close = text.find('"' + match[1], match.end())
            end = n if close < 0 else close + 1 + len(match[1])
            tokens.append((line, text[i:end]))
            line += text.count("\n", i, end)
            i = end
        elif match := STRING.match(text, i):
            j = match.end()
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            tokens.append((line, text[i : j + 1]))
            line += text.count("\n", i, j)
            i = j + 1
        elif match := CHAR.match(text, i):
            i = match.end()
        elif char == "'":
            i += 1
        elif match := IDENT.match(text, i):
            tokens.append((line, match[0]))
            i = match.end()
        else:
            tokens.append((line, char))
            i += 1
    return tokens


def matching(tokens: list[tuple[int, str]], i: int) -> int:
    """The index of the bracket that closes the one at `i`."""
    depth = 0
    for k in range(i, len(tokens)):
        tok = tokens[k][1]
        if tok in "([{":
            depth += 1
        elif tok in ")]}":
            depth -= 1
            if depth == 0:
                return k
    return len(tokens) - 1


# Items that end at a semicolon or at the brace that closes their body.
BODY_ITEMS = {"fn", "struct", "enum", "union", "impl", "mod", "trait", "macro_rules", "extern"}
# Items that end at a semicolon, whatever braces come before it.
STATEMENT_ITEMS = {"const", "static", "let", "type", "use"}
QUALIFIERS = {"pub", "async", "unsafe", "default"}


def item_end(tokens: list[tuple[int, str]], i: int) -> int:
    """The index of the last token of the item, field, arm or statement at `i`.

    A generic type's angle brackets aren't counted as brackets, since < and >
    are also operators, so the comma in `Result<(), String>` is at the same
    depth as the comma after a field. That's why an item like a function only
    ends at a semicolon or at the brace that closes its body.
    """
    k = i
    while k < len(tokens) and tokens[k][1] in QUALIFIERS:
        # A visibility like pub(in crate::player) is one qualifier.
        if tokens[k][1] == "pub" and k + 1 < len(tokens) and tokens[k + 1][1] == "(":
            k = matching(tokens, k + 1)
        k += 1
    word = tokens[k][1] if k < len(tokens) else ""
    if word == "const" and k + 1 < len(tokens) and tokens[k + 1][1] in BODY_ITEMS | {"unsafe", "async", "extern"}:
        word = "fn"
    mode = "body" if word in BODY_ITEMS else "statement" if word in STATEMENT_ITEMS else "list"
    depth = 0
    for k in range(i, len(tokens)):
        tok = tokens[k][1]
        if tok in "([{":
            depth += 1
        elif tok in ")]}":
            depth -= 1
            if depth < 0:
                return k - 1
            if depth == 0 and tok == "}" and mode != "statement":
                return k
        elif depth == 0 and (tok == ";" or (tok == "," and mode == "list")):
            return k
    return len(tokens) - 1


def cfg_test(tokens: list[str], i: int) -> tuple[bool, int]:
    """Whether the cfg predicate at `i` only holds in a test build, and where it ends."""
    name = tokens[i]
    i += 1
    if i < len(tokens) and tokens[i] == "(":
        args = []
        i += 1
        while i < len(tokens) and tokens[i] != ")":
            if tokens[i] == ",":
                i += 1
                continue
            result, i = cfg_test(tokens, i)
            args.append(result)
        i += 1
        if name == "all":
            return any(args), i
        if name == "any":
            return bool(args) and all(args), i
        return False, i
    if i < len(tokens) and tokens[i] == "=":
        return False, i + 2
    return name == "test", i


def test_attribute(tokens: list[str]) -> bool:
    """Whether an attribute's tokens make its item test code. That's #[test] or a
    path that ends in ::test, like #[tokio::test(flavor = "multi_thread")], or a
    cfg that only holds in a test build."""
    end = next((k for k, tok in enumerate(tokens) if tok in ("(", "=")), len(tokens))
    if tokens[:end] == ["test"] or tokens[max(end - 3, 0) : end] == [":", ":", "test"]:
        return True
    if len(tokens) > 2 and tokens[0] == "cfg" and tokens[1] == "(":
        return cfg_test(tokens, 2)[0]
    return False


@dataclass
class Function:
    name: str
    first: int
    last: int


@dataclass
class RustScan:
    # Every line is test code, from an inner #![cfg(test)].
    whole: bool = False
    # The first and last lines of each test item.
    spans: list[tuple[int, int]] = field(default_factory=list)
    # The modules declared in test code, as the inline modules around them,
    # the name and any #[path]. An inline module is None when a #[path] moves
    # it, and the #[path] is "" when it isn't a plain string.
    test_mods: list[tuple[list[str | None], str, str | None]] = field(default_factory=list)
    functions: list[Function] = field(default_factory=list)

    def test_lines(self) -> set[int]:
        return {line for first, last in self.spans for line in range(first, last + 1)}


def module_item(tokens: list[tuple[int, str]], i: int) -> tuple[str, str, int] | None:
    """A module at `i`, after any `pub(...)`, as its name, the `;` or `{` that
    follows the name, and that token's index."""
    k = i
    if tokens[k][1] == "pub":
        k += 1
        if k < len(tokens) and tokens[k][1] == "(":
            k = matching(tokens, k) + 1
    if (
        k + 2 < len(tokens)
        and tokens[k][1] == "mod"
        and IDENT.fullmatch(tokens[k + 1][1])
        and tokens[k + 2][1] in (";", "{")
    ):
        return tokens[k + 1][1], tokens[k + 2][1], k + 2
    return None


def path_attribute(attr: list[str]) -> str | None:
    """The string a #[path = "..."] gives, "" when it gives something else, or
    None for another attribute."""
    if attr[:2] != ["path", "="]:
        return None
    return attr[2] if len(attr) == 3 and attr[2][:1] in ('"', "r") else ""


def scan_test_item(
    tokens: list[tuple[int, str]],
    i: int,
    end: int,
    outer: list[str | None],
    path: str | None,
    scan: RustScan,
) -> None:
    """Adds the functions and module declarations of the test item from `i` to
    `end` to `scan`. `outer` holds the inline modules around the item, and
    `path` is the item's own #[path]."""
    # The inline modules inside the item, with the depth inside each, so that
    # `mod helpers;` in `mod tests { ... }` is found under tests/.
    local: list[tuple[str | None, int]] = []
    level = 0
    # The #[path] for the next item.
    pending = path
    k = i
    while k <= end:
        tok = tokens[k][1]
        inner = tok == "#" and k + 1 <= end and tokens[k + 1][1] == "!"
        bracket = k + (2 if inner else 1)
        if tok == "#" and bracket <= end and tokens[bracket][1] == "[":
            close = matching(tokens, bracket)
            found = path_attribute([t for _, t in tokens[bracket + 1 : close]])
            if not inner and found is not None:
                pending = found
            k = close + 1
            continue
        module = module_item(tokens, k)
        if module is not None:
            name, kind, at = module
            if kind == ";":
                scan.test_mods.append((outer + [n for n, _ in local], name, pending))
            else:
                level += 1
                local.append((name if pending is None else None, level))
            pending = None
            k = at + 1
            continue
        if tok == "fn" and k + 1 < len(tokens) and IDENT.fullmatch(tokens[k + 1][1]):
            last = item_end(tokens, k)
            scan.functions.append(Function(tokens[k + 1][1], tokens[k][0], tokens[last][0]))
        if tok in "([{":
            level += 1
        elif tok in ")]}":
            if tok == "}" and local and local[-1][1] == level:
                local.pop()
            level -= 1
        if tok in (";", "{", "}"):
            pending = None
        k += 1


def scan_rust(text: str) -> RustScan:
    """Finds the test code, test modules and functions in Rust source."""
    tokens = rust_tokens(text)
    scan = RustScan()
    # The inline modules around the current token, with the brace depth inside each.
    modules: list[tuple[str, int]] = []
    depth = 0
    attrs: list[tuple[int, list[str]]] = []
    i = 0
    while i < len(tokens):
        line, tok = tokens[i]
        inner = tok == "#" and i + 1 < len(tokens) and tokens[i + 1][1] == "!"
        bracket = i + (2 if inner else 1)
        if tok == "#" and bracket < len(tokens) and tokens[bracket][1] == "[":
            close = matching(tokens, bracket)
            attr = [t for _, t in tokens[bracket + 1 : close]]
            if inner and depth == 0 and test_attribute(attr):
                scan.whole = True
            elif not inner:
                attrs.append((line, attr))
            i = close + 1
            continue
        first = attrs[0][0] if attrs else line
        test = any(test_attribute(attr) for _, attr in attrs)
        path = next((p for _, attr in attrs if (p := path_attribute(attr)) is not None), None)
        attrs = []
        if not test and tok == "fn" and i + 1 < len(tokens) and IDENT.fullmatch(tokens[i + 1][1]):
            end = item_end(tokens, i)
            scan.functions.append(Function(tokens[i + 1][1], first, tokens[end][0]))
        if test:
            end = item_end(tokens, i)
            scan.spans.append((first, tokens[end][0]))
            scan_test_item(tokens, i, end, [name for name, _ in modules], path, scan)
            i = end + 1
            continue
        module = module_item(tokens, i)
        if module is not None and module[1] == "{":
            depth += 1
            modules.append((module[0] if path is None else None, depth))
            i = module[2] + 1
            continue
        if tok in "([{":
            depth += 1
        elif tok in ")]}":
            if tok == "}" and modules and modules[-1][1] == depth:
                modules.pop()
            depth -= 1
        i += 1
    return scan


def string_value(literal: str) -> str:
    """The text of a plain string literal from a #[path]."""
    if literal.startswith("r"):
        return literal.strip("r#")[1:-1]
    return literal[1:-1].replace('\\"', '"').replace("\\\\", "\\")


@dataclass
class Crate:
    package: str
    folder: str

    def owns(self, path: str) -> bool:
        return path.startswith(self.folder + "/src/") and path.endswith(".rs")


def crates() -> list[Crate]:
    workspace = tomllib.loads((ROOT / "Cargo.toml").read_text(encoding="utf-8"))["workspace"]
    out = []
    for folder in workspace["members"]:
        if any(c in folder for c in "*?["):
            raise SystemExit(f"Cargo.toml lists the member {folder} as a glob, which this can't read")
        manifest = tomllib.loads((ROOT / folder / "Cargo.toml").read_text(encoding="utf-8"))
        out.append(Crate(manifest["package"]["name"], folder.rstrip("/")))
    return out


def test_modules(crate: Crate) -> tuple[set[str], list[str]]:
    """The files of the crate's test modules, and the folders that hold their
    submodules."""
    files: set[str] = set()
    folders: list[str] = []
    root = ROOT.resolve()
    for source in sorted((root / crate.folder / "src").rglob("*.rs")):
        rel = source.relative_to(root).as_posix()
        try:
            text = source.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            # A file this can't read might declare test modules, so the check
            # stops rather than count their lines.
            what = "is a link to nothing" if source.is_symlink() and not source.exists() else "can't be read"
            raise SystemExit(
                f"{rel} {what}, so the check can't tell whether it declares test modules."
                f" Fix or delete it. {error}"
            ) from None
        scan = scan_rust(text)
        here = source.parent
        children = here if source.name in ("mod.rs", "lib.rs", "main.rs") else here / source.stem
        for inside, name, literal in scan.test_mods:
            if None in inside or literal == "" or (literal is not None and inside):
                # A #[path] inside an inline module, or on one, is read from
                # a folder this doesn't work out, and one that isn't a plain
                # string can't be read here. The files it names count.
                continue
            if literal is not None:
                # rustc reads a file that a #[path] names as if it were a
                # mod.rs, so its own modules sit next to it. That folder can
                # hold other code, so only the file itself is test code.
                target = (here / string_value(literal)).resolve()
                if target.is_relative_to(root) and target.is_file():
                    files.add(target.relative_to(root).as_posix())
                continue
            base = children.joinpath(*inside)
            for candidate in (base / f"{name}.rs", base / name / "mod.rs"):
                if candidate.exists():
                    files.add(candidate.relative_to(root).as_posix())
            folders.append((base / name).relative_to(root).as_posix() + "/")
        if scan.whole:
            files.add(rel)
    return files, folders


@dataclass
class FunctionLeftOut:
    """Changed lines in a function that an exclusion entry leaves out."""

    path: str
    function: str
    # The name or glob in the entry's functions that matches.
    pattern: str
    entry: int
    reason: str
    lines: list[int]

    def warning(self) -> str:
        what = f"line {self.lines[0]}" if len(self.lines) == 1 else f"lines {show_ranges(self.lines)}"
        return (
            f"{EXCLUDE_FILE}, entry {self.entry}, leaves out {what} of {self.function} in"
            f" {self.path}, which this change adds or changes, since {self.pattern} matches"
            " the function's name. Check that the entry means to leave out this function."
        )


@dataclass
class RustFiles:
    """Which changed lines of each crate's files are test code."""

    crates: list[Crate]
    change: Change
    cache: dict[str, tuple[set[str], list[str]]] = field(default_factory=dict)

    def crate(self, path: str) -> Crate | None:
        return next((c for c in self.crates if c.owns(path)), None)

    def test_file(self, path: str) -> bool:
        crate = self.crate(path)
        if crate is None:
            return True
        if crate.package not in self.cache:
            self.cache[crate.package] = test_modules(crate)
        files, folders = self.cache[crate.package]
        return path in files or any(path.startswith(folder) for folder in folders)

    def counted(
        self, path: str, lines: list[int], exclusions: list[Exclusion]
    ) -> tuple[list[int], list[FunctionLeftOut]]:
        """The lines of `lines` that aren't test code or in an excluded
        function, and the changed lines each function entry leaves out."""
        if self.test_file(path):
            return [], []
        scan = scan_rust(self.change.source(path).decode("utf-8"))
        if scan.whole:
            return [], []
        tests = scan.test_lines()
        skip = set(tests)
        left_out = []
        for number, entry in enumerate(exclusions, start=1):
            if not entry.functions or not entry.matches(path):
                continue
            for fn in scan.functions:
                pattern = next((name for name in entry.functions if fnmatchcase(fn.name, name)), None)
                if pattern is None:
                    continue
                skip.update(range(fn.first, fn.last + 1))
                dropped = [line for line in lines if fn.first <= line <= fn.last and line not in tests]
                if dropped:
                    left_out.append(FunctionLeftOut(path, fn.name, pattern, number, entry.reason, dropped))
        return [line for line in lines if line not in skip], left_out


# ---------------------------------------------------------------------------
# The counted files.


def frontend_file(path: str) -> bool:
    return (
        path.startswith(FRONTEND_SRC)
        and path.endswith((".ts", ".tsx"))
        and not path.endswith(".d.ts")
        and not re.search(r"\.(?:test|spec)\.tsx?$", path)
        and not path.startswith(FRONTEND_SRC + "test/")
    )


@dataclass
class Counted:
    """The changed lines each check counts, by file."""

    frontend: dict[str, list[int]]
    rust: dict[str, list[int]]
    # Files left out by an entry in the exclusion file, with its reason.
    excluded: dict[str, str]
    # Changed lines left out by an entry's functions.
    functions: list[FunctionLeftOut] = field(default_factory=list)


def counted(change: Change, exclusions: list[Exclusion]) -> Counted:
    rust_files = RustFiles(crates(), change)
    folders = [c.folder for c in rust_files.crates]
    added = change.added(FRONTEND_SRC, *folders)
    frontend: dict[str, list[int]] = {}
    rust: dict[str, list[int]] = {}
    excluded: dict[str, str] = {}
    functions: list[FunctionLeftOut] = []
    for path, lines in sorted(added.items()):
        is_frontend, is_rust = frontend_file(path), rust_files.crate(path) is not None
        if not (is_frontend or is_rust):
            continue
        entry = file_exclusion(exclusions, path)
        if entry is not None:
            excluded[path] = entry.reason
        elif is_frontend:
            frontend[path] = lines
        else:
            lines, left_out = rust_files.counted(path, lines, exclusions)
            functions += left_out
            if lines:
                rust[path] = lines
    return Counted(frontend, rust, excluded, functions)


# ---------------------------------------------------------------------------
# plan


# Files for Stryker's --mutate, by their names in apps/player, with the
# ranges of lines to mutate in each, or None for the whole file.
Spans = dict[str, list[tuple[int, int]] | None]


def stryker_name_error(path: str) -> str | None:
    """An error when Stryker can't take `path` in --mutate, or None."""
    if STRYKER_BAD_NAME.search(path) or "\udc80" <= max(path) <= "\udcff":
        return annotation(
            "error",
            "Not checked",
            f"Stryker can't take the name {path} in --mutate. Rename the file so"
            " the check can run on it.",
        )
    return None


def stryker_library() -> tuple[list[str], list[str]]:
    """The files in src/lib that the mutate globs in stryker.config.mjs give,
    and an error for each one Stryker can't take in --mutate. A test checks
    that the two lists agree."""
    names: list[str] = []
    errors: list[str] = []
    for path in sorted((ROOT / FRONTEND_SRC / "lib").rglob("*")):
        name = path.relative_to(ROOT / FRONTEND).as_posix()
        if not path.is_file() or not frontend_file(FRONTEND + name) or name == "src/lib/types.ts":
            continue
        error = stryker_name_error(FRONTEND + name)
        if error:
            errors.append(error)
        else:
            names.append(name)
    return names, errors


def mutate_text(files: Spans) -> str:
    """`files` as Stryker's --mutate takes them, like src/lib/a.ts:3-5,src/lib/b.ts."""
    return ",".join(
        part
        for name, spans in files.items()
        for part in ([name] if spans is None else [f"{name}:{a}-{b}" for a, b in spans])
    )


def stryker_shards(files: Spans) -> list[tuple[list[str], int]]:
    """Splits `files` into shards of about LINES_PER_STRYKER_SHARD lines, and
    gives the names in each shard with its number of lines. A file stays in
    one shard, so its mutants are in one report. The largest file goes first,
    and each one goes to the shard with the fewest lines so far."""
    weights = {
        name: line_count(FRONTEND + name) if spans is None else sum(b - a + 1 for a, b in spans)
        for name, spans in files.items()
    }
    count = -(-sum(weights.values()) // LINES_PER_STRYKER_SHARD)
    count = max(1, min(MAX_SHARDS, len(files), count))
    shards: list[list[str]] = [[] for _ in range(count)]
    loads = [0] * count
    for name in sorted(weights, key=lambda name: (-weights[name], name)):
        k = loads.index(min(loads))
        shards[k].append(name)
        loads[k] += weights[name]
    return [(sorted(names), load) for names, load in zip(shards, loads)]


def stryker_matrix(mutate: Spans, lines: Spans) -> str:
    """The matrix of Stryker shards, as JSON for the workflow. Each shard has
    the files it mutates and the changed lines in them, which its job checks.
    It prints the size of each shard for the log."""
    shards = stryker_shards(mutate)
    include = []
    for k, (names, weight) in enumerate(shards):
        print(f"Stryker shard {k} of {len(shards)}: {weight} lines in {len(names)} files")
        include.append(
            {
                "shard": k,
                "shards": len(shards),
                "mutate": mutate_text({name: mutate[name] for name in names}),
                "lines": mutate_text({name: lines[name] for name in names if name in lines}),
            }
        )
    return json.dumps({"include": include}, separators=(",", ":"))


def stryker_plan(change: Change, exclusions: list[Exclusion]) -> tuple[dict[str, str], list[str]]:
    """The outputs for the frontend mutation job, and the errors that stop it."""
    added = change.added(FRONTEND_SRC)
    errors: list[str] = []
    names: dict[str, list[int]] = {}
    for path, lines in sorted(added.items()):
        if not frontend_file(path) or file_exclusion(exclusions, path) is not None:
            continue
        error = stryker_name_error(path)
        if error:
            errors.append(error)
            continue
        names[path[len(FRONTEND) :]] = lines
    # Git counts lines by LF alone, but Stryker's parser also ends a line at a
    # U+2028, a U+2029 or a CR that no LF follows. In a file with one of
    # those, the ranges would miss the lines the change makes, so the job
    # fails for it. An escape like   and a CRLF line ending are fine.
    for name in list(names):
        if STRYKER_BREAKS.search(change.source(FRONTEND + name)):
            errors.append(
                annotation(
                    "error",
                    "Not checked",
                    f"{FRONTEND}{name} has a U+2028, a U+2029 or a CR that no LF follows,"
                    " which Stryker counts as a line break and git doesn't. Write a U+2028"
                    " or a U+2029 as an escape like \\u2028, and replace each CR that no LF"
                    " follows with an LF, so the check can run on the file.",
                )
            )
            del names[name]
    changed = change.names()
    versions = git(
        *DIFF, "--text", "-U0", *change.revs(), "--", FRONTEND + "package.json"
    ).decode("utf-8", "replace")
    setup = any(STRYKER_SETUP.fullmatch(n) for n in changed) or bool(STRYKER_TOOLS.search(versions))
    lines: Spans = {name: ranges(found) for name, found in names.items()}
    if not lines and (setup or STRYKER_CANARY_TRIGGERS.intersection(changed)):
        if (ROOT / FRONTEND / STRYKER_CANARY).is_file():
            lines = {STRYKER_CANARY: None}
        else:
            errors.append(
                annotation(
                    "error",
                    "No canary",
                    f"{STRYKER_CANARY} is gone. Pick another file for the check to run on.",
                )
            )
    mutate = lines
    if setup:
        # Every file in src/lib, and the changed lines in other files, such as
        # a component or src/lib/types.ts. A file that --mutate names whole is
        # mutated whole.
        library, library_errors = stryker_library()
        errors += [error for error in library_errors if error not in errors]
        mutate = dict.fromkeys(library) | {n: s for n, s in lines.items() if n not in library}
    run = bool(lines or errors)
    out = {
        "run": str(run).lower(),
        "lines": mutate_text(lines),
        "full": str(setup).lower(),
        "mutate": mutate_text(mutate),
        "matrix": stryker_matrix(mutate, lines) if run else "",
    }
    return out, errors


def has_cargo_mutants() -> bool:
    try:
        result = subprocess.run(
            ["cargo", "mutants", "--version"],
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        return False
    return result.returncode == 0


def list_mutants(package: str, diff: Path) -> int:
    result = subprocess.run(
        ["cargo", "mutants", "--list", "--json", "--in-diff", str(diff), "-p", package],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
    )
    # cargo-mutants exits with 0 and lists nothing when the diff holds no
    # mutants for the package.
    if result.returncode != 0:
        raise SystemExit(f"cargo mutants --list for {package} failed with exit code {result.returncode}")
    text = result.stdout.decode("utf-8").strip()
    return len(json.loads(text)) if text.startswith("[") else 0


def rust_diff(change: Change) -> bytes:
    """The diff of the crates for cargo-mutants. It leaves out the mutants
    that .cargo/mutants.toml names, so the exclusion file doesn't apply."""
    return change.text(*[c.folder for c in crates()])


def write_outputs(path: str | None, outputs: dict[str, str]) -> None:
    text = "".join(f"{key}={value}\n" for key, value in outputs.items())
    if path:
        with open(path, "a", encoding="utf-8") as out:
            out.write(text)
    else:
        sys.stdout.write(text)


def plan(args: argparse.Namespace) -> int:
    change = Change(args.base, args.head)
    exclusions = load_exclusions()
    for warning in stale_exclusions(exclusions):
        print(annotation("warning", "Exclusion", warning))
    found = counted(change, exclusions)
    # What the change stops checking, for a reviewer to look at.
    notes = []
    for warning in widened_exclusions(change, exclusions):
        print(annotation("warning", "Exclusion added", warning))
        notes.append(warning)
    for left_out in found.functions:
        warning = left_out.warning()
        print(
            annotation(
                "warning", "Function left out", warning, left_out.path, left_out.lines[0], left_out.lines[-1]
            )
        )
        notes.append(warning)
    for title, warning in changed_mutants_settings(change):
        print(annotation("warning", title, warning, MUTANTS_CONFIG))
        notes.append(warning)
    for path, line, warning in new_mutant_skips(change):
        print(annotation("warning", "Mutants left out", warning, path, line))
        notes.append(warning)
    if notes and args.summary:
        with open(args.summary, "a", encoding="utf-8") as summary:
            summary.write("## Exclusions\n\n" + "".join(f"- {note}\n" for note in notes))
    stryker, _ = stryker_plan(change, exclusions)
    outputs = {
        "frontend": str(bool(found.frontend)).lower(),
        "rust": str(bool(found.rust)).lower(),
        "stryker": stryker["run"],
        "stryker-matrix": stryker["matrix"],
    }
    if args.shards:
        diff = Path(args.shards)
        diff.write_bytes(rust_diff(change))
        include = []
        checked = False
        for crate in crates():
            # cargo-mutants only mutates the lines a change adds to .rs files.
            if not any(path.endswith(".rs") for path in change.added(crate.folder)):
                print(f"{crate.package}: no changed .rs lines")
                continue
            if not checked and not has_cargo_mutants():
                raise SystemExit(
                    "Counting the mutants in the changed .rs lines needs cargo-mutants, which"
                    " isn't installed. Install it, or run pnpm check:changed with --no-mutation."
                )
            checked = True
            count = list_mutants(crate.package, diff)
            print(f"{crate.package}: {count} mutants in the changed lines")
            if not count:
                continue
            per = MUTANTS_PER_SHARD.get(crate.package, 50)
            shards = min(MAX_SHARDS, -(-count // per))
            include += [
                {"package": crate.package, "shard": k, "shards": shards} for k in range(shards)
            ]
        outputs["matrix"] = json.dumps({"include": include}, separators=(",", ":")) if include else ""
        outputs["app"] = str(any(e["package"] == "max-video-player" for e in include)).lower()
    for key, value in outputs.items():
        print(f"{key}: {value}")
    write_outputs(args.output, outputs)
    return 0


def stryker(args: argparse.Namespace) -> int:
    if args.all:
        library, errors = stryker_library()
        files = dict.fromkeys(library)
        outputs = {"mutate": mutate_text(files), "matrix": stryker_matrix(files, {})}
    else:
        outputs, errors = stryker_plan(Change(args.base, args.head), load_exclusions())
    for error in errors:
        print(error)
    write_outputs(args.output, outputs)
    return 1 if errors else 0


def write_rust_diff(args: argparse.Namespace) -> int:
    Path(args.out).write_bytes(rust_diff(Change(args.base, args.head)))
    return 0


# ---------------------------------------------------------------------------
# coverage


def read_lcov(path: str, base: Path) -> dict[str, dict[int, int]]:
    """The hits on each line of each file in an lcov report, by path from the
    repo root. A relative path in the report is relative to `base`."""
    root = os.path.realpath(ROOT)
    hits: dict[str, dict[int, int]] = {}
    current: dict[int, int] | None = None
    with open(path, encoding="utf-8", errors="surrogateescape") as report:
        for line in report:
            line = line.rstrip("\n")
            if line.startswith("SF:"):
                name = Path(line[3:])
                full = os.path.realpath(name if name.is_absolute() else base / name)
                rel = os.path.relpath(full, root)
                current = None if rel.startswith("..") else hits.setdefault(Path(rel).as_posix(), {})
            elif line.startswith("DA:") and current is not None:
                number, count = line[3:].split(",")[:2]
                current[int(number)] = max(current.get(int(number), 0), int(float(count)))
            elif line == "end_of_record":
                current = None
    return hits


@dataclass
class FileCoverage:
    path: str
    counted: list[int]
    uncovered: list[int]


def share_text(covered: int, total: int) -> str:
    """The covered share as a percentage, rounded down so that a share just
    under the threshold never shows as the threshold."""
    tenths = 1000 * covered // total
    return f"{tenths // 10}.{tenths % 10}%"


def coverage(args: argparse.Namespace) -> int:
    change = Change(args.base, args.head)
    found = counted(change, load_exclusions())
    sections = []
    if args.frontend_lcov:
        sections.append(("Frontend", found.frontend, read_lcov(args.frontend_lcov, ROOT / FRONTEND)))
    if args.rust_lcov:
        sections.append(("Rust", found.rust, read_lcov(args.rust_lcov, ROOT)))
    if not sections:
        raise SystemExit("coverage needs --frontend-lcov or --rust-lcov")

    status = 0
    out = [f"## {args.title}", ""]
    out += ["| Code | Lines counted | Covered | Coverage | Result |", "| --- | ---: | ---: | ---: | --- |"]
    details: list[str] = []
    annotations: list[str] = []
    for language, files, hits in sections:
        if language == "Rust" and not hits:
            # cargo-llvm-cov writes a record for every file the tests build,
            # so a report without one means the tests didn't run.
            status = 1
            annotations.append(
                annotation(
                    "error",
                    "No coverage data",
                    "cargo-llvm-cov's report has no data for any file in the repo, so the Rust"
                    " tests didn't run or the report didn't come through.",
                )
            )
            out.append(f"| {language} | n/a | n/a | n/a | fails, the report has no data |")
            continue
        results: list[FileCoverage] = []
        no_data: list[str] = []
        for path, lines in files.items():
            data = hits.get(path)
            if data is None:
                no_data.append(path)
                # Vitest reports every file in src that a test could load,
                # even one no test does, so a missing frontend file means the
                # report doesn't match the change. Rust coverage has no data
                # for code that Linux doesn't build.
                if language == "Frontend":
                    status = 1
                    annotations.append(
                        annotation(
                            "error",
                            "No coverage data",
                            "Vitest's coverage report has no data for this file, which this"
                            " change adds or changes. Check that vitest.config.ts includes it.",
                            path,
                        )
                    )
                continue
            lines_counted = [n for n in lines if n in data]
            if lines_counted:
                results.append(FileCoverage(path, lines_counted, [n for n in lines_counted if data[n] == 0]))
        total = sum(len(r.counted) for r in results)
        missed = sum(len(r.uncovered) for r in results)
        if not total:
            out.append(f"| {language} | 0 | 0 | n/a | passes, nothing to count |")
        else:
            passes = 100 * (total - missed) >= THRESHOLD * total
            result = "passes" if passes else f"fails, under {THRESHOLD:g}%"
            out.append(
                f"| {language} | {total} | {total - missed} | {share_text(total - missed, total)} | {result} |"
            )
            if not passes:
                status = 1
            kind = "warning" if passes else "error"
            for r in results:
                for a, b in ranges(r.uncovered):
                    lines = f"line {a}" if a == b else f"lines {a} to {b}"
                    annotations.append(
                        annotation(
                            kind,
                            "Not covered",
                            f"No test runs {lines}, which this change adds or changes.",
                            r.path,
                            a,
                            b,
                        )
                    )
        if results:
            details += ["", f"### {language}", "", "| File | Counted | Uncovered | Uncovered lines |"]
            details += ["| --- | ---: | ---: | --- |"]
            for r in sorted(results, key=lambda r: (-len(r.uncovered), r.path)):
                details.append(
                    f"| {code(r.path)} | {len(r.counted)} | {len(r.uncovered)}"
                    f" | {show_ranges(r.uncovered) or 'none'} |"
                )
        if no_data and language == "Frontend":
            details += ["", "No frontend coverage data for these changed files, which fails the check:", ""]
            details += [f"- {code(path)}" for path in no_data]
        elif no_data:
            details += ["", f"No {language.lower()} coverage data for these changed files, so they don't count:", ""]
            details += [f"- {code(path)}" for path in no_data]
    out += [
        "",
        f"Only the lines the change adds or changes count, and only those the coverage"
        f" tool can run. Each part needs at least {THRESHOLD:g}% of them covered.",
    ]
    out += details
    functions = found.functions if args.rust_lcov else []
    if found.excluded or functions:
        out += ["", f"Left out by `{EXCLUDE_FILE}`:", ""]
        out += [f"- {code(path)}: {reason}" for path, reason in found.excluded.items()]
        out += [
            f"- {code(f.function)} in {code(f.path)}, lines {show_ranges(f.lines)}, by entry {f.entry}: {f.reason}"
            for f in functions
        ]
    text = "\n".join(out) + "\n"
    if args.summary:
        with open(args.summary, "a", encoding="utf-8") as summary:
            summary.write(text)
    else:
        print(text)
    for line in annotations:
        print(line)
    return status


# ---------------------------------------------------------------------------
# mutants


def fn_line(lines: list[str], first: int, body: int) -> int:
    """The line of `fn` in a function whose attributes start at `first`."""
    for number in range(first, body + 1):
        text = lines[number - 1] if number <= len(lines) else ""
        if not text.lstrip().startswith("//") and re.search(r"\bfn\b", text):
            return number
    return first


def skip_comment_lines(mutant: dict, lines: list[str]) -> list[int]:
    """The lines a skip comment for `mutant` may sit on."""
    start = mutant["span"]["start"]["line"]
    function = mutant.get("function")
    if mutant.get("genre") == "FnValue" and function:
        first = function["span"]["start"]["line"]
        return list(range(first - 1, fn_line(lines, first, start)))
    return [start - 1]


def check_mutant(mutant: dict, lines: list[str]) -> tuple[str | None, list[str]]:
    """The reason of the skip comment that covers `mutant`, if one does, and the
    problems with any comment near it that doesn't."""
    genre = mutant.get("genre", "")
    problems = []
    for number in skip_comment_lines(mutant, lines):
        if number < 1 or number > len(lines):
            continue
        text = lines[number - 1]
        match = SKIP.fullmatch(text)
        if match is None:
            if SKIP_MENTION.search(text):
                problems.append(
                    f"The comment on line {number} isn't `// mutants: skip <genre>: <reason>`"
                    " alone on its line."
                )
            continue
        names = [name.strip() for name in match[1].split(",")]
        unknown = [name for name in names if name not in GENRES]
        if unknown:
            problems.append(
                f"The comment on line {number} names {', '.join(unknown)}, which isn't one of"
                f" {', '.join(GENRES)}."
            )
        elif genre not in names:
            problems.append(f"The comment on line {number} doesn't name {genre}.")
        elif not match[2].strip():
            problems.append(f"The comment on line {number} doesn't say why no test can catch it.")
        else:
            return match[2].strip(), []
    return None, problems


# What cargo-mutants says about a mutant in outcomes.json.
MUTANT_SUMMARIES = {"CaughtMutant", "MissedMutant", "Timeout", "Unviable"}


def has_line(span: object) -> bool:
    """Whether a span in outcomes.json has a start line."""
    start = span.get("start") if isinstance(span, dict) else None
    line = start.get("line") if isinstance(start, dict) else None
    return isinstance(line, int) and not isinstance(line, bool) and line >= 1


def mutant_problem(mutant: dict) -> str | None:
    """What a mutant in outcomes.json lacks that the check reads, if anything."""
    if not all(isinstance(mutant.get(key), str) for key in ("file", "name", "genre")):
        return "no file, name or genre"
    if not has_line(mutant.get("span")):
        return "no line"
    function = mutant.get("function")
    if function is not None and (not isinstance(function, dict) or not has_line(function.get("span"))):
        return "a function with no line"
    return None


def shown(value: object) -> str:
    """Up to 200 characters of `value` as JSON, for an error message."""
    try:
        return json.dumps(value)[:200]
    except (RecursionError, ValueError):
        return "a value nested too deeply to show"


def read_outcomes(folder: str) -> tuple[list[dict], str | None]:
    """The mutants cargo-mutants missed in `folder`, or why its results can't
    be read. The plan only starts a run that has mutants to test, so a run
    without any had a problem."""
    outcomes = Path(folder) / "outcomes.json"
    if not outcomes.is_file():
        return [], f"{outcomes} is missing, so cargo-mutants didn't finish."
    try:
        data = json.loads(outcomes.read_text(encoding="utf-8"))
    except (ValueError, RecursionError) as error:
        # ValueError covers bad UTF-8, bad JSON and a number too long to read.
        return [], f"{outcomes} isn't JSON this check can read: {error}"
    entries = data.get("outcomes") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        return [], f"{outcomes} has no list of outcomes."
    missed = []
    tested = 0
    for outcome in entries:
        if not isinstance(outcome, dict):
            return [], f"{outcomes} has an outcome this check can't read: {shown(outcome)}"
        scenario = outcome.get("scenario")
        if scenario == "Baseline":
            continue
        if not isinstance(scenario, dict) or not isinstance(scenario.get("Mutant"), dict):
            return [], f"{outcomes} has a scenario this check can't read: {shown(scenario)}"
        problem = mutant_problem(scenario["Mutant"])
        if problem is not None:
            return [], f"{outcomes} has a mutant with {problem}: {shown(scenario['Mutant'])}"
        summary = outcome.get("summary")
        if not isinstance(summary, str) or summary not in MUTANT_SUMMARIES:
            return [], f"{outcomes} has a mutant whose summary is {shown(summary)}, which this check doesn't know."
        tested += 1
        if summary == "MissedMutant":
            missed.append(scenario["Mutant"])
    if not tested:
        return [], f"{outcomes} has no mutants, though the plan found some to test."
    return missed, None


def repo_lines(path: str) -> list[str] | None:
    """The lines of a file in the repo as cargo-mutants numbers them, or None
    when it isn't a UTF-8 file inside the repo."""
    root = ROOT.resolve()
    file = (root / path).resolve()
    if not file.is_relative_to(root) or not file.is_file():
        return None
    try:
        # cargo-mutants numbers lines by LF alone, as git does.
        return file.read_bytes().decode("utf-8").split("\n")
    except (OSError, UnicodeDecodeError):
        return None


def mutants(args: argparse.Namespace) -> int:
    missed = []
    for folder in args.folders:
        found, problem = read_outcomes(folder)
        if problem is not None:
            print(annotation("error", "No results", problem))
            return 1
        missed += found
    count = skipped = 0
    for mutant in sorted(missed, key=lambda m: (m["file"], m["span"]["start"]["line"])):
        path = mutant["file"]
        start = mutant["span"]["start"]
        description = mutant["name"].split(": ", 1)[-1]
        lines = repo_lines(path)
        if lines is None:
            count += 1
            message = (
                f"cargo-mutants made {description}, and no test failed. This check can't read"
                f" {path} as a UTF-8 file in the repo, so it can't look for a skip comment."
            )
            print(annotation("error", "Mutant missed", message, path, start["line"]))
            continue
        reason, problems = check_mutant(mutant, lines)
        genre = mutant.get("genre", "")
        if reason is not None:
            skipped += 1
            message = (
                f"cargo-mutants missed {description}, and a comment skips it, for the reason"
                f' "{reason.rstrip(".")}". Check that it still holds for the changed code.'
            )
            print(annotation("warning", "Mutant skipped", message, path, start["line"]))
            continue
        count += 1
        function = mutant.get("function")
        place = (
            f"alone on the line before line {function['span']['start']['line']}, above the"
            " function's doc comment and attributes"
            if genre == "FnValue" and function
            else f"alone on the line before line {start['line']}"
        )
        message = (
            f"cargo-mutants made {description}, and no test failed. Add a test that fails on"
            f" this change. If it does the same thing as the code, put"
            f" `// mutants: skip {genre}: <why>` {place}."
        )
        if problems:
            message += " " + " ".join(problems)
        print(annotation("error", "Mutant missed", message, path, start["line"]))
    if count:
        mutants_word = "mutant" if count == 1 else "mutants"
        print(f"{count} {mutants_word} in the changed lines survived with no skip comment.")
        if count > 10:
            print("GitHub shows at most 10 of them as annotations, and this log lists them all.")
        return 1
    if skipped:
        print(f"Every mutant in the changed lines was caught, or skipped by a comment ({skipped}).")
    else:
        print("Every mutant in the changed lines was caught.")
    return 0


# ---------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Check the code a change adds.")
    commands = parser.add_subparsers(dest="command", required=True)

    def with_diff(name: str, help: str, all_help: str | None = None) -> argparse.ArgumentParser:
        sub = commands.add_parser(name, help=help)
        base = sub
        if all_help:
            # --all stands in for --base.
            base = sub.add_mutually_exclusive_group(required=True)
            base.add_argument("--all", action="store_true", help=all_help)
        base.add_argument("--base", required=not all_help, help="the commit to compare with")
        sub.add_argument(
            "--head", help="the commit with the changes, or the working tree when left out"
        )
        return sub

    sub = with_diff("plan", "say which checks have lines to check")
    sub.add_argument("--output", help="append key=value lines here, as for $GITHUB_OUTPUT")
    sub.add_argument("--summary", help="append a Markdown list of the added exclusions here")
    sub.add_argument(
        "--shards", metavar="DIFF", help="write the Rust diff here and plan the mutant shards"
    )
    sub.set_defaults(run=plan)

    sub = with_diff(
        "stryker",
        "the lines for Stryker and their shards",
        all_help="the shards of all of src/lib, with no diff",
    )
    sub.add_argument("--output", help="append key=value lines here, as for $GITHUB_OUTPUT")
    sub.set_defaults(run=stryker)

    sub = with_diff("rust-diff", "the diff for cargo-mutants")
    sub.add_argument("out", metavar="DIFF")
    sub.set_defaults(run=write_rust_diff)

    sub = with_diff("coverage", "check changed-line coverage")
    sub.add_argument("--frontend-lcov", help="Vitest's lcov report")
    sub.add_argument("--rust-lcov", help="cargo-llvm-cov's lcov report")
    sub.add_argument("--summary", help="append the Markdown summary here")
    sub.add_argument("--title", default="Changed-line coverage")
    sub.set_defaults(run=coverage)

    sub = commands.add_parser("mutants", help="check cargo-mutants results")
    sub.add_argument("folders", nargs="+", metavar="MUTANTS_OUT")
    sub.set_defaults(run=mutants)

    args = parser.parse_args(argv)
    return args.run(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
