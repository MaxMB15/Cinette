// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { defineConfig, mergeConfig, type Plugin } from "vitest/config";
import base from "./vitest.config.ts";
import { isCompiler } from "./react-compiler.config.ts";

/**
 * Stryker runs each mutant against only the tests that reached it, which it
 * picks with a test name pattern. Its Vitest runner (10.0.0) joins the suite
 * and test names with a space, but Vitest 5 matches the pattern against names
 * joined with " > ". A test inside a describe block never matches, so it
 * doesn't run, and a mutant that only such tests reach counts as survived.
 * This plugin lets each space in the pattern match " > " as well.
 * A space inside a name can then match a suite boundary too, which only runs
 * a few more tests. Once the runner matches Vitest 5, point stryker.config.mjs
 * back at vitest.config.ts and delete this file.
 */
const matchVitestTestNames = (): Plugin => ({
	name: "stryker-match-vitest-test-names",
	configureVitest: ({ project }) => {
		let pattern = project.config.testNamePattern;
		Object.defineProperty(project.config, "testNamePattern", {
			configurable: true,
			enumerable: true,
			get: () => pattern,
			set: (value: RegExp | undefined) => {
				pattern =
					value && new RegExp(value.source.replaceAll(" ", "(?: > | )"), value.flags);
			},
		});
	},
});

// Stryker's runner switches the pool to "threads" with one worker. Putting the
// main config's "vmThreads" back measured no faster, so this file leaves it.
//
// Stryker sets no reporters, so on GitHub's runners Vitest adds its GitHub
// reporter, which prints an error command for each failing test. When a
// mutant crashes a test runner process, Stryker prints the end of that
// process's output, and GitHub shows those lines as errors on a run that
// passed. Stryker reads the results itself, so the default reporter is enough.
/**
 * Stryker's mutants turn expressions into conditionals, which the React
 * Compiler can't compile inside a try, and its build check would then stop
 * the file from loading. The mutants test what the code does, which doesn't
 * depend on memoizing, so these runs leave the compiler out. The normal test
 * run checks the compiled code.
 */
const withoutCompiler = {
	...base,
	plugins: (base.plugins ?? []).flat().filter((plugin) => !isCompiler(plugin)),
};

export default mergeConfig(
	withoutCompiler,
	defineConfig({ plugins: [matchVitestTestNames()], test: { reporters: ["default"] } })
);
