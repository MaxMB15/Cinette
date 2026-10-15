#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

"""
Tests for changed-code.py. Each test builds a small git repo with a made-up
workspace in a temp folder and points the script at it, so nothing here reads
the real repo or reaches the network.

  python3 -I scripts/changed-code-test.py
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parent / "changed-code.py"


def load_script():
    spec = importlib.util.spec_from_file_location("changed_code", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    # dataclasses look the module up by name while the file runs.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


cc = load_script()

# Git that ignores the user's own config and any repo the tests run inside.
GIT_ENV = {
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.invalid",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.invalid",
}
GIT_UNSET = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY")

WORKSPACE = {
    "Cargo.toml": '[workspace]\nmembers = ["crates/core"]\nresolver = "3"\n',
    "crates/core/Cargo.toml": '[package]\nname = "mvp-core"\n',
    "crates/core/src/lib.rs": "pub fn one() -> u8 {\n    1\n}\n",
    "apps/player/src/lib/a.ts": "export const a = 1;\n",
    "apps/player/src/lib/b.ts": "export const b = 2;\n",
    cc.EXCLUDE_FILE: "",
}


class RepoTest(unittest.TestCase):
    """A test with its own git repo as the script's ROOT."""

    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        # On macOS the temp folder is under /var, a link to /private/var.
        self.root = Path(folder.name).resolve()
        env = mock.patch.dict(os.environ, GIT_ENV)
        env.start()
        self.addCleanup(env.stop)
        for name in GIT_UNSET:
            os.environ.pop(name, None)
        root = mock.patch.object(cc, "ROOT", self.root)
        root.start()
        self.addCleanup(root.stop)
        self.git("init", "-q", "-b", "main")
        self.write(WORKSPACE)
        self.commit("base")

    def git(self, *args: str) -> None:
        subprocess.run(["git", *args], cwd=self.root, check=True, stdout=subprocess.DEVNULL)

    def write(self, files: dict[str, str | bytes]) -> None:
        for name, text in files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(text, bytes):
                path.write_bytes(text)
            else:
                path.write_text(text, encoding="utf-8")

    def commit(self, message: str) -> None:
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", message)

    def run_script(self, *args: str) -> tuple[int, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            status = cc.main(list(args))
        return status, out.getvalue()


class ExclusionFileTest(RepoTest):
    def test_files_must_be_a_list(self) -> None:
        self.write({cc.EXCLUDE_FILE: '[[exclude]]\nfiles = "apps/player/src/lib/a.ts"\nreason = "x"\n'})
        with self.assertRaises(SystemExit) as caught:
            cc.load_exclusions()
        self.assertIn("list of file globs", str(caught.exception))

    def test_entries_must_be_tables(self) -> None:
        self.write({cc.EXCLUDE_FILE: "exclude = [1]\n"})
        with self.assertRaises(SystemExit) as caught:
            cc.load_exclusions()
        self.assertIn("[[exclude]] table", str(caught.exception))

    def test_reads_a_good_entry(self) -> None:
        self.write(
            {
                cc.EXCLUDE_FILE: '[[exclude]]\nfiles = ["crates/core/src/lib.rs"]\n'
                'functions = ["one"]\nreason = " Needs a window. "\n'
            }
        )
        (entry,) = cc.load_exclusions()
        self.assertEqual(entry.files, ["crates/core/src/lib.rs"])
        self.assertEqual(entry.functions, ["one"])
        self.assertEqual(entry.reason, "Needs a window.")


class WidenedExclusionTest(RepoTest):
    def setUp(self) -> None:
        super().setUp()
        self.write({cc.EXCLUDE_FILE: '[[exclude]]\nfiles = ["apps/player/src/lib/a.ts"]\nreason = "x"\n'})
        self.commit("exclude a.ts")
        self.summary = self.root.parent / f"{self.root.name}-summary.md"
        self.addCleanup(self.summary.unlink, missing_ok=True)

    def plan(self) -> str:
        status, out = self.run_script(
            "plan", "--base", "HEAD^1", "--head", "HEAD", "--summary", str(self.summary)
        )
        self.assertEqual(status, 0)
        return out

    def test_warns_about_a_widened_glob(self) -> None:
        self.write({cc.EXCLUDE_FILE: '[[exclude]]\nfiles = ["apps/player/src/lib/*.ts"]\nreason = "x"\n'})
        self.commit("exclude more")
        out = self.plan()
        self.assertIn("::warning title=Exclusion added::", out)
        self.assertIn("leaves out the file apps/player/src/lib/b.ts,", out)
        self.assertNotIn("lib/a.ts,", out)
        summary = self.summary.read_text(encoding="utf-8")
        self.assertTrue(summary.startswith("## Exclusions\n\n- "))
        self.assertIn("apps/player/src/lib/b.ts", summary)

    def test_warns_about_an_added_function(self) -> None:
        self.write(
            {
                cc.EXCLUDE_FILE: '[[exclude]]\nfiles = ["apps/player/src/lib/a.ts"]\nreason = "x"\n'
                '[[exclude]]\nfiles = ["crates/core/src/lib.rs"]\nfunctions = ["one"]\nreason = "y"\n'
            }
        )
        self.commit("exclude a function")
        out = self.plan()
        self.assertIn("entry 2, leaves out the function one in crates/core/src/lib.rs,", out)
        self.assertNotIn("entry 1", out)

    def test_ignores_files_that_never_count(self) -> None:
        self.write(
            {
                "apps/player/src/lib/a.test.ts": "it('a', () => {});\n",
                cc.EXCLUDE_FILE: '[[exclude]]\nfiles = ["apps/player/src/lib/a*.ts"]\nreason = "x"\n',
            }
        )
        self.commit("exclude a test file")
        out = self.plan()
        self.assertNotIn("Exclusion added", out)
        self.assertFalse(self.summary.exists())

    def test_quiet_when_nothing_changes(self) -> None:
        self.write({"apps/player/src/lib/b.ts": "export const b = 3;\n"})
        self.commit("change b")
        out = self.plan()
        self.assertNotIn("Exclusion added", out)
        self.assertIn("frontend: true", out)
        self.assertFalse(self.summary.exists())

    def test_warns_about_changed_lines_in_an_excluded_function(self) -> None:
        self.write(
            {
                cc.EXCLUDE_FILE: '[[exclude]]\nfiles = ["crates/core/src/lib.rs"]\nfunctions = ["on*"]\nreason = "y"\n'
            }
        )
        self.commit("exclude one")
        self.write({"crates/core/src/lib.rs": WORKSPACE["crates/core/src/lib.rs"] + "pub fn only() -> u8 {\n    3\n}\n"})
        self.commit("add only")
        out = self.plan()
        self.assertIn("::warning file=crates/core/src/lib.rs,line=4,endLine=6,title=Function left out::", out)
        self.assertIn("entry 1, leaves out lines 4-6 of only in crates/core/src/lib.rs,", out)
        self.assertIn("since on* matches the function's name", out)
        self.assertIn("leaves out lines 4-6 of only", self.summary.read_text(encoding="utf-8"))
        lcov = self.root / "lcov.info"
        lcov.write_text("SF:crates/core/src/lib.rs\nDA:2,1\nend_of_record\n", encoding="utf-8")
        status, out = self.run_script(
            "coverage", "--base", "HEAD^1", "--head", "HEAD", "--rust-lcov", str(lcov)
        )
        self.assertEqual(status, 0)
        self.assertIn("- `only` in `crates/core/src/lib.rs`, lines 4-6, by entry 1: y", out)

    def test_quiet_about_unchanged_lines_in_an_excluded_function(self) -> None:
        self.write(
            {
                cc.EXCLUDE_FILE: '[[exclude]]\nfiles = ["crates/core/src/lib.rs"]\nfunctions = ["one"]\nreason = "y"\n'
            }
        )
        self.commit("exclude one")
        self.write({"crates/core/src/lib.rs": WORKSPACE["crates/core/src/lib.rs"] + "pub fn two() -> u8 {\n    2\n}\n"})
        self.commit("add two")
        self.assertNotIn("Function left out", self.plan())

    def test_warns_about_added_mutant_filters(self) -> None:
        self.write({".cargo/mutants.toml": 'exclude_re = ["replace one"]\n'})
        self.commit("filter one")
        self.write(
            {
                ".cargo/mutants.toml": 'exclude_re = ["replace one", "replace .* with"]\n'
                'exclude_globs = ["crates/core/src/lib.rs"]\n'
            }
        )
        self.commit("filter more")
        out = self.plan()
        self.assertIn("::warning file=.cargo/mutants.toml,title=Mutants left out::", out)
        self.assertIn("adds `replace .* with` to exclude_re,", out)
        self.assertIn("adds `crates/core/src/lib.rs` to exclude_globs,", out)
        self.assertNotIn("`replace one`", out)
        self.assertIn("`replace .* with`", self.summary.read_text(encoding="utf-8"))

    def test_warns_about_an_added_mutants_skip(self) -> None:
        self.write(
            {
                "crates/core/src/lib.rs": WORKSPACE["crates/core/src/lib.rs"]
                + "#[mutants :: skip]\npub fn two() -> u8 {\n    2\n}\n"
            }
        )
        self.commit("skip two")
        out = self.plan()
        self.assertIn("::warning file=crates/core/src/lib.rs,line=4,title=Mutants left out::", out)
        self.assertIn("adds a mutants::skip on line 4,", self.summary.read_text(encoding="utf-8"))

    def test_warns_about_any_changed_mutants_setting(self) -> None:
        self.write(
            {
                ".cargo/mutants.toml": 'exclude_re = ["replace one"]\ntimeout_multiplier = 3.0\n'
                "minimum_test_timeout = 60\n"
            }
        )
        self.commit("settings")
        self.write(
            {
                ".cargo/mutants.toml": 'examine_re = ["^nothing$"]\ntimeout_multiplier = 0.01\n'
                "exclude_re = []\n"
            }
        )
        self.commit("change the settings")
        out = self.plan()
        self.assertIn("::warning file=.cargo/mutants.toml,title=Mutants settings::", out)
        self.assertIn('sets examine_re to `["^nothing$"]`, which the base commit\'s copy doesn\'t set.', out)
        self.assertIn("changes timeout_multiplier from `3.0` to `0.01`.", out)
        self.assertIn("no longer sets minimum_test_timeout, which the base commit's copy sets to `60`.", out)
        # Taking an entry out of exclude_re makes more mutants, so it's fine.
        self.assertNotIn("exclude_re", out)
        self.assertNotIn("Mutants left out", out)
        self.assertIn("examine_re", self.summary.read_text(encoding="utf-8"))

    def test_quiet_when_mutants_settings_only_change_comments(self) -> None:
        self.write({".cargo/mutants.toml": 'exclude_re = ["replace one"]\n'})
        self.commit("settings")
        self.write({".cargo/mutants.toml": '# Why.\nexclude_re = [\n    "replace one",\n]\n'})
        self.commit("explain the settings")
        out = self.plan()
        self.assertNotIn("Mutants", out)
        self.assertFalse(self.summary.exists())

    def test_warns_about_mutants_settings_it_cannot_read(self) -> None:
        self.write({".cargo/mutants.toml": "exclude_re = [\n"})
        self.commit("break the settings")
        out = self.plan()
        self.assertIn("title=Mutants settings::", out)
        self.assertIn("can't read the new copy", out)

    def test_warns_about_a_split_mutants_skip(self) -> None:
        self.write(
            {
                "crates/core/src/lib.rs": WORKSPACE["crates/core/src/lib.rs"]
                + "#[mutants::\n    skip]\npub fn two() -> u8 {\n    2\n}\n"
                "#[mutants::/* x */skip]\npub fn three() -> u8 {\n    3\n}\n"
                "#[cfg_attr(test, mutants::skip)]\npub fn four() -> u8 {\n    4\n}\n"
            }
        )
        self.commit("skip three ways")
        out = self.plan()
        for line in (4, 9, 13):
            self.assertIn(f"::warning file=crates/core/src/lib.rs,line={line},title=Mutants left out::", out)
        self.assertEqual(out.count("title=Mutants left out::"), 3)

    def test_warns_about_a_changed_line_in_an_old_mutants_skip(self) -> None:
        self.write(
            {
                "crates/core/src/lib.rs": "#[mutants::\n    allow]\n" + WORKSPACE["crates/core/src/lib.rs"]
            }
        )
        self.commit("allow")
        self.write(
            {
                "crates/core/src/lib.rs": "#[mutants::\n    skip]\n" + WORKSPACE["crates/core/src/lib.rs"]
            }
        )
        self.commit("skip")
        out = self.plan()
        self.assertIn("::warning file=crates/core/src/lib.rs,line=2,title=Mutants left out::", out)

    def test_quiet_about_mutants_skip_in_comments_and_strings(self) -> None:
        self.write(
            {
                "crates/core/src/lib.rs": WORKSPACE["crates/core/src/lib.rs"]
                + "// A #[mutants::skip] would hide this.\n"
                '/// Not #[mutants::skip].\n#[doc = "mutants::skip"]\n#[allow(dead_code)]\n'
                'pub fn two() -> &\'static str {\n    "#[mutants::skip]"\n}\n'
            }
        )
        self.commit("mention skip")
        self.assertNotIn("Mutants left out", self.plan())

    def test_lists_three_and_counts_the_rest(self) -> None:
        self.assertEqual(cc.listing(["a"], "files"), "a")
        self.assertEqual(cc.listing(["a", "b"], "files"), "a and b")
        self.assertEqual(cc.listing(["a", "b", "c"], "files"), "a, b and c")
        self.assertEqual(cc.listing(["a", "b", "c", "d", "e"], "files"), "a, b, c and 2 more files")


class TestCodeTest(RepoTest):
    def counted_rust(self) -> dict[str, list[int]]:
        return cc.counted(cc.Change("HEAD^1", "HEAD"), []).rust

    def test_a_file_named_tests_counts_unless_declared_as_test(self) -> None:
        self.write(
            {
                "crates/core/src/lib.rs": "pub fn one() -> u8 {\n    1\n}\npub mod tests;\npub mod parse_tests;\n",
                "crates/core/src/tests.rs": "pub fn two() -> u8 {\n    2\n}\n",
                "crates/core/src/parse_tests.rs": "pub fn three() -> u8 {\n    3\n}\n",
            }
        )
        self.commit("add modules")
        rust = self.counted_rust()
        self.assertEqual(rust.get("crates/core/src/tests.rs"), [1, 2, 3])
        self.assertEqual(rust.get("crates/core/src/parse_tests.rs"), [1, 2, 3])

    def test_a_module_declared_under_cfg_test_does_not_count(self) -> None:
        self.write(
            {
                "crates/core/src/lib.rs": "pub fn one() -> u8 {\n    1\n}\n#[cfg(test)]\nmod checks;\n",
                "crates/core/src/checks.rs": "#[test]\nfn one_is_one() {\n    assert_eq!(super::one(), 1);\n}\n",
            }
        )
        self.commit("add a test module")
        self.assertEqual(self.counted_rust(), {})

    def test_tokio_test_with_arguments_is_test_code(self) -> None:
        scan = cc.scan_rust(
            '#[tokio::test(flavor = "multi_thread")]\nasync fn runs() {\n    assert!(true);\n}\n'
            "fn real() {}\n"
        )
        self.assertEqual(scan.test_lines(), {1, 2, 3, 4})

    def test_plain_tokio_test_is_test_code(self) -> None:
        scan = cc.scan_rust("#[tokio::test]\nasync fn runs() {\n    assert!(true);\n}\n")
        self.assertEqual(scan.test_lines(), {1, 2, 3, 4})

    def test_a_path_module_leaves_its_folder_counted(self) -> None:
        self.write(
            {
                "crates/core/src/lib.rs": WORKSPACE["crates/core/src/lib.rs"]
                + '#[cfg(test)]\n#[path = "extra/lib_checks.rs"]\nmod tests;\npub mod extra;\n',
                "crates/core/src/extra/mod.rs": "pub mod real;\n",
                "crates/core/src/extra/real.rs": "pub fn four() -> u8 {\n    4\n}\n",
                "crates/core/src/extra/lib_checks.rs": "fn helper() -> u8 {\n    5\n}\n",
            }
        )
        self.commit("add a test module by path")
        self.assertEqual(
            self.counted_rust(),
            {
                "crates/core/src/lib.rs": [7],
                "crates/core/src/extra/mod.rs": [1],
                "crates/core/src/extra/real.rs": [1, 2, 3],
            },
        )

    def test_a_path_outside_the_repo_counts_nothing_as_tests(self) -> None:
        outside = self.root.parent / f"{self.root.name}-outside.rs"
        outside.write_text("fn helper() {}\n", encoding="utf-8")
        self.addCleanup(outside.unlink)
        self.write(
            {
                "crates/core/src/lib.rs": WORKSPACE["crates/core/src/lib.rs"]
                + f'#[cfg(test)]\n#[path = "../../../../{outside.name}"]\nmod tests;\n',
            }
        )
        self.commit("add a test module outside the repo")
        self.assertEqual(cc.test_modules(cc.crates()[0]), (set(), []))
        self.assertEqual(self.counted_rust(), {})

    def test_modules_in_an_inline_test_module_are_under_its_folder(self) -> None:
        self.write(
            {
                "crates/core/src/lib.rs": WORKSPACE["crates/core/src/lib.rs"]
                + "pub mod helpers;\n#[cfg(test)]\nmod tests {\n    mod helpers;\n}\n",
                "crates/core/src/helpers.rs": "pub fn six() -> u8 {\n    6\n}\n",
                "crates/core/src/tests/helpers.rs": "fn check() {}\n",
            }
        )
        self.commit("add helpers")
        self.assertEqual(
            self.counted_rust(),
            {"crates/core/src/lib.rs": [4], "crates/core/src/helpers.rs": [1, 2, 3]},
        )

    def test_a_path_in_an_inline_test_module_counts_its_file(self) -> None:
        self.write(
            {
                "crates/core/src/lib.rs": WORKSPACE["crates/core/src/lib.rs"]
                + '#[cfg(test)]\nmod tests {\n    #[path = "helpers.rs"]\n    mod helpers;\n}\n',
                "crates/core/src/helpers.rs": "fn check() {}\n",
            }
        )
        self.commit("add helpers by path")
        self.assertEqual(self.counted_rust(), {"crates/core/src/helpers.rs": [1]})

    def test_a_file_module_looks_in_its_own_folder(self) -> None:
        self.write(
            {
                "crates/core/src/lib.rs": WORKSPACE["crates/core/src/lib.rs"] + "pub mod foo;\n",
                "crates/core/src/foo.rs": "pub fn seven() -> u8 {\n    7\n}\n#[cfg(test)]\nmod checks;\n",
                "crates/core/src/foo/checks.rs": "fn check() {}\n",
                "crates/core/src/checks.rs": "pub fn eight() {}\n",
            }
        )
        self.commit("add foo")
        self.assertEqual(
            self.counted_rust(),
            {
                "crates/core/src/lib.rs": [4],
                "crates/core/src/foo.rs": [1, 2, 3],
                "crates/core/src/checks.rs": [1],
            },
        )

    def test_cfg_all_with_test_is_test_code(self) -> None:
        self.write(
            {
                "crates/core/src/lib.rs": WORKSPACE["crates/core/src/lib.rs"]
                + '#[cfg(all(test, feature = "x"))]\nmod checks;\n',
                "crates/core/src/checks.rs": "fn check() {}\n",
            }
        )
        self.commit("add checks")
        self.assertEqual(self.counted_rust(), {})

    def test_cfg_any_with_test_still_counts(self) -> None:
        self.write(
            {
                "crates/core/src/lib.rs": WORKSPACE["crates/core/src/lib.rs"]
                + '#[cfg(any(test, feature = "x"))]\nmod extra;\n',
                "crates/core/src/extra.rs": "pub fn nine() {}\n",
            }
        )
        self.commit("add extra")
        self.assertEqual(
            self.counted_rust(),
            {"crates/core/src/lib.rs": [4, 5], "crates/core/src/extra.rs": [1]},
        )

    def test_a_link_to_nothing_stops_the_check(self) -> None:
        self.write({"crates/core/src/lib.rs": "pub fn one() -> u8 {\n    2\n}\n"})
        self.commit("change one")
        (self.root / "crates/core/src/gone.rs").symlink_to("missing.rs")
        with self.assertRaises(SystemExit) as caught:
            self.counted_rust()
        self.assertIn("crates/core/src/gone.rs is a link to nothing,", str(caught.exception))

    def test_a_path_visibility_is_one_qualifier(self) -> None:
        scan = cc.scan_rust(
            "#[cfg(test)]\npub(in crate::player) fn helper() -> Result<(), String> {\n"
            "    Ok(())\n}\npub fn real() -> u8 {\n    1\n}\n"
        )
        self.assertEqual(scan.test_lines(), {1, 2, 3, 4})
        (real,) = [fn for fn in scan.functions if fn.name == "real"]
        self.assertEqual((real.first, real.last), (5, 7))


class CoverageTest(RepoTest):
    def setUp(self) -> None:
        super().setUp()
        self.write({"apps/player/src/lib/a.ts": "export const a = 1;\nexport const c = 3;\n"})
        self.commit("change a")
        self.lcov = self.root / "lcov.info"

    def coverage(self, report: str) -> tuple[int, str]:
        self.lcov.write_text(report, encoding="utf-8")
        return self.run_script(
            "coverage", "--base", "HEAD^1", "--head", "HEAD", "--frontend-lcov", str(self.lcov)
        )

    def test_passes_when_the_changed_lines_run(self) -> None:
        status, out = self.coverage("SF:src/lib/a.ts\nDA:1,1\nDA:2,4\nend_of_record\n")
        self.assertEqual(status, 0)
        self.assertIn("| Frontend | 1 | 1 | 100.0% | passes |", out)

    def test_fails_when_a_changed_line_never_runs(self) -> None:
        status, out = self.coverage("SF:src/lib/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n")
        self.assertEqual(status, 1)
        self.assertIn("| Frontend | 1 | 0 | 0.0% | fails, under 80% |", out)
        self.assertIn("::error file=apps/player/src/lib/a.ts,line=2,title=Not covered::", out)

    def test_a_frontend_file_with_no_data_fails(self) -> None:
        status, out = self.coverage("SF:src/lib/b.ts\nDA:1,1\nend_of_record\n")
        self.assertEqual(status, 1)
        self.assertIn("::error file=apps/player/src/lib/a.ts,title=No coverage data::", out)
        self.assertIn("which fails the check", out)

    def rust_coverage(self, report: str) -> tuple[int, str]:
        self.write({"crates/core/src/lib.rs": "pub fn one() -> u8 {\n    2\n}\n"})
        self.commit("change one")
        self.lcov.write_text(report, encoding="utf-8")
        return self.run_script(
            "coverage", "--base", "HEAD^1", "--head", "HEAD", "--rust-lcov", str(self.lcov)
        )

    def test_a_rust_file_with_no_data_does_not_count(self) -> None:
        status, out = self.rust_coverage("SF:crates/core/src/other.rs\nDA:1,1\nend_of_record\n")
        self.assertEqual(status, 0)
        self.assertIn("so they don't count", out)

    def test_an_empty_rust_report_fails(self) -> None:
        status, out = self.rust_coverage("")
        self.assertEqual(status, 1)
        self.assertIn("| Rust | n/a | n/a | n/a | fails, the report has no data |", out)
        self.assertIn("::error title=No coverage data::", out)

    def test_the_share_rounds_down(self) -> None:
        self.assertEqual(cc.share_text(7999, 10000), "79.9%")
        self.assertEqual(cc.share_text(4, 5), "80.0%")
        self.assertEqual(cc.share_text(2, 3), "66.6%")
        self.assertEqual(cc.share_text(1, 1), "100.0%")


def mutant(line: int, genre: str = "BinaryOperator") -> dict:
    return {
        "file": "crates/core/src/lib.rs",
        "name": f"crates/core/src/lib.rs:{line}:5: replace + with - in add",
        "genre": genre,
        "span": {"start": {"line": line, "column": 5}, "end": {"line": line, "column": 6}},
    }


class MutantsTest(RepoTest):
    def setUp(self) -> None:
        super().setUp()
        self.out = self.root / "mutants.out"
        self.out.mkdir()

    def outcomes(self, *outcomes: object) -> None:
        data = {"outcomes": [{"scenario": "Baseline", "summary": "Success"}, *outcomes]}
        (self.out / "outcomes.json").write_text(json.dumps(data), encoding="utf-8")

    def mutants(self) -> tuple[int, str]:
        return self.run_script("mutants", str(self.out))

    def test_missing_results_fail(self) -> None:
        status, out = self.mutants()
        self.assertEqual(status, 1)
        self.assertIn("::error title=No results::", out)
        self.assertIn("is missing", out)

    def test_results_with_no_mutants_fail(self) -> None:
        self.outcomes()
        status, out = self.mutants()
        self.assertEqual(status, 1)
        self.assertIn("has no mutants", out)

    def test_results_that_are_not_json_fail(self) -> None:
        (self.out / "outcomes.json").write_text("{", encoding="utf-8")
        status, out = self.mutants()
        self.assertEqual(status, 1)
        self.assertIn("isn't JSON this check can read", out)

    def test_an_outcome_that_is_not_an_object_fails(self) -> None:
        self.outcomes(["MissedMutant"])
        status, out = self.mutants()
        self.assertEqual(status, 1)
        self.assertIn("::error title=No results::", out)
        self.assertIn("has an outcome this check can't read", out)

    def test_a_mutant_with_no_line_fails(self) -> None:
        bad = mutant(2)
        del bad["span"]["start"]
        self.outcomes({"scenario": {"Mutant": bad}, "summary": "MissedMutant"})
        status, out = self.mutants()
        self.assertEqual(status, 1)
        self.assertIn("has a mutant with no line", out)

    def test_a_mutant_whose_function_has_no_line_fails(self) -> None:
        bad = mutant(2, "FnValue")
        bad["function"] = {"function_name": "add"}
        self.outcomes({"scenario": {"Mutant": bad}, "summary": "MissedMutant"})
        status, out = self.mutants()
        self.assertEqual(status, 1)
        self.assertIn("has a mutant with a function with no line", out)

    def test_results_of_the_wrong_shape_fail(self) -> None:
        def with_mutant(**changes: object) -> dict:
            return {"scenario": {"Mutant": {**mutant(2), **changes}}, "summary": "MissedMutant"}

        cases = {
            "a list": [],
            "outcomes that aren't a list": {"outcomes": {"scenario": "Baseline"}},
            "a summary that's a list": {
                "outcomes": [{"scenario": {"Mutant": mutant(2)}, "summary": ["MissedMutant"]}]
            },
            "a summary that's an object": {
                "outcomes": [{"scenario": {"Mutant": mutant(2)}, "summary": {"MissedMutant": 1}}]
            },
            "a scenario that's a string": {"outcomes": [{"scenario": "Mutant", "summary": "MissedMutant"}]},
            "a mutant that's a list": {"outcomes": [{"scenario": {"Mutant": []}, "summary": "MissedMutant"}]},
            "a file that's a number": {"outcomes": [with_mutant(file=1)]},
            "a name that's missing": {"outcomes": [with_mutant(name=None)]},
            "a genre that's a list": {"outcomes": [with_mutant(genre=["FnValue"])]},
            "a span that's a list": {"outcomes": [with_mutant(span=[2])]},
            "a line that's a string": {"outcomes": [with_mutant(span={"start": {"line": "2"}})]},
            "a line that's true": {"outcomes": [with_mutant(span={"start": {"line": True}})]},
            "a line of 0": {"outcomes": [with_mutant(span={"start": {"line": 0}})]},
            "a function that's a string": {"outcomes": [with_mutant(function="add")]},
        }
        for name, data in cases.items():
            with self.subTest(name):
                (self.out / "outcomes.json").write_text(json.dumps(data), encoding="utf-8")
                status, out = self.mutants()
                self.assertEqual(status, 1)
                self.assertIn("::error title=No results::", out)
        (self.out / "outcomes.json").write_text('{"outcomes": [' + "[" * 100000 + "]" * 100000 + "]}")
        status, out = self.mutants()
        self.assertEqual(status, 1)
        # How deep the json module reads depends on the Python build, so either
        # the reader or the outcome check stops it.
        self.assertIn("::error title=No results::", out)

    def test_an_outcome_it_cannot_show_still_gets_a_message(self) -> None:
        circular: list = []
        circular.append(circular)
        self.assertEqual(cc.shown(circular), "a value nested too deeply to show")
        self.assertEqual(cc.shown("x" * 300), json.dumps("x" * 300)[:200])

    def test_a_missed_mutant_in_a_file_it_cannot_read_fails(self) -> None:
        (self.root.parent / f"{self.root.name}-outside.rs").write_text("fn a() {}\n", encoding="utf-8")
        self.addCleanup((self.root.parent / f"{self.root.name}-outside.rs").unlink)
        self.write({"crates/core/src/latin1.rs": b"// caf\xe9\n"})
        for path in (
            "crates/core/src/gone.rs",
            f"../{self.root.name}-outside.rs",
            "crates/core/src",
            "crates/core/src/latin1.rs",
        ):
            with self.subTest(path):
                self.outcomes({"scenario": {"Mutant": {**mutant(2), "file": path}}, "summary": "MissedMutant"})
                status, out = self.mutants()
                self.assertEqual(status, 1)
                self.assertIn(f"::error file={path},line=2,title=Mutant missed::", out)
                self.assertIn(f"can't read {path} as a UTF-8 file in the repo", out)

    def test_an_unknown_summary_fails(self) -> None:
        self.outcomes({"scenario": {"Mutant": mutant(2)}, "summary": "Failure"})
        status, out = self.mutants()
        self.assertEqual(status, 1)
        self.assertIn('summary is "Failure"', out)

    def test_caught_mutants_pass(self) -> None:
        self.outcomes(
            {"scenario": {"Mutant": mutant(2)}, "summary": "CaughtMutant"},
            {"scenario": {"Mutant": mutant(2)}, "summary": "Timeout"},
            {"scenario": {"Mutant": mutant(2)}, "summary": "Unviable"},
        )
        status, out = self.mutants()
        self.assertEqual(status, 0)
        self.assertIn("Every mutant in the changed lines was caught.", out)

    def test_a_missed_mutant_fails(self) -> None:
        self.outcomes({"scenario": {"Mutant": mutant(2)}, "summary": "MissedMutant"})
        status, out = self.mutants()
        self.assertEqual(status, 1)
        self.assertIn("::error file=crates/core/src/lib.rs,line=2,title=Mutant missed::", out)

    def test_a_skip_comment_counts_lines_as_git_does(self) -> None:
        # A U+2028 in a string is one line to git and cargo-mutants, though
        # Python's splitlines() splits there.
        self.write(
            {
                "crates/core/src/lib.rs": 'pub const S: &str = "a b";\n'
                "// mutants: skip BinaryOperator: Adding zero either way.\n"
                "pub fn add(a: u8) -> u8 { a + 0 }\n"
            }
        )
        self.outcomes({"scenario": {"Mutant": mutant(3)}, "summary": "MissedMutant"})
        status, out = self.mutants()
        self.assertEqual(status, 0)
        self.assertIn("title=Mutant skipped::", out)
        self.assertIn('"Adding zero either way"', out)


class PlanShardsTest(RepoTest):
    def plan(self) -> tuple[int, str]:
        return self.run_script(
            "plan", "--base", "HEAD^1", "--head", "HEAD", "--shards", str(self.root / "rust.diff")
        )

    def test_a_frontend_change_needs_no_cargo_mutants(self) -> None:
        self.write({"apps/player/src/lib/b.ts": "export const b = 3;\n"})
        self.commit("change b")
        with (
            mock.patch.object(cc, "has_cargo_mutants", return_value=False),
            mock.patch.object(cc, "list_mutants", side_effect=AssertionError("listed mutants")),
        ):
            status, out = self.plan()
        self.assertEqual(status, 0)
        self.assertIn("mvp-core: no changed .rs lines", out)
        self.assertIn("matrix: \n", out)

    def test_a_rust_change_needs_cargo_mutants(self) -> None:
        self.write({"crates/core/src/lib.rs": "pub fn one() -> u8 {\n    2\n}\n"})
        self.commit("change one")
        with mock.patch.object(cc, "has_cargo_mutants", return_value=False):
            with self.assertRaises(SystemExit) as caught:
                self.plan()
        self.assertIn("needs cargo-mutants", str(caught.exception))

    def test_a_rust_change_is_split_into_shards(self) -> None:
        self.write({"crates/core/src/lib.rs": "pub fn one() -> u8 {\n    2\n}\n"})
        self.commit("change one")
        with (
            mock.patch.object(cc, "has_cargo_mutants", return_value=True),
            mock.patch.object(cc, "list_mutants", return_value=150),
        ):
            status, out = self.plan()
        self.assertEqual(status, 0)
        matrix = json.loads(out.split("matrix: ", 1)[1].split("\n", 1)[0])
        self.assertEqual(
            matrix["include"],
            [
                {"package": "mvp-core", "shard": 0, "shards": 2},
                {"package": "mvp-core", "shard": 1, "shards": 2},
            ],
        )
        self.assertIn(b"+    2", (self.root / "rust.diff").read_bytes())


if __name__ == "__main__":
    unittest.main()
