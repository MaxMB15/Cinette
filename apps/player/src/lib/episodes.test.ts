// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import {
	dedupeEpisodes,
	episodeNeighbors,
	findEpisode,
	isSameEpisode,
	sortEpisodes,
} from "./episodes";
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

	it("folds copies of an episode whose names differ", () => {
		const other = { ...ep("b", 1, 1, "http://b/1.mkv"), name: "Show - 1x01" };
		const result = dedupeEpisodes([ep("a", 1, 1), other, ep("c", 1, 2)]);
		expect(result.map((e) => e.id)).toEqual(["a", "c"]);
	});

	it("keeps unnumbered episodes apart when their names differ", () => {
		const extra = (id: string, name: string): Channel => ({
			...ep(id, 1, 1),
			name,
			episode: undefined,
		});
		const result = dedupeEpisodes([
			extra("a", "Show Behind the Scenes"),
			extra("b", "Show Bloopers"),
		]);
		expect(result.map((e) => e.id)).toEqual(["a", "b"]);
	});

	it("takes the logo of a later copy when the first has none", () => {
		const later = { ...ep("b", 1, 1, "http://b/1.mkv"), logoUrl: "http://example.test/b.png" };
		expect(dedupeEpisodes([ep("a", 1, 1), later])[0].logoUrl).toBe("http://example.test/b.png");
	});

	it("keeps the first copy's logo", () => {
		const first = { ...ep("a", 1, 1), logoUrl: "http://example.test/a.png" };
		const withLogo = {
			...ep("b", 1, 1, "http://b/1.mkv"),
			logoUrl: "http://example.test/b.png",
		};
		const without = ep("c", 1, 1, "http://c/1.mkv");
		expect(dedupeEpisodes([first, withLogo, without])[0].logoUrl).toBe(
			"http://example.test/a.png"
		);
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

	it.each([
		{ what: "no season or episode number", season: undefined, episode: undefined },
		{ what: "a season but no episode number", season: 1, episode: undefined },
		{ what: "an episode number but no season", season: undefined, episode: 3 },
	])("returns the entry with that id as listed when it has $what", ({ season, episode }) => {
		const extra = (id: string, name: string): Channel => ({
			...ep(id, 1, 1),
			name,
			season,
			episode,
		});
		const extras = [extra("x1", "Show Making Of"), extra("x2", "Show Deleted Scenes")];
		expect(findEpisode(extras, "x2", "Show Deleted Scenes")).toEqual(extras[1]);
	});
});

describe("isSameEpisode", () => {
	it("is the same season and episode, which both have", () => {
		expect(isSameEpisode(ep("a", 1, 2), ep("b", 1, 2))).toBe(true);
		expect(isSameEpisode(ep("a", 1, 2), ep("b", 1, 3))).toBe(false);
		expect(isSameEpisode(ep("a", 1, 2), ep("b", 2, 2))).toBe(false);
		const unnumbered = { id: "x" };
		expect(isSameEpisode(unnumbered, unnumbered)).toBe(false);
		expect(isSameEpisode({ id: "x", season: 1 }, { id: "y", season: 1 })).toBe(false);
		expect(isSameEpisode({ id: "x", episode: 1 }, { id: "y", episode: 1 })).toBe(false);
	});
});

describe("episodeNeighbors", () => {
	const list = [ep("a", 1, 1), ep("b", 1, 2), ep("b2", 1, 2), ep("c", 1, 3)];

	it("gives the episodes before and after, past other copies of this one", () => {
		expect(episodeNeighbors(list, 1)).toEqual({ prev: list[0], next: list[3] });
		expect(episodeNeighbors(list, 2)).toEqual({ prev: list[0], next: list[3] });
	});

	it("has nothing past either end, or for an episode not in the list", () => {
		expect(episodeNeighbors(list, 0)).toEqual({ prev: null, next: list[1] });
		expect(episodeNeighbors(list, 3)).toEqual({ prev: list[2], next: null });
		expect(episodeNeighbors(list, -1)).toEqual({ prev: null, next: null });
	});

	it("tells unnumbered episodes apart by id, past another entry with the same one", () => {
		const items = [{ id: "x" }, { id: "y" }, { id: "x" }];
		expect(episodeNeighbors(items, 1)).toEqual({ prev: items[0], next: items[2] });
		const twice = [{ id: "x" }, { id: "x" }, { id: "y" }];
		expect(episodeNeighbors(twice, 0)).toEqual({ prev: null, next: twice[2] });
	});

	it("works on another device's catalog items", () => {
		const items = sortEpisodes([
			{ id: "e3", name: "Three", season: 1, episode: 3 },
			{ id: "e1", name: "One", season: 1, episode: 1 },
			{ id: "e2", name: "Two", season: 1, episode: 2 },
		]);
		expect(episodeNeighbors(items, 1)).toEqual({ prev: items[0], next: items[2] });
		expect(items.map((i) => i.id)).toEqual(["e1", "e2", "e3"]);
	});
});
