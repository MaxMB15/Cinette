// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { defineConfig } from "vitest/config";
import type { Reporter } from "vitest/node";
import { writeFileSync } from "node:fs";
import base from "./vitest.config.ts";
import { flowsToMarkdown } from "./src/dev/flow-report.ts";

/**
 * Prints the flows a test measured as Markdown, and saves them as JSON when
 * PERF_OUT names a file.
 */
const flowReporter: Reporter = {
	onTestCaseResult: (testCase) => {
		const flows = testCase.meta().flows;
		if (!flows) return;
		process.stdout.write(`\n${flowsToMarkdown(flows)}\n\n`);
		if (process.env.PERF_OUT) {
			writeFileSync(process.env.PERF_OUT, `${JSON.stringify(flows, null, 2)}\n`);
		}
	},
};

/**
 * Runs the measured flows in src/dev, which the normal test run leaves out.
 * The test list replaces the main config's, where mergeConfig would add to it.
 */
export default defineConfig({
	...base,
	test: {
		...base.test,
		include: ["src/**/*.perf.test.tsx"],
		exclude: [],
		reporters: ["default", flowReporter],
		// The app's own logs, such as each player poll, would bury the tables.
		onConsoleLog: () => false,
		// The flows wait in real time, and one file at a time keeps the counts
		// from changing with the machine's load.
		fileParallelism: false,
	},
});
