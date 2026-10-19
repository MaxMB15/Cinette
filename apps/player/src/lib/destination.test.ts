// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import {
	localPlaybackState,
	localCapabilities,
	orderDestinations,
	UnsupportedError,
	type LocalPlayerReport,
	type DestinationSummary,
} from "./destination";
import type { Channel, PolledMpvState } from "./types";

const mpvState = (over: Partial<PolledMpvState> = {}): PolledMpvState => ({
	isPlaying: false,
	isPaused: false,
	currentUrl: null,
	volume: 100,
	position: 0,
	duration: 0,
	playbackStarted: false,
	openFailed: false,
	reachedEnd: false,
	waiting: false,
	fallbackActive: false,
	positionAt: 0,
	...over,
});

const report = (
	over: Partial<Omit<LocalPlayerReport, "state">> = {},
	state: Partial<PolledMpvState> = {}
): LocalPlayerReport => ({
	state: mpvState(state),
	error: null,
	opening: false,
	buffering: false,
	reconnecting: false,
	loadFailed: false,
	openFailed: false,
	...over,
});

const channel: Channel = {
	id: "movie-7",
	name: "A Film",
	url: "http://example.invalid/movie/7.mp4",
	groupTitle: "Drama",
	isFavorite: false,
	contentType: "movie",
	sources: [],
};

describe("localPlaybackState", () => {
	it("is idle with nothing loaded", () => {
		const s = localPlaybackState(report(), null);
		expect(s).toEqual({
			status: "idle",
			item: null,
			position: 0,
			positionAt: 0,
			duration: 0,
			volume: 100,
			subtitles: [],
			subtitleId: null,
			audio: [],
			audioId: null,
			connection: "connected",
			error: null,
		});
	});

	it("names the channel without its URL", () => {
		const s = localPlaybackState(report(), channel);
		expect(s.item).toEqual({ title: "A Film", contentType: "movie", ref: "movie-7" });
		expect(JSON.stringify(s)).not.toContain("example.invalid");
	});

	it("passes the position, its time, the length and the volume through", () => {
		const s = localPlaybackState(
			report({}, { position: 12.5, positionAt: 900, duration: 60, volume: 40 }),
			channel
		);
		expect([s.position, s.positionAt, s.duration, s.volume]).toEqual([12.5, 900, 60, 40]);
	});

	it.each([
		["playing", {}, { isPlaying: true }],
		["paused", {}, { isPlaying: true, isPaused: true }],
		["ended", {}, { isPlaying: true, isPaused: true, reachedEnd: true }],
		["buffering", { buffering: true }, { isPlaying: true }],
		["buffering", { reconnecting: true }, { isPlaying: true }],
		["opening", { opening: true, buffering: true }, {}],
		["error", { error: "boom", opening: true }, {}],
		["error", { loadFailed: true, reconnecting: true }, {}],
		["error", { openFailed: true }, { isPlaying: true }],
	] as const)("is %s for %j with %j", (status, over, state) => {
		expect(localPlaybackState(report(over, state), channel).status).toBe(status);
	});

	it("says which failure it was, retries running out first", () => {
		expect(
			localPlaybackState(report({ loadFailed: true, openFailed: true, error: "x" }), null)
				.error
		).toEqual({
			code: "loadFailed",
		});
		expect(localPlaybackState(report({ openFailed: true, error: "x" }), null).error).toEqual({
			code: "openFailed",
		});
		expect(localPlaybackState(report({ error: "no route" }), null).error).toEqual({
			code: "failed",
			message: "no route",
		});
	});

	it("treats an empty error message as an error", () => {
		const s = localPlaybackState(report({ error: "" }), null);
		expect(s.status).toBe("error");
		expect(s.error).toEqual({ code: "failed", message: "" });
	});
});

describe("localCapabilities", () => {
	it("seeks only when it's told it can", () => {
		expect(localCapabilities(false).seek).toBe(false);
		expect(localCapabilities(true).seek).toBe(true);
	});

	it("describes today's player", () => {
		expect(localCapabilities(true)).toEqual({
			seek: true,
			pause: true,
			volume: "absolute",
			subtitles: "none",
			externalSubtitles: true,
			audioTracks: false,
			resumeAt: true,
			catalog: false,
		});
	});
});

describe("orderDestinations", () => {
	const d = (
		id: string,
		kind: DestinationSummary["kind"],
		name: string,
		deviceType?: string
	): DestinationSummary => ({ id, kind, name, deviceType });

	it("lists this device, TVs running Cinette, other Cinette devices, Cast, then AirPlay", () => {
		// The names run against the order, so only the groups put them in it.
		const list = [
			d("a", "airplay", "Attic"),
			d("c", "cast", "Basement"),
			d("m", "cinette", "Cellar Mac", "mac"),
			d("f", "cinette", "Yard", "fire-tv"),
			d("l", "local", "Zoo"),
			d("g", "cinette", "Zebra", "android-tv"),
			d("p", "cinette", "Den"),
		];
		expect(orderDestinations(list).map((x) => x.id)).toEqual([
			"l",
			"f",
			"g",
			"m",
			"p",
			"c",
			"a",
		]);
	});

	it("sorts names within a group without regard to case, then by id", () => {
		const list = [
			d("4", "cast", "kitchen"),
			d("1", "cast", "Den"),
			d("3", "cast", "Kitchen"),
			d("2", "cast", "KITCHEN"),
		];
		expect(orderDestinations(list).map((x) => x.id)).toEqual(["1", "2", "3", "4"]);
	});

	it("leaves the list it was given alone", () => {
		const list = [d("b", "cast", "B"), d("a", "local", "A")];
		const copy = [...list];
		orderDestinations(list);
		expect(list).toEqual(copy);
	});
});

describe("UnsupportedError", () => {
	it("carries a code and says what isn't supported", () => {
		const e = new UnsupportedError("Audio tracks");
		expect(e).toBeInstanceOf(Error);
		expect(e.code).toBe("unsupported");
		expect(e.name).toBe("UnsupportedError");
		expect(e.message).toBe("Audio tracks isn't supported here");
	});
});
