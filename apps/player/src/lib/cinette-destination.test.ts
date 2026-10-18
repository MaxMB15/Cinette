// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi } from "vitest";
import {
	connectionOf,
	createCinetteDestination,
	remoteCapabilities,
	remotePlaybackState,
	type RemoteSnapshot,
} from "./cinette-destination";
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

	it("turns the other device's error into a failed error", () => {
		const state = remotePlaybackState(
			snapshot({ status: "error", error: "Stream ended" }),
			"connected",
			0
		);
		expect(state.error).toStrictEqual({ code: "failed", message: "Stream ended" });
	});

	it("says how the connection stands", () => {
		const connection = connectionOf;
		expect(connection({ phase: "connected" })).toBe("connected");
		expect(connection({ phase: "reconnecting", attempt: 2 })).toBe("reconnecting");
		expect(connection({ phase: "connecting" })).toBe("reconnecting");
		expect(connection({ phase: "pending", expiresInMs: 30_000 })).toBe("reconnecting");
		expect(connection({ phase: "verifying", code: "123456" })).toBe("reconnecting");
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

const destination = () => {
	const sent: RemoteCommand[] = [];
	const send = vi.fn(async (command: RemoteCommand) => {
		sent.push(command);
		return 1;
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
		d.receive(snapshot(), 0);
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

	it("passes a refused command's error on", async () => {
		const send = vi.fn(() => Promise.reject("stale_item"));
		const d = createCinetteDestination("dev1", "TV", send);
		d.receive(snapshot(), 0);
		await expect(d.pause()).rejects.toBe("stale_item");
	});

	it("tells subscribers about every new state and phase, until they leave", () => {
		const { d } = destination();
		const seen: string[] = [];
		const stop = d.subscribe((s) => seen.push(`${s.status}/${s.connection}/${s.positionAt}`));
		const before = d.getState();
		expect(d.getState(), "the same object until it changes").toBe(before);
		d.setPhase({ phase: "connected" });
		d.receive(snapshot({ status: "paused" }), 500);
		expect(d.getState()).not.toBe(before);
		expect(d.getState().status).toBe("paused");
		expect(d.capabilities.pause).toBe(true);
		stop();
		d.receive(snapshot(), 900);
		expect(seen).toStrictEqual(["idle/connected/0", "paused/connected/500"]);
		expect(d.getState().positionAt).toBe(900);
	});
});
