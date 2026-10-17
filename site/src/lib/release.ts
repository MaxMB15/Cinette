// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/** The parts of GitHub's latest release that the page shows. */
export type Release = {
	/** The tag, such as `v0.6.1`. */
	tag: string;
	/** When the release was published, as an ISO 8601 time. */
	publishedAt: string;
	assets: ReleaseAsset[];
};

export type ReleaseAsset = {
	name: string;
	/** The file's size in bytes. */
	size: number;
	/** GitHub's checksum of the file, such as `sha256:<hex>`, when it has one. */
	digest: string | null;
	/** `uploaded` once the file is complete. */
	state: string;
};

export const REPO_URL = "https://github.com/MaxMB15/MaxVideoPlayer";
export const RELEASE_API_URL =
	"https://api.github.com/repos/MaxMB15/MaxVideoPlayer/releases/latest";
/** A link in this form always points at the file in the newest release. */
export const LATEST_DOWNLOAD_URL = `${REPO_URL}/releases/latest/download/`;

/**
 * Set this to `1` to build with the made-up release in `fixtures/release.json`
 * instead of asking GitHub. Pull request builds use it, so they never reach
 * the network.
 */
export const FIXTURE_ENV = "SITE_RELEASE_FIXTURE";

const TAG = /^v\d+\.\d+\.\d+$/;
const SHA256 = /^sha256:([0-9a-f]{64})$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const parseAsset = (asset: unknown, index: number): ReleaseAsset => {
	if (!isRecord(asset) || typeof asset.name !== "string") {
		throw new Error(`Release asset ${index} has no name.`);
	}
	if (!Number.isSafeInteger(asset.size)) {
		throw new Error(`Release asset ${asset.name} has no size.`);
	}
	return {
		name: asset.name,
		size: asset.size as number,
		digest: typeof asset.digest === "string" ? asset.digest : null,
		state: typeof asset.state === "string" ? asset.state : "",
	};
};

/**
 * Checks the answer from GitHub's releases API and keeps what the page uses.
 * It throws when the tag, the date or a file's size is missing, so a deploy
 * fails rather than publish a page without sizes.
 */
export const parseRelease = (data: unknown): Release => {
	if (!isRecord(data)) throw new Error("The release isn't a JSON object.");
	const { tag_name: tag, published_at: publishedAt, assets } = data;
	if (typeof tag !== "string" || !TAG.test(tag)) {
		throw new Error(`The release's tag isn't a version like v1.2.3: ${String(tag)}`);
	}
	if (typeof publishedAt !== "string" || Number.isNaN(Date.parse(publishedAt))) {
		throw new Error(`Release ${tag} has no publish date.`);
	}
	if (!Array.isArray(assets)) throw new Error(`Release ${tag} has no list of files.`);
	return { tag, publishedAt, assets: assets.map(parseAsset) };
};

export type LoadOptions = {
	env: Record<string, string | undefined>;
	fetch: (url: string, init: { headers: Record<string, string> }) => Promise<Response>;
	readFixture: () => Promise<string>;
};

/**
 * Gets the latest release from GitHub, or the fixture when `FIXTURE_ENV` is
 * `1`. A `GITHUB_TOKEN` in `env` only raises GitHub's rate limit, and it never
 * goes into an error message.
 */
export const loadRelease = async ({ env, fetch, readFixture }: LoadOptions): Promise<Release> => {
	if (env[FIXTURE_ENV] === "1") return parseRelease(JSON.parse(await readFixture()));
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
	const response = await fetch(RELEASE_API_URL, { headers });
	if (!response.ok) {
		throw new Error(
			`GitHub's releases API answered ${response.status}. Set ${FIXTURE_ENV}=1 to build with the made-up release in fixtures/release.json.`
		);
	}
	return parseRelease(await response.json());
};

export type Platform = "macos" | "linux";

/** A file the page offers, in the order the page lists them. */
export const FILES = [
	{
		id: "mac-arm",
		platform: "macos",
		label: "Apple Silicon",
		file: "MaxVideoPlayer_aarch64.dmg",
	},
	{ id: "mac-intel", platform: "macos", label: "Intel", file: "MaxVideoPlayer_x64.dmg" },
	{ id: "appimage", platform: "linux", label: "AppImage", file: "MaxVideoPlayer_amd64.AppImage" },
	{ id: "deb", platform: "linux", label: "Debian and Ubuntu", file: "MaxVideoPlayer_amd64.deb" },
	{ id: "rpm", platform: "linux", label: "Fedora", file: "MaxVideoPlayer_x86_64.rpm" },
] as const satisfies readonly { id: string; platform: Platform; label: string; file: string }[];

export type FileId = (typeof FILES)[number]["id"];

export type Download = (typeof FILES)[number] & {
	url: string;
	bytes: number;
	/** The SHA-256 in hex, when GitHub has one. */
	sha256: string | null;
};

/**
 * The files the page links to. A file that the release doesn't have, or that
 * hasn't finished uploading, is left out, so the page never links a 404.
 */
export const pickDownloads = (release: Release): Download[] =>
	FILES.flatMap((file) => {
		const asset = release.assets.find(
			(a) => a.name === file.file && a.state === "uploaded" && a.size > 0
		);
		if (!asset) return [];
		const sha256 = asset.digest?.match(SHA256)?.[1] ?? null;
		return [{ ...file, url: LATEST_DOWNLOAD_URL + file.file, bytes: asset.size, sha256 }];
	});

/**
 * A size in decimal megabytes, as Finder shows it. 68031110 bytes is "68 MB"
 * and 179796472 bytes is "179.8 MB".
 */
export const formatSize = (bytes: number): string =>
	`${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(bytes / 1e6)} MB`;

/** The release date as GitHub shows it in UTC, such as "October 13, 2026". */
export const formatDate = (iso: string): string =>
	new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(new Date(iso));

/** The version without the tag's `v`. */
export const versionOf = (release: Release): string => release.tag.slice(1);
