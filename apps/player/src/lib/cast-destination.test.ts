// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it, vi } from "vitest";
import {
	applyUpdate,
	castCapabilities,
	castPlaybackState,
	castRouteOf,
	createCastDestination,
	idleSnapshot,
	STALE,
	throughThisDevice,
	type CastBackend,
	type CastSnapshot,
	PAUSE_LIMIT_MS,
} from "@/lib/cast-destination";
import type { PlayRoute, StreamFormat } from "@/lib/route";
import type { StreamFormats } from "@/lib/route-profiles";
import type { CastReceiver, CastUpdate } from "@/lib/tauri";
import type { Channel } from "@/lib/types";

const receiver: CastReceiver = {
	id: "cast:tv",
	name: "Living Room",
	model: "Chromecast",
	status: null,
	available: true,
};

const channel = { id: "live-7", name: "Evening News", contentType: "live" } as Channel;
const movie = { id: "movie-1", name: "A Film", contentType: "movie" } as Channel;

const hls: StreamFormat = {
	container: "hls-ts",
	video: "h264",
	interlaced: false,
	audio: "aac",
	cors: true,
	hdr: false,
};
const ts: StreamFormat = { ...hls, container: "ts" };

/** Xtream live: `.m3u8` at place 0, `.ts` at place 1. */
const xtream: StreamFormats = {
	formats: [hls, ts],
	sources: [0, 1],
	duration: null,
	generation: 7,
};

type Media = NonNullable<Extract<CastUpdate, { kind: "media" }>["media"]>;

const media = (over: Partial<Media> = {}): Media => ({
	player: "playing",
	idleReason: null,
	position: 10,
	duration: 600,
	live: false,
	canPause: true,
	canSeek: true,
	...over,
});

const backend = (formats: StreamFormats = xtream, convert = true) => {
	const fake = {
		getStreamFormats: vi.fn(async () => formats),
		getConverterSupport: vi.fn(async () => ({ convert, hardwareEncoder: false })),
		castLoad: vi.fn(async () => {}),
		castControl: vi.fn(async () => {}),
		castStop: vi.fn(async () => {}),
		castRelease: vi.fn(async () => {}),
	};
	return fake satisfies CastBackend;
};

const snap = (over: Partial<CastSnapshot>): CastSnapshot => ({ ...idleSnapshot, ...over });

describe("applyUpdate", () => {
	it("follows the receiver from connecting to ready to closed", () => {
		const ready = applyUpdate(idleSnapshot, { kind: "ready" }, 1);
		expect(ready.phase).toBe("ready");
		const closed = applyUpdate(
			snap({ phase: "ready", loading: true, media: media() }),
			{ kind: "closed", reason: "timeout" },
			2
		);
		expect(closed).toMatchObject({
			phase: "closed",
			closedReason: "timeout",
			loading: false,
			media: null,
		});
	});

	it("keeps the volume and whether the TV fixes it", () => {
		const next = applyUpdate(
			idleSnapshot,
			{ kind: "volume", level: 0.4, muted: false, fixed: true },
			1
		);
		expect(next.volume).toBe(0.4);
		expect(next.volumeFixed).toBe(true);
	});

	it("stops loading once something plays, and clears an old error", () => {
		const loading = snap({ loading: true, error: { code: "failed" } });
		const buffering = applyUpdate(
			loading,
			{ kind: "media", media: media({ player: "buffering" }) },
			5
		);
		expect(buffering).toMatchObject({ loading: false, error: null, mediaAt: 5 });
		// Idle before the load took isn't the end of loading.
		const idle = applyUpdate(loading, { kind: "media", media: media({ player: "idle" }) }, 6);
		expect(idle.loading).toBe(true);
		expect(idle.error).toEqual({ code: "failed" });
		const none = applyUpdate(loading, { kind: "media", media: null }, 7);
		expect(none.loading).toBe(true);
		// Idle with an error is.
		const failed = applyUpdate(
			loading,
			{ kind: "media", media: media({ player: "idle", idleReason: "error" }) },
			8
		);
		expect(failed.loading).toBe(false);
		// Not loading stays not loading.
		const playing = applyUpdate(idleSnapshot, { kind: "media", media: media() }, 9);
		expect(playing.loading).toBe(false);
	});

	it("turns failures into the player's error codes", () => {
		const loading = snap({ loading: true });
		expect(applyUpdate(loading, { kind: "loadFailed", code: 104 }, 1)).toMatchObject({
			loading: false,
			error: { code: "openFailed" },
		});
		expect(applyUpdate(loading, { kind: "playbackError", code: null }, 1).error).toEqual({
			code: "failed",
		});
		expect(applyUpdate(loading, { kind: "conversionFailed", refused: true }, 1)).toMatchObject({
			loading: false,
			error: { code: "refused" },
		});
		expect(applyUpdate(loading, { kind: "conversionFailed", refused: false }, 1).error).toEqual(
			{
				code: "loadFailed",
			}
		);
	});

	it("leaves the state alone when a command is turned down", () => {
		const before = snap({ phase: "ready" });
		expect(applyUpdate(before, { kind: "rejected", reason: "no" }, 1)).toBe(before);
	});
});

describe("castPlaybackState", () => {
	it("says what the receiver is doing", () => {
		const status = (over: Partial<CastSnapshot>) => castPlaybackState(snap(over)).status;
		expect(status({ error: { code: "failed" }, loading: true })).toBe("opening");
		expect(status({ error: { code: "failed" }, media: media() })).toBe("error");
		expect(status({ loading: true, media: media() })).toBe("opening");
		expect(status({ media: media() })).toBe("playing");
		expect(status({ media: media({ player: "paused" }) })).toBe("paused");
		expect(status({ media: media({ player: "buffering" }) })).toBe("buffering");
		expect(status({ media: media({ player: "idle", idleReason: "finished" }) })).toBe("ended");
		expect(status({ media: media({ player: "idle", idleReason: "cancelled" }) })).toBe("idle");
		expect(status({})).toBe("idle");
	});

	it("gives the position in the item, a converted stream counting from its start", () => {
		const direct = castPlaybackState(snap({ media: media(), mediaAt: 77 }));
		expect(direct).toMatchObject({ position: 10, positionAt: 77, duration: 600 });
		const converted = castPlaybackState(
			snap({ media: media({ duration: null }), converted: true, offset: 300, duration: 900 })
		);
		expect(converted).toMatchObject({ position: 310, duration: 900 });
		expect(castPlaybackState(snap({ offset: 300 })).position).toBe(300);
	});

	it("gives live streams no length, and VOD the receiver's or the probe's", () => {
		expect(castPlaybackState(snap({ media: media({ live: true }) })).duration).toBe(0);
		expect(
			castPlaybackState(snap({ media: media({ duration: null }), duration: 42 })).duration
		).toBe(42);
		expect(castPlaybackState(snap({ duration: 42 })).duration).toBe(42);
		expect(
			castPlaybackState(snap({ media: media({ live: true }), converted: true, duration: 42 }))
				.duration
		).toBe(42);
	});

	it("shows the volume as a percentage", () => {
		expect(castPlaybackState(snap({ volume: 0.456 })).volume).toBe(46);
		expect(castPlaybackState(idleSnapshot).volume).toBe(0);
	});

	it("says the connection is lost only when the receiver went away", () => {
		const item = { title: "A", contentType: "movie" as const, ref: "m" };
		const connection = (over: Partial<CastSnapshot>) =>
			castPlaybackState(snap(over)).connection;
		expect(connection({ phase: "closed", closedReason: "appStopped", item })).toBe("lost");
		expect(connection({ phase: "closed", closedReason: "stopped", item })).toBe("connected");
		expect(connection({ phase: "connecting", item })).toBe("reconnecting");
		expect(connection({ phase: "connecting" })).toBe("connected");
		expect(connection({ phase: "ready", item })).toBe("connected");
	});

	it("has no tracks to offer", () => {
		const state = castPlaybackState(
			snap({ item: { title: "A", contentType: "live", ref: "l" } })
		);
		expect(state).toMatchObject({
			item: { title: "A", contentType: "live", ref: "l" },
			subtitles: [],
			subtitleId: null,
			audio: [],
			audioId: null,
			error: null,
		});
	});
});

describe("castCapabilities", () => {
	it("seeks what the receiver can, and a converted VOD by converting again", () => {
		expect(castCapabilities(snap({ media: media() })).seek).toBe(true);
		expect(castCapabilities(snap({ media: media({ canSeek: false }) })).seek).toBe(false);
		expect(castCapabilities(snap({ media: media({ live: true }) })).seek).toBe(false);
		expect(castCapabilities(snap({})).seek).toBe(false);
		expect(castCapabilities(snap({ converted: true, duration: 600 })).seek).toBe(true);
		expect(castCapabilities(snap({ converted: true, duration: 0, media: media() })).seek).toBe(
			false
		);
	});

	it("pauses and sets the volume when the receiver lets it", () => {
		expect(castCapabilities(snap({ media: media() })).pause).toBe(true);
		expect(castCapabilities(snap({ media: media({ canPause: false }) })).pause).toBe(false);
		expect(castCapabilities(snap({})).pause).toBe(false);
		expect(castCapabilities(snap({})).volume).toBe("absolute");
		expect(castCapabilities(snap({ volumeFixed: true })).volume).toBe("none");
		expect(castCapabilities(snap({}))).toMatchObject({
			subtitles: "none",
			externalSubtitles: false,
			audioTracks: false,
			resumeAt: true,
			catalog: false,
		});
	});
});

describe("castRouteOf and throughThisDevice", () => {
	const formats: StreamFormats = {
		formats: [hls, { ...ts, video: null, audio: null }],
		sources: [2, 5],
		duration: null,
		generation: 7,
	};

	it("names the format by its URL's place", () => {
		expect(castRouteOf({ via: "direct", format: 0 }, formats)).toEqual({
			via: "direct",
			generation: 7,
			source: 2,
			container: "hls-ts",
		});
		const converted: PlayRoute = {
			via: "converted",
			format: 1,
			video: "transcode",
			audio: "aac",
			output: "matroska",
			keep: "on",
		};
		expect(castRouteOf(converted, formats)).toEqual({
			via: "converted",
			generation: 7,
			source: 5,
			container: "ts",
			video: "transcode",
			audio: "aac",
		});
		expect(() => castRouteOf({ via: "local" }, formats)).toThrow(
			"Casting by way of local isn't supported here"
		);
	});

	it("remuxes what the receiver could fetch itself", () => {
		expect(throughThisDevice({ via: "direct", format: 0 }, formats)).toEqual({
			via: "converted",
			format: 0,
			video: "copy",
			audio: "copy",
			output: "matroska",
			keep: "on",
		});
		expect(throughThisDevice({ via: "direct", format: 1 }, formats)).toMatchObject({
			video: "none",
			audio: "none",
		});
		const local: PlayRoute = { via: "local" };
		expect(throughThisDevice(local, formats)).toBe(local);
	});
});

describe("createCastDestination", () => {
	const item = { kind: "local" as const, channel };

	it("is the receiver", () => {
		const cast = createCastDestination(receiver, backend());
		expect(cast).toMatchObject({
			id: "cast:tv",
			kind: "cast",
			name: "Living Room",
			catalog: { kind: "local" },
		});
		expect(cast.capabilities.catalog).toBe(false);
		// The same object until the state changes.
		const before = cast.capabilities;
		expect(cast.capabilities).toBe(before);
		cast.receive({ kind: "media", media: media() });
		expect(cast.capabilities).not.toBe(before);
		expect(cast.capabilities.pause).toBe(true);
	});

	it("routes HLS with CORS directly, asking for the formats once", async () => {
		const fake = backend();
		const playing = {
			fileFormat: "hls",
			videoCodec: "h264",
			audioCodec: "aac",
			interlaced: false,
			hdr: false,
		};
		const cast = createCastDestination(receiver, fake, { playing: () => playing });
		expect(await cast.route(item)).toEqual({ ok: true, route: { via: "direct", format: 0 } });
		await cast.route(item);
		expect(fake.getStreamFormats).toHaveBeenCalledTimes(1);
		expect(fake.getStreamFormats).toHaveBeenCalledWith(channel, playing);
	});

	it("converts what the receiver can't play, or says why", async () => {
		const dolby: StreamFormats = {
			formats: [{ ...ts, audio: "ac3" }],
			sources: [0],
			duration: null,
			generation: 7,
		};
		expect(await createCastDestination(receiver, backend(dolby)).route(item)).toMatchObject({
			ok: true,
			route: { via: "converted", video: "copy", audio: "aac" },
		});
		expect(await createCastDestination(receiver, backend(dolby, false)).route(item)).toEqual({
			ok: false,
			reason: "container",
			detail: "ts",
		});
		await expect(
			createCastDestination(receiver, backend()).route({
				kind: "remote",
				itemId: "x",
				title: "X",
			})
		).rejects.toThrow("Casting another device's item isn't supported here");
	});

	it("streams through this device when asked", async () => {
		let through = true;
		const cast = createCastDestination(receiver, backend(), { streamThrough: () => through });
		expect(await cast.route(item)).toMatchObject({
			ok: true,
			route: { via: "converted", video: "copy", audio: "copy", keep: "on" },
		});
		through = false;
		expect(await cast.route(item)).toEqual({ ok: true, route: { via: "direct", format: 0 } });
		const blocked = createCastDestination(receiver, backend({ ...xtream, formats: [] }), {
			streamThrough: () => true,
		});
		expect(await blocked.route(item)).toEqual({ ok: false, reason: "unreachable" });
	});

	it("loads the route it was given, or works one out", async () => {
		const fake = backend();
		const cast = createCastDestination(receiver, fake, { now: () => 3 });
		const seen: string[] = [];
		const unsubscribe = cast.subscribe((s) => seen.push(s.status));
		await cast.load(item, { route: { via: "direct", format: 1 }, startAt: 20 });
		expect(fake.castLoad).toHaveBeenLastCalledWith(
			"cast:tv",
			channel,
			{ via: "direct", generation: 7, source: 1, container: "ts" },
			20
		);
		expect(cast.getState()).toMatchObject({
			status: "opening",
			item: { title: "Evening News", contentType: "live", ref: "live-7" },
			position: 0,
		});
		cast.receive({ kind: "media", media: media() });
		expect(cast.getState()).toMatchObject({ status: "playing", position: 10, positionAt: 3 });
		expect(seen).toEqual(["opening", "playing"]);
		unsubscribe();
		await cast.load(item);
		expect(fake.castLoad).toHaveBeenLastCalledWith(
			"cast:tv",
			channel,
			{ via: "direct", generation: 7, source: 0, container: "hls-ts" },
			undefined
		);
		expect(seen).toEqual(["opening", "playing"]);

		const nothing = createCastDestination(receiver, backend({ ...xtream, formats: [] }));
		await expect(nothing.load(item)).rejects.toThrow("unreachable");
	});

	it("drops a playlist that failed at cast time, and routes the rest", async () => {
		const fake = backend();
		fake.castLoad.mockRejectedValueOnce("notPlaylist");
		const cast = createCastDestination(receiver, fake);
		await expect(cast.load(item)).rejects.toBe("notPlaylist");
		expect(cast.getState()).toMatchObject({
			status: "error",
			error: { code: "openFailed", message: "notPlaylist" },
		});
		// Only the `.ts` form is left, which goes through the converter. Its
		// AAC comes as ADTS, which the converter's Matroska can't copy.
		expect(await cast.route(item)).toMatchObject({
			ok: true,
			route: { via: "converted", format: 0, video: "copy", audio: "aac" },
		});
		await cast.load(item);
		expect(fake.castLoad).toHaveBeenLastCalledWith(
			"cast:tv",
			channel,
			{
				via: "converted",
				generation: 7,
				source: 1,
				container: "ts",
				video: "copy",
				audio: "aac",
			},
			undefined
		);
		expect(cast.getState().status).toBe("opening");
	});

	it("asks for the formats again after a stale load", async () => {
		const fake = backend();
		fake.castLoad.mockRejectedValueOnce(STALE);
		const cast = createCastDestination(receiver, fake);
		await expect(cast.load(item)).rejects.toBe("stale");
		expect(fake.getStreamFormats).toHaveBeenCalledTimes(1);
		await cast.route(item);
		expect(fake.getStreamFormats).toHaveBeenCalledTimes(2);
		expect(STALE).toBe("stale");
	});

	it("keeps the formats after any other failure", async () => {
		const fake = backend();
		fake.castLoad.mockRejectedValueOnce("unreachable");
		const cast = createCastDestination(receiver, fake);
		await expect(cast.load(item)).rejects.toBe("unreachable");
		expect(await cast.route(item)).toEqual({ ok: true, route: { via: "direct", format: 0 } });
		// A rejection after the formats were forgotten changes nothing more.
		fake.castLoad.mockRejectedValueOnce("cors");
		await expect(cast.load(item)).rejects.toBe("cors");
		expect(await cast.route(item)).toMatchObject({ route: { via: "converted" } });
	});

	it("sends the controls, with the volume as a level", async () => {
		const fake = backend();
		const cast = createCastDestination(receiver, fake);
		await cast.load(item);
		await cast.play();
		await cast.pause();
		await cast.seek(30);
		await cast.setVolume(25);
		expect(fake.castControl.mock.calls).toEqual([
			["cast:tv", { action: "play" }],
			["cast:tv", { action: "pause" }],
			["cast:tv", { action: "seek", to: 30 }],
			["cast:tv", { action: "volume", level: 0.25 }],
		]);
		await expect(cast.selectSubtitle("1")).rejects.toThrow(
			"Subtitles on a Cast receiver isn't supported here"
		);
		await expect(cast.selectAudio("1")).rejects.toThrow(
			"Choosing the audio on a Cast receiver isn't supported here"
		);
		await cast.stop();
		expect(fake.castStop).toHaveBeenCalledWith("cast:tv");
	});

	it("seeks a converted stream by converting again from there", async () => {
		const dolby: StreamFormats = {
			formats: [{ ...ts, audio: "ac3" }],
			sources: [4],
			duration: 5400,
			generation: 7,
		};
		const fake = backend(dolby);
		const cast = createCastDestination(receiver, fake);
		const film = { kind: "local" as const, channel: movie };
		await cast.load(film, { startAt: 60 });
		const route = {
			via: "converted",
			generation: 7,
			source: 4,
			container: "ts",
			video: "copy",
			audio: "aac",
		};
		expect(fake.castLoad).toHaveBeenLastCalledWith("cast:tv", movie, route, 60);
		cast.receive({ kind: "media", media: media({ position: 5, duration: null, live: true }) });
		expect(cast.getState()).toMatchObject({ position: 65, duration: 5400 });
		expect(cast.capabilities.seek).toBe(true);
		await cast.seek(1200);
		expect(fake.castLoad).toHaveBeenLastCalledWith("cast:tv", movie, route, 1200);
		expect(fake.castControl).not.toHaveBeenCalled();
		expect(cast.getState().position).toBe(1200);
		// After a stop, a seek goes to the receiver, which has nothing.
		await cast.stop();
		await cast.seek(5);
		expect(fake.castControl).toHaveBeenCalledWith("cast:tv", { action: "seek", to: 5 });
	});

	it("is waiting for the receiver until it's ready", async () => {
		const cast = createCastDestination(receiver, backend());
		await cast.load(item);
		expect(cast.getState().connection).toBe("reconnecting");
		cast.receive({ kind: "ready" });
		expect(cast.getState().connection).toBe("connected");
	});

	it("times updates by this device's clock", () => {
		const cast = createCastDestination(receiver, backend());
		const before = performance.now();
		cast.receive({ kind: "media", media: media() });
		expect(cast.getState().positionAt).toBeGreaterThanOrEqual(before);
	});

	it("tells when the receiver goes away", () => {
		const cast = createCastDestination(receiver, backend());
		cast.receive({ kind: "ready" });
		cast.receive({ kind: "closed", reason: "appStopped" });
		expect(cast.getState().status).toBe("idle");
		expect(cast.getState()).toBe(cast.getState());
	});

	it("says why it closed, and connects again for the next load", async () => {
		const cast = createCastDestination(receiver, backend());
		expect(cast.closedReason()).toBeNull();
		cast.receive({ kind: "ready" });
		cast.receive({ kind: "closed", reason: "connectionLost" });
		expect(cast.closedReason()).toBe("connectionLost");
		expect(cast.getState().connection).toBe("lost");
		await cast.load(item);
		expect(cast.closedReason()).toBeNull();
		expect(cast.getState().connection).toBe("reconnecting");
		// A load on a cast that's still open keeps it connected.
		cast.receive({ kind: "ready" });
		await cast.load(item);
		expect(cast.getState().connection).toBe("connected");
	});

	it("converts a file again from where it paused once the pause ran long", async () => {
		let clock = 1000;
		const film: StreamFormats = {
			formats: [{ ...ts, audio: "ac3" }],
			sources: [4],
			duration: 5400,
			generation: 7,
		};
		const fake = backend(film);
		const cast = createCastDestination(receiver, fake, { now: () => clock });
		const movieItem = { kind: "local" as const, channel: movie };
		await cast.load(movieItem, { startAt: 60 });
		cast.receive({ kind: "media", media: media({ position: 30, duration: null, live: true }) });
		await cast.pause();
		expect(fake.castControl).toHaveBeenLastCalledWith("cast:tv", { action: "pause" });
		cast.receive({
			kind: "media",
			media: media({ player: "paused", position: 30, duration: null, live: true }),
		});
		// A short pause goes on where it was.
		clock += PAUSE_LIMIT_MS - 1;
		await cast.play();
		expect(fake.castControl).toHaveBeenLastCalledWith("cast:tv", { action: "play" });
		expect(fake.castLoad).toHaveBeenCalledTimes(1);
		// A long one converts again from the place it paused.
		await cast.pause();
		clock += PAUSE_LIMIT_MS;
		await cast.play();
		expect(fake.castLoad).toHaveBeenCalledTimes(2);
		expect(fake.castLoad).toHaveBeenLastCalledWith("cast:tv", movie, expect.anything(), 90);
		// Play without a pause before it just plays.
		await cast.play();
		expect(fake.castLoad).toHaveBeenCalledTimes(2);
	});

	it("goes on after a long pause of a stream the receiver fetches, or live", async () => {
		let clock = 0;
		const fake = backend();
		const cast = createCastDestination(receiver, fake, { now: () => clock });
		await cast.load(item);
		await cast.pause();
		clock += PAUSE_LIMIT_MS * 2;
		await cast.play();
		expect(fake.castControl).toHaveBeenLastCalledWith("cast:tv", { action: "play" });
		expect(fake.castLoad).toHaveBeenCalledTimes(1);
		// Live through the converter has no place to go back to.
		const through = createCastDestination(receiver, fake, {
			now: () => clock,
			streamThrough: () => true,
		});
		await through.load(item);
		await through.pause();
		clock += PAUSE_LIMIT_MS * 2;
		await through.play();
		expect(fake.castLoad).toHaveBeenCalledTimes(2);
		// A seek after a pause converts from there, and Play then just plays.
		const filmBackend = backend({ ...xtream, duration: 600 });
		const film = createCastDestination(receiver, filmBackend, {
			now: () => clock,
			streamThrough: () => true,
		});
		await film.load({ kind: "local", channel: movie });
		await film.pause();
		await film.seek(100);
		clock += PAUSE_LIMIT_MS * 2;
		await film.play();
		expect(filmBackend.castLoad).toHaveBeenCalledTimes(2);
		expect(filmBackend.castControl).toHaveBeenLastCalledWith("cast:tv", { action: "play" });
	});

	it("lets go of the stream and keeps the cast", async () => {
		let clock = 0;
		const film: StreamFormats = {
			formats: [{ ...ts, audio: "ac3" }],
			sources: [4],
			duration: 5400,
			generation: 7,
		};
		const fake = backend(film);
		const cast = createCastDestination(receiver, fake, { now: () => clock });
		await cast.load({ kind: "local", channel: movie });
		await cast.pause();
		await cast.release();
		expect(fake.castRelease).toHaveBeenCalledWith("cast:tv");
		expect(fake.castStop).not.toHaveBeenCalled();
		// Nothing is loaded now, so Play after a long pause converts nothing.
		clock += PAUSE_LIMIT_MS * 2;
		await cast.play();
		expect(fake.castLoad).toHaveBeenCalledTimes(1);
		expect(fake.castControl).toHaveBeenLastCalledWith("cast:tv", { action: "play" });
		// A seek goes to the receiver too.
		await cast.seek(30);
		expect(fake.castControl).toHaveBeenLastCalledWith("cast:tv", { action: "seek", to: 30 });
	});
});
