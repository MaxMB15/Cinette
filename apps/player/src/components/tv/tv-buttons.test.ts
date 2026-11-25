// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it, vi } from "vitest";
import { tvRow, tvTiles, type TvRowOptions, type TvTileOptions } from "./tv-buttons";

/** A movie that's playing, with only the buttons every player has. */
const rowOptions = (overrides: Partial<TvRowOptions> = {}): TvRowOptions => ({
	live: false,
	paused: false,
	retrying: false,
	onRetry: vi.fn(),
	onTogglePlay: vi.fn(),
	onSkip: vi.fn(),
	atLive: false,
	onZap: vi.fn(),
	onGuide: vi.fn(),
	subtitlesOn: false,
	...overrides,
});

const labels = (overrides: Partial<TvRowOptions> = {}) => {
	const row = tvRow(rowOptions(overrides));
	return [row.start, row.center, row.end].map((group) => group.map((b) => b.label));
};

const ids = (overrides: Partial<TvRowOptions> = {}) => {
	const row = tvRow(rowOptions(overrides));
	return [...row.start, ...row.center, ...row.end].map((b) => b.id);
};

const button = (id: string, overrides: Partial<TvRowOptions> = {}) => {
	const row = tvRow(rowOptions(overrides));
	const found = [...row.start, ...row.center, ...row.end].find((b) => b.id === id);
	if (!found) throw new Error(`No ${id} button`);
	return found;
};

const SKIP = { back: 10, forward: 30 };

describe("tvRow", () => {
	it("puts the info first, the playback buttons in the middle and the subtitles last", () => {
		expect(
			labels({
				series: true,
				onInfo: vi.fn(),
				onPrevEpisode: vi.fn(),
				onNextEpisode: vi.fn(),
				skip: SKIP,
				onSubtitles: vi.fn(),
			})
		).toEqual([
			["Episodes and info"],
			["Previous episode", "Back 10 s", "Pause", "Forward 30 s", "Next episode"],
			["Subtitles"],
		]);
	});

	it("steps between channels and has the guide on live TV", () => {
		expect(labels({ live: true, onInfo: vi.fn(), skip: SKIP, onSubtitles: vi.fn() })).toEqual([
			["Channel info"],
			["Previous channel", "Back 10 s", "Pause", "Forward 30 s", "Next channel"],
			["Subtitles", "Guide"],
		]);
	});

	it("gives every button its own id", () => {
		const all = { onInfo: vi.fn(), skip: SKIP, onSubtitles: vi.fn() };
		expect(ids({ ...all, onPrevEpisode: vi.fn(), onNextEpisode: vi.fn() })).toEqual([
			"info",
			"prev",
			"back",
			"playback",
			"forward",
			"next",
			"subtitles",
		]);
		expect(ids({ ...all, live: true })).toEqual([
			"info",
			"prev",
			"back",
			"playback",
			"forward",
			"next",
			"subtitles",
			"guide",
		]);
	});

	it("calls a movie's info just that", () => {
		expect(labels({ onInfo: vi.fn() })[0]).toEqual(["Info"]);
	});

	it("leaves out what the player can't do", () => {
		expect(labels()).toEqual([[], ["Pause"], []]);
	});

	it("plays, pauses or tries again from one place", () => {
		expect(button("playback").label).toBe("Pause");
		expect(button("playback", { paused: true }).label).toBe("Play");
		expect(button("playback", { paused: true, retrying: true }).label).toBe("Try again");
	});

	it("gives each button what it does", () => {
		const o = rowOptions({
			live: true,
			skip: SKIP,
			onInfo: vi.fn(),
			onSubtitles: vi.fn(),
		});
		const row = tvRow(o);
		for (const b of [...row.start, ...row.center, ...row.end]) b.onPress();
		expect(o.onInfo).toHaveBeenCalledOnce();
		expect(o.onZap).toHaveBeenNthCalledWith(1, -1);
		expect(o.onZap).toHaveBeenNthCalledWith(2, 1);
		expect(o.onSkip).toHaveBeenNthCalledWith(1, -1);
		expect(o.onSkip).toHaveBeenNthCalledWith(2, 1);
		expect(o.onTogglePlay).toHaveBeenCalledOnce();
		expect(o.onSubtitles).toHaveBeenCalledOnce();
		expect(o.onGuide).toHaveBeenCalledOnce();
		expect(o.onRetry).not.toHaveBeenCalled();
	});

	it("tries again from the playback button while the stream is down", () => {
		const o = rowOptions({ retrying: true });
		button("playback", o).onPress();
		expect(o.onRetry).toHaveBeenCalledOnce();
		expect(o.onTogglePlay).not.toHaveBeenCalled();
	});

	it("goes to the episodes either side", () => {
		const o = rowOptions({ onPrevEpisode: vi.fn(), onNextEpisode: vi.fn() });
		button("prev", o).onPress();
		button("next", o).onPress();
		expect(o.onPrevEpisode).toHaveBeenCalledOnce();
		expect(o.onNextEpisode).toHaveBeenCalledOnce();
	});

	it("puts how far a skip goes in its icon", () => {
		expect(button("back", { skip: SKIP }).badge).toBe(10);
		expect(button("forward", { skip: SKIP }).badge).toBe(30);
	});

	it("can't skip forward from live", () => {
		expect(button("forward", { live: true, atLive: true, skip: SKIP }).disabled).toBe(true);
		expect(button("forward", { live: true, skip: SKIP }).disabled).toBe(false);
		expect(button("forward", { atLive: true, skip: SKIP }).disabled).toBe(false);
	});

	it("marks the subtitles while some show", () => {
		expect(button("subtitles", { onSubtitles: vi.fn(), subtitlesOn: true }).dot).toBe(true);
		expect(button("subtitles", { onSubtitles: vi.fn() }).dot).toBe(false);
	});
});

const tileOptions = (overrides: Partial<TvTileOptions> = {}): TvTileOptions => ({
	live: false,
	onSource: vi.fn(),
	onAutoplayChange: vi.fn(),
	onAudio: vi.fn(),
	onSpeed: vi.fn(),
	...overrides,
});

const ALL_TILES = { source: "Source 2", autoplay: true, audio: "English 5.1", speed: "Normal" };

describe("tvTiles", () => {
	it("lists the options in order, with what each is set to", () => {
		expect(tvTiles(tileOptions(ALL_TILES)).map((t) => [t.label, t.value])).toEqual([
			["Source", "Source 2"],
			["Autoplay", "On"],
			["Audio", "English 5.1"],
			["Speed", "Normal"],
			["Download", "Needs storage"],
		]);
	});

	it("gives every option its own id", () => {
		expect(tvTiles(tileOptions(ALL_TILES)).map((t) => t.id)).toEqual([
			"source",
			"autoplay",
			"audio",
			"speed",
			"save",
		]);
		expect(tvTiles(tileOptions({ live: true })).map((t) => t.id)).toEqual(["save"]);
	});

	it("records on live TV, and saving is off for now", () => {
		const tiles = tvTiles(tileOptions({ live: true }));
		expect(tiles.map((t) => t.label)).toEqual(["Record"]);
		expect(tiles[0].disabled).toBe(true);
		expect(() => tiles[0].onPress()).not.toThrow();
		expect(tvTiles(tileOptions())[0].disabled).toBe(true);
	});

	it("opens what each option picks from", () => {
		const o = tileOptions(ALL_TILES);
		for (const t of tvTiles(o)) t.onPress();
		expect(o.onSource).toHaveBeenCalledOnce();
		expect(o.onAutoplayChange).toHaveBeenCalledExactlyOnceWith(false);
		expect(o.onAudio).toHaveBeenCalledOnce();
		expect(o.onSpeed).toHaveBeenCalledOnce();
	});

	it("turns autoplay on when it's off", () => {
		const o = tileOptions({ autoplay: false });
		const tile = tvTiles(o)[0];
		expect(tile.value).toBe("Off");
		tile.onPress();
		expect(o.onAutoplayChange).toHaveBeenCalledExactlyOnceWith(true);
	});
});
