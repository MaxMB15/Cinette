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

/**
 * The link to a file in one release. It names the tag rather than going
 * through `releases/latest`, so a page built from an older release, after a
 * failed or late deploy, still links the files whose sizes it shows.
 */
export const downloadUrl = (tag: string, file: string): string =>
	`${REPO_URL}/releases/download/${tag}/${file}`;

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
	fetch: (
		url: string,
		init: { headers: Record<string, string>; signal: AbortSignal }
	) => Promise<Response>;
	readFixture: () => Promise<string>;
	/** Resolves after the given number of milliseconds. */
	wait: (ms: number) => Promise<unknown>;
};

/**
 * How long loadRelease waits before its second and third tries, in
 * milliseconds. A request to GitHub's API now and then fails to connect or
 * gets a 502 that the next one doesn't.
 */
export const RETRY_DELAYS = [2000, 5000] as const;

/**
 * How long each try waits for GitHub, in milliseconds, before it gives up.
 * Node's fetch can wait five minutes for an answer, so three tries could
 * outlast the build job's 15 minutes before the build says why it failed.
 */
export const REQUEST_TIMEOUT = 30_000;

const FIXTURE_HINT = `Set ${FIXTURE_ENV}=1 to build with the made-up release in fixtures/release.json.`;

/**
 * Asks for the release, and asks again after each of `RETRY_DELAYS` while the
 * request doesn't reach GitHub, gets no answer within `REQUEST_TIMEOUT` or
 * gets a 5xx. It returns the last answer, and the last try's error reaches
 * the caller.
 */
const fetchWithRetries = async (
	{ fetch, wait }: LoadOptions,
	headers: Record<string, string>
): Promise<Response> => {
	// Each try gets a signal of its own, so each has the whole timeout.
	const request = () =>
		fetch(RELEASE_API_URL, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
	for (const delay of RETRY_DELAYS) {
		try {
			const response = await request();
			if (response.status < 500) return response;
			// Dropping the body frees the connection while the build waits.
			// Stryker disable next-line OptionalChaining: a 5xx without a body throws here, and the catch below waits and tries again just the same.
			await response.body?.cancel();
		} catch {
			// A timeout gets another try, as a dropped connection does. The last
			// try reports the error when it happens again.
		}
		await wait(delay);
	}
	return request().catch((error: unknown) => {
		throw new Error(`GitHub's releases API couldn't be reached. ${FIXTURE_HINT}`, {
			cause: error,
		});
	});
};

/**
 * Gets the latest release from GitHub, or the fixture when `FIXTURE_ENV` is
 * `1`. It tries three times when the network or GitHub fails, then throws. A
 * `GITHUB_TOKEN` in `env` only raises GitHub's rate limit, and it never goes
 * into an error message.
 */
export const loadRelease = async (options: LoadOptions): Promise<Release> => {
	const { env, readFixture } = options;
	if (env[FIXTURE_ENV] === "1") return parseRelease(JSON.parse(await readFixture()));
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
	const response = await fetchWithRetries(options, headers);
	if (!response.ok) {
		throw new Error(`GitHub's releases API answered ${response.status}. ${FIXTURE_HINT}`);
	}
	return parseRelease(await response.json());
};

/**
 * Calls `load` the first time and hands every later caller the same promise.
 * A promise that rejects isn't kept, so the call after a failure loads again.
 */
export const keepUnlessFailed = <T>(load: () => Promise<T>): (() => Promise<T>) => {
	let kept: Promise<T> | undefined;
	return () =>
		(kept ??= load().catch((error: unknown) => {
			kept = undefined;
			throw error;
		}));
};

export type Platform = "macos" | "linux";

/**
 * How each installer's name starts, newest first. The app was called Max Video
 * Player before it became Cinette, and the page shows the last release until
 * the first one under the new name is out.
 */
const PREFIXES = ["Cinette_", "MaxVideoPlayer_"] as const;

/** A file the page offers, in the order the page lists them, with its name after the prefix. */
export const FILES = [
	{ id: "mac-arm", platform: "macos", label: "Apple Silicon", suffix: "aarch64.dmg" },
	{ id: "mac-intel", platform: "macos", label: "Intel", suffix: "x64.dmg" },
	{ id: "appimage", platform: "linux", label: "AppImage", suffix: "amd64.AppImage" },
	{ id: "deb", platform: "linux", label: "Debian and Ubuntu", suffix: "amd64.deb" },
	{ id: "rpm", platform: "linux", label: "Fedora", suffix: "x86_64.rpm" },
] as const satisfies readonly { id: string; platform: Platform; label: string; suffix: string }[];

export type FileId = (typeof FILES)[number]["id"];

export type Download = (typeof FILES)[number] & {
	/** The file's name in the release, such as `Cinette_x64.dmg`. */
	file: string;
	/** The file in the release the page shows, from `downloadUrl`. */
	url: string;
	bytes: number;
	/** The SHA-256 in hex, when GitHub has one. */
	sha256: string | null;
};

/** The release's file with the first of `PREFIXES` that has one ready to download. */
const findAsset = (release: Release, suffix: string): ReleaseAsset | undefined => {
	for (const prefix of PREFIXES) {
		const asset = release.assets.find(
			(a) => a.name === `${prefix}${suffix}` && a.state === "uploaded" && a.size > 0
		);
		if (asset) return asset;
	}
	return undefined;
};

/**
 * The files the page links to. A file that the release doesn't have, or that
 * hasn't finished uploading, is left out, so the page never links a 404.
 */
export const pickDownloads = (release: Release): Download[] =>
	FILES.flatMap((file) => {
		const asset = findAsset(release, file.suffix);
		if (!asset) return [];
		const sha256 = asset.digest?.match(SHA256)?.[1] ?? null;
		return [
			{
				...file,
				file: asset.name,
				url: downloadUrl(release.tag, asset.name),
				bytes: asset.size,
				sha256,
			},
		];
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
