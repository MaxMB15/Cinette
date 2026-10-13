// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import { playbackKey, isFinished, shouldOfferResume } from "./playback";
import type { Channel } from "./types";

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
