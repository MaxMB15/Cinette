// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// Builds the parts of the page that come from the latest release. Only checked
// values reach the HTML. The tag matches a version, the checksum is hex, the
// size and date are numbers, a file's name equals a prefix and an ending from
// release.ts, and the rest are constants there.

import { renderGuide } from "./guide.ts";
import {
	REPO_URL,
	formatDate,
	formatSize,
	pickDownloads,
	versionOf,
	type Download,
	type FileId,
	type Platform,
	type Release,
} from "./release.ts";

export const SITE_URL = "https://maxmb15.github.io/Cinette/";
export const APP_STORE_URL = "https://apps.apple.com/us/app/cinette/id6824008116";

/** The Intel build needs the same macOS as the Apple Silicon one. */
const MACOS = "macOS 15 Sequoia or later";
const IOS = "iOS and iPadOS 17.5 or later";
const ANDROID = "Android 9 or later";

const DOWNLOAD_ICON =
	'<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/></svg>';

/** Apple's badge, which the stylesheet sizes for the hero or the download list. */
const APP_STORE_BADGE = `<a class="badge" href="${APP_STORE_URL}"><img src="./img/app-store-badge.svg" alt="Download on the App Store" width="156" height="52"></a>`;

const find = (downloads: Download[], id: FileId): Download | undefined =>
	downloads.find((d) => d.id === id);

/** The systems with files in a release, by the names the page uses. */
const SYSTEMS: [Platform, string][] = [
	["macos", "Mac"],
	["linux", "Linux"],
	["android", "Android"],
];

/** Joins names as a sentence does: `A`, `A and B`, `A, B and C`. */
export const listOf = (names: string[]): string =>
	names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

const systemsIn = (downloads: Download[]): string =>
	listOf(
		SYSTEMS.filter(([platform]) => downloads.some((d) => d.platform === platform)).map(
			([, name]) => name
		)
	);

const mainButton = (download: Download, title: string, note: string): string =>
	`<a class="btn btn-main" href="${download.url}">${DOWNLOAD_ICON}${title} <small>${note}</small></a>`;

const altButton = (download: Download, title: string): string =>
	`<a class="btn btn-alt" href="${download.url}">${title} <small>${formatSize(download.bytes)}</small></a>`;

/** One choice in the hero. The script in index.html shows the one for the visitor's system. */
const pick = (os: string, buttons: string, note: string): string =>
	`<div class="os-pick" data-for="${os}"><div class="cta">${buttons}</div><p class="cta-note">${note}</p></div>`;

const allDownloads = (os: string, version: string, downloads: Download[]): string =>
	pick(
		os,
		`<a class="btn btn-main" href="#download">See all downloads</a>${APP_STORE_BADGE}`,
		`${version} is out for ${systemsIn(downloads)}, and the iPhone and iPad app is on the App Store.`
	);

/**
 * The download buttons at the top of the page, one set for each kind of
 * system. Browsers don't say which chip a Mac has, so the Mac set offers
 * Apple Silicon and links the Intel build in its note. A system whose main
 * file is missing from the release gets the link to every download.
 */
export const renderHero = (release: Release, downloads: Download[]): string => {
	const version = `Version ${versionOf(release)}`;
	const arm = find(downloads, "mac-arm");
	const intel = find(downloads, "mac-intel");
	const appImage = find(downloads, "appimage");
	const packages = downloads.some((d) => d.id === "deb" || d.id === "rpm");
	const phone = find(downloads, "android-phone");
	const tv = find(downloads, "android-tv");
	const mac = arm
		? pick(
				"mac",
				mainButton(arm, "Download for Mac", `Apple Silicon, ${formatSize(arm.bytes)}`) +
					APP_STORE_BADGE,
				intel
					? `${version} for ${MACOS}. For an Intel Mac, <a href="${intel.url}">download the Intel build</a> (${formatSize(intel.bytes)}).`
					: `${version} for Apple Silicon, ${MACOS}.`
			)
		: allDownloads("mac", version, downloads);
	const linux = appImage
		? pick(
				"linux",
				mainButton(
					appImage,
					"Download for Linux",
					`AppImage, ${formatSize(appImage.bytes)}`
				) + APP_STORE_BADGE,
				`${version} for x86_64.${packages ? ' Packages for Debian, Ubuntu and Fedora are under <a href="#download">Download</a>.' : ""}`
			)
		: allDownloads("linux", version, downloads);
	const android = phone
		? pick(
				"android",
				mainButton(
					phone,
					"Download for Android",
					`Phone and tablet, ${formatSize(phone.bytes)}`
				) + (tv ? altButton(tv, "TV and Fire TV") : ""),
				`${version} for ${ANDROID}.${tv ? ' A TV takes an app like Downloader to install it, as <a href="#install-tv">the TV steps</a> show.' : ""}`
			)
		: allDownloads("android", version, downloads);
	const ios = pick(
		"ios",
		APP_STORE_BADGE,
		`Free on the App Store for ${IOS}. ${version} is also out for <a href="#download">${systemsIn(downloads)}</a>.`
	);
	return mac + linux + android + ios + allDownloads("other", version, downloads);
};

/** The release's version and date, with a link to its notes. */
export const renderReleaseMeta = (release: Release): string =>
	`<p class="release-meta">Version ${versionOf(release)}, released ${formatDate(release.publishedAt)}. <a href="${REPO_URL}/releases/tag/${release.tag}">Release notes</a></p>`;

const fileLink = (download: Download, index: number): string =>
	`<a class="file${index === 0 ? " main" : ""}" href="${download.url}">${download.label} <small>${formatSize(download.bytes)}</small></a>`;

const row = (title: string, requirement: string, files: string, note: string): string =>
	`<div class="dl-row"><div><h3>${title}</h3><p class="req">${requirement}</p></div><div><div class="files">${files}</div>${note}</div></div>`;

/** A row of files for one system, left out when the release has none. The first file is the one most people want. */
const fileRow = (title: string, requirement: string, files: Download[], note: string): string =>
	files.length === 0 ? "" : row(title, requirement, files.map(fileLink).join(""), note);

const rowNote = (text: string): string => `<p class="dl-note">${text}</p>`;

/**
 * A row for each system: the Mac, the App Store for iPhone and iPad, Linux,
 * and Android with its TVs. A system the release has no files for is left
 * out, except iPhone and iPad, which only link to the App Store. A Mac row
 * with one file names its chip in the requirement.
 */
export const renderPlatforms = (downloads: Download[]): string => {
	const of = (platform: Platform): Download[] => downloads.filter((d) => d.platform === platform);
	const mac = of("macos");
	const android = of("android");
	const chipNote =
		mac.length > 1
			? rowNote("Pick the build for your Mac's chip, which About This Mac shows.")
			: "";
	const tvNote = android.some((d) => d.id === "android-tv")
		? rowNote(
				'A TV takes an app like Downloader to install it. <a href="#install-tv">Read the TV steps</a>'
			)
		: "";
	return (
		fileRow("Mac", mac.length === 1 ? `${mac[0].label}, ${MACOS}` : MACOS, mac, chipNote) +
		row("iPhone and iPad", IOS, APP_STORE_BADGE, "") +
		fileRow("Linux", "x86_64", of("linux"), "") +
		fileRow("Fire TV, Google TV and Android", `${ANDROID}, Fire OS 7 or later`, android, tvNote)
	);
};

/** GitHub's SHA-256 of each file that has one, folded away. */
export const renderChecksums = (downloads: Download[]): string => {
	const rows = downloads
		.filter((d) => d.sha256 !== null)
		.map((d) => `<div><dt>${d.file}</dt><dd><code>${d.sha256}</code></dd></div>`)
		.join("");
	return rows === ""
		? ""
		: `<details class="checksums"><summary>SHA-256 checksums</summary><dl>${rows}</dl></details>`;
};

/** The systems the app runs on, for search engines. */
const operatingSystems = (downloads: Download[]): string => {
	const has = (platform: Platform): boolean => downloads.some((d) => d.platform === platform);
	return [
		has("macos") ? "macOS 15" : "",
		"iOS 17.5",
		"iPadOS 17.5",
		has("linux") ? "Linux" : "",
		has("android") ? "Android 9" : "",
	]
		.filter((name) => name !== "")
		.join(", ");
};

/**
 * What the page is about, as schema.org data that search engines read. A `<`
 * is escaped, so nothing in it can end the script element.
 */
export const renderJsonLd = (release: Release, downloads: Download[]): string => {
	const data = {
		"@context": "https://schema.org",
		"@graph": [
			{ "@type": "WebSite", "@id": `${SITE_URL}#website`, url: SITE_URL, name: "Cinette" },
			{
				"@type": "SoftwareApplication",
				"@id": `${SITE_URL}#app`,
				name: "Cinette",
				url: SITE_URL,
				description:
					"A free, open-source IPTV player. Add an M3U playlist or Xtream Codes login and watch live TV, movies and series with a TV guide.",
				applicationCategory: "MultimediaApplication",
				operatingSystem: operatingSystems(downloads),
				softwareVersion: versionOf(release),
				downloadUrl: `${REPO_URL}/releases/latest`,
				image: `${SITE_URL}og.png`,
				license: "https://www.gnu.org/licenses/gpl-3.0.html",
				isAccessibleForFree: true,
				offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
				sameAs: [APP_STORE_URL, REPO_URL],
			},
		],
	};
	const json = JSON.stringify(data);
	// Stryker disable next-line StringLiteral,MethodExpression: every value is a constant or checked in release.ts, so none has a < to escape.
	return `<script type="application/ld+json">${json.replaceAll("<", "\\u003c")}</script>`;
};

/**
 * Puts the part in place of the page's `<!-- name -->` marker. It throws when
 * the marker is missing or there twice.
 */
const fillMarker = (html: string, name: string, part: string): string => {
	const pieces = html.split(`<!-- ${name} -->`);
	if (pieces.length !== 2) {
		throw new Error(`index.html needs one <!-- ${name} --> marker.`);
	}
	return pieces.join(part);
};

/**
 * Fills index.html's markers: `<!-- guide -->` with the hero's TV guide, and
 * `<!-- release:hero -->`, `<!-- release:meta -->`, `<!-- release:platforms -->`,
 * `<!-- release:checksums -->` and `<!-- release:jsonld -->` with the parts
 * that come from the release. It throws when the release has none of the
 * files, or when a marker is missing or there twice.
 */
export const fillPage = (html: string, release: Release): string => {
	const downloads = pickDownloads(release);
	if (downloads.length === 0) {
		throw new Error(`Release ${release.tag} has none of the files the page links to.`);
	}
	const parts: [string, string][] = [
		["guide", renderGuide()],
		["release:hero", renderHero(release, downloads)],
		["release:meta", renderReleaseMeta(release)],
		["release:platforms", renderPlatforms(downloads)],
		["release:checksums", renderChecksums(downloads)],
		["release:jsonld", renderJsonLd(release, downloads)],
	];
	return parts.reduce((page, [name, part]) => fillMarker(page, name, part), html);
};
