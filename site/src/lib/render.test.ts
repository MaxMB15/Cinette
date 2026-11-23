// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.
// @vitest-environment jsdom

import { expect, test } from "vitest";
import { parseRelease, pickDownloads, type FileId, type Release } from "./release";
import { renderGuide } from "./guide";
import {
	APP_STORE_URL,
	SITE_URL,
	fillPage,
	listOf,
	renderChecksums,
	renderHero,
	renderJsonLd,
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

/** The HTML as a browser reads it, inside a div. */
const parse = (html: string): HTMLDivElement => {
	const div = document.createElement("div");
	div.innerHTML = html;
	return div;
};

/** The element's text, with a space where each tag was. */
const textOf = (element: Element): string => {
	const parts: string[] = [];
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	while (walker.nextNode()) parts.push((walker.currentNode as Text).data);
	return parts.join(" ").replace(/\s+/g, " ").trim();
};

/** The visible text of each hero choice, by the system it's for. */
const picks = (html: string): Record<string, string> =>
	Object.fromEntries(
		[...parse(html).querySelectorAll<HTMLElement>(".os-pick")].map((pick) => [
			pick.dataset.for,
			textOf(pick),
		])
	);

test("renderHero offers each system its own download", () => {
	expect(lines(renderHero(FULL, pickDownloads(FULL)))).toMatchSnapshot();
});

test("renderHero has one choice for each system", () => {
	const html = renderHero(FULL, pickDownloads(FULL));
	const choices = [...parse(html).querySelectorAll<HTMLElement>("[data-for]")];
	expect(choices.map((choice) => choice.dataset.for)).toEqual([
		"mac",
		"linux",
		"android",
		"ios",
		"other",
	]);
});

test("renderHero offers Apple Silicon and links Intel in the note", () => {
	expect(picks(renderHero(FULL, pickDownloads(FULL))).mac).toBe(
		"Download for Mac Apple Silicon, 70.1 MB Version 1.2.3 for macOS 15 Sequoia or later. For an Intel Mac, download the Intel build (72.3 MB)."
	);
});

test("renderHero leaves Intel out of a release without it and says the app needs Apple Silicon", () => {
	const release = only("mac-arm", "appimage");
	const html = renderHero(release, pickDownloads(release));
	expect(picks(html).mac).toBe(
		"Download for Mac Apple Silicon, 70.1 MB Version 1.2.3 for Apple Silicon, macOS 15 Sequoia or later."
	);
	expect(
		[...parse(html).querySelectorAll('[data-for="mac"] a')].map((a) => a.getAttribute("href"))
	).toEqual([
		"https://github.com/MaxMB15/Cinette/releases/download/v1.2.3/Cinette_aarch64.dmg",
		APP_STORE_URL,
	]);
});

test("renderHero sends Macs to every download when there's no Apple Silicon build", () => {
	const release = only("mac-intel", "appimage");
	expect(picks(renderHero(release, pickDownloads(release))).mac).toBe(
		"See all downloads Version 1.2.3 is out for Mac and Linux, and the iPhone and iPad app is on the App Store."
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
		"See all downloads Version 1.2.3 is out for Linux, and the iPhone and iPad app is on the App Store."
	);
});

test("renderHero offers Android the phone build and the TV build next to it", () => {
	const html = renderHero(FULL, pickDownloads(FULL));
	expect(picks(html).android).toBe(
		"Download for Android Phone and tablet, 101.2 MB TV and Fire TV 98.8 MB Version 1.2.3 for Android 9 or later. A TV takes an app like Downloader to install it, as the TV steps show."
	);
	expect(
		[...parse(html).querySelectorAll('[data-for="android"] a')].map((a) =>
			a.getAttribute("href")
		)
	).toEqual([
		"https://github.com/MaxMB15/Cinette/releases/download/v1.2.3/Cinette_arm64-v8a.apk",
		"https://github.com/MaxMB15/Cinette/releases/download/v1.2.3/Cinette_armeabi-v7a.apk",
		"#install-tv",
	]);
});

test("renderHero leaves the TV out of a release without its build", () => {
	const release = only("android-phone", "mac-arm");
	expect(picks(renderHero(release, pickDownloads(release))).android).toBe(
		"Download for Android Phone and tablet, 101.2 MB Version 1.2.3 for Android 9 or later."
	);
});

test("renderHero sends Android to every download when there's no phone build", () => {
	const release = only("android-tv", "mac-arm");
	expect(picks(renderHero(release, pickDownloads(release))).android).toBe(
		"See all downloads Version 1.2.3 is out for Mac and Android, and the iPhone and iPad app is on the App Store."
	);
});

test("renderHero sends iPhone and iPad to the App Store", () => {
	const html = renderHero(FULL, pickDownloads(FULL));
	expect(picks(html).ios).toBe(
		"Free on the App Store for iOS and iPadOS 17.5 or later. Version 1.2.3 is also out for Mac, Linux and Android ."
	);
	expect(
		[...parse(html).querySelectorAll('[data-for="ios"] a')].map((a) => a.getAttribute("href"))
	).toEqual([APP_STORE_URL, "#download"]);
	expect(parse(html).querySelector('[data-for="ios"] img')?.getAttribute("alt")).toBe(
		"Download on the App Store"
	);
});

test("renderHero names only the systems the release has", () => {
	const release = only("mac-arm");
	expect(picks(renderHero(release, pickDownloads(release))).other).toBe(
		"See all downloads Version 1.2.3 is out for Mac, and the iPhone and iPad app is on the App Store."
	);
});

test("listOf joins names as a sentence does", () => {
	expect(listOf([])).toBe("");
	expect(listOf(["Mac"])).toBe("Mac");
	expect(listOf(["Mac", "Linux"])).toBe("Mac and Linux");
	expect(listOf(["Mac", "Linux", "Android"])).toBe("Mac, Linux and Android");
});

test("renderReleaseMeta shows the version, the date and the release notes", () => {
	expect(renderReleaseMeta(FULL)).toBe(
		'<p class="release-meta">Version 1.2.3, released January 2, 2026. <a href="https://github.com/MaxMB15/Cinette/releases/tag/v1.2.3">Release notes</a></p>'
	);
});

test("renderPlatforms lists each file with its size", () => {
	expect(lines(renderPlatforms(pickDownloads(FULL)))).toMatchSnapshot();
});

/** Each row's title, requirement, files and note, as text. The note is everything after the files. */
const rows = (release: Release): string[][] =>
	[...parse(renderPlatforms(pickDownloads(release))).querySelectorAll(".dl-row")].map((row) => {
		const files = row.querySelector(".files") as Element;
		const after = [...(files.parentElement as Element).childNodes].filter(
			(node) => node !== files
		);
		return [
			row.querySelector("h3")?.textContent ?? "",
			row.querySelector(".req")?.textContent ?? "",
			textOf(files),
			after.map((node) => node.textContent).join(""),
		];
	});

test("renderPlatforms has a row for each system, with the main file first", () => {
	expect(rows(FULL)).toEqual([
		[
			"Mac",
			"macOS 15 Sequoia or later",
			"Apple Silicon 70.1 MB Intel 72.3 MB",
			"Pick the build for your Mac's chip, which About This Mac shows.",
		],
		["iPhone and iPad", "iOS and iPadOS 17.5 or later", "", ""],
		["Linux", "x86_64", "AppImage 181.2 MB Debian and Ubuntu 41.2 MB Fedora 41.2 MB", ""],
		[
			"Fire TV, Google TV and Android",
			"Android 9 or later, Fire OS 7 or later",
			"TV and Fire TV 98.8 MB Phone and tablet 101.2 MB",
			"A TV takes an app like Downloader to install it. Read the TV steps",
		],
	]);
	const main = [...parse(renderPlatforms(pickDownloads(FULL))).querySelectorAll(".file.main")];
	expect(main.map((link) => link.textContent)).toEqual([
		"Apple Silicon 70.1 MB",
		"AppImage 181.2 MB",
		"TV and Fire TV 98.8 MB",
	]);
});

test("renderPlatforms names the chip when the Mac has one build", () => {
	expect(rows(only("mac-arm", "appimage"))[0]).toEqual([
		"Mac",
		"Apple Silicon, macOS 15 Sequoia or later",
		"Apple Silicon 70.1 MB",
		"",
	]);
	expect(rows(only("mac-intel", "appimage"))[0]).toEqual([
		"Mac",
		"Intel, macOS 15 Sequoia or later",
		"Intel 72.3 MB",
		"",
	]);
});

test("renderPlatforms only points to the TV steps when there's a TV build", () => {
	expect(rows(only("android-phone"))[1]).toEqual([
		"Fire TV, Google TV and Android",
		"Android 9 or later, Fire OS 7 or later",
		"Phone and tablet 101.2 MB",
		"",
	]);
});

test("renderPlatforms leaves out a system the release has no files for", () => {
	expect(rows(only("deb")).map(([title]) => title)).toEqual(["iPhone and iPad", "Linux"]);
	expect(rows(only("mac-intel")).map(([title]) => title)).toEqual(["Mac", "iPhone and iPad"]);
	expect(renderPlatforms(pickDownloads(only("deb")))).toBe(
		`<div class="dl-row"><div><h3>iPhone and iPad</h3><p class="req">iOS and iPadOS 17.5 or later</p></div><div><div class="files"><a class="badge" href="${APP_STORE_URL}"><img src="./img/app-store-badge.svg" alt="Download on the App Store" width="156" height="52"></a></div></div></div><div class="dl-row"><div><h3>Linux</h3><p class="req">x86_64</p></div><div><div class="files"><a class="file main" href="https://github.com/MaxMB15/Cinette/releases/download/v1.2.3/Cinette_amd64.deb">Debian and Ubuntu <small>41.2 MB</small></a></div></div></div>`
	);
});

test("renderChecksums lists each file that has a checksum", () => {
	expect(lines(renderChecksums(pickDownloads(FULL)))).toMatchSnapshot();
});

test("renderChecksums is empty when no file has a checksum", () => {
	expect(renderChecksums(pickDownloads(only("rpm")))).toBe("");
});

/** The schema.org data in the script that renderJsonLd makes. */
const jsonLd = (release: Release): Record<string, unknown> => {
	const script = parse(renderJsonLd(release, pickDownloads(release))).querySelector("script");
	expect(script?.getAttribute("type")).toBe("application/ld+json");
	return JSON.parse(script?.textContent ?? "") as Record<string, unknown>;
};

test("renderJsonLd describes the site and the app for search engines", () => {
	expect(jsonLd(FULL)).toEqual({
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "WebSite",
				"@id": "https://maxmb15.github.io/Cinette/#website",
				url: "https://maxmb15.github.io/Cinette/",
				name: "Cinette",
			},
			{
				"@type": "SoftwareApplication",
				"@id": "https://maxmb15.github.io/Cinette/#app",
				name: "Cinette",
				url: "https://maxmb15.github.io/Cinette/",
				description:
					"A free, open-source IPTV player. Add an M3U playlist or Xtream Codes login and watch live TV, movies and series with a TV guide.",
				applicationCategory: "MultimediaApplication",
				operatingSystem: "macOS 15, iOS 17.5, iPadOS 17.5, Linux, Android 9",
				softwareVersion: "1.2.3",
				downloadUrl: "https://github.com/MaxMB15/Cinette/releases/latest",
				image: "https://maxmb15.github.io/Cinette/og.png",
				license: "https://www.gnu.org/licenses/gpl-3.0.html",
				isAccessibleForFree: true,
				offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
				sameAs: [APP_STORE_URL, "https://github.com/MaxMB15/Cinette"],
			},
		],
	});
	expect(SITE_URL).toBe("https://maxmb15.github.io/Cinette/");
	expect(APP_STORE_URL).toBe("https://apps.apple.com/us/app/cinette/id6824008116");
});

test("renderJsonLd only names the systems the release has files for", () => {
	const app = (jsonLd(only("deb"))["@graph"] as Record<string, unknown>[])[1];
	expect(app.operatingSystem).toBe("iOS 17.5, iPadOS 17.5, Linux");
	const mac = (jsonLd(only("mac-arm", "android-tv"))["@graph"] as Record<string, unknown>[])[1];
	expect(mac.operatingSystem).toBe("macOS 15, iOS 17.5, iPadOS 17.5, Android 9");
});

test("renderJsonLd leaves no < inside its script", () => {
	const html = renderJsonLd(FULL, pickDownloads(FULL));
	expect(html.slice(35, -9)).not.toContain("<");
	expect(html.startsWith('<script type="application/ld+json">{')).toBe(true);
	expect(html.endsWith("}</script>")).toBe(true);
});

const PAGE =
	"<head><!-- release:jsonld --></head><header><!-- release:hero --><!-- guide --></header><main><!-- release:meta --><div><!-- release:platforms --></div><!-- release:checksums --></main>";

test("fillPage puts each part in place of its marker", () => {
	const release = only("mac-arm", "rpm");
	const downloads = pickDownloads(release);
	expect(fillPage(PAGE, release)).toBe(
		`<head>${renderJsonLd(release, downloads)}</head><header>${renderHero(release, downloads)}${renderGuide()}</header><main>${renderReleaseMeta(release)}<div>${renderPlatforms(downloads)}</div>${renderChecksums(downloads)}</main>`
	);
});

test("fillPage fails when a marker is missing or there twice", () => {
	for (const name of [
		"guide",
		"release:hero",
		"release:meta",
		"release:platforms",
		"release:checksums",
		"release:jsonld",
	]) {
		const marker = `<!-- ${name} -->`;
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
