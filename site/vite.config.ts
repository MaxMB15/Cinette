// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { defineConfig, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { keepUnlessFailed, loadRelease } from "./src/lib/release.ts";
import { fillPage } from "./src/lib/render.ts";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures/release.json");

/**
 * Puts the latest release's version, links and file sizes into index.html.
 * It asks GitHub once per build or dev server. When GitHub can't answer, the
 * build fails, unless SITE_RELEASE_FIXTURE=1 asks for the made-up release.
 * The dev server shows the error and asks again on the next page load.
 */
const latestRelease = (): Plugin => {
	const release = keepUnlessFailed(() =>
		loadRelease({
			env: process.env,
			fetch,
			readFixture: () => readFile(FIXTURE, "utf8"),
			wait,
		})
	);
	return {
		name: "latest-release",
		transformIndexHtml: {
			order: "pre",
			handler: async (html) => fillPage(html, await release()),
		},
	};
};

export default defineConfig({
	// Relative links, so the page works at /Cinette/ on GitHub Pages
	// and at the root of `vite preview`.
	base: "./",
	plugins: [tailwindcss(), latestRelease()],
	build: {
		// The deploy copies dist onto the gh-pages branch and keeps the coverage
		// reports already there. Names without a hash replace the files from the
		// last deploy, where hashed names would pile up next to them.
		rolldownOptions: {
			output: {
				entryFileNames: "assets/[name].js",
				chunkFileNames: "assets/[name].js",
				assetFileNames: "assets/[name][extname]",
			},
		},
	},
});
