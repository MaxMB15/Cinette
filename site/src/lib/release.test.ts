// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { expect, onTestFinished, test, vi } from "vitest";
import {
	FILES,
	FIXTURE_ENV,
	RELEASE_API_URL,
	downloadUrl,
	formatDate,
	formatSize,
	keepUnlessFailed,
	loadRelease,
	parseRelease,
	pickDownloads,
	versionOf,
	type Release,
	type ReleaseAsset,
} from "./release";
import FIXTURE from "../../fixtures/release.json?raw";
import README from "../../../README.md?raw";

const asset = (name: string, extra: Partial<ReleaseAsset> = {}): ReleaseAsset => ({
	name,
	size: 1000,
	digest: null,
	state: "uploaded",
	...extra,
});

const release = (assets: ReleaseAsset[]): Release => ({
	tag: "v1.2.3",
	publishedAt: "2026-01-02T03:04:05Z",
	assets,
});

const raw = (fields: Record<string, unknown>) => ({
	tag_name: "v1.2.3",
	published_at: "2026-01-02T03:04:05Z",
	assets: [],
	...fields,
});

test("parseRelease keeps the tag, the date and each file's name, size, checksum and state", () => {
	expect(parseRelease(JSON.parse(FIXTURE))).toEqual({
		tag: "v1.2.3",
		publishedAt: "2026-01-02T03:04:05Z",
		assets: [
			{
				name: "latest.json",
				size: 1557,
				digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
				state: "uploaded",
			},
			{
				name: "Cinette_aarch64.dmg",
				size: 70123456,
				digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				state: "uploaded",
			},
			{
				name: "Cinette_x64.dmg",
				size: 72345678,
				digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				state: "uploaded",
			},
			{
				name: "Cinette_amd64.AppImage",
				size: 181234567,
				digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
				state: "uploaded",
			},
			{
				name: "Cinette_amd64.deb",
				size: 41234567,
				digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
				state: "uploaded",
			},
			{ name: "Cinette_x86_64.rpm", size: 41239999, digest: null, state: "uploaded" },
			{
				name: "Cinette_linux.tar.gz",
				size: 180000000,
				digest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
				state: "uploaded",
			},
		],
	});
});

test("parseRelease accepts versions with more than one digit in each part", () => {
	expect(parseRelease(raw({ tag_name: "v10.20.30" })).tag).toBe("v10.20.30");
});

test("parseRelease rejects anything but a JSON object", () => {
	for (const data of [null, [], "v1.2.3", 3]) {
		expect(() => parseRelease(data)).toThrow("The release isn't a JSON object.");
	}
});

test("parseRelease rejects a tag that isn't a plain version", () => {
	for (const tag of ["1.2.3", "v1.2", "v1.2.3-beta", "xv1.2.3", "v1.2.3x", "v1a2b3", "va.b.c"]) {
		expect(() => parseRelease(raw({ tag_name: tag }))).toThrow(
			`The release's tag isn't a version like v1.2.3: ${tag}`
		);
	}
	expect(() => parseRelease(raw({ tag_name: 123 }))).toThrow(
		"The release's tag isn't a version like v1.2.3: 123"
	);
	expect(() => parseRelease(raw({ tag_name: undefined }))).toThrow(
		"The release's tag isn't a version like v1.2.3: undefined"
	);
	// A list with one version in it passes the pattern, which reads it as text.
	expect(() => parseRelease(raw({ tag_name: ["v1.2.3"] }))).toThrow(
		"The release's tag isn't a version like v1.2.3: v1.2.3"
	);
});

test("parseRelease rejects a release without a publish date", () => {
	// Date.parse reads a list with one date in it as that date.
	for (const date of [null, 1760354761, "not a date", ["2026-01-02T03:04:05Z"]]) {
		expect(() => parseRelease(raw({ published_at: date }))).toThrow(
			"Release v1.2.3 has no publish date."
		);
	}
});

test("parseRelease rejects a release without a list of files", () => {
	for (const assets of [undefined, {}, "Cinette_aarch64.dmg"]) {
		expect(() => parseRelease(raw({ assets }))).toThrow("Release v1.2.3 has no list of files.");
	}
});

test("parseRelease rejects a file without a name, and says which one", () => {
	const named = { name: "a.dmg", size: 1 };
	expect(() => parseRelease(raw({ assets: [null] }))).toThrow("Release asset 0 has no name.");
	expect(() => parseRelease(raw({ assets: [named, []] }))).toThrow(
		"Release asset 1 has no name."
	);
	expect(() => parseRelease(raw({ assets: [named, { size: 1 }] }))).toThrow(
		"Release asset 1 has no name."
	);
	expect(() => parseRelease(raw({ assets: [{ name: 7, size: 1 }] }))).toThrow(
		"Release asset 0 has no name."
	);
});

test("parseRelease rejects a file without a size in whole bytes", () => {
	for (const size of [undefined, "1000", 1.5, Number.NaN, 2 ** 53]) {
		expect(() => parseRelease(raw({ assets: [{ name: "a.dmg", size }] }))).toThrow(
			"Release asset a.dmg has no size."
		);
	}
});

test("parseRelease leaves out a checksum or state that isn't text", () => {
	expect(
		parseRelease(raw({ assets: [{ name: "a.dmg", size: 0, digest: 5, state: true }] })).assets
	).toEqual([{ name: "a.dmg", size: 0, digest: null, state: "" }]);
});

const response = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), { status });

/** A wait that returns at once, so no test sleeps. */
const wait = async () => {};

/**
 * A fetch that gives these answers in turn, throwing each error, and a wait.
 * Both write to one log, so a test sees the order of tries and waits. Each
 * request's URL, headers and signal go into `requests`.
 */
const answers = (...queue: (Response | Error)[]) => {
	const log: string[] = [];
	const requests: [string, { headers: Record<string, string>; signal: AbortSignal }][] = [];
	const fetch = async (
		url: string,
		init: { headers: Record<string, string>; signal: AbortSignal }
	) => {
		log.push("fetch");
		requests.push([url, init]);
		const answer = queue.shift();
		if (answer === undefined) throw new Error("The test gave no more answers.");
		if (answer instanceof Error) throw answer;
		return answer;
	};
	const wait = async (ms: number) => {
		log.push(`wait ${ms}`);
	};
	return { log, requests, fetch, wait };
};

const FIXTURE_HINT =
	"Set SITE_RELEASE_FIXTURE=1 to build with the made-up release in fixtures/release.json.";

test("loadRelease asks GitHub for the latest release", async () => {
	const fetch = vi.fn(async () => response(200, raw({ tag_name: "v0.6.1" })));
	const readFixture = vi.fn(async () => FIXTURE);
	const wait = vi.fn(async () => {});
	const loaded = await loadRelease({ env: {}, fetch, readFixture, wait });
	expect(loaded).toEqual({ tag: "v0.6.1", publishedAt: "2026-01-02T03:04:05Z", assets: [] });
	expect(fetch).toHaveBeenCalledExactlyOnceWith(
		"https://api.github.com/repos/MaxMB15/Cinette/releases/latest",
		{
			headers: {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			signal: expect.any(AbortSignal),
		}
	);
	expect(readFixture).not.toHaveBeenCalled();
	expect(wait).not.toHaveBeenCalled();
});

test("loadRelease sends GITHUB_TOKEN when there is one", async () => {
	const fetch = vi.fn(async () => response(200, raw({})));
	await loadRelease({
		env: { GITHUB_TOKEN: "made-up-token" },
		fetch,
		readFixture: vi.fn(),
		wait,
	});
	expect(fetch).toHaveBeenCalledExactlyOnceWith(RELEASE_API_URL, {
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			Authorization: "Bearer made-up-token",
		},
		signal: expect.any(AbortSignal),
	});
});

test("loadRelease sends no token when GITHUB_TOKEN is empty", async () => {
	const fetch = vi.fn(async () => response(200, raw({})));
	await loadRelease({ env: { GITHUB_TOKEN: "" }, fetch, readFixture: vi.fn(), wait });
	expect(fetch.mock.calls[0]).toEqual([
		RELEASE_API_URL,
		{
			headers: {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			signal: expect.any(AbortSignal),
		},
	]);
});

test("loadRelease fails at once when GitHub refuses, without the token", async () => {
	for (const status of [403, 404, 499]) {
		const tries = answers(response(status, { message: "API rate limit exceeded" }));
		const loading = loadRelease({
			env: { GITHUB_TOKEN: "made-up-token" },
			readFixture: vi.fn(),
			...tries,
		});
		await expect(loading).rejects.toThrow(
			new Error(`GitHub's releases API answered ${status}. ${FIXTURE_HINT}`)
		);
		expect(tries.log).toEqual(["fetch"]);
	}
});

test("loadRelease tries again after a dropped connection or a 5xx", async () => {
	const tries = answers(
		new TypeError("fetch failed"),
		response(500, { message: "Server Error" }),
		response(200, raw({ tag_name: "v0.6.1" }))
	);
	const loaded = await loadRelease({
		env: { GITHUB_TOKEN: "made-up-token" },
		readFixture: vi.fn(),
		...tries,
	});
	expect(loaded.tag).toBe("v0.6.1");
	expect(tries.log).toEqual(["fetch", "wait 2000", "fetch", "wait 5000", "fetch"]);
	// Each try sends the same request, token and all.
	const request = [
		RELEASE_API_URL,
		{
			headers: {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				Authorization: "Bearer made-up-token",
			},
			signal: expect.any(AbortSignal),
		},
	];
	expect(tries.requests).toEqual([request, request, request]);
});

test("loadRelease gives each try 30 seconds of its own", async () => {
	const timeout = vi.spyOn(AbortSignal, "timeout");
	onTestFinished(() => timeout.mockRestore());
	const tries = answers(response(502, {}), response(200, raw({})));
	await loadRelease({ env: {}, readFixture: vi.fn(), ...tries });
	expect(timeout.mock.calls).toEqual([[30_000], [30_000]]);
	const signals = tries.requests.map(([, init]) => init.signal);
	expect(signals).toHaveLength(2);
	expect(signals[0]).toBe(timeout.mock.results[0]?.value);
	expect(signals[1]).toBe(timeout.mock.results[1]?.value);
});

test("loadRelease tries again when GitHub takes too long to answer", async () => {
	const tries = answers(
		new DOMException("The operation was aborted due to timeout", "TimeoutError"),
		response(200, raw({ tag_name: "v0.6.1" }))
	);
	const loaded = await loadRelease({ env: {}, readFixture: vi.fn(), ...tries });
	expect(loaded.tag).toBe("v0.6.1");
	expect(tries.log).toEqual(["fetch", "wait 2000", "fetch"]);
});

test("loadRelease drops each 5xx answer's body before it waits", async () => {
	const first = response(502, { message: "Bad Gateway" });
	const second = response(503, { message: "Service Unavailable" });
	const tries = answers(first, second, response(200, raw({})));
	const dropped: [boolean, boolean][] = [];
	const loaded = await loadRelease({
		env: {},
		readFixture: vi.fn(),
		fetch: tries.fetch,
		wait: async () => {
			dropped.push([first.bodyUsed, second.bodyUsed]);
		},
	});
	expect(loaded.tag).toBe("v1.2.3");
	expect(dropped).toEqual([
		[true, false],
		[true, true],
	]);
});

test("loadRelease tries again after a 5xx answer with no body", async () => {
	const tries = answers(new Response(null, { status: 503 }), response(200, raw({})));
	const loaded = await loadRelease({ env: {}, readFixture: vi.fn(), ...tries });
	expect(loaded.tag).toBe("v1.2.3");
	expect(tries.log).toEqual(["fetch", "wait 2000", "fetch"]);
});

test("loadRelease stops trying once GitHub answers", async () => {
	const tries = answers(response(502, {}), response(200, raw({})));
	await loadRelease({ env: {}, readFixture: vi.fn(), ...tries });
	expect(tries.log).toEqual(["fetch", "wait 2000", "fetch"]);
});

test("loadRelease fails after three 5xx answers", async () => {
	const tries = answers(response(503, {}), response(502, {}), response(504, {}));
	await expect(loadRelease({ env: {}, readFixture: vi.fn(), ...tries })).rejects.toThrow(
		new Error(`GitHub's releases API answered 504. ${FIXTURE_HINT}`)
	);
	expect(tries.log).toEqual(["fetch", "wait 2000", "fetch", "wait 5000", "fetch"]);
});

test("loadRelease fails after three tries without a connection, with the last error", async () => {
	const last = new TypeError("fetch failed: getaddrinfo ENOTFOUND api.github.com");
	const tries = answers(new TypeError("fetch failed"), new TypeError("fetch failed"), last);
	const error = await loadRelease({ env: {}, readFixture: vi.fn(), ...tries }).catch(
		(caught: unknown) => caught
	);
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).message).toBe(
		`GitHub's releases API couldn't be reached. ${FIXTURE_HINT}`
	);
	expect((error as Error).cause).toBe(last);
	expect(tries.log).toEqual(["fetch", "wait 2000", "fetch", "wait 5000", "fetch"]);
});

test("loadRelease checks what GitHub sends", async () => {
	const fetch = vi.fn(async () => response(200, { message: "Not Found" }));
	await expect(loadRelease({ env: {}, fetch, readFixture: vi.fn(), wait })).rejects.toThrow(
		"The release's tag isn't a version like v1.2.3: undefined"
	);
});

test(`loadRelease reads the fixture without the network when ${FIXTURE_ENV} is 1`, async () => {
	const fetch = vi.fn();
	const loaded = await loadRelease({
		env: { [FIXTURE_ENV]: "1" },
		fetch,
		readFixture: async () => FIXTURE,
		wait,
	});
	expect(loaded).toEqual(parseRelease(JSON.parse(FIXTURE)));
	expect(fetch).not.toHaveBeenCalled();
});

test(`loadRelease only takes 1 as a yes for ${FIXTURE_ENV}`, async () => {
	for (const value of ["0", "true", ""]) {
		const fetch = vi.fn(async () => response(200, raw({})));
		const readFixture = vi.fn(async () => FIXTURE);
		await loadRelease({ env: { [FIXTURE_ENV]: value }, fetch, readFixture, wait });
		expect(fetch).toHaveBeenCalledOnce();
		expect(readFixture).not.toHaveBeenCalled();
	}
});

test("keepUnlessFailed loads once and hands every caller what it loaded", async () => {
	const load = vi.fn(async () => "v1.2.3");
	const get = keepUnlessFailed(load);
	expect(load).not.toHaveBeenCalled();
	expect(await Promise.all([get(), get()])).toEqual(["v1.2.3", "v1.2.3"]);
	expect(await get()).toBe("v1.2.3");
	expect(load).toHaveBeenCalledOnce();
});

test("keepUnlessFailed loads again after a failure", async () => {
	const load = vi
		.fn<() => Promise<string>>()
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValue("v1.2.3");
	const get = keepUnlessFailed(load);
	const waiting = [get(), get()];
	for (const result of waiting) {
		await expect(result).rejects.toThrow(new Error("offline"));
	}
	expect(load).toHaveBeenCalledOnce();
	expect(await get()).toBe("v1.2.3");
	expect(await get()).toBe("v1.2.3");
	expect(load).toHaveBeenCalledTimes(2);
});

test("FILES lists the downloads in the order the page shows them", () => {
	expect(FILES.map((f) => [f.id, f.platform, f.label, f.suffix])).toEqual([
		["mac-arm", "macos", "Apple Silicon", "aarch64.dmg"],
		["mac-intel", "macos", "Intel", "x64.dmg"],
		["appimage", "linux", "AppImage", "amd64.AppImage"],
		["deb", "linux", "Debian and Ubuntu", "amd64.deb"],
		["rpm", "linux", "Fedora", "x86_64.rpm"],
	]);
});

test("FILES has the names the README links to", () => {
	for (const { suffix } of FILES) {
		expect(README).toContain(
			`https://github.com/MaxMB15/Cinette/releases/latest/download/Cinette_${suffix})`
		);
	}
});

test("pickDownloads links each file the release has in that release", () => {
	expect(pickDownloads(parseRelease(JSON.parse(FIXTURE)))).toEqual([
		{
			...FILES[0],
			file: "Cinette_aarch64.dmg",
			url: "https://github.com/MaxMB15/Cinette/releases/download/v1.2.3/Cinette_aarch64.dmg",
			bytes: 70123456,
			sha256: "a".repeat(64),
		},
		{
			...FILES[1],
			file: "Cinette_x64.dmg",
			url: "https://github.com/MaxMB15/Cinette/releases/download/v1.2.3/Cinette_x64.dmg",
			bytes: 72345678,
			sha256: "b".repeat(64),
		},
		{
			...FILES[2],
			file: "Cinette_amd64.AppImage",
			url: "https://github.com/MaxMB15/Cinette/releases/download/v1.2.3/Cinette_amd64.AppImage",
			bytes: 181234567,
			sha256: "c".repeat(64),
		},
		{
			...FILES[3],
			file: "Cinette_amd64.deb",
			url: "https://github.com/MaxMB15/Cinette/releases/download/v1.2.3/Cinette_amd64.deb",
			bytes: 41234567,
			sha256: "d".repeat(64),
		},
		{
			...FILES[4],
			file: "Cinette_x86_64.rpm",
			url: "https://github.com/MaxMB15/Cinette/releases/download/v1.2.3/Cinette_x86_64.rpm",
			bytes: 41239999,
			sha256: null,
		},
	]);
});

test("pickDownloads leaves out a file the release doesn't have", () => {
	const downloads = pickDownloads(
		release([
			asset("Cinette_amd64.deb"),
			asset("cinette_x64.dmg"),
			asset("Cinette-aarch64.dmg"),
			asset("maxvideoplayer_amd64.AppImage"),
			asset("Max_x86_64.rpm"),
		])
	);
	expect(downloads.map((d) => d.id)).toEqual(["deb"]);
});

test("pickDownloads takes the names from before the rename to Cinette", () => {
	const hex = "0123456789abcdef".repeat(4);
	const downloads = pickDownloads(
		release([
			asset("MaxVideoPlayer_aarch64.dmg", { digest: `sha256:${hex}` }),
			asset("MaxVideoPlayer_amd64.deb"),
		])
	);
	expect(downloads.map((d) => [d.id, d.file, d.url, d.sha256])).toEqual([
		[
			"mac-arm",
			"MaxVideoPlayer_aarch64.dmg",
			`https://github.com/MaxMB15/Cinette/releases/download/v1.2.3/MaxVideoPlayer_aarch64.dmg`,
			hex,
		],
		[
			"deb",
			"MaxVideoPlayer_amd64.deb",
			`https://github.com/MaxMB15/Cinette/releases/download/v1.2.3/MaxVideoPlayer_amd64.deb`,
			null,
		],
	]);
});

test("pickDownloads prefers the Cinette name and takes the old one while the new one uploads", () => {
	const downloads = pickDownloads(
		release([
			asset("MaxVideoPlayer_x64.dmg", { size: 1 }),
			asset("Cinette_x64.dmg", { size: 2 }),
			asset("Cinette_amd64.deb", { state: "starter" }),
			asset("MaxVideoPlayer_amd64.deb", { size: 3 }),
		])
	);
	expect(downloads.map((d) => [d.file, d.bytes])).toEqual([
		["Cinette_x64.dmg", 2],
		["MaxVideoPlayer_amd64.deb", 3],
	]);
});

test("pickDownloads leaves out a file that hasn't finished uploading or is empty", () => {
	const downloads = pickDownloads(
		release([
			asset("Cinette_aarch64.dmg", { state: "starter" }),
			asset("Cinette_x64.dmg", { size: 0 }),
			asset("Cinette_amd64.deb", { size: 1 }),
		])
	);
	expect(downloads.map((d) => [d.id, d.bytes])).toEqual([["deb", 1]]);
});

test("pickDownloads only shows a checksum that is a SHA-256 in hex", () => {
	const hex = "0123456789abcdef".repeat(4);
	const sha256 = (digest: string | null) =>
		pickDownloads(release([asset("Cinette_aarch64.dmg", { digest })]))[0].sha256;
	expect(sha256(`sha256:${hex}`)).toBe(hex);
	for (const digest of [
		null,
		hex,
		`sha256:${hex.toUpperCase()}`,
		`sha256:${hex}0`,
		`sha256:${hex.slice(1)}`,
		`sha256:${hex.slice(1)}g`,
		`xsha256:${hex}`,
		`sha512:${hex}`,
	]) {
		expect(sha256(digest)).toBe(null);
	}
});

test("downloadUrl names the release's tag rather than the latest release", () => {
	expect(downloadUrl("v0.7.0", "MaxVideoPlayer_x64.dmg")).toBe(
		"https://github.com/MaxMB15/Cinette/releases/download/v0.7.0/MaxVideoPlayer_x64.dmg"
	);
});

test("pickDownloads links the files of the release it was given", () => {
	const older = { ...release([asset("MaxVideoPlayer_amd64.deb")]), tag: "v0.6.1" };
	expect(pickDownloads(older).map((d) => d.url)).toEqual([
		"https://github.com/MaxMB15/Cinette/releases/download/v0.6.1/MaxVideoPlayer_amd64.deb",
	]);
});

test("formatSize shows decimal megabytes with one decimal at most, like Finder", () => {
	expect(formatSize(68031110)).toBe("68 MB");
	expect(formatSize(179796472)).toBe("179.8 MB");
	expect(formatSize(40980690)).toBe("41 MB");
	expect(formatSize(1_000_000)).toBe("1 MB");
	expect(formatSize(1_234_567_890)).toBe("1,234.6 MB");
});

test("formatDate shows the day in UTC, as GitHub's release page does", () => {
	expect(formatDate("2026-10-13T11:26:01Z")).toBe("October 13, 2026");
	// One side of midnight or the other moves in any time zone but UTC.
	expect(formatDate("2026-03-01T00:30:00Z")).toBe("March 1, 2026");
	expect(formatDate("2026-02-28T23:30:00Z")).toBe("February 28, 2026");
});

test("versionOf drops the tag's v", () => {
	expect(versionOf(release([]))).toBe("1.2.3");
});
