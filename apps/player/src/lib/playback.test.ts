// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, describe, it, expect, vi } from "vitest";
import {
	EMPTY_PROGRESS,
	playbackKey,
	isFinished,
	progressFor,
	saveProgress,
	shouldOfferResume,
} from "./playback";
import { deletePlaybackPosition, markPositionFinished, savePlaybackPosition } from "./tauri";
import type { Channel } from "./types";

vi.mock("./tauri", () => ({
	savePlaybackPosition: vi.fn(() => Promise.resolve()),
	deletePlaybackPosition: vi.fn(() => Promise.resolve()),
	markPositionFinished: vi.fn(() => Promise.resolve()),
}));

const ch = (overrides: Partial<Channel>): Channel => ({
	id: "x",
	name: "Name",
	url: "http://a/1.mkv",
	groupTitle: "",
	isFavorite: false,
	contentType: "movie",
	sources: [],
	...overrides,
});

describe("playbackKey", () => {
	it("returns null for live channels", () => {
		expect(playbackKey(ch({ contentType: "live" }))).toBeNull();
	});
	it("normalizes movie names", () => {
		expect(playbackKey(ch({ name: "  The   Matrix " }))).toBe("movie:the matrix");
	});
	it("ignores id and url", () => {
		const a = playbackKey(ch({ id: "p-ch-1", url: "http://a/1.mkv" }));
		const b = playbackKey(ch({ id: "p-ch-9", url: "http://b/2.mp4" }));
		expect(a).toBe(b);
	});
	it("keys episodes by series title, season and episode", () => {
		expect(
			playbackKey(
				ch({
					contentType: "series",
					name: "Show S01E02",
					seriesTitle: "Show",
					season: 1,
					episode: 2,
				})
			)
		).toBe("series:show:s1e2");
	});
	it("derives the series title from the name when missing", () => {
		expect(
			playbackKey(
				ch({ contentType: "series", name: "Show S01E02 Pilot", season: 1, episode: 2 })
			)
		).toBe("series:show:s1e2");
	});
	it("falls back to the name for series items without season/episode", () => {
		expect(playbackKey(ch({ contentType: "series", name: "Show Special" }))).toBe(
			"series:show special"
		);
	});
	it.each([
		{ what: "only a season", season: 2, episode: undefined },
		{ what: "only an episode number", season: undefined, episode: 4 },
	])("keys a series item with $what by its name", ({ season, episode }) => {
		expect(
			playbackKey(ch({ contentType: "series", name: "Show Extra", season, episode }))
		).toBe("series:show extra");
	});
	it("keys a movie by its name even when it has season and episode numbers", () => {
		expect(playbackKey(ch({ name: "Show S01E02", season: 1, episode: 2 }))).toBe(
			"movie:show s01e02"
		);
	});
});

describe("isFinished", () => {
	it("is false with unknown duration", () => {
		expect(isFinished(100, 0)).toBe(false);
	});
	it("is true within the last 5%", () => {
		expect(isFinished(5700, 6000)).toBe(true);
		expect(isFinished(5600, 6000)).toBe(false);
	});
	it("is true within the last 30 seconds", () => {
		expect(isFinished(100, 125)).toBe(true);
	});
	it("is false with exactly 30 seconds left of a short item", () => {
		expect(isFinished(70, 100)).toBe(false);
	});
});

describe("shouldOfferResume", () => {
	it("requires at least 30 seconds watched", () => {
		expect(shouldOfferResume(29, 6000)).toBe(false);
		expect(shouldOfferResume(30, 6000)).toBe(true);
	});
	it("is false once finished", () => {
		expect(shouldOfferResume(5900, 6000)).toBe(false);
	});
});

describe("progressFor", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("starts an item's progress where it starts, keyed by its resume key", () => {
		vi.useFakeTimers({ now: 5000, toFake: ["Date"] });
		const movie = ch({ name: "Heat", contentType: "movie" });
		expect(progressFor(movie, 600)).toEqual({
			key: "movie:heat",
			url: "http://a/1.mkv",
			position: 600,
			duration: 0,
			dirty: false,
			lastSaved: 5000,
			pendingStart: 600,
		});
		expect(progressFor(movie, undefined, "http://b/1.mkv")).toMatchObject({
			url: "http://b/1.mkv",
			position: 0,
			pendingStart: null,
		});
	});
});

describe("saveProgress", () => {
	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	const at = (position: number, more = {}) => ({
		...EMPTY_PROGRESS,
		key: "movie:heat",
		position,
		duration: 5400,
		dirty: true,
		...more,
	});

	it("saves where it got to, once, and when it was saved", async () => {
		vi.useFakeTimers({ now: 7000, toFake: ["Date"] });
		const p = at(600);
		await saveProgress(p);
		expect(savePlaybackPosition).toHaveBeenCalledWith("movie:heat", 600, 5400);
		expect(p).toMatchObject({ dirty: false, lastSaved: 7000 });
		await saveProgress(p);
		expect(savePlaybackPosition).toHaveBeenCalledTimes(1);
	});

	it("keeps a finished item as finished, and forgets one barely started", async () => {
		await saveProgress(at(5390));
		expect(markPositionFinished).toHaveBeenCalledWith("movie:heat", 5400);
		await saveProgress(at(29));
		expect(deletePlaybackPosition).toHaveBeenCalledWith("movie:heat");
		await saveProgress(at(30));
		expect(savePlaybackPosition).toHaveBeenCalledWith("movie:heat", 30, 5400);
	});

	it("saves nothing without a key, a change or a length", async () => {
		await saveProgress(at(600, { key: null }));
		await saveProgress(at(600, { dirty: false }));
		await saveProgress(at(600, { duration: 0 }));
		expect(savePlaybackPosition).not.toHaveBeenCalled();
		expect(markPositionFinished).not.toHaveBeenCalled();
		expect(deletePlaybackPosition).not.toHaveBeenCalled();
	});

	it("gets past a save that failed", async () => {
		vi.mocked(savePlaybackPosition).mockRejectedValueOnce("disk");
		vi.mocked(markPositionFinished).mockRejectedValueOnce("disk");
		vi.mocked(deletePlaybackPosition).mockRejectedValueOnce("disk");
		await expect(saveProgress(at(600))).resolves.toBeUndefined();
		await expect(saveProgress(at(5390))).resolves.toBeUndefined();
		await expect(saveProgress(at(10))).resolves.toBeUndefined();
	});
});
