// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import {
	destinationControls,
	destinationStatus,
	localPlaybackState,
	localCapabilities,
	orderDestinations,
	positionNow,
	UnsupportedError,
	type LocalPlayerReport,
	type DestinationSummary,
	type PlaybackState,
} from "./destination";
import type { Channel, PolledMpvState } from "./types";
import { playbackCapabilities, playbackState } from "@/test/destination-fixtures";

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

describe("positionNow", () => {
	const state = (patch: Partial<PlaybackState> = {}) =>
		playbackState({ item: null, positionAt: 1000, ...patch });

	it("moves on with the time since the receiver said, while it plays", () => {
		expect(positionNow(state(), 3000)).toBe(602);
		// Never back, for a reading from this device's future.
		expect(positionNow(state(), 500)).toBe(600);
		// Not past the end.
		expect(positionNow(state({ position: 5399 }), 4000)).toBe(5400);
		// Live has no end to stop at.
		expect(positionNow(state({ duration: 0 }), 3000)).toBe(602);
	});

	it("stays where it was while it doesn't play", () => {
		for (const status of ["paused", "buffering", "opening", "idle"] as const)
			expect(positionNow(state({ status }), 3000)).toBe(600);
	});
});

/** A movie whose position was read at 1 s. */
const tvState = (patch: Partial<PlaybackState> = {}) =>
	playbackState({ positionAt: 1000, ...patch });
const tvCaps = playbackCapabilities;

describe("destinationControls", () => {
	it("shows a playing item with its position now, and every control it has", () => {
		expect(destinationControls(tvState(), tvCaps(), 3000)).toEqual({
			player: {
				isPlaying: true,
				isPaused: false,
				currentUrl: "mv1",
				volume: 40,
				position: 602,
				duration: 5400,
			},
			over: false,
			pause: true,
			seek: true,
			volume: true,
		});
	});

	it("counts buffering as playing, and paused as paused", () => {
		expect(
			destinationControls(tvState({ status: "buffering" }), tvCaps(), 0).player
		).toMatchObject({ isPlaying: true, isPaused: false });
		expect(
			destinationControls(tvState({ status: "paused" }), tvCaps(), 0).player
		).toMatchObject({
			isPlaying: false,
			isPaused: true,
		});
		expect(
			destinationControls(tvState({ status: "opening" }), tvCaps(), 0).player
		).toMatchObject({
			isPlaying: false,
			isPaused: false,
		});
	});

	it("leaves out what the destination can't do", () => {
		const c = destinationControls(
			tvState(),
			tvCaps({ seek: false, pause: false, volume: "none" }),
			1000
		);
		expect(c).toMatchObject({ pause: false, seek: false, volume: false });
		// No length, no seek bar.
		expect(c.player.duration).toBe(0);
	});

	it("has no seek bar for an item without a length", () => {
		const c = destinationControls(tvState({ duration: 0 }), tvCaps(), 1000);
		expect(c.seek).toBe(false);
		expect(c.player.duration).toBe(0);
	});

	it("names no item when nothing plays", () => {
		expect(
			destinationControls(tvState({ item: null }), tvCaps(), 0).player.currentUrl
		).toBeNull();
	});

	it("is over when lost, failed, at the end, in error, or idle with its item, and then offers nothing", () => {
		for (const patch of [
			{ connection: "lost" as const },
			{ error: { code: "failed" as const } },
			{ status: "ended" as const },
			{ status: "error" as const },
			{ status: "idle" as const },
		]) {
			expect(destinationControls(tvState(patch), tvCaps(), 0)).toMatchObject({
				over: true,
				pause: false,
				seek: false,
				volume: false,
			});
		}
		// Idle with nothing loaded yet isn't over.
		expect(destinationControls(tvState({ status: "idle", item: null }), tvCaps(), 0).over).toBe(
			false
		);
		expect(destinationControls(tvState({ connection: "reconnecting" }), tvCaps(), 0).over).toBe(
			false
		);
	});
});

describe("destinationStatus", () => {
	it("says nothing while it plays or is paused", () => {
		expect(destinationStatus(tvState(), "Hotel TV")).toBeNull();
		expect(destinationStatus(tvState({ status: "paused" }), "Hotel TV")).toBeNull();
	});

	it("says where it stands, in order", () => {
		expect(
			destinationStatus(tvState({ connection: "lost", status: "opening" }), "Hotel TV")
		).toBe("Lost the connection to Hotel TV.");
		expect(
			destinationStatus(
				tvState({ error: { code: "failed" }, connection: "reconnecting" }),
				"Hotel TV"
			)
		).toBe("It stopped on Hotel TV.");
		expect(
			destinationStatus(
				tvState({ connection: "reconnecting", status: "opening" }),
				"Hotel TV"
			)
		).toBe("Reconnecting…");
		expect(destinationStatus(tvState({ status: "opening" }), "Hotel TV")).toBe(
			"Starting on Hotel TV…"
		);
		expect(destinationStatus(tvState({ status: "buffering" }), "Hotel TV")).toBe("Buffering…");
		expect(destinationStatus(tvState({ status: "ended" }), "Hotel TV")).toBe("Finished.");
	});

	it("says an error's message, in the destination's own words where it has them", () => {
		const failed = tvState({ error: { code: "refused", message: "403" } });
		expect(destinationStatus(failed, "Hotel TV")).toBe("403");
		expect(destinationStatus(failed, "Hotel TV", (m) => `Hotel TV said ${m}.`)).toBe(
			"Hotel TV said 403."
		);
	});
});
