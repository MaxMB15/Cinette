// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { defineConfig } from "vitest/config";

// A config of its own, so the tests never load vite.config.ts and the plugin
// there that asks GitHub for the latest release. The tests use the made-up
// release in fixtures/release.json.
export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		// Vitest blanks imported CSS. page.test.ts reads the stylesheet as text
		// to check its selectors.
		css: { include: [/\/styles\.css\?raw$/] },
	},
});
