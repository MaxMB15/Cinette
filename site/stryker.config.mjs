// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// Mutation testing for the release helpers in src/lib. Run it with
// `pnpm test:mutation`. The reports stay in reports/mutation/.
//
// The tests have no describe blocks. Stryker's Vitest runner (10.0.0) picks a
// mutant's tests by a name that Vitest 5 can't match inside a describe block,
// as apps/player/vitest.stryker.config.ts explains.
export default {
	testRunner: "vitest",
	plugins: ["@stryker-mutator/vitest-runner"],
	vitest: { configFile: "vitest.config.ts" },
	mutate: ["src/lib/**/*.ts", "!src/lib/**/*.test.ts"],
	coverageAnalysis: "perTest",
	reporters: ["clear-text", "progress", "html", "json"],
	htmlReporter: { fileName: "reports/mutation/index.html" },
	jsonReporter: { fileName: "reports/mutation/mutation.json" },
	concurrency: 4,
	incremental: false,
	ignorePatterns: ["/dist", "/reports"],
};
