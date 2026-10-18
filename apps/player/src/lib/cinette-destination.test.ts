// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi } from "vitest";
import {
	commandError,
	connectionOf,
	createCinetteDestination,
	LOAD_SHOWS_WITHIN_MS,
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
	// No version in the answer, so a load doesn't wait for a state.
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
		expect(commandError("timedOut")).toMatchObject({ code: "timedOut" });
		expect(commandError("timedOut").message).toBe(
			"The other device didn't carry it out: timedOut"
		);
		expect(commandError(new Error("odd"))).toMatchObject({ code: "failed" });
		expect(commandError("unsupported")).toMatchObject({ code: "unsupported" });
		expect(commandError("unsupported").message).toBe(
			"That on the other device isn't supported here"
		);
		expect(new RemoteCommandError("busy").name).toBe("RemoteCommandError");
	});

	it("finishes a load once the other device's state is as new as its answer", async () => {
		let answer = 0;
		const send = vi.fn(async (): Promise<unknown> => answer);
		const d = createCinetteDestination("dev1", "TV", send);
		d.receive(versioned(snapshot(), 4), 0);
		answer = 6;
		let done = false;
		const load = d.load({ kind: "remote", itemId: "movie-2", title: "Film" }).then(() => {
			done = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		d.receive(versioned(snapshot(), 5), 10);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(done, "version 5 is older than the answer").toBe(false);
		d.receive(versioned(snapshot({ item: null }), 6), 20);
		await load;
		expect(done).toBe(true);
		// An answer the state already reached doesn't wait.
		answer = 3;
		await d.load({ kind: "remote", itemId: "movie-2", title: "Film" });
	});

	it("finishes a load when the other device starts again, or the link ends", async () => {
		const send = vi.fn(async (): Promise<unknown> => 9);
		const d = createCinetteDestination("dev1", "TV", send);
		d.receive(versioned(snapshot(), 1, "old"), 0);
		const restarted = d.load({ kind: "remote", itemId: "a", title: "A" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		d.receive(versioned(snapshot(), 1, "new"), 5);
		await restarted;
		const closed = d.load({ kind: "remote", itemId: "b", title: "B" });
		// Until the answer is in, nothing waits.
		await new Promise((resolve) => setTimeout(resolve, 0));
		d.receive(versioned(snapshot(), 2, "new"), 6);
		d.setPhase({ phase: "closed", reason: "lost" });
		await closed;
		// Over the closed link, a load doesn't wait at all.
		await d.load({ kind: "remote", itemId: "c", title: "C" });
	});

	it("finishes a load whose state never comes, after a while", async () => {
		vi.useFakeTimers();
		try {
			const send = vi.fn(async (): Promise<unknown> => 9);
			const d = createCinetteDestination("dev1", "TV", send);
			let done = false;
			const load = d.load({ kind: "remote", itemId: "a", title: "A" }).then(() => {
				done = true;
			});
			await vi.advanceTimersByTimeAsync(LOAD_SHOWS_WITHIN_MS - 1);
			expect(done).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await load;
			expect(done).toBe(true);
			// A state that comes later finds nothing waiting.
			d.receive(versioned(snapshot(), 9), 0);
		} finally {
			vi.useRealTimers();
		}
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
