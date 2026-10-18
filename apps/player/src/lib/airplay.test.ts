// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it, vi } from "vitest";
import {
	AIRPLAY_RECEIVER,
	CONVERT_WARNING,
	IDLE_NATIVE_STATE,
	airplayBlockedMessage,
	airplayCapabilities,
	airplayErrorMessage,
	airplayFailureMessage,
	airplaySender,
	airplayKey,
	airplayProgress,
	airplayPlaybackState,
	createAirPlayDestination,
	type AirPlayBridge,
	type AirPlayNativeState,
} from "@/lib/airplay";
import { UnsupportedError, type PlaybackState } from "@/lib/destination";
import { airplayTvProfile } from "@/lib/route-profiles";
import type { StreamFormat } from "@/lib/route";
import type { Channel } from "@/lib/types";

const channel = (over: Partial<Channel> = {}): Channel =>
	({
		id: "movie-7",
		name: "A Film",
		url: "http://example.invalid/movie/u/p/7.mp4",
		logoUrl: null,
		groupTitle: "Films",
		tvgId: null,
		tvgName: null,
		isFavorite: false,
		contentType: "movie",
		sources: [],
		...over,
	}) as Channel;

const mp4: StreamFormat = {
	container: "mp4",
	video: "h264",
	interlaced: false,
	audio: "aac",
	cors: false,
};

const playing: AirPlayNativeState = {
	...IDLE_NATIVE_STATE,
	status: "playing",
	position: 41,
	duration: 5400,
};

const fakeBridge = (formats: StreamFormat[] = [mp4], sources = [3]) => {
	let handler: ((s: AirPlayNativeState) => void) | null = null;
	const unlisten = vi.fn();
	const bridge = {
		formats: vi.fn(async () => ({ formats, sources, duration: null })),
		load: vi.fn(async () => {}),
		loadConverted: vi.fn(async () => {}),
		endConversion: vi.fn(async () => {}),
		play: vi.fn(async () => {}),
		pause: vi.fn(async () => {}),
		seek: vi.fn(async () => {}),
		selectSubtitle: vi.fn(async () => {}),
		selectAudio: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		listen: vi.fn(async (h: (s: AirPlayNativeState) => void) => {
			handler = h;
			return unlisten;
		}),
		now: vi.fn(() => 1000),
	} satisfies AirPlayBridge;
	const emit = (s: AirPlayNativeState) => handler?.(s);
	return { bridge, emit, unlisten };
};

const receiver = { id: "airplay:AB-12", name: "Living Room TV" };
const noConverter = airplaySender({ convert: false, hardwareEncoder: false });
const converter = airplaySender({ convert: true, hardwareEncoder: false });

const converting = {
	via: "converted" as const,
	format: 0,
	video: "copy" as const,
	audio: "copy" as const,
	output: "hls" as const,
	keep: "on" as const,
};

/** Lets the bridge's `listen` promise settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the idle state", () => {
	it("has nothing playing", () => {
		expect(IDLE_NATIVE_STATE).toEqual({
			status: "idle",
			position: 0,
			duration: 0,
			subtitles: [],
			subtitleId: null,
			audio: [],
			audioId: null,
			connection: "connected",
			error: null,
		});
	});
});

describe("the AirPlay profiles", () => {
	it("uses the AirPlay 2 TV profile, and converts with the screen locked", () => {
		expect(AIRPLAY_RECEIVER).toBe(airplayTvProfile);
		expect(converter).toEqual({
			convert: true,
			hardwareEncoder: false,
			convertNeedsScreen: false,
		});
		expect(airplaySender({ convert: true, hardwareEncoder: true }).hardwareEncoder).toBe(true);
		expect(noConverter.convert).toBe(false);
		expect(CONVERT_WARNING).toBe(
			"This iPhone converts the stream and sends it to the TV. Keep it on Wi-Fi and charged. It can lock."
		);
	});
});

describe("airplayPlaybackState", () => {
	it("copies AVPlayer's state and numbers the tracks", () => {
		const item = { title: "A Film", contentType: "movie" as const, ref: "movie-7" };
		const state = airplayPlaybackState(
			{
				...playing,
				subtitles: [{ label: "English", language: "en" }, { label: "French" }],
				subtitleId: "1",
				audio: [{ label: "Main" }],
				audioId: "0",
				connection: "reconnecting",
			},
			item,
			77
		);
		expect(state).toEqual({
			status: "playing",
			item,
			position: 41,
			positionAt: 77,
			duration: 5400,
			volume: 100,
			subtitles: [
				{ id: "0", label: "English", language: "en" },
				{ id: "1", label: "French", language: undefined },
			],
			subtitleId: "1",
			audio: [{ id: "0", label: "Main", language: undefined }],
			audioId: "0",
			connection: "reconnecting",
			error: null,
		} satisfies PlaybackState);
	});

	it("words each error", () => {
		const state = airplayPlaybackState(
			{ ...IDLE_NATIVE_STATE, status: "error", error: { code: "refused" } },
			null,
			0
		);
		expect(state.error).toEqual({
			code: "refused",
			message: airplayErrorMessage({ code: "refused" }),
		});
	});
});

describe("airplayErrorMessage", () => {
	it("says why, most specific first", () => {
		expect(airplayErrorMessage({ code: "refused", unsupported: true })).toMatch(
			/refused the stream/
		);
		expect(airplayErrorMessage({ code: "openFailed", unsupported: true })).toBe(
			"The TV can't play this stream as it is."
		);
		expect(airplayErrorMessage({ code: "openFailed" })).toBe(
			"Couldn't start the stream on the TV."
		);
		expect(airplayErrorMessage({ code: "failed", unsupported: false })).toBe(
			"The stream stopped on the TV."
		);
	});
});

describe("airplayCapabilities", () => {
	it("seeks and resumes VOD with a length, and never sets the volume", () => {
		expect(airplayCapabilities(playing, false, false)).toEqual({
			seek: true,
			pause: true,
			volume: "none",
			subtitles: "none",
			externalSubtitles: false,
			audioTracks: false,
			resumeAt: true,
			catalog: false,
		});
	});

	it("doesn't seek live, or an item with no length yet", () => {
		expect(airplayCapabilities(playing, true, false)).toMatchObject({
			seek: false,
			resumeAt: false,
		});
		expect(airplayCapabilities({ ...playing, duration: 0 }, false, false).seek).toBe(false);
	});

	it("converted, it keeps one audio track and pauses only what isn't live", () => {
		const two = [{ label: "A" }, { label: "B" }];
		expect(airplayCapabilities({ ...playing, audio: two }, false, true)).toMatchObject({
			audioTracks: false,
			pause: true,
		});
		expect(airplayCapabilities(playing, true, true).pause).toBe(false);
		expect(airplayCapabilities(playing, true, false).pause).toBe(true);
	});

	it("offers subtitles when there are any, and audio when there's a choice", () => {
		const one = [{ label: "A" }];
		const two = [{ label: "A" }, { label: "B" }];
		expect(airplayCapabilities({ ...playing, subtitles: one }, false, false).subtitles).toBe(
			"select"
		);
		expect(airplayCapabilities({ ...playing, audio: one }, false, false).audioTracks).toBe(
			false
		);
		expect(airplayCapabilities({ ...playing, audio: two }, false, false).audioTracks).toBe(
			true
		);
	});
});

describe("createAirPlayDestination", () => {
	it("names itself after the receiver and plays this device's catalog", () => {
		const { bridge } = fakeBridge();
		const d = createAirPlayDestination(receiver, bridge, noConverter);
		expect(d.id).toBe("airplay:AB-12");
		expect(d.kind).toBe("airplay");
		expect(d.name).toBe("Living Room TV");
		expect(d.catalog).toEqual({ kind: "local" });
		expect(d.getState().status).toBe("idle");
		expect(d.getState().positionAt).toBe(1000);
	});

	it("routes an MP4 directly, and can't play another device's item", async () => {
		const { bridge } = fakeBridge();
		const d = createAirPlayDestination(receiver, bridge, noConverter);
		const film = channel();
		expect(await d.route({ kind: "local", channel: film })).toEqual({
			ok: true,
			route: { via: "direct", format: 0 },
		});
		expect(bridge.formats).toHaveBeenCalledWith(film);
		expect(await d.route({ kind: "remote", itemId: "x", title: "X" })).toEqual({
			ok: false,
			reason: "notFound",
		});
	});

	it("says why when only a conversion would work", async () => {
		const { bridge } = fakeBridge([{ ...mp4, container: "mkv" }]);
		const d = createAirPlayDestination(receiver, bridge, noConverter);
		expect(await d.route({ kind: "local", channel: channel() })).toEqual({
			ok: false,
			reason: "container",
			detail: "mkv",
		});
	});

	it("loads the routed format by its source, at the start position", async () => {
		const { bridge } = fakeBridge([{ ...mp4, container: "ts" }, mp4], [0, 4]);
		const d = createAirPlayDestination(receiver, bridge, noConverter);
		const film = channel();
		const states: PlaybackState[] = [];
		d.subscribe((s) => states.push(s));
		const decision = await d.route({ kind: "local", channel: film });
		expect(decision).toEqual({ ok: true, route: { via: "direct", format: 1 } });
		if (!decision.ok) throw new Error("no route");
		await d.load({ kind: "local", channel: film }, { route: decision.route, startAt: 41 });
		expect(bridge.load).toHaveBeenCalledWith(film, 4, 41);
		expect(states[states.length - 1]).toMatchObject({
			status: "opening",
			item: { title: "A Film", contentType: "movie", ref: "movie-7" },
		});
		expect(d.getState()).toBe(states[states.length - 1]);
	});

	it("starts live from now", async () => {
		const { bridge, emit } = fakeBridge([{ ...mp4, container: "hls-ts" }], [0]);
		const d = createAirPlayDestination(receiver, bridge, noConverter);
		await settle();
		const live = channel({ id: "live-1", contentType: "live" });
		const decision = await d.route({ kind: "local", channel: live });
		if (!decision.ok) throw new Error("no route");
		await d.load({ kind: "local", channel: live }, { route: decision.route, startAt: 41 });
		expect(bridge.load).toHaveBeenCalledWith(live, 0, undefined);
		emit(playing);
		expect(d.capabilities.seek).toBe(false);
		expect(d.capabilities.resumeAt).toBe(false);
	});

	it("refuses to load without a route checked first", async () => {
		const { bridge } = fakeBridge();
		const d = createAirPlayDestination(receiver, bridge, noConverter);
		const film = { kind: "local" as const, channel: channel() };
		await expect(d.load(film)).rejects.toThrow(
			"Playing this route on AirPlay isn't supported here"
		);
		await expect(d.load(film, { route: { via: "local" } })).rejects.toBeInstanceOf(
			UnsupportedError
		);
		await expect(d.load(film, { route: converting })).rejects.toThrow(
			"Check the route before loading"
		);
		await expect(d.load(film, { route: { via: "direct", format: 0 } })).rejects.toThrow(
			"Check the route before loading"
		);
		await d.route(film);
		await expect(d.load(film, { route: { via: "direct", format: 1 } })).rejects.toThrow(
			"Check the route before loading"
		);
		await expect(
			d.load(
				{ kind: "remote", itemId: "x", title: "X" },
				{ route: { via: "direct", format: 0 } }
			)
		).rejects.toThrow("Playing another device's item isn't supported here");
		expect(bridge.load).not.toHaveBeenCalled();
		expect(bridge.loadConverted).not.toHaveBeenCalled();
	});

	it("converts what the TV can't play, when this device can", async () => {
		const { bridge, emit } = fakeBridge([{ ...mp4, container: "mkv" }], [2]);
		const d = createAirPlayDestination(receiver, bridge, converter);
		await settle();
		const film = channel();
		const decision = await d.route({ kind: "local", channel: film });
		expect(decision).toEqual({ ok: true, route: converting });
		if (!decision.ok) throw new Error("no route");
		await d.load({ kind: "local", channel: film }, { route: decision.route, startAt: 41 });
		expect(bridge.loadConverted).toHaveBeenCalledWith(film, 2, 41);
		expect(bridge.load).not.toHaveBeenCalled();
		emit({ ...playing, audio: [{ label: "A" }, { label: "B" }] });
		expect(d.capabilities).toMatchObject({ seek: true, pause: true, audioTracks: false });

		// A seek converts again from there.
		await d.seek(900);
		expect(bridge.loadConverted).toHaveBeenLastCalledWith(film, 2, 900);
		expect(bridge.seek).not.toHaveBeenCalled();

		// Stopping ends the conversion too.
		await d.stop();
		expect(bridge.endConversion).toHaveBeenCalledTimes(1);
		expect(bridge.stop).toHaveBeenCalledTimes(1);
		expect(bridge.endConversion.mock.invocationCallOrder[0]).toBeLessThan(
			bridge.stop.mock.invocationCallOrder[0]
		);
		await d.stop();
		expect(bridge.endConversion).toHaveBeenCalledTimes(1);
	});

	it("tells subscribers about a route's capabilities with the state that brings them", async () => {
		const { bridge } = fakeBridge([{ ...mp4, container: "ts" }], [0]);
		const d = createAirPlayDestination(receiver, bridge, converter);
		const live = channel({ id: "live-1", contentType: "live" });
		await d.route({ kind: "local", channel: live });
		const seen: boolean[] = [];
		d.subscribe(() => seen.push(d.capabilities.pause));
		await d.load({ kind: "local", channel: live }, { route: converting });
		// Converted live can't pause, and the first state says so.
		expect(seen).toEqual([false]);
		await d.stop();
		expect(seen).toEqual([false, true]);
	});

	it("can't pause a converted live channel, and seeks it nowhere", async () => {
		const { bridge, emit } = fakeBridge([{ ...mp4, container: "ts" }], [0]);
		const d = createAirPlayDestination(receiver, bridge, converter);
		await settle();
		const live = channel({ id: "live-1", contentType: "live" });
		const decision = await d.route({ kind: "local", channel: live });
		if (!decision.ok) throw new Error("no route");
		await d.load({ kind: "local", channel: live }, { route: decision.route, startAt: 41 });
		expect(bridge.loadConverted).toHaveBeenCalledWith(live, 0, undefined);
		emit(playing);
		expect(d.capabilities).toMatchObject({ pause: false, seek: false });
		await d.seek(10);
		expect(bridge.seek).toHaveBeenCalledWith(10);
		expect(bridge.loadConverted).toHaveBeenCalledTimes(1);
	});

	it("goes back to the receiver's own seeking after a direct load", async () => {
		const { bridge } = fakeBridge([{ ...mp4, container: "mkv" }, mp4], [0, 1]);
		const d = createAirPlayDestination(receiver, bridge, converter);
		const film = channel();
		await d.route({ kind: "local", channel: film });
		await d.load({ kind: "local", channel: film }, { route: { ...converting, format: 0 } });
		await d.load({ kind: "local", channel: film }, { route: { via: "direct", format: 1 } });
		expect(bridge.load).toHaveBeenCalledWith(film, 1, undefined);
		await d.seek(5);
		expect(bridge.seek).toHaveBeenCalledWith(5);
		await d.stop();
		expect(bridge.endConversion).not.toHaveBeenCalled();
	});

	it("follows the backend's state, and the capabilities with it", async () => {
		const { bridge, emit } = fakeBridge();
		const d = createAirPlayDestination(receiver, bridge, noConverter);
		await settle();
		const listener = vi.fn();
		const unsubscribe = d.subscribe(listener);
		bridge.now.mockReturnValue(2000);
		emit({ ...playing, subtitles: [{ label: "English" }] });
		expect(listener).toHaveBeenCalledTimes(1);
		expect(d.getState()).toMatchObject({ status: "playing", position: 41, positionAt: 2000 });
		expect(d.capabilities).toMatchObject({ seek: true, subtitles: "select" });
		unsubscribe();
		emit({ ...playing, status: "paused" });
		expect(listener).toHaveBeenCalledTimes(1);
		expect(d.getState().status).toBe("paused");
	});

	it("passes the controls through", async () => {
		const { bridge } = fakeBridge();
		const d = createAirPlayDestination(receiver, bridge, noConverter);
		await d.play();
		await d.pause();
		await d.seek(90);
		await d.selectSubtitle("2");
		await d.selectSubtitle(null);
		await d.selectAudio("1");
		await d.selectAudio("0");
		expect(bridge.play).toHaveBeenCalled();
		expect(bridge.pause).toHaveBeenCalled();
		expect(bridge.seek).toHaveBeenCalledWith(90);
		expect(bridge.selectSubtitle.mock.calls).toEqual([[2], [null]]);
		expect(bridge.selectAudio.mock.calls).toEqual([[1], [0]]);
	});

	it("rejects the volume and track ids it never gave out", async () => {
		const { bridge } = fakeBridge();
		const d = createAirPlayDestination(receiver, bridge, noConverter);
		await expect(d.setVolume(50)).rejects.toThrow(
			"Setting the TV's volume isn't supported here"
		);
		await expect(d.selectSubtitle("x")).rejects.toThrow("No track x");
		await expect(d.selectAudio("-1")).rejects.toThrow("No track -1");
		await expect(d.selectAudio("1.5")).rejects.toThrow("No track 1.5");
		expect(bridge.selectSubtitle).not.toHaveBeenCalled();
		expect(bridge.selectAudio).not.toHaveBeenCalled();
	});

	it("goes idle when it stops", async () => {
		const { bridge, emit } = fakeBridge();
		const d = createAirPlayDestination(receiver, bridge, noConverter);
		await settle();
		const film = channel();
		const decision = await d.route({ kind: "local", channel: film });
		if (!decision.ok) throw new Error("no route");
		await d.load({ kind: "local", channel: film }, { route: decision.route });
		emit(playing);
		const listener = vi.fn();
		d.subscribe(listener);
		await d.stop();
		expect(bridge.stop).toHaveBeenCalled();
		expect(d.getState()).toMatchObject({ status: "idle", item: null, position: 0 });
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("stops listening when disposed, even before listening started", async () => {
		const first = fakeBridge();
		const d = createAirPlayDestination(receiver, first.bridge, noConverter);
		await settle();
		const listener = vi.fn();
		d.subscribe(listener);
		d.dispose();
		expect(first.unlisten).toHaveBeenCalledTimes(1);
		first.emit(playing);
		expect(listener).not.toHaveBeenCalled();
		d.dispose();
		expect(first.unlisten).toHaveBeenCalledTimes(1);

		const early = fakeBridge();
		createAirPlayDestination(receiver, early.bridge, noConverter).dispose();
		await settle();
		expect(early.unlisten).toHaveBeenCalledTimes(1);
	});
});

describe("airplayFailureMessage", () => {
	it("words the provider's refusal, passes the backend's message, or says it plainly", () => {
		expect(airplayFailureMessage("refused")).toBe(airplayErrorMessage({ code: "refused" }));
		expect(airplayFailureMessage("Connect to Wi-Fi to send this to the TV.")).toBe(
			"Connect to Wi-Fi to send this to the TV."
		);
		expect(airplayFailureMessage("")).toBe("Couldn't start AirPlay.");
		expect(airplayFailureMessage(new Error("x"))).toBe("Couldn't start AirPlay.");
		expect(airplayFailureMessage(undefined)).toBe("Couldn't start AirPlay.");
	});
});

describe("airplayBlockedMessage", () => {
	it("names what AirPlay can't play", () => {
		const cases = [
			["container", "mkv", "AirPlay can't play MKV files."],
			["container", "ts", "AirPlay can't play this raw MPEG-TS stream."],
			["container", "other", "AirPlay can't play this kind of stream."],
			["videoCodec", "hevc", "AirPlay can't play HEVC video."],
			["videoCodec", "mpeg2", "AirPlay can't play MPEG-2 video."],
			["audioCodec", "ac3", "AirPlay can't play Dolby Digital audio."],
			["audioCodec", "eac3", "AirPlay can't play Dolby Digital Plus audio."],
			["audioCodec", "mp2", "AirPlay can't play MP2 audio."],
			["audioCodec", "dts", "AirPlay can't play DTS audio."],
			["audioCodec", "opus", "AirPlay can't play Opus audio."],
			["audioCodec", "something", "AirPlay can't play this stream."],
			["videoCodec", undefined, "AirPlay can't play this stream."],
			["interlaced", undefined, "AirPlay can't play interlaced video."],
			["audioOnly", undefined, "AirPlay TVs don't play streams without video."],
			["unreachable", undefined, "Couldn't check the stream for AirPlay."],
			["cors", undefined, "Couldn't check the stream for AirPlay."],
		] as const;
		for (const [reason, detail, message] of cases)
			expect(airplayBlockedMessage({ ok: false, reason, detail })).toBe(message);
	});
});

describe("airplayKey", () => {
	const caps = airplayCapabilities(playing, false, false);
	const state = airplayPlaybackState(playing, null, 0);
	const at = (patch: Partial<PlaybackState>) => ({ ...state, ...patch });

	it("plays and pauses the TV", () => {
		expect(airplayKey({ type: "togglePlay" }, state, caps)).toEqual({ kind: "pause" });
		expect(airplayKey({ type: "togglePlay" }, at({ status: "buffering" }), caps)).toEqual({
			kind: "pause",
		});
		for (const status of ["paused", "opening", "ended", "error", "idle"] as const)
			expect(airplayKey({ type: "togglePlay" }, at({ status }), caps)).toEqual({
				kind: "play",
			});
		expect(airplayKey({ type: "togglePlay" }, state, { ...caps, pause: false })).toEqual({
			kind: "ignore",
		});
	});

	it("seeks within the item, when the TV can", () => {
		expect(airplayKey({ type: "seekBy", seconds: 10 }, state, caps)).toEqual({
			kind: "seek",
			to: 51,
		});
		expect(airplayKey({ type: "seekBy", seconds: -100 }, state, caps)).toEqual({
			kind: "seek",
			to: 0,
		});
		expect(airplayKey({ type: "seekBy", seconds: 9999 }, state, caps)).toEqual({
			kind: "seek",
			to: 5400,
		});
		expect(airplayKey({ type: "seekToPercent", percent: 50 }, state, caps)).toEqual({
			kind: "seek",
			to: 2700,
		});
		expect(
			airplayKey({ type: "seekBy", seconds: 10 }, state, { ...caps, seek: false })
		).toEqual({ kind: "ignore" });
	});

	it("leaves full screen, the shortcut list and Escape to the player", () => {
		for (const type of ["toggleFullscreen", "toggleShortcuts", "escape"] as const)
			expect(airplayKey({ type }, state, caps)).toEqual({ kind: "pass" });
	});

	it("ignores what would start or change playback here", () => {
		const ignored = [
			{ type: "toggleMute" },
			{ type: "volumeBy", delta: 5 },
			{ type: "nextEpisode" },
			{ type: "prevEpisode" },
			{ type: "toggleSubtitles" },
			{ type: "toggleInfo" },
			{ type: "skipSegment" },
		] as const;
		for (const action of ignored)
			expect(airplayKey(action, state, caps)).toEqual({ kind: "ignore" });
	});
});

describe("airplayProgress", () => {
	const saved = { position: 600, duration: 5400, dirty: false, lastSaved: 1000 };
	const state = (patch: Partial<PlaybackState>) =>
		airplayPlaybackState(
			{ ...playing, position: 610, ...patch } as AirPlayNativeState,
			null,
			0
		);

	it("takes the receiver's position, and saves it every interval", () => {
		expect(airplayProgress(saved, state({}), 3000, 5000)).toEqual({
			progress: { position: 610, duration: 5400, dirty: true, lastSaved: 1000 },
			save: false,
		});
		expect(airplayProgress(saved, state({}), 6000, 5000)?.save).toBe(true);
		expect(airplayProgress(saved, state({}), 5999, 5000)?.save).toBe(false);
	});

	it("saves at once when the receiver pauses", () => {
		expect(airplayProgress(saved, state({ status: "paused" }), 1001, 5000)?.save).toBe(true);
	});

	it("leaves an unmoved resume point as it is", () => {
		const same = airplayProgress(saved, state({ position: 600 }), 1001, 5000);
		expect(same?.progress).toBe(saved);
		const longer = airplayProgress(saved, state({ position: 600, duration: 5500 }), 1001, 5000);
		expect(longer?.progress).toEqual({ ...saved, duration: 5500, dirty: true });
	});

	it("changes nothing without a length or at the very start", () => {
		expect(airplayProgress(saved, state({ duration: 0 }), 9000, 5000)).toBeNull();
		expect(airplayProgress(saved, state({ duration: -1 }), 9000, 5000)).toBeNull();
		expect(airplayProgress(saved, state({ position: 1 }), 9000, 5000)).toBeNull();
		expect(airplayProgress(saved, state({ position: 1.5 }), 9000, 5000)).not.toBeNull();
		expect(
			airplayProgress(saved, state({ duration: 0.5, position: 2 }), 9000, 5000)
		).not.toBeNull();
	});
});
