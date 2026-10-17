// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// Builds the parts of the page that come from the latest release. Only checked
// values reach the HTML. The tag matches a version, the checksum is hex, the
// size and date are numbers, a file's name equals a prefix and an ending from
// release.ts, and the rest are constants there.

import {
	REPO_URL,
	formatDate,
	formatSize,
	pickDownloads,
	versionOf,
	type Download,
	type FileId,
	type Release,
} from "./release.ts";

const DOWNLOAD_ICON =
	'<svg class="btn-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/></svg>';

const find = (downloads: Download[], id: FileId): Download | undefined =>
	downloads.find((d) => d.id === id);

const button = (download: Download, title: string, note: string, primary: boolean): string =>
	`<a class="btn ${primary ? "btn-primary" : "btn-secondary"}" href="${download.url}">${primary ? DOWNLOAD_ICON : ""}<span class="btn-text"><span class="btn-title">${title}</span><span class="btn-note">${note}</span></span></a>`;

const ALL_DOWNLOADS = '<a class="btn btn-primary" href="#download">See all downloads</a>';

/** The Intel build needs the same macOS as the Apple Silicon one. */
const MACOS = "macOS 15 Sequoia or later";

/** One choice in the hero. The script in index.html shows the one for the visitor's system. */
const pick = (os: string, buttons: string, note: string): string =>
	`<div class="os-pick" data-for="${os}"><div class="btn-row">${buttons}</div><p class="hero-note">${note}</p></div>`;

const allDownloads = (os: string, version: string): string =>
	pick(
		os,
		ALL_DOWNLOADS,
		`${version} is out for macOS and Linux. Windows and Android are planned.`
	);

/**
 * The download buttons at the top of the page, one set for each kind of
 * system. Browsers don't say which chip a Mac has, so the Mac set names Apple
 * Silicon and offers Intel next to it. Without an Intel build, the note says
 * the app needs Apple Silicon.
 */
export const renderHero = (release: Release, downloads: Download[]): string => {
	const version = `Version ${versionOf(release)}`;
	const arm = find(downloads, "mac-arm");
	const intel = find(downloads, "mac-intel");
	const appImage = find(downloads, "appimage");
	const packages = downloads.some((d) => d.id === "deb" || d.id === "rpm");
	const mac = arm
		? pick(
				"mac",
				button(arm, "Download for Mac", `Apple Silicon, ${formatSize(arm.bytes)}`, true) +
					(intel ? button(intel, "Intel Mac", formatSize(intel.bytes), false) : ""),
				intel
					? `${version} for ${MACOS}. About This Mac in the Apple menu shows which chip your Mac has.`
					: `${version} for Apple Silicon, ${MACOS}.`
			)
		: allDownloads("mac", version);
	const linux = appImage
		? pick(
				"linux",
				button(
					appImage,
					"Download for Linux",
					`AppImage, ${formatSize(appImage.bytes)}`,
					true
				),
				`${version} for x86_64.${packages ? ' Packages for Debian, Ubuntu and Fedora are under <a href="#download">Download</a>.' : ""}`
			)
		: allDownloads("linux", version);
	const ios = pick(
		"ios",
		'<span class="btn btn-soon">Coming soon to the App Store</span>',
		`The iPhone and iPad app is on its way. ${version} is out for <a href="#download">macOS and Linux</a>.`
	);
	return mac + linux + ios + allDownloads("other", version);
};

const row = (download: Download): string =>
	`<li><a class="file-row" href="${download.url}"><span class="file-label">${download.label}</span><span class="file-name">${download.file.replace("_", "_<wbr>")}</span><span class="file-size">${formatSize(download.bytes)}</span></a></li>`;

const group = (title: string, requirement: string, files: Download[], note: string): string =>
	files.length === 0
		? ""
		: `<div class="platform"><h3>${title}</h3><p class="requirement">${requirement}</p><ul class="file-list">${files.map(row).join("")}</ul>${note}</div>`;

/** The release's version and date, with a link to its notes. */
export const renderReleaseMeta = (release: Release): string =>
	`<p class="release-meta">Version ${versionOf(release)}, released ${formatDate(release.publishedAt)}. <a href="${REPO_URL}/releases/tag/${release.tag}">Release notes</a></p>`;

/**
 * A list of files for macOS and one for Linux, each left out when the release
 * has none. A Mac list with one file names its chip in the requirement.
 */
export const renderPlatforms = (downloads: Download[]): string => {
	const mac = downloads.filter((d) => d.platform === "macos");
	const linux = downloads.filter((d) => d.platform === "linux");
	const chipNote =
		mac.length > 1
			? '<p class="platform-note">Pick the build for your Mac\'s chip, which About This Mac shows.</p>'
			: "";
	const requirement = mac.length === 1 ? `${mac[0].label}, ${MACOS}` : MACOS;
	return group("macOS", requirement, mac, chipNote) + group("Linux", "x86_64", linux, "");
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

/**
 * Puts the release into index.html in place of the `<!-- release:hero -->`,
 * `<!-- release:meta -->`, `<!-- release:platforms -->` and
 * `<!-- release:checksums -->` markers. It throws when the release has none
 * of the files, or when a marker is missing or there twice.
 */
export const fillPage = (html: string, release: Release): string => {
	const downloads = pickDownloads(release);
	if (downloads.length === 0) {
		throw new Error(`Release ${release.tag} has none of the files the page links to.`);
	}
	const parts: [string, string][] = [
		["hero", renderHero(release, downloads)],
		["meta", renderReleaseMeta(release)],
		["platforms", renderPlatforms(downloads)],
		["checksums", renderChecksums(downloads)],
	];
	return parts.reduce((page, [name, part]) => {
		const pieces = page.split(`<!-- release:${name} -->`);
		if (pieces.length !== 2) {
			throw new Error(`index.html needs one <!-- release:${name} --> marker.`);
		}
		return pieces.join(part);
	}, html);
};
