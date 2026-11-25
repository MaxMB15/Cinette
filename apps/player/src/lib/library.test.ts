// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./tauri", async (importOriginal) => ({
	...(await importOriginal<typeof import("./tauri")>()),
	remoteLibrary: vi.fn(async () => "answer"),
}));

import * as tauri from "./tauri";
import { libraryOf, LOCAL, REMOTE_URL, remoteItemId, remoteSource, type Library } from "./library";
import type { Channel } from "./types";

const channel = (id: string, url: string) => ({ id, url }) as Channel;

beforeEach(() => vi.mocked(tauri.remoteLibrary).mockClear());

describe("sources", () => {
	it("name this device and the device a link controls", () => {
		expect(LOCAL).toBe("local");
		expect(remoteSource(12)).toBe("remote:12");
	});
});

describe("libraryOf", () => {
	it("is this device's own commands for this device", () => {
		const local = libraryOf(LOCAL);
		expect(local.getAllChannels).toBe(tauri.getAllChannels);
		expect(local.toggleFavorite).toBe(tauri.toggleFavorite);
		expect(local.clearWatchHistoryOfType).toBe(tauri.clearWatchHistoryOfType);
	});

	type Row = [
		name: string,
		call: (library: Library) => Promise<unknown>,
		sent: tauri.LibraryCall,
	];

	const rows: Row[] = [
		["getAllChannels", (l) => l.getAllChannels(), { name: "channels" }],
		["getProviders", (l) => l.getProviders(), { name: "providers" }],
		[
			"getGroupHierarchy",
			(l) => l.getGroupHierarchy("p1", "movie"),
			{ name: "groupHierarchy", providerId: "p1", contentType: "movie" },
		],
		[
			"getPinnedGroups",
			(l) => l.getPinnedGroups("p1", "live"),
			{ name: "pinnedGroups", providerId: "p1", contentType: "live" },
		],
		[
			"getEpgForLiveChannels",
			(l) => l.getEpgForLiveChannels(100, 200, ["news.tv"]),
			{ name: "guide", from: 100, to: 200, ids: ["news.tv"] },
		],
		[
			"getEpgProgrammes",
			(l) => l.getEpgProgrammes("news.tv", 100, 200),
			{ name: "schedule", epgId: "news.tv", from: 100, to: 200 },
		],
		[
			"searchEpgProgrammes",
			(l) => l.searchEpgProgrammes("match", 100),
			{ name: "guideSearch", query: "match", from: 100 },
		],
		[
			"getWatchHistory",
			(l) => l.getWatchHistory(20, "movie"),
			{ name: "history", limit: 20, contentType: "movie" },
		],
		[
			"getXtreamSeriesEpisodes",
			(l) => l.getXtreamSeriesEpisodes("s1"),
			{ name: "seriesEpisodes", seriesId: "s1" },
		],
		[
			"getCachedSeriesEpisodes",
			(l) => l.getCachedSeriesEpisodes("s2"),
			{ name: "seriesEpisodes", seriesId: "s2" },
		],
		[
			"fetchOmdbData",
			(l) => l.fetchOmdbData("m1", "Sintel", "movie"),
			{ name: "omdb", id: "m1", title: "Sintel", kind: "movie" },
		],
		[
			"fetchWhatsonData",
			(l) => l.fetchWhatsonData("tt1", "show"),
			{ name: "whatson", imdbId: "tt1", kind: "show" },
		],
		["toggleFavorite", (l) => l.toggleFavorite("c1"), { name: "toggleFavorite", id: "c1" }],
		[
			"pinGroup",
			(l) => l.pinGroup("p1", "live", "News", 3),
			{ name: "pinGroup", providerId: "p1", contentType: "live", group: "News", order: 3 },
		],
		[
			"unpinGroup",
			(l) => l.unpinGroup("p1", "live", "News"),
			{ name: "unpinGroup", providerId: "p1", contentType: "live", group: "News" },
		],
		[
			"deleteHistoryEntry",
			(l) => l.deleteHistoryEntry("c1"),
			{ name: "deleteHistory", channelId: "c1" },
		],
		[
			"deleteHistorySeries",
			(l) => l.deleteHistorySeries("Show"),
			{ name: "deleteHistorySeries", seriesTitle: "Show" },
		],
		["clearWatchHistory", (l) => l.clearWatchHistory(), { name: "clearHistory" }],
		[
			"clearWatchHistoryOfType",
			(l) => l.clearWatchHistoryOfType("live"),
			{ name: "clearHistory", contentType: "live" },
		],
	];

	it.each(rows)("asks the other device for %s", async (_, call, sent) => {
		await expect(call(libraryOf(remoteSource(12)))).resolves.toBe("answer");
		expect(tauri.remoteLibrary).toHaveBeenCalledExactlyOnceWith(12, sent);
	});

	it("has a row for every call the screens make", () => {
		expect(rows.map(([name]) => name).sort()).toEqual(
			Object.keys(libraryOf(remoteSource(1))).sort()
		);
	});
});

describe("remoteItemId", () => {
	it("is the id on the other device that a source picked from its list names", () => {
		expect(REMOTE_URL).toBe("cinette-remote:");
		expect(remoteItemId(channel("show-1", `${REMOTE_URL}ep-9`))).toBe("ep-9");
	});

	it("is the channel's own id otherwise", () => {
		expect(remoteItemId(channel("ep-9", "xtream://series/4"))).toBe("ep-9");
		expect(remoteItemId(channel("ep-9", `ep-1${REMOTE_URL}`))).toBe("ep-9");
	});
});
