// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// Mutation testing for the helpers in src/lib. Run it with `pnpm test:mutation`.
// Nothing here uploads results. The reports stay in reports/mutation/.
export default {
	testRunner: "vitest",
	plugins: ["@stryker-mutator/vitest-runner"],
	vitest: {
		// The main config plus a fix for how the runner picks tests by name.
		configFile: "vitest.stryker.config.ts",
	},
	mutate: [
		"src/lib/**/*.{ts,tsx}",
		"!src/lib/**/*.test.{ts,tsx}",
		// Only types and interfaces, so nothing to mutate.
		"!src/lib/types.ts",
		// tauri.ts stays in. Its contract test catches a wrong command name or
		// argument key, and its mutants take about a minute.
	],
	// Each mutant runs only the tests that reached its code in the first run.
	coverageAnalysis: "perTest",
	reporters: ["clear-text", "progress", "html", "json"],
	htmlReporter: { fileName: "reports/mutation/index.html" },
	jsonReporter: { fileName: "reports/mutation/mutation.json" },
	// Other heavy jobs share the machine.
	concurrency: 4,
	incremental: false,
	// Stryker copies this folder into .stryker-tmp for each run. These are
	// build output and downloads that no test reads. The tests do read some
	// files in src-tauri, such as the command arguments and the app icon, so
	// the rest of it is copied.
	ignorePatterns: [
		"/dist",
		"/coverage",
		"/reports",
		"/resources",
		"/src-tauri/binaries",
		"/src-tauri/gen",
		"/src-tauri/target",
	],
	// The first run goes through every test file one at a time, each in a new
	// worker with its own jsdom, which takes several minutes on a busy machine.
	dryRunTimeoutMinutes: 20,
};
