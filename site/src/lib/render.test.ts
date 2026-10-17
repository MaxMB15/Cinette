// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { expect, test } from "vitest";
import { parseRelease, pickDownloads, type FileId, type Release } from "./release";
import {
	fillPage,
	renderChecksums,
	renderHero,
	renderPlatforms,
	renderReleaseMeta,
} from "./render";
import FIXTURE from "../../fixtures/release.json?raw";

const FULL = parseRelease(JSON.parse(FIXTURE));

/** The fixture with only the given downloads in it. */
const only = (...ids: FileId[]): Release => {
	const names = new Set<string>(
		pickDownloads(FULL)
			.filter((d) => ids.includes(d.id))
			.map((d) => d.file)
	);
	return { ...FULL, assets: FULL.assets.filter((a) => names.has(a.name)) };
};

/** One tag on each line, so a snapshot reads like the page. */
const lines = (html: string): string => html.replaceAll("><", ">\n<");

/** The visible text of each hero choice, by the system it's for. */
const picks = (html: string): Record<string, string> =>
	Object.fromEntries(
		html
			.split('<div class="os-pick" data-for="')
			.slice(1)
			.map((part) => {
				const end = part.indexOf('">');
				const text = part.slice(end + 2).replace(/<[^>]+>/g, " ");
				return [part.slice(0, end), text.replace(/\s+/g, " ").trim()];
			})
	);

test("renderHero offers each system its own download", () => {
	expect(lines(renderHero(FULL, pickDownloads(FULL)))).toMatchSnapshot();
});

test("renderHero has one choice for each system", () => {
	const html = renderHero(FULL, pickDownloads(FULL));
	expect([...html.matchAll(/data-for="(\w+)"/g)].map((m) => m[1])).toEqual([
		"mac",
		"linux",
		"ios",
		"other",
	]);
});

test("renderHero names Apple Silicon and offers Intel next to it", () => {
	expect(picks(renderHero(FULL, pickDownloads(FULL))).mac).toBe(
		"Download for Mac Apple Silicon, 70.1 MB Intel Mac 72.3 MB Version 1.2.3 for macOS 15 Sequoia or later. About This Mac in the Apple menu shows which chip your Mac has."
	);
});

test("renderHero leaves Intel out of a release without it", () => {
	const release = only("mac-arm", "appimage");
	const html = renderHero(release, pickDownloads(release));
	expect(picks(html).mac).toBe(
		"Download for Mac Apple Silicon, 70.1 MB Version 1.2.3 for macOS 15 Sequoia or later."
	);
	expect(html).not.toContain("MaxVideoPlayer_x64.dmg");
});

test("renderHero sends Macs to every download when there's no Apple Silicon build", () => {
	const release = only("mac-intel", "appimage");
	expect(picks(renderHero(release, pickDownloads(release))).mac).toBe(
		"See all downloads Version 1.2.3 is out for macOS and Linux. Windows and Android are planned."
	);
});

test("renderHero offers Linux the AppImage and points to the packages", () => {
	expect(picks(renderHero(FULL, pickDownloads(FULL))).linux).toBe(
		"Download for Linux AppImage, 181.2 MB Version 1.2.3 for x86_64. Packages for Debian, Ubuntu and Fedora are under Download ."
	);
});

test("renderHero only points to the packages when there are some", () => {
	for (const id of ["deb", "rpm"] as const) {
		const release = only("appimage", id);
		expect(picks(renderHero(release, pickDownloads(release))).linux).toContain(
			"Packages for Debian, Ubuntu and Fedora"
		);
	}
	const release = only("appimage", "mac-arm");
	expect(picks(renderHero(release, pickDownloads(release))).linux).toBe(
		"Download for Linux AppImage, 181.2 MB Version 1.2.3 for x86_64."
	);
});

test("renderHero sends Linux to every download when there's no AppImage", () => {
	const release = only("deb", "rpm");
	expect(picks(renderHero(release, pickDownloads(release))).linux).toBe(
		"See all downloads Version 1.2.3 is out for macOS and Linux. Windows and Android are planned."
	);
});

test("renderHero tells iPhone and iPad visitors the app is coming", () => {
	expect(picks(renderHero(FULL, pickDownloads(FULL))).ios).toBe(
		"Coming soon to the App Store The iPhone and iPad app is on its way. Version 1.2.3 is out for macOS and Linux ."
	);
});

test("renderReleaseMeta shows the version, the date and the release notes", () => {
	expect(renderReleaseMeta(FULL)).toBe(
		'<p class="release-meta">Version 1.2.3, released January 2, 2026. <a href="https://github.com/MaxMB15/MaxVideoPlayer/releases/tag/v1.2.3">Release notes</a></p>'
	);
});

test("renderPlatforms lists each file with its size", () => {
	expect(lines(renderPlatforms(pickDownloads(FULL)))).toMatchSnapshot();
});

test("renderPlatforms only asks about the Mac's chip when there's a choice", () => {
	const release = only("mac-arm", "appimage");
	const html = renderPlatforms(pickDownloads(release));
	expect(html).toContain("<h3>macOS</h3>");
	expect(html).not.toContain("platform-note");
	expect(html).toContain('</ul></div><div class="platform"><h3>Linux</h3>');
});

test("renderPlatforms leaves out a system the release has no files for", () => {
	const linux = only("deb");
	expect(renderPlatforms(pickDownloads(linux))).toBe(
		'<div class="platform"><h3>Linux</h3><p class="requirement">x86_64</p><ul class="file-list"><li><a class="file-row" href="https://github.com/MaxMB15/MaxVideoPlayer/releases/latest/download/MaxVideoPlayer_amd64.deb"><span class="file-label">Debian and Ubuntu</span><span class="file-name">MaxVideoPlayer_<wbr>amd64.deb</span><span class="file-size">41.2 MB</span></a></li></ul></div>'
	);
	const mac = only("mac-intel");
	expect(renderPlatforms(pickDownloads(mac))).not.toContain("Linux");
});

test("renderChecksums lists each file that has a checksum", () => {
	expect(lines(renderChecksums(pickDownloads(FULL)))).toMatchSnapshot();
});

test("renderChecksums is empty when no file has a checksum", () => {
	expect(renderChecksums(pickDownloads(only("rpm")))).toBe("");
});

const PAGE =
	"<header><!-- release:hero --></header><main><!-- release:meta --><div><!-- release:platforms --></div><!-- release:checksums --></main>";

test("fillPage puts each part of the release in place of its marker", () => {
	const release = only("mac-arm", "rpm");
	const downloads = pickDownloads(release);
	expect(fillPage(PAGE, release)).toBe(
		`<header>${renderHero(release, downloads)}</header><main>${renderReleaseMeta(release)}<div>${renderPlatforms(downloads)}</div>${renderChecksums(downloads)}</main>`
	);
});

test("fillPage fails when a marker is missing or there twice", () => {
	for (const name of ["hero", "meta", "platforms", "checksums"]) {
		const marker = `<!-- release:${name} -->`;
		expect(() => fillPage(PAGE.replace(marker, ""), FULL)).toThrow(
			new Error(`index.html needs one ${marker} marker.`)
		);
		expect(() => fillPage(PAGE.replace(marker, marker + marker), FULL)).toThrow(
			new Error(`index.html needs one ${marker} marker.`)
		);
	}
});

test("fillPage fails for a release with none of the files", () => {
	const release = { ...FULL, assets: FULL.assets.filter((a) => a.name === "latest.json") };
	expect(() => fillPage(PAGE, release)).toThrow(
		new Error("Release v1.2.3 has none of the files the page links to.")
	);
});
