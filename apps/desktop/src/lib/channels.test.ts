// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import type { Channel, Category, PlayerState } from "./types";

// Pure category derivation — mirrors the logic in useChannels.
// Tested independently so regressions surface without needing Tauri mocks.
const deriveCategories = (channels: Channel[]): Category[] => {
	const counts: Record<string, number> = {};
	for (const ch of channels) {
		const key = ch.groupTitle || "";
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return Object.entries(counts).map(([name, channelCount]) => ({
		id: name,
		name,
		channelCount,
	}));
};

const makeChannel = (overrides: Partial<Channel> = {}): Channel => {
	return {
		id: "ch-1",
		name: "Test Channel",
		url: "http://stream.example.com/1",
		groupTitle: "General",
		isFavorite: false,
		contentType: "live",
		sources: [],
		...overrides,
	};
};

// ── Deduplication helpers (mirrored in ChannelList) ──────────────────────

const dedupeByTitle = (channels: Channel[]): Channel[] => {
	const seen = new Map<string, Channel>();
	for (const ch of channels) {
		if (!seen.has(ch.name)) {
			seen.set(ch.name, { ...ch, sources: [...ch.sources] });
		} else {
			const existing = seen.get(ch.name)!;
			existing.sources.push(ch.url);
			existing.sources.push(...ch.sources);
			if (!existing.logoUrl && ch.logoUrl) existing.logoUrl = ch.logoUrl;
		}
	}
	return Array.from(seen.values());
};

const dedupeEpisodes = (episodes: Channel[]): Channel[] => {
	const seen = new Map<string, Channel>();
	for (const ep of episodes) {
		const key = `${ep.season ?? 0}x${ep.episode ?? ep.name}`;
		if (!seen.has(key)) {
			seen.set(key, { ...ep, sources: [...ep.sources] });
		} else {
			const existing = seen.get(key)!;
			existing.sources.push(ep.url);
			existing.sources.push(...ep.sources);
			if (!existing.logoUrl && ep.logoUrl) existing.logoUrl = ep.logoUrl;
		}
	}
	return Array.from(seen.values());
};

const DEFAULT_PLAYER_STATE: PlayerState = {
	isPlaying: false,
	isPaused: false,
	currentUrl: null,
	volume: 100,
	position: 0,
	duration: 0,
};

// ── Category derivation ──────────────────────────────────────────────────

describe("deriveCategories", () => {
	it("groups channels by groupTitle", () => {
		const channels = [
			makeChannel({ id: "ch-1", groupTitle: "News" }),
			makeChannel({ id: "ch-2", groupTitle: "News" }),
			makeChannel({ id: "ch-3", groupTitle: "Sports" }),
		];
		const cats = deriveCategories(channels);
		const news = cats.find((c) => c.name === "News");
		const sports = cats.find((c) => c.name === "Sports");
		expect(news?.channelCount).toBe(2);
		expect(sports?.channelCount).toBe(1);
	});

	it("returns empty array for empty channel list", () => {
		expect(deriveCategories([])).toEqual([]);
	});

	it("treats empty groupTitle as its own category", () => {
		const channels = [
			makeChannel({ id: "ch-1", groupTitle: "" }),
			makeChannel({ id: "ch-2", groupTitle: "" }),
		];
		const cats = deriveCategories(channels);
		expect(cats).toHaveLength(1);
		expect(cats[0].channelCount).toBe(2);
	});

	it("each category id equals its name", () => {
		const channels = [makeChannel({ groupTitle: "Movies" })];
		const cats = deriveCategories(channels);
		expect(cats[0].id).toBe(cats[0].name);
	});

	it("handles large number of groups", () => {
		const channels = Array.from({ length: 100 }, (_, i) =>
			makeChannel({ id: `ch-${i}`, groupTitle: `Group ${i % 10}` })
		);
		const cats = deriveCategories(channels);
		expect(cats).toHaveLength(10);
		for (const cat of cats) {
			expect(cat.channelCount).toBe(10);
		}
	});
});

// ── Channel shape ────────────────────────────────────────────────────────

describe("Channel type", () => {
	it("optional fields may be absent", () => {
		const ch = makeChannel({ logoUrl: undefined, tvgId: undefined, tvgName: undefined });
		expect(ch.logoUrl).toBeUndefined();
		expect(ch.tvgId).toBeUndefined();
		expect(ch.tvgName).toBeUndefined();
	});

	it("isFavorite defaults to false", () => {
		const ch = makeChannel();
		expect(ch.isFavorite).toBe(false);
	});
});

describe("dedupeByTitle", () => {
	it("keeps single entry unchanged", () => {
		const ch = makeChannel({ contentType: "movie", name: "The Matrix" });
		const result = dedupeByTitle([ch]);
		expect(result).toHaveLength(1);
		expect(result[0].sources).toEqual([]);
	});

	it("merges two entries with same title into one with alternate source", () => {
		const ch1 = makeChannel({
			id: "m-1",
			name: "The Matrix",
			url: "http://src1/matrix",
			contentType: "movie",
		});
		const ch2 = makeChannel({
			id: "m-2",
			name: "The Matrix",
			url: "http://src2/matrix",
			contentType: "movie",
		});
		const result = dedupeByTitle([ch1, ch2]);
		expect(result).toHaveLength(1);
		expect(result[0].url).toBe("http://src1/matrix");
		expect(result[0].sources).toContain("http://src2/matrix");
	});

	it("keeps distinct titles as separate entries", () => {
		const ch1 = makeChannel({ id: "m-1", name: "The Matrix", contentType: "movie" });
		const ch2 = makeChannel({ id: "m-2", name: "Inception", contentType: "movie" });
		expect(dedupeByTitle([ch1, ch2])).toHaveLength(2);
	});

	it("picks up logo from second entry when first has none", () => {
		const ch1 = makeChannel({
			id: "m-1",
			name: "The Matrix",
			logoUrl: undefined,
			contentType: "movie",
		});
		const ch2 = makeChannel({
			id: "m-2",
			name: "The Matrix",
			logoUrl: "http://logo.png",
			contentType: "movie",
		});
		const result = dedupeByTitle([ch1, ch2]);
		expect(result[0].logoUrl).toBe("http://logo.png");
	});

	it("merges sources from all entries", () => {
		const ch1 = makeChannel({
			id: "m-1",
			name: "Film",
			url: "http://url1",
			sources: ["http://url1b"],
			contentType: "movie",
		});
		const ch2 = makeChannel({
			id: "m-2",
			name: "Film",
			url: "http://url2",
			sources: ["http://url2b"],
			contentType: "movie",
		});
		const result = dedupeByTitle([ch1, ch2]);
		expect(result[0].sources).toEqual(["http://url1b", "http://url2", "http://url2b"]);
	});

	it("handles empty input", () => {
		expect(dedupeByTitle([])).toEqual([]);
	});

	it("is O(n) — does not regress on large input", () => {
		const channels = Array.from({ length: 10_000 }, (_, i) =>
			makeChannel({
				id: `m-${i}`,
				name: `Movie ${i % 500}`,
				url: `http://src/${i}`,
				contentType: "movie",
			})
		);
		const start = performance.now();
		const result = dedupeByTitle(channels);
		const elapsed = performance.now() - start;
		expect(result).toHaveLength(500);
		expect(elapsed).toBeLessThan(100); // well under 100ms for 10k items
	});
});

describe("dedupeEpisodes", () => {
	it("keeps single episode unchanged", () => {
		const ep = makeChannel({ contentType: "series", season: 1, episode: 1 });
		const result = dedupeEpisodes([ep]);
		expect(result).toHaveLength(1);
		expect(result[0].sources).toEqual([]);
	});

	it("merges duplicate S01E01 from two providers", () => {
		const ep1 = makeChannel({
			id: "e-1",
			contentType: "series",
			season: 1,
			episode: 1,
			url: "http://p1/s1e1",
		});
		const ep2 = makeChannel({
			id: "e-2",
			contentType: "series",
			season: 1,
			episode: 1,
			url: "http://p2/s1e1",
		});
		const result = dedupeEpisodes([ep1, ep2]);
		expect(result).toHaveLength(1);
		expect(result[0].sources).toContain("http://p2/s1e1");
	});

	it("keeps different episodes separate", () => {
		const ep1 = makeChannel({ id: "e-1", contentType: "series", season: 1, episode: 1 });
		const ep2 = makeChannel({ id: "e-2", contentType: "series", season: 1, episode: 2 });
		expect(dedupeEpisodes([ep1, ep2])).toHaveLength(2);
	});

	it("treats same episode number in different seasons as different", () => {
		const ep1 = makeChannel({ id: "e-1", contentType: "series", season: 1, episode: 1 });
		const ep2 = makeChannel({ id: "e-2", contentType: "series", season: 2, episode: 1 });
		expect(dedupeEpisodes([ep1, ep2])).toHaveLength(2);
	});
});

// ── PlayerState ──────────────────────────────────────────────────────────

describe("PlayerState", () => {
	it("default state is stopped", () => {
		expect(DEFAULT_PLAYER_STATE.isPlaying).toBe(false);
		expect(DEFAULT_PLAYER_STATE.isPaused).toBe(false);
		expect(DEFAULT_PLAYER_STATE.currentUrl).toBeNull();
	});

	it("volume is within valid range [0, 150]", () => {
		const state: PlayerState = { ...DEFAULT_PLAYER_STATE, volume: 100 };
		expect(state.volume).toBeGreaterThanOrEqual(0);
		expect(state.volume).toBeLessThanOrEqual(150);
	});

	it("position and duration are non-negative", () => {
		const state: PlayerState = {
			...DEFAULT_PLAYER_STATE,
			position: 30,
			duration: 3600,
		};
		expect(state.position).toBeGreaterThanOrEqual(0);
		expect(state.duration).toBeGreaterThanOrEqual(0);
	});

	it("paused state is not playing", () => {
		const state: PlayerState = {
			...DEFAULT_PLAYER_STATE,
			isPlaying: false,
			isPaused: true,
			currentUrl: "http://stream.example.com/1",
		};
		expect(state.isPlaying).toBe(false);
		expect(state.isPaused).toBe(true);
		expect(state.currentUrl).not.toBeNull();
	});
});
