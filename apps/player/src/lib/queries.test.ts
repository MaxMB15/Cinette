// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./tauri", () => ({
	getProviders: vi.fn(async () => [{ id: "p1" }]),
	getAllChannels: vi.fn(async () => [{ id: "c1" }]),
	getGroupHierarchy: vi.fn(async () => [{ groupName: "News" }]),
	getPinnedGroups: vi.fn(async () => [{ groupName: "Sport" }]),
	getEpgForLiveChannels: vi.fn(),
	getEpgProgrammes: vi.fn(async () => [{ title: "News" }]),
	searchEpgProgrammes: vi.fn(async () => [{ title: "Found" }]),
	fetchOmdbData: vi.fn(async () => ({ title: "Sintel" })),
	fetchWhatsonData: vi.fn(async () => ({ certification: "12A" })),
}));

import {
	fetchOmdbData,
	fetchWhatsonData,
	getAllChannels,
	getEpgForLiveChannels,
	getEpgProgrammes,
	getGroupHierarchy,
	getPinnedGroups,
	getProviders,
	searchEpgProgrammes,
} from "./tauri";
import {
	channelGuideQuery,
	channelsQuery,
	groupHierarchyQuery,
	guideQuery,
	guideSearchQuery,
	loadChannelGuide,
	LOCAL,
	omdbQuery,
	pinnedGroupsQuery,
	providersQuery,
	SCHEDULE_STEP,
	scheduleQuery,
	whatsonQuery,
} from "./queries";
import type { EpgProgram } from "./types";
import { answerFrom } from "@/test/guide-answers";
import { createTestQueryClient } from "@/test/query";

const program = (channelId: string, title: string): EpgProgram => ({
	channelId,
	title,
	startTime: 1000,
	endTime: 2800,
});
const guide = [program("news.tv", "Noon News"), program("sport.tv", "Match Day")];
const morning = { from: 1000, to: 8000 };

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getEpgForLiveChannels).mockImplementation(answerFrom(guide));
});

describe("queries", () => {
	it("start each key with where the data comes from", () => {
		expect(LOCAL).toBe("local");
		expect(providersQuery().queryKey).toEqual(["local", "providers"]);
		expect(channelsQuery().queryKey).toEqual(["local", "channels"]);
		expect(providersQuery(LOCAL).queryKey).toEqual(providersQuery().queryKey);
		expect(groupHierarchyQuery("p1", "movie").queryKey).toEqual([
			"local",
			"groupHierarchy",
			"p1",
			"movie",
		]);
		expect(pinnedGroupsQuery("p1", "live").queryKey).toEqual([
			"local",
			"pinnedGroups",
			"p1",
			"live",
		]);
		expect(groupHierarchyQuery("p1", "movie", LOCAL).queryKey).toEqual(
			groupHierarchyQuery("p1", "movie").queryKey
		);
		expect(pinnedGroupsQuery("p1", "live", LOCAL).queryKey).toEqual(
			pinnedGroupsQuery("p1", "live").queryKey
		);
	});

	it("ask the backend for one provider's groups of one type", async () => {
		const client = createTestQueryClient();
		await expect(client.fetchQuery(groupHierarchyQuery("p1", "movie"))).resolves.toEqual([
			{ groupName: "News" },
		]);
		expect(getGroupHierarchy).toHaveBeenCalledExactlyOnceWith("p1", "movie");
		await expect(client.fetchQuery(pinnedGroupsQuery("p2", "live"))).resolves.toEqual([
			{ groupName: "Sport" },
		]);
		expect(getPinnedGroups).toHaveBeenCalledExactlyOnceWith("p2", "live");
	});

	it("ask the backend for the providers", async () => {
		const client = createTestQueryClient();
		await expect(client.fetchQuery(providersQuery())).resolves.toEqual([{ id: "p1" }]);
		expect(getProviders).toHaveBeenCalledTimes(1);
		expect(getProviders).toHaveBeenCalledWith();
		expect(getAllChannels).not.toHaveBeenCalled();
	});

	it("ask the backend for the channels", async () => {
		const client = createTestQueryClient();
		await expect(client.fetchQuery(channelsQuery())).resolves.toEqual([{ id: "c1" }]);
		expect(getAllChannels).toHaveBeenCalledTimes(1);
		expect(getAllChannels).toHaveBeenCalledWith();
		expect(getProviders).not.toHaveBeenCalled();
	});
});

describe("guide queries", () => {
	it("key every channel's guide and one channel's by range and version", () => {
		expect(guideQuery(morning, "v1").queryKey).toEqual([
			"local",
			"guide",
			1000,
			8000,
			"v1",
			"all",
		]);
		expect(channelGuideQuery(morning, "v1", "news.tv").queryKey).toEqual([
			"local",
			"guide",
			1000,
			8000,
			"v1",
			"channel",
			"news.tv",
		]);
		expect(guideQuery(morning, "v1", LOCAL).queryKey).toEqual(
			guideQuery(morning, "v1").queryKey
		);
		expect(channelGuideQuery(morning, "v1", "a", LOCAL).queryKey).toEqual(
			channelGuideQuery(morning, "v1", "a").queryKey
		);
	});

	it("load every channel's guide with no ids", async () => {
		const client = createTestQueryClient();
		await expect(client.fetchQuery(guideQuery(morning, "v1"))).resolves.toEqual(guide);
		expect(getEpgForLiveChannels).toHaveBeenCalledExactlyOnceWith(1000, 8000);
	});

	it("load one channel's guide through the batch", async () => {
		const client = createTestQueryClient();
		await expect(
			client.fetchQuery(channelGuideQuery(morning, "v1", "sport.tv"))
		).resolves.toEqual([program("sport.tv", "Match Day")]);
		expect(getEpgForLiveChannels).toHaveBeenCalledExactlyOnceWith(1000, 8000, ["sport.tv"]);
	});
});

describe("loadChannelGuide", () => {
	it("asks for the ids asked for in the same moment in one call, in order", async () => {
		const [news, sport] = await Promise.all([
			loadChannelGuide(morning, "news.tv"),
			loadChannelGuide(morning, "sport.tv"),
		]);
		expect(getEpgForLiveChannels).toHaveBeenCalledExactlyOnceWith(1000, 8000, [
			"news.tv",
			"sport.tv",
		]);
		expect(news).toEqual([program("news.tv", "Noon News")]);
		expect(sport).toEqual([program("sport.tv", "Match Day")]);
	});

	it("makes a call of its own for each range", async () => {
		await Promise.all([
			loadChannelGuide(morning, "news.tv"),
			loadChannelGuide({ from: 5000, to: 12000 }, "news.tv"),
		]);
		expect(vi.mocked(getEpgForLiveChannels).mock.calls).toEqual([
			[1000, 8000, ["news.tv"]],
			[5000, 12000, ["news.tv"]],
		]);
	});

	it("starts a new call for ids asked for after the last one went out", async () => {
		await loadChannelGuide(morning, "news.tv");
		await loadChannelGuide(morning, "sport.tv");
		expect(vi.mocked(getEpgForLiveChannels).mock.calls).toEqual([
			[1000, 8000, ["news.tv"]],
			[1000, 8000, ["sport.tv"]],
		]);
	});

	it("gives every id in a call that fails the failure", async () => {
		vi.mocked(getEpgForLiveChannels).mockRejectedValueOnce(new Error("offline"));
		const results = await Promise.allSettled([
			loadChannelGuide(morning, "news.tv"),
			loadChannelGuide(morning, "sport.tv"),
		]);
		expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
		await expect(loadChannelGuide(morning, "news.tv")).resolves.toHaveLength(1);
	});
});

describe("scheduleQuery", () => {
	it("asks for 12 hours either side of the step, and one step more", async () => {
		const client = createTestQueryClient();
		expect(SCHEDULE_STEP).toBe(600);
		expect(scheduleQuery("news24.uk", 60_000).queryKey).toEqual([
			"local",
			"schedule",
			"news24.uk",
			60_000,
		]);
		expect(scheduleQuery("a", 1, LOCAL).queryKey).toEqual(scheduleQuery("a", 1).queryKey);
		await expect(client.fetchQuery(scheduleQuery("news24.uk", 60_000))).resolves.toEqual([
			{ title: "News" },
		]);
		expect(getEpgProgrammes).toHaveBeenCalledExactlyOnceWith(
			"news24.uk",
			60_000 - 12 * 3600,
			60_000 + 12 * 3600 + 600
		);
	});
});

describe("guideSearchQuery", () => {
	it("searches from now and keeps the answer for a minute", async () => {
		vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_500 });
		try {
			const client = createTestQueryClient();
			const query = guideSearchQuery("news");
			expect(query.queryKey).toEqual(["local", "guideSearch", "news"]);
			expect(guideSearchQuery("news", LOCAL).queryKey).toEqual(query.queryKey);
			expect(query.staleTime).toBe(60_000);
			await expect(client.fetchQuery(query)).resolves.toEqual([{ title: "Found" }]);
			expect(searchEpgProgrammes).toHaveBeenCalledExactlyOnceWith("news", 1_700_000_000);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("details queries", () => {
	it("ask OMDb by the channel, title and kind", async () => {
		const client = createTestQueryClient();
		const query = omdbQuery("mv1", "Sintel", "movie");
		expect(query.queryKey).toEqual(["local", "omdb", "mv1", "Sintel", "movie"]);
		expect(omdbQuery("mv1", "Sintel", "movie", LOCAL).queryKey).toEqual(query.queryKey);
		await expect(client.fetchQuery(query)).resolves.toEqual({ title: "Sintel" });
		expect(fetchOmdbData).toHaveBeenCalledExactlyOnceWith("mv1", "Sintel", "movie");
	});

	it("ask Whatson for a movie, and for a series as a show", async () => {
		const client = createTestQueryClient();
		expect(whatsonQuery("tt1", "movie").queryKey).toEqual(["local", "whatson", "tt1", "movie"]);
		expect(whatsonQuery("tt1", "series", LOCAL).queryKey).toEqual(
			whatsonQuery("tt1", "series").queryKey
		);
		await client.fetchQuery(whatsonQuery("tt1", "movie"));
		await client.fetchQuery(whatsonQuery("tt2", "series"));
		expect(vi.mocked(fetchWhatsonData).mock.calls).toEqual([
			["tt1", "movie"],
			["tt2", "show"],
		]);
	});
});
