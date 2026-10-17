// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.
// @vitest-environment jsdom

// Checks index.html itself: the script that picks the hero's downloads, the
// links between sections, and that nothing loads from another site. The page
// goes through a DOM parser, as a browser would read it, and its script never
// runs here except through osFor. The stylesheet is read as text.

import { expect, test } from "vitest";
import page from "../index.html?raw";
import fixture from "../fixtures/release.json?raw";
import styles from "./styles.css?raw";
import { FILES, parseRelease } from "./lib/release";
import { fillPage } from "./lib/render";

const parse = (html: string): Document => new DOMParser().parseFromString(html, "text/html");

const PAGE = parse(page);
const FILLED = parse(fillPage(page, parseRelease(JSON.parse(fixture))));

const scripts = [...PAGE.querySelectorAll("script")];

/** The attribute's value on each element the selector finds. */
const attributes = (doc: Document, selector: string, name: string): string[] =>
	[...doc.querySelectorAll(selector)].map((element) => element.getAttribute(name) ?? "");

/** Runs the page's script as a browser with this user agent would. */
const osFor = (userAgent: string, maxTouchPoints = 0): string | undefined => {
	const document = { documentElement: { dataset: {} as Record<string, string> } };
	new Function("navigator", "document", scripts[0].text)({ userAgent, maxTouchPoints }, document);
	return document.documentElement.dataset.os;
};

const MAC =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const MAC_FIREFOX =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0";
const IPHONE =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD =
	"Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1";

const LINUX_DESKTOPS = [
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
	"Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
];

const LINUX_TVS_AND_PHONES = [
	"Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36 WebAppManager",
	"Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36",
	"Mozilla/5.0 (SMART-TV; X11; Linux armv7l) AppleWebKit/537.42 (KHTML, like Gecko) Chromium/25.0.1349.2 Chrome/25.0.1349.2 Safari/537.42",
	"Mozilla/5.0 (Linux; Tizen 2.3) AppleWebKit/538.1 (KHTML, like Gecko)Version/2.3 TV Safari/538.1",
	"Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile Safari/605.1.15",
];

const ANDROID_CHROMEOS_WINDOWS = [
	"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
	"Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7633) AppleWebKit/537.36 (KHTML, like Gecko) Silk/130.0.0 like Chrome/130.0.0.0 Safari/537.36",
	"Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
	"",
];

/** Each user agent above, with the touch points its device reports. */
const AGENTS: [userAgent: string, maxTouchPoints: number][] = [
	[MAC, 0],
	[MAC, 1],
	[MAC, 5],
	[MAC_FIREFOX, 0],
	[IPHONE, 5],
	[IPAD, 5],
	...[...LINUX_DESKTOPS, ...LINUX_TVS_AND_PHONES, ...ANDROID_CHROMEOS_WINDOWS].map(
		(userAgent): [string, number] => [userAgent, 0]
	),
];

test("the page has one script, inline", () => {
	expect(scripts).toHaveLength(1);
	expect(scripts[0].hasAttribute("src")).toBe(false);
	expect(scripts[0].text.trim()).not.toBe("");
});

test("the script tells a Mac from an iPad, which asks for the Mac site", () => {
	expect(osFor(MAC)).toBe("mac");
	expect(osFor(MAC, 1)).toBe("mac");
	expect(osFor(MAC, 5)).toBe("ios");
	expect(osFor(MAC_FIREFOX)).toBe("mac");
});

test("the script knows iPhones and iPads", () => {
	expect(osFor(IPHONE, 5)).toBe("ios");
	expect(osFor(IPAD, 5)).toBe("ios");
});

test("the script knows desktop Linux", () => {
	for (const userAgent of LINUX_DESKTOPS) {
		expect(osFor(userAgent)).toBe("linux");
	}
});

test("the script offers every download to Linux TVs and phones", () => {
	for (const userAgent of LINUX_TVS_AND_PHONES) {
		expect(osFor(userAgent)).toBe("other");
	}
});

test("the script offers every download to Android, ChromeOS and Windows", () => {
	for (const userAgent of ANDROID_CHROMEOS_WINDOWS) {
		expect(osFor(userAgent)).toBe("other");
	}
});

test("the script, the hero and the stylesheet name the same systems", () => {
	// The systems the script picks for the user agents above.
	const picked = [...new Set(AGENTS.map(([userAgent, touch]) => osFor(userAgent, touch)))].sort();
	expect(attributes(FILLED, ".os-pick", "data-for").sort()).toEqual(picked);
	const shown = [
		...styles.matchAll(/:root\[data-os="([^"]*)"\] \.os-pick\[data-for="([^"]*)"\]/g),
	];
	expect(shown.map(([, os]) => os).sort()).toEqual(picked);
	for (const [, os, pick] of shown) {
		expect(pick).toBe(os);
	}
	// Without the script, the link to every download shows.
	expect(styles).toContain(':root:not([data-os]) .os-pick[data-for="other"]');
	const picks = [...styles.matchAll(/\.os-pick\[data-for="([^"]*)"\]/g)].map(([, os]) => os);
	expect(picks).toHaveLength(picked.length + 1);
	expect(new Set(picks)).toEqual(new Set(picked));
});

test("the release fills every marker in the page", () => {
	const comments: string[] = [];
	const walker = FILLED.createTreeWalker(FILLED, NodeFilter.SHOW_COMMENT);
	while (walker.nextNode()) comments.push((walker.currentNode as Comment).data.trim());
	expect(comments.filter((comment) => comment.startsWith("release:"))).toEqual([]);
	const links = attributes(FILLED, "a[href]", "href");
	for (const { suffix } of FILES) {
		expect(links).toContain(
			`https://github.com/MaxMB15/Cinette/releases/download/v1.2.3/Cinette_${suffix}`
		);
	}
});

test("each link to a section has a section to go to", () => {
	const ids = new Set(attributes(FILLED, "[id]", "id"));
	const targets = attributes(FILLED, '[href^="#"]', "href").map((href) => href.slice(1));
	expect(targets.length).toBeGreaterThan(0);
	for (const target of targets) {
		expect(ids).toContain(target);
	}
});

test("each id is used once", () => {
	const ids = attributes(FILLED, "[id]", "id");
	expect(ids.length).toBeGreaterThan(0);
	expect(new Set(ids).size).toBe(ids.length);
});

test("each image has alt text or is marked as decoration", () => {
	const images = [...PAGE.querySelectorAll("img")];
	expect(images.length).toBeGreaterThan(0);
	for (const image of images) {
		expect(image.hasAttribute("alt")).toBe(true);
	}
});

test("images and styles come from the repo, not another site", () => {
	const sources = [
		...attributes(PAGE, "img", "src"),
		...attributes(PAGE, 'link:not([rel="canonical"])', "href"),
	];
	expect(sources.length).toBeGreaterThan(0);
	for (const source of sources) {
		expect(source).toMatch(/^\.\.?\//);
	}
	expect(attributes(PAGE, 'link[rel="canonical"]', "href")).toEqual([
		"https://maxmb15.github.io/Cinette/",
	]);
});

test("links to other sites use https", () => {
	const hrefs = attributes(FILLED, "[href]", "href").filter(
		(href) => !href.startsWith("#") && !href.startsWith(".")
	);
	expect(hrefs.length).toBeGreaterThan(0);
	for (const href of hrefs) {
		expect(href).toMatch(/^https:\/\//);
	}
});
