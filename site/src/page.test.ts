// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// Checks index.html itself: the script that picks the hero's downloads, the
// links between sections, and that nothing loads from another site.

import { expect, test } from "vitest";
import page from "../index.html?raw";
import fixture from "../fixtures/release.json?raw";
import { FILES, parseRelease } from "./lib/release";
import { fillPage } from "./lib/render";

const FILLED = fillPage(page, parseRelease(JSON.parse(fixture)));

const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

/** Runs the page's script as a browser with this user agent would. */
const osFor = (userAgent: string, maxTouchPoints = 0): string | undefined => {
	const document = { documentElement: { dataset: {} as Record<string, string> } };
	new Function("navigator", "document", scripts[0])({ userAgent, maxTouchPoints }, document);
	return document.documentElement.dataset.os;
};

const MAC =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

test("the page has one script, inline", () => {
	expect(scripts).toHaveLength(1);
	expect(page).not.toMatch(/<script[^>]*\ssrc=/);
});

test("the script tells a Mac from an iPad, which asks for the Mac site", () => {
	expect(osFor(MAC)).toBe("mac");
	expect(osFor(MAC, 1)).toBe("mac");
	expect(osFor(MAC, 5)).toBe("ios");
	expect(
		osFor(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0"
		)
	).toBe("mac");
});

test("the script knows iPhones and iPads", () => {
	expect(
		osFor(
			"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
			5
		)
	).toBe("ios");
	expect(
		osFor(
			"Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1",
			5
		)
	).toBe("ios");
});

test("the script knows desktop Linux", () => {
	expect(
		osFor(
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
		)
	).toBe("linux");
	expect(
		osFor("Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0")
	).toBe("linux");
});

test("the script offers every download to Android, ChromeOS and Windows", () => {
	for (const userAgent of [
		"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
		"Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7633) AppleWebKit/537.36 (KHTML, like Gecko) Silk/130.0.0 like Chrome/130.0.0.0 Safari/537.36",
		"Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
		"",
	]) {
		expect(osFor(userAgent)).toBe("other");
	}
});

test("the release fills every marker in the page", () => {
	expect(FILLED).not.toContain("<!-- release:");
	for (const { file } of FILES) {
		expect(FILLED).toContain(
			`href="https://github.com/MaxMB15/MaxVideoPlayer/releases/latest/download/${file}"`
		);
	}
});

test("each link to a section has a section to go to", () => {
	const ids = new Set([...FILLED.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
	const targets = [...FILLED.matchAll(/href="#([^"]*)"/g)].map((m) => m[1]);
	expect(targets.length).toBeGreaterThan(0);
	for (const target of targets) {
		expect(ids).toContain(target);
	}
});

test("each id is used once", () => {
	const ids = [...FILLED.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
	expect(new Set(ids).size).toBe(ids.length);
});

test("each image has alt text or is marked as decoration", () => {
	const images = [...page.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
	expect(images.length).toBeGreaterThan(0);
	for (const image of images) {
		expect(image).toMatch(/\salt="/);
	}
});

test("images and styles come from the repo, not another site", () => {
	for (const [, source] of page.matchAll(/<(?:img|link)\b[^>]*\s(?:src|href)="([^"]+)"/g)) {
		if (source === "https://maxmb15.github.io/MaxVideoPlayer/") continue;
		expect(source).toMatch(/^\.\.?\//);
	}
});

test("links to other sites use https", () => {
	for (const [, href] of FILLED.matchAll(/href="([^"#.][^"]*)"/g)) {
		expect(href).toMatch(/^https:\/\//);
	}
});
