// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import { dedupeEpisodes, findEpisode, sortEpisodes } from "./episodes";
import type { Channel } from "./types";

const ep = (id: string, season: number, episode: number, url = `http://a/${id}.mkv`): Channel => ({
	id,
	name: `Show (2011) S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")} Title`,
	url,
	groupTitle: "Series",
	isFavorite: false,
	contentType: "series",
	sources: [],
	seriesTitle: "Show (2011)",
	season,
	episode,
});

describe("sortEpisodes", () => {
	it("orders by season then episode", () => {
		const sorted = sortEpisodes([ep("c", 2, 1), ep("b", 1, 2), ep("a", 1, 1)]);
		expect(sorted.map((e) => e.id)).toEqual(["a", "b", "c"]);
	});
});

describe("dedupeEpisodes", () => {
	it("folds duplicate episodes into the first one's sources", () => {
		const result = dedupeEpisodes([ep("a", 1, 1), ep("b", 1, 1, "http://b/1.mkv")]);
		expect(result).toHaveLength(1);
		expect(result[0].url).toBe("http://a/a.mkv");
		expect(result[0].sources).toEqual(["http://b/1.mkv"]);
	});
});

describe("findEpisode", () => {
	const list = [ep("a", 1, 1), ep("b", 1, 2), ep("dup", 1, 2, "http://b/dup.mkv")];

	it("finds by id and keeps the watched source", () => {
		const found = findEpisode(list, "dup", "ignored");
		expect(found?.url).toBe("http://b/dup.mkv");
		expect(found?.sourceList).toEqual(["http://a/b.mkv", "http://b/dup.mkv"]);
	});

	it("falls back to the SxxEyy in the name when the id has changed", () => {
		const found = findEpisode(list, "stale-id", "Show (2011) S01E02 Title");
		expect(found?.id).toBe("b");
		expect(found?.sources).toEqual(["http://b/dup.mkv"]);
	});

	it("returns null when the episode isn't listed", () => {
		expect(findEpisode(list, "stale-id", "Show (2011) S03E01 Title")).toBeNull();
		expect(findEpisode(list, "stale-id", "No episode number")).toBeNull();
	});
});
