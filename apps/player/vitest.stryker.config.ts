// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { defineConfig, mergeConfig, type Plugin } from "vitest/config";
import base from "./vitest.config.ts";

/**
 * Stryker runs each mutant against only the tests that reached it, which it
 * picks with a test name pattern. Its Vitest runner (10.0.0) joins the suite
 * and test names with a space, but Vitest 5 matches the pattern against names
 * joined with " > ". Nothing matches, no test runs, and the mutant counts as
 * survived. This plugin lets each space in the pattern match " > " as well.
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
export default mergeConfig(base, defineConfig({ plugins: [matchVitestTestNames()] }));
