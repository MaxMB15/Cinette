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
		// Each worker loads jsdom once and gives every test file a fresh VM
		// context and window, so files stay isolated and the suite takes about
		// half as long. Errors and objects from Node's own modules, or from
		// packages Vitest doesn't transform, come from another realm, so an
		// `instanceof` check against them can be false.
		pool: "vmThreads",
		setupFiles: ["./src/test/polyfills.ts", "./src/test/setup.ts"],
		include: ["src/**/*.{test,spec}.{ts,tsx}"],
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
