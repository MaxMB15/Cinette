// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { beforeEach, describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useLocalPlayback, type LocalPlayer } from "./useLocalPlayback";
import { UnsupportedError, type PlaybackState } from "@/lib/destination";
import type { Channel, PolledMpvState } from "@/lib/types";

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

const player = (over: Partial<LocalPlayer> = {}): LocalPlayer => ({
	state: mpvState(),
	error: null,
	opening: false,
	buffering: false,
	reconnecting: false,
	loadFailed: false,
	openFailed: false,
	play: vi.fn(async () => {}),
	pause: vi.fn(async () => {}),
	seek: vi.fn(async () => {}),
	setVolume: vi.fn(async () => {}),
	stop: vi.fn(async () => {}),
	...over,
});

const channel: Channel = {
	id: "live-3",
	name: "News",
	url: "http://example.invalid/live/3.ts",
	groupTitle: "News",
	isFavorite: false,
	contentType: "live",
	sources: [],
};

const loadChannel = vi.fn();

beforeEach(() => {
	loadChannel.mockReset();
});

describe("useLocalPlayback", () => {
	it("is this device, with its own catalog", () => {
		const { result } = renderHook(() => useLocalPlayback(player(), null, vi.fn()));
		expect(result.current.id).toBe("local");
		expect(result.current.kind).toBe("local");
		expect(result.current.name).toBe("This device");
		expect(result.current.catalog).toEqual({ kind: "local" });
	});

	it("passes the controls straight to the player", async () => {
		const p = player();
		const { result } = renderHook(() => useLocalPlayback(p, channel, loadChannel));
		await result.current.play();
		await result.current.pause();
		await result.current.seek(42);
		await result.current.setVolume(30);
		await result.current.stop();
		expect(p.play).toHaveBeenCalledOnce();
		expect(p.pause).toHaveBeenCalledOnce();
		expect(p.seek).toHaveBeenCalledWith(42);
		expect(p.setVolume).toHaveBeenCalledWith(30);
		expect(p.stop).toHaveBeenCalledOnce();
	});

	it("loads a channel through the player's own flow, at the start position", async () => {
		const { result } = renderHook(() => useLocalPlayback(player(), null, loadChannel));
		await result.current.load({ kind: "local", channel }, { startAt: 90 });
		expect(loadChannel).toHaveBeenCalledWith(channel, 90);
		await result.current.load({ kind: "local", channel });
		expect(loadChannel).toHaveBeenLastCalledWith(channel, undefined);
	});

	it("can't play another device's items", async () => {
		const p = player();
		const { result } = renderHook(() => useLocalPlayback(p, null, loadChannel));
		const remote = { kind: "remote", itemId: "movie-1", title: "Film" } as const;
		await expect(result.current.route(remote)).resolves.toEqual({
			ok: false,
			reason: "notFound",
		});
		await expect(result.current.route({ kind: "local", channel })).resolves.toEqual({
			ok: true,
			route: { via: "local" },
		});
		await expect(result.current.load(remote)).rejects.toBeInstanceOf(UnsupportedError);
		await expect(result.current.load(remote)).rejects.toThrow(
			"Playing another device's item isn't supported here"
		);
		expect(loadChannel).not.toHaveBeenCalled();
	});

	it("refuses track choices it can't make yet", async () => {
		const { result } = renderHook(() => useLocalPlayback(player(), null, vi.fn()));
		await expect(result.current.selectSubtitle("en")).rejects.toMatchObject({
			code: "unsupported",
			message: "Choosing a subtitle track isn't supported here",
		});
		await expect(result.current.selectAudio("1")).rejects.toMatchObject({
			code: "unsupported",
			message: "Choosing an audio track isn't supported here",
		});
	});

	it("can seek once the length is known", () => {
		let p = player();
		const { result, rerender } = renderHook(() => useLocalPlayback(p, channel, loadChannel));
		expect(result.current.capabilities.seek).toBe(false);
		p = player({ state: mpvState({ duration: 0.5 }) });
		rerender();
		expect(result.current.capabilities.seek).toBe(true);
	});

	it("stays the same object while the length changes but stays known", () => {
		let p = player({ state: mpvState({ duration: 120 }) });
		const { result, rerender } = renderHook(() => useLocalPlayback(p, channel, loadChannel));
		const first = result.current;
		p = { ...p, state: mpvState({ duration: 121 }) };
		rerender();
		expect(result.current).toBe(first);
	});

	it("tells subscribers about each new state, and stops when they leave", () => {
		let p = player();
		const { result, rerender } = renderHook(() => useLocalPlayback(p, channel, loadChannel));
		const seen: PlaybackState[] = [];
		const unsubscribe = result.current.subscribe((s) => seen.push(s));
		p = player({ state: mpvState({ isPlaying: true, position: 5 }) });
		rerender();
		expect(seen.map((s) => s.status)).toEqual(["playing"]);
		expect(result.current.getState()).toBe(seen[0]);
		expect(seen[0].item?.ref).toBe("live-3");
		unsubscribe();
		p = player({ state: mpvState({ isPaused: true, isPlaying: true }) });
		rerender();
		expect(seen).toHaveLength(1);
		expect(result.current.getState().status).toBe("paused");
	});

	it("keeps the same state object while nothing changes", () => {
		const p = player();
		const { result, rerender } = renderHook(() => useLocalPlayback(p, channel, loadChannel));
		const first = result.current.getState();
		const destination = result.current;
		rerender();
		expect(result.current.getState()).toBe(first);
		expect(result.current).toBe(destination);
	});

	it("reports what went wrong", () => {
		let p = player({ openFailed: true });
		const { result, rerender } = renderHook(() => useLocalPlayback(p, channel, loadChannel));
		expect(result.current.getState().error).toEqual({ code: "openFailed" });
		p = player({ opening: true });
		rerender();
		expect(result.current.getState().status).toBe("opening");
		p = player({ buffering: true });
		rerender();
		expect(result.current.getState().status).toBe("buffering");
		p = player({ reconnecting: true });
		rerender();
		expect(result.current.getState().status).toBe("buffering");
		p = player({ loadFailed: true });
		rerender();
		expect(result.current.getState().error).toEqual({ code: "loadFailed" });
		p = player({ error: "gone" });
		rerender();
		expect(result.current.getState().error).toEqual({ code: "failed", message: "gone" });
	});
});
