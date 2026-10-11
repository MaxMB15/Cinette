// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it, vi } from "vitest";
import type { Provider } from "@/lib/types";
import { findDueRefreshes, isRefreshDue, type RefreshSettings } from "./refresh-schedule";

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
