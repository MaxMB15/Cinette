// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			"@": path.resolve(import.meta.dirname, "./src"),
		},
	},
	test: {
		environment: "jsdom",
		// Each worker loads jsdom's code once, and every test file still gets a
		// new VM context with its own window, so files stay isolated and the
		// suite runs about a third faster. Node's built-in modules, and the
		// globals Vitest copies in from Node such as structuredClone, fetch,
		// Buffer and AbortController, come from another realm. An `instanceof`
		// or toStrictEqual check on what they return can fail.
		pool: "vmThreads",
		setupFiles: ["./src/test/polyfills.ts", "./src/test/setup.ts"],
		include: ["src/**/*.{test,spec}.{ts,tsx}"],
		// The measured flows in src/dev take a while and only print numbers.
		// vitest.perf.config.ts runs them.
		exclude: ["**/node_modules/**", "src/**/*.perf.test.tsx"],
		globals: false,
		coverage: {
			provider: "v8",
			include: ["src/**/*.{ts,tsx}"],
			exclude: [
				"src/**/*.{test,spec}.{ts,tsx}",
				"src/test/**",
				"src/vite-env.d.ts",
				"src/main.tsx",
			],
			reporter: ["text", "text-summary", "html", "json-summary"],
			reportsDirectory: "./coverage",
		},
	},
});
