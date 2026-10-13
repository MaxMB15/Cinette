// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it, vi } from "vitest";
import type { Provider } from "@/lib/types";
import {
	RETRY_FIRST_DELAY_MS,
	RETRY_MAX_DELAY_MS,
	createRefreshTracker,
	findDueRefreshes,
	isRefreshDue,
	retryDelayMs,
	type RefreshSettings,
} from "./refresh-schedule";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-12T12:00:00Z");

const provider = (id: string, overrides: Partial<Provider> = {}): Provider => ({
	id,
	name: id,
	type: "m3u",
	url: `http://example.test/${id}.m3u`,
	channelCount: 0,
	...overrides,
});

const settings = (overrides: Partial<RefreshSettings> = {}): RefreshSettings => ({
	autoRefresh: true,
	refreshIntervalHours: 24,
	epgAutoRefresh: true,
	epgRefreshIntervalHours: 12,
	...overrides,
});

describe("isRefreshDue", () => {
	it("is due exactly one interval after the last refresh", () => {
		expect(isRefreshDue(NOW - 24 * HOUR, 24, NOW)).toBe(true);
	});

	it("is not due before the interval has passed", () => {
		expect(isRefreshDue(NOW - 24 * HOUR + 1, 24, NOW)).toBe(false);
	});

	it("is due when the provider has never refreshed", () => {
		expect(isRefreshDue(0, 24, NOW)).toBe(true);
	});
});

describe("findDueRefreshes", () => {
	it("lists stale playlists and EPG sources", () => {
		const providers = [
			provider("stale", {
				lastUpdated: new Date(NOW - 25 * HOUR).toISOString(),
				epgUrl: "http://example.test/epg.xml",
			}),
			provider("fresh", {
				lastUpdated: new Date(NOW - HOUR).toISOString(),
				epgUrl: "http://example.test/epg.xml",
			}),
		];
		const lastEpg: Record<string, number> = { stale: NOW - 13 * HOUR, fresh: NOW - HOUR };
		const due = findDueRefreshes(
			providers,
			{ settingsFor: () => settings(), epgLastRefreshFor: (id) => lastEpg[id] },
			NOW
		);
		expect(due).toEqual({ playlistIds: ["stale"], epgIds: ["stale"] });
	});

	it("skips providers with auto refresh turned off", () => {
		const due = findDueRefreshes(
			[provider("a", { epgUrl: "http://example.test/epg.xml" })],
			{
				settingsFor: () => settings({ autoRefresh: false, epgAutoRefresh: false }),
				epgLastRefreshFor: () => 0,
			},
			NOW
		);
		expect(due).toEqual({ playlistIds: [], epgIds: [] });
	});

	it("only checks the EPG for providers that have an EPG URL", () => {
		const epgLastRefreshFor = vi.fn(() => 0);
		const due = findDueRefreshes(
			[provider("no-epg")],
			{ settingsFor: () => settings({ autoRefresh: false }), epgLastRefreshFor },
			NOW
		);
		expect(due.epgIds).toEqual([]);
		expect(epgLastRefreshFor).not.toHaveBeenCalled();
	});

	it("treats a missing or unreadable last update as never refreshed", () => {
		const due = findDueRefreshes(
			[provider("missing"), provider("garbled", { lastUpdated: "not a date" })],
			{ settingsFor: () => settings(), epgLastRefreshFor: () => 0 },
			NOW
		);
		expect(due.playlistIds).toEqual(["missing", "garbled"]);
	});
});

describe("retryDelayMs", () => {
	it("doubles the wait after each failure", () => {
		expect(retryDelayMs(1)).toBe(RETRY_FIRST_DELAY_MS);
		expect(retryDelayMs(2)).toBe(2 * RETRY_FIRST_DELAY_MS);
		expect(retryDelayMs(3)).toBe(4 * RETRY_FIRST_DELAY_MS);
	});

	it("never waits longer than the cap", () => {
		expect(retryDelayMs(20)).toBe(RETRY_MAX_DELAY_MS);
	});
});

describe("createRefreshTracker", () => {
	/** Lets the promise callbacks of a finished refresh run. */
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

	const setup = () => {
		let now = NOW;
		const tracker = createRefreshTracker(() => now);
		return { tracker, advance: (ms: number) => (now += ms) };
	};

	it("joins a refresh that is still running instead of starting another", async () => {
		const { tracker } = setup();
		let finish = () => {};
		const refresh = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));

		const first = tracker.run("epg:p1", refresh);
		expect(first).toBeInstanceOf(Promise);
		expect(tracker.run("epg:p1", refresh)).toBe(first);
		expect(refresh).toHaveBeenCalledTimes(1);

		finish();
		await expect(first).resolves.toBeUndefined();
		expect(tracker.run("epg:p1", refresh)).not.toBe(first);
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it("tracks each key on its own", () => {
		const { tracker } = setup();
		const refresh = vi.fn(() => new Promise<void>(() => {}));

		tracker.run("epg:p1", refresh);
		tracker.run("epg:p2", refresh);
		tracker.run("playlist:p1", refresh);
		expect(refresh).toHaveBeenCalledTimes(3);
	});

	it("rejects with the error when a refresh fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { tracker } = setup();

		await expect(
			tracker.run("epg:p1", () => Promise.reject(new Error("login failed")))
		).rejects.toThrow("login failed");
		vi.mocked(console.error).mockRestore();
	});

	it("waits longer after each failure before trying again", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { tracker, advance } = setup();
		const refresh = vi.fn(() => Promise.reject(new Error("login failed")));

		tracker.run("epg:p1", refresh);
		await settle();
		advance(RETRY_FIRST_DELAY_MS - 1);
		expect(tracker.run("epg:p1", refresh)).toBeNull();
		advance(1);
		expect(tracker.run("epg:p1", refresh)).not.toBeNull();
		await settle();

		advance(RETRY_FIRST_DELAY_MS);
		expect(tracker.run("epg:p1", refresh)).toBeNull();
		advance(RETRY_FIRST_DELAY_MS);
		expect(tracker.run("epg:p1", refresh)).not.toBeNull();
		expect(refresh).toHaveBeenCalledTimes(3);
		vi.mocked(console.error).mockRestore();
	});

	it("forgets earlier failures once a refresh works", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { tracker, advance } = setup();
		const refresh = vi
			.fn<() => Promise<void>>(() => Promise.resolve())
			.mockRejectedValueOnce(new Error("down"))
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("down again"));

		tracker.run("playlist:p1", refresh);
		await settle();
		advance(RETRY_FIRST_DELAY_MS);
		tracker.run("playlist:p1", refresh);
		await settle();
		expect(tracker.run("playlist:p1", refresh)).not.toBeNull();
		await settle();

		// The new failure starts over at the first wait, not the second.
		advance(RETRY_FIRST_DELAY_MS);
		expect(tracker.run("playlist:p1", refresh)).not.toBeNull();
		vi.mocked(console.error).mockRestore();
	});
});
