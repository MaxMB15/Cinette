// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi } from "vitest";
import {
	commandError,
	connectionOf,
	createCinetteDestination,
	RemoteCommandError,
	remoteCapabilities,
	remotePlaybackState,
	type RemoteSnapshot,
	type VersionedSnapshot,
} from "./cinette-destination";
import { UnsupportedError } from "./destination";
import type { RemoteCommand } from "./remote-target";
import type { Channel } from "./types";

const snapshot = (overrides: Partial<RemoteSnapshot> = {}): RemoteSnapshot => ({
	status: "playing",
	item: { id: "live-7", name: "News", contentType: "live", group: "UK" },
	position: 30,
	duration: 0,
	volume: 55,
	subtitles: [{ id: "s1", label: "English" }],
	subtitleId: null,
	audio: [{ id: "a1", label: "Main" }],
	audioId: "a1",
	capabilities: {
		pause: true,
		seek: false,
		volume: true,
		subtitles: true,
		audioTracks: true,
		resumeAt: false,
	},
	error: null,
	...overrides,
});

describe("remotePlaybackState", () => {
	it("names the item by the other device's id and keeps the rest", () => {
		const state = remotePlaybackState(snapshot(), "connected", 1_234);
		expect(state).toStrictEqual({
			status: "playing",
			item: { title: "News", contentType: "live", ref: "live-7" },
			position: 30,
			positionAt: 1_234,
			duration: 0,
			volume: 55,
			subtitles: [{ id: "s1", label: "English" }],
			subtitleId: null,
			audio: [{ id: "a1", label: "Main" }],
			audioId: "a1",
			connection: "connected",
			error: null,
		});
	});

	it("names an episode's series where the other device does", () => {
		const item = { id: "e2", name: "Two", contentType: "series", group: "", seriesId: "s9" };
		expect(remotePlaybackState(snapshot({ item }), "connected", 0).item).toStrictEqual({
			title: "Two",
			contentType: "series",
			ref: "e2",
			seriesId: "s9",
		});
	});

	it("reads each known content type and calls anything else live", () => {
		for (const t of ["live", "movie", "series", "recording"]) {
			const item = { id: "x", name: "X", contentType: t, group: "" };
			const state = remotePlaybackState(snapshot({ item }), "connected", 0);
			expect(state.item?.contentType).toBe(t);
		}
		const odd = { id: "x", name: "X", contentType: "radio", group: "" };
		expect(remotePlaybackState(snapshot({ item: odd }), "connected", 0).item?.contentType).toBe(
			"live"
		);
	});

	it("has no item when nothing plays and no volume when it can't be set", () => {
		const state = remotePlaybackState(
			snapshot({ item: null, volume: null, status: "idle" }),
			"connected",
			0
		);
		expect(state.item).toBeNull();
		expect(state.volume).toBe(0);
	});

	it("takes the other device's error code, and an unknown one as failed", () => {
		const errorOf = (error: string) =>
			remotePlaybackState(snapshot({ status: "error", error }), "connected", 0).error;
		expect(errorOf("refused")).toStrictEqual({ code: "refused" });
		expect(errorOf("openFailed")).toStrictEqual({ code: "openFailed" });
		expect(errorOf("loadFailed")).toStrictEqual({ code: "loadFailed" });
		expect(errorOf("failed")).toStrictEqual({ code: "failed" });
		expect(errorOf("unknown")).toStrictEqual({ code: "failed" });
	});

	it("says how the connection stands", () => {
		const connection = connectionOf;
		expect(connection({ phase: "connected" })).toBe("connected");
		expect(connection({ phase: "reconnecting", attempt: 2 })).toBe("reconnecting");
		expect(connection({ phase: "connecting" })).toBe("reconnecting");
		expect(connection({ phase: "pending", expiresInMs: 30_000 })).toBe("reconnecting");
		expect(connection({ phase: "verifying", code: "123456", name: "TV" })).toBe("reconnecting");
		expect(connection({ phase: "closed", reason: "lost" })).toBe("lost");
	});
});

describe("remoteCapabilities", () => {
	it("follows what the other device's player can do, and has a catalog", () => {
		expect(remoteCapabilities(snapshot())).toStrictEqual({
			seek: false,
			pause: true,
			volume: "absolute",
			subtitles: "select",
			externalSubtitles: false,
			audioTracks: true,
			resumeAt: false,
			catalog: true,
		});
		const none = snapshot({
			capabilities: {
				pause: false,
				seek: true,
				volume: false,
				subtitles: false,
				audioTracks: false,
				resumeAt: true,
			},
		});
		expect(remoteCapabilities(none)).toMatchObject({
			seek: true,
			pause: false,
			volume: "none",
			subtitles: "none",
			audioTracks: false,
			resumeAt: true,
		});
	});
});

/** `state` as the other device sends it. */
const versioned = (state: RemoteSnapshot, version = 1, epoch = "e1"): VersionedSnapshot => ({
	epoch,
	version,
	state,
});

const destination = () => {
	const sent: RemoteCommand[] = [];
	// No version in the answer, so a load always shows the item opening.
	const send = vi.fn(async (command: RemoteCommand): Promise<unknown> => {
		sent.push(command);
		return undefined;
	});
	return { d: createCinetteDestination("dev1", "Living Room", send), sent, send };
};

describe("createCinetteDestination", () => {
	it("names the device and its catalog", () => {
		const { d } = destination();
		expect(d.id).toBe("cinette:dev1");
		expect(d.kind).toBe("cinette");
		expect(d.name).toBe("Living Room");
		expect(d.catalog).toStrictEqual({ kind: "remote", deviceId: "dev1" });
	});

	it("starts with nothing playing while it connects", () => {
		const { d } = destination();
		expect(d.getState()).toStrictEqual({
			status: "idle",
			item: null,
			position: 0,
			positionAt: 0,
			duration: 0,
			volume: 0,
			subtitles: [],
			subtitleId: null,
			audio: [],
			audioId: null,
			connection: "reconnecting",
			error: null,
		});
		expect(d.capabilities).toStrictEqual({
			seek: false,
			pause: false,
			volume: "none",
			subtitles: "none",
			externalSubtitles: false,
			audioTracks: false,
			resumeAt: false,
			catalog: true,
		});
	});

	it("plays the other device's items, never this device's channels", async () => {
		const { d, sent } = destination();
		await expect(d.route({ kind: "remote", itemId: "live-1", title: "One" })).resolves.toEqual({
			ok: true,
			route: { via: "cinette" },
		});
		const channel = { id: "live-1" } as Channel;
		await expect(d.route({ kind: "local", channel })).resolves.toEqual({
			ok: false,
			reason: "notFound",
		});
		await expect(d.load({ kind: "local", channel })).rejects.toThrow(
			"Playing this device's channel on another device isn't supported here"
		);
		await d.load({ kind: "remote", itemId: "movie-2", title: "Film" }, { startAt: 90 });
		await d.load({ kind: "remote", itemId: "live-1", title: "One" });
		expect(sent).toStrictEqual([
			{ action: "load", itemId: "movie-2", startAt: 90 },
			{ action: "load", itemId: "live-1" },
		]);
	});

	it("names the playing item in every command about it", async () => {
		const { d, sent } = destination();
		d.receive(versioned(snapshot()), 0);
		await d.play();
		await d.pause();
		await d.seek(42);
		await d.setVolume(33.4);
		await d.selectSubtitle(null);
		await d.selectAudio("a2");
		await d.stop();
		expect(sent).toStrictEqual([
			{ action: "play", itemId: "live-7" },
			{ action: "pause", itemId: "live-7" },
			{ action: "seek", itemId: "live-7", to: 42 },
			{ action: "volume", value: 33 },
			{ action: "subtitle", itemId: "live-7", trackId: null },
			{ action: "audio", itemId: "live-7", trackId: "a2" },
			{ action: "stop" },
		]);
	});

	it("refuses commands about an item when nothing plays", async () => {
		const { d, send } = destination();
		await expect(d.play()).rejects.toThrow("Controlling nothing isn't supported here");
		await expect(d.seek(3)).rejects.toMatchObject({ code: "unsupported" });
		expect(send).not.toHaveBeenCalled();
		await d.stop();
		await d.setVolume(10);
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("passes a refused command's error on as an error with its code", async () => {
		const send = vi.fn(() => Promise.reject("stale_item"));
		const d = createCinetteDestination("dev1", "TV", send);
		d.receive(versioned(snapshot()), 0);
		const refused = d.pause();
		await expect(refused).rejects.toBeInstanceOf(RemoteCommandError);
		await expect(refused).rejects.toMatchObject({ code: "stale_item" });
		send.mockImplementationOnce(() => Promise.reject("unsupported"));
		await expect(d.play()).rejects.toBeInstanceOf(UnsupportedError);
	});

	it("turns what a command rejects with into an error", () => {
		expect(commandError("link_timed_out")).toMatchObject({ code: "link_timed_out" });
		expect(commandError("link_timed_out").message).toBe(
			"The other device didn't carry it out: link_timed_out"
		);
		expect(commandError(new Error("odd"))).toMatchObject({ code: "failed" });
		expect(commandError("unsupported")).toMatchObject({ code: "unsupported" });
		expect(commandError("unsupported").message).toBe(
			"That on the other device isn't supported here"
		);
		expect(new RemoteCommandError("link_busy").name).toBe("RemoteCommandError");
	});

	it("names a loaded item until the other device's next state", async () => {
		const { d } = destination();
		d.receive(
			versioned(
				snapshot({ status: "paused", error: "failed", subtitleId: "s1", audioId: "a1" })
			),
			0
		);
		const seen: string[] = [];
		d.subscribe((s) => seen.push(`${s.status}/${s.item?.ref ?? "-"}`));
		const before = performance.now();
		await d.load({ kind: "remote", itemId: "movie-2", title: "Film" }, { startAt: 90 });
		expect(d.getState()).toMatchObject({
			status: "opening",
			item: { ref: "movie-2", title: "Film" },
			position: 90,
			duration: 0,
			error: null,
			volume: 55,
			// The old item's tracks aren't the new one's.
			subtitles: [],
			subtitleId: null,
			audio: [],
			audioId: null,
		});
		expect(d.getState().positionAt).toBeGreaterThanOrEqual(before);
		expect(seen).toStrictEqual(["opening/movie-2"]);
		// A command now names the new item.
		await d.pause();
		await d.load({ kind: "remote", itemId: "live-1", title: "One" });
		expect(d.getState().position, "from the start").toBe(0);
		d.receive(versioned(snapshot(), 2), 10);
		expect(d.getState().item?.ref).toBe("live-7");
	});

	it("keeps a state from the other device that came before the load's answer", async () => {
		let answer: (version: number) => void = () => {};
		const send = vi.fn(
			() => new Promise<unknown>((resolve) => (answer = resolve as (v: number) => void))
		);
		const d = createCinetteDestination("dev1", "TV", send);
		d.receive(versioned(snapshot(), 4), 0);
		const movie = snapshot({
			status: "playing",
			item: { id: "movie-2", name: "Film", contentType: "movie", group: "Drama" },
			duration: 5400,
		});
		const loading = d.load({ kind: "remote", itemId: "movie-2", title: "Film" });
		// The state the load made arrives first, then the answer with its version.
		d.receive(versioned(movie, 5), 10);
		answer(5);
		await loading;
		expect(d.getState()).toMatchObject({
			status: "playing",
			item: { ref: "movie-2", contentType: "movie" },
			duration: 5400,
		});
	});

	it("shows the item opening when the answer is newer than the last state", async () => {
		const send = vi.fn(() => Promise.resolve<unknown>(5));
		const d = createCinetteDestination("dev1", "TV", send);
		d.receive(versioned(snapshot(), 4), 0);
		await d.load({ kind: "remote", itemId: "movie-2", title: "Film" });
		expect(d.getState()).toMatchObject({ status: "opening", item: { ref: "movie-2" } });
	});

	it("shows the item opening when no state came before the answer", async () => {
		const send = vi.fn(() => Promise.resolve<unknown>(0));
		const d = createCinetteDestination("dev1", "TV", send);
		await d.load({ kind: "remote", itemId: "movie-2", title: "Film" });
		expect(d.getState()).toMatchObject({ status: "opening", item: { ref: "movie-2" } });
	});

	it("leaves the state as it was when a load is refused", async () => {
		const send = vi.fn(() => Promise.reject("not_found"));
		const d = createCinetteDestination("dev1", "TV", send);
		d.receive(versioned(snapshot()), 0);
		await expect(
			d.load({ kind: "remote", itemId: "gone", title: "Gone" })
		).rejects.toMatchObject({ code: "not_found" });
		expect(d.getState().item?.ref).toBe("live-7");
	});

	it("keeps its capabilities the same object until they change", () => {
		const { d } = destination();
		d.receive(versioned(snapshot()), 0);
		const first = d.capabilities;
		d.receive(versioned(snapshot({ position: 90 }), 2), 5);
		expect(d.capabilities).toBe(first);
		d.receive(
			versioned(snapshot({ capabilities: { ...snapshot().capabilities, seek: true } }), 3),
			6
		);
		expect(d.capabilities).not.toBe(first);
		expect(d.capabilities.seek).toBe(true);
	});

	it("tells nobody about a phase that leaves the connection as it was", () => {
		const { d } = destination();
		const seen: string[] = [];
		d.subscribe((s) => seen.push(s.connection));
		d.setPhase({ phase: "verifying", code: "123456", name: "TV" });
		d.setPhase({ phase: "pending", expiresInMs: 1 });
		d.setPhase({ phase: "connected" });
		d.setPhase({ phase: "connected" });
		expect(seen).toStrictEqual(["connected"]);
	});

	it("tells subscribers about every new state and phase, until they leave", () => {
		const { d } = destination();
		const seen: string[] = [];
		const stop = d.subscribe((s) => seen.push(`${s.status}/${s.connection}/${s.positionAt}`));
		const before = d.getState();
		expect(d.getState(), "the same object until it changes").toBe(before);
		d.setPhase({ phase: "connected" });
		d.receive(versioned(snapshot({ status: "paused" })), 500);
		expect(d.getState()).not.toBe(before);
		expect(d.getState().status).toBe("paused");
		expect(d.capabilities.pause).toBe(true);
		stop();
		d.receive(versioned(snapshot()), 900);
		expect(seen).toStrictEqual(["idle/connected/0", "paused/connected/500"]);
		expect(d.getState().positionAt).toBe(900);
	});
});
