// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import type { EventCallback } from "@tauri-apps/api/event";

const handlers = vi.hoisted(() => new Map<string, EventCallback<unknown>>());
const unlisteners = vi.hoisted(() => [] as ReturnType<typeof vi.fn>[]);
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn((event: string, handler: EventCallback<unknown>) => {
		handlers.set(event, handler);
		const stop = vi.fn(() => handlers.delete(event));
		unlisteners.push(stop);
		return Promise.resolve(stop);
	}),
}));

vi.mock("@/lib/tauri", () => ({
	mpvStop: vi.fn(() => Promise.resolve()),
	remoteFinishCommand: vi.fn(() => Promise.resolve()),
	remoteSessions: vi.fn(() => Promise.resolve([])),
	remoteSetState: vi.fn(() => Promise.resolve()),
}));

const navigate = vi.hoisted(() => vi.fn());
vi.mock("react-router", () => ({ useNavigate: () => navigate }));

const channels = vi.hoisted(() => ({ list: [] as Channel[] }));
vi.mock("@/hooks/useChannels", () => ({ useChannels: () => ({ channels: channels.list }) }));

import { listen } from "@tauri-apps/api/event";
import { mpvStop, remoteFinishCommand, remoteSessions, remoteSetState } from "@/lib/tauri";
import { usePublishRemoteState, useRemoteSessions, useRemoteTarget } from "./useRemoteTarget";
import { getMountedPlayer, IDLE_REMOTE_STATE, setMountedPlayer } from "@/lib/remote-target";
import { localCapabilities, type PlaybackDestination, type PlaybackState } from "@/lib/destination";
import type { Channel } from "@/lib/types";

const channel: Channel = {
	id: "live-1",
	name: "News",
	url: "http://iptv.example/live/u/p/1.ts",
	groupTitle: "UK",
	isFavorite: false,
	contentType: "live",
	sources: [],
};

const emit = (event: string, payload: unknown) =>
	act(() => {
		handlers.get(event)?.({ event, id: 1, payload });
	});

const session = (connected: boolean) => ({
	sessionId: "s1",
	deviceId: "d1",
	name: "Phone",
	deviceType: "iphone",
	connected,
});

const playingState: PlaybackState = {
	status: "playing",
	item: { title: "News", contentType: "live", ref: "live-1" },
	position: 5,
	positionAt: 0,
	duration: 0,
	volume: 40,
	subtitles: [],
	subtitleId: null,
	audio: [],
	audioId: null,
	connection: "connected",
	error: null,
};

const fakeDestination = () => {
	const listeners = new Set<(s: PlaybackState) => void>();
	let current = playingState;
	const destination = {
		capabilities: localCapabilities(false),
		getState: () => current,
		subscribe: (l: (s: PlaybackState) => void) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		load: vi.fn(() => Promise.resolve()),
		play: vi.fn(() => Promise.resolve()),
	};
	const push = (next: PlaybackState) => {
		current = next;
		for (const l of listeners) l(next);
	};
	return {
		destination: destination as unknown as PlaybackDestination,
		listeners,
		push,
		mocks: destination,
	};
};

beforeEach(() => {
	handlers.clear();
	unlisteners.length = 0;
	channels.list = [channel];
	setMountedPlayer(null);
});

afterEach(() => {
	vi.clearAllMocks();
});

/** Makes going to the player page open one, which registers `player`. */
const pageOpens = () => {
	const { destination, mocks } = fakeDestination();
	navigate.mockImplementation(() => setMountedPlayer(destination));
	return mocks;
};

describe("useRemoteTarget", () => {
	it("opens the player for a load when none is open, and plays there", async () => {
		const page = pageOpens();
		renderHook(() => useRemoteTarget());
		await waitFor(() => expect(handlers.has("remote://command")).toBe(true));
		emit("remote://command", {
			token: 4,
			command: { action: "load", itemId: "live-1", startAt: 30 },
		});
		await waitFor(() => expect(remoteFinishCommand).toHaveBeenCalledWith(4, "ok"));
		expect(navigate).toHaveBeenCalledWith("/player");
		expect(page.load).toHaveBeenCalledWith({ kind: "local", channel }, { startAt: 30 });
	});

	it("uses the channels as they are when the command comes", async () => {
		pageOpens();
		channels.list = [];
		const { rerender } = renderHook(() => useRemoteTarget());
		await waitFor(() => expect(handlers.has("remote://command")).toBe(true));
		channels.list = [channel];
		rerender();
		emit("remote://command", { token: 5, command: { action: "load", itemId: "live-1" } });
		await waitFor(() => expect(remoteFinishCommand).toHaveBeenCalledWith(5, "ok"));
		expect(vi.mocked(listen)).toHaveBeenCalledTimes(1);
	});

	it("sends other commands to the mounted player", async () => {
		const { destination, mocks } = fakeDestination();
		setMountedPlayer(destination);
		renderHook(() => useRemoteTarget());
		await waitFor(() => expect(handlers.has("remote://command")).toBe(true));
		emit("remote://command", { token: 6, command: { action: "play", itemId: "live-1" } });
		await waitFor(() => expect(remoteFinishCommand).toHaveBeenCalledWith(6, "ok"));
		expect(mocks.play).toHaveBeenCalledTimes(1);
	});

	it("plays an episode that comes with the command", async () => {
		const episode = { ...channel, id: "ep-1", name: "Pilot", url: "http://x.test/ep1.mkv" };
		const page = pageOpens();
		renderHook(() => useRemoteTarget());
		await waitFor(() => expect(handlers.has("remote://command")).toBe(true));
		emit("remote://command", {
			token: 8,
			command: { action: "load", itemId: "ep-1" },
			channel: episode,
		});
		await waitFor(() => expect(remoteFinishCommand).toHaveBeenCalledWith(8, "ok"));
		expect(page.load).toHaveBeenCalledWith(
			{ kind: "local", channel: episode },
			{ startAt: undefined }
		);
	});

	it("looks in the channel list when the episode is another one", async () => {
		const page = pageOpens();
		renderHook(() => useRemoteTarget());
		await waitFor(() => expect(handlers.has("remote://command")).toBe(true));
		emit("remote://command", {
			token: 9,
			command: { action: "load", itemId: "live-1" },
			channel: { ...channel, id: "ep-1", name: "Pilot" },
		});
		await waitFor(() => expect(remoteFinishCommand).toHaveBeenCalledWith(9, "ok"));
		expect(page.load).toHaveBeenCalledWith({ kind: "local", channel }, { startAt: undefined });
	});

	it("stops mpv for a stop when no player page is open", async () => {
		renderHook(() => useRemoteTarget());
		await waitFor(() => expect(handlers.has("remote://command")).toBe(true));
		emit("remote://command", { token: 8, command: { action: "stop" } });
		await waitFor(() => expect(remoteFinishCommand).toHaveBeenCalledWith(8, "ok"));
		expect(mpvStop).toHaveBeenCalledTimes(1);
	});

	it("reports what wasn't found", async () => {
		renderHook(() => useRemoteTarget());
		await waitFor(() => expect(handlers.has("remote://command")).toBe(true));
		emit("remote://command", { token: 7, command: { action: "load", itemId: "nope" } });
		await waitFor(() => expect(remoteFinishCommand).toHaveBeenCalledWith(7, "notFound"));
		expect(navigate).not.toHaveBeenCalled();
	});

	it("stops listening when unmounted, even before listening started", async () => {
		const view = renderHook(() => useRemoteTarget());
		await waitFor(() => expect(unlisteners).toHaveLength(1));
		view.unmount();
		expect(unlisteners[0]).toHaveBeenCalledTimes(1);

		let resolve: (stop: () => void) => void = () => {};
		vi.mocked(listen).mockImplementationOnce(
			() => new Promise((r) => (resolve = r as typeof resolve))
		);
		const early = renderHook(() => useRemoteTarget());
		early.unmount();
		const stop = vi.fn();
		await act(async () => resolve(stop));
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("survives a failure to listen", async () => {
		vi.mocked(listen).mockRejectedValueOnce(new Error("no Tauri"));
		const view = renderHook(() => useRemoteTarget());
		await act(async () => {});
		view.unmount();
	});
});

describe("useRemoteSessions", () => {
	it("starts from the backend's list and follows the events", async () => {
		vi.mocked(remoteSessions).mockResolvedValueOnce([session(true)]);
		const { result } = renderHook(() => useRemoteSessions());
		await waitFor(() => expect(result.current).toEqual([session(true)]));
		await waitFor(() => expect(handlers.has("remote://sessions")).toBe(true));
		emit("remote://sessions", [session(false)]);
		expect(result.current).toEqual([session(false)]);
	});

	it("takes anything but a list from the backend as none", async () => {
		vi.mocked(remoteSessions).mockResolvedValueOnce(undefined as never);
		const { result } = renderHook(() => useRemoteSessions());
		await act(async () => {});
		expect(result.current).toEqual([]);
	});

	it("stays empty where remote control doesn't run", async () => {
		vi.mocked(remoteSessions).mockRejectedValueOnce("unavailable");
		const { result } = renderHook(() => useRemoteSessions());
		await act(async () => {});
		expect(result.current).toEqual([]);
	});

	it("keeps the newest list when a first load answers late", async () => {
		// StrictMode mounts twice, so the first load's answer comes for a
		// mount that has gone.
		let late: (list: ReturnType<typeof session>[]) => void = () => {};
		vi.mocked(remoteSessions)
			.mockImplementationOnce(() => new Promise((r) => (late = r)))
			.mockResolvedValueOnce([session(true)]);
		const { result } = renderHook(() => useRemoteSessions(), { wrapper: StrictMode });
		await waitFor(() => expect(result.current).toEqual([session(true)]));
		await act(async () => late([session(false)]));
		expect(result.current).toEqual([session(true)]);
	});

	it("ignores a list that arrives after unmounting", async () => {
		let resolve: (list: ReturnType<typeof session>[]) => void = () => {};
		vi.mocked(remoteSessions).mockImplementationOnce(() => new Promise((r) => (resolve = r)));
		const { result, unmount } = renderHook(() => useRemoteSessions());
		unmount();
		await act(async () => resolve([session(true)]));
		expect(result.current).toEqual([]);
	});
});

describe("usePublishRemoteState", () => {
	it("registers the player while mounted", () => {
		const { destination } = fakeDestination();
		const view = renderHook(() => usePublishRemoteState(destination, channel));
		expect(getMountedPlayer()).toBe(destination);
		view.unmount();
		expect(getMountedPlayer()).toBeNull();
	});

	it("registers the player the page uses now", () => {
		const first = fakeDestination().destination;
		const second = fakeDestination().destination;
		const view = renderHook(({ player }) => usePublishRemoteState(player, channel), {
			initialProps: { player: first },
		});
		view.rerender({ player: second });
		expect(getMountedPlayer()).toBe(second);
		view.unmount();
	});

	it("tells controllers the player is idle when the page closes", async () => {
		const { destination } = fakeDestination();
		const view = renderHook(() => usePublishRemoteState(destination, channel));
		view.unmount();
		await waitFor(() => expect(remoteSetState).toHaveBeenCalled());
		expect(vi.mocked(remoteSetState).mock.calls.at(-1)?.[0]).toEqual({
			status: "idle",
			item: null,
			position: 0,
			duration: 0,
			volume: null,
			subtitles: [],
			subtitleId: null,
			audio: [],
			audioId: null,
			capabilities: {
				pause: false,
				seek: false,
				volume: false,
				subtitles: false,
				audioTracks: false,
				resumeAt: false,
			},
			error: null,
		});
	});

	it("sends no idle state when the page swaps in a new destination", async () => {
		const first = fakeDestination().destination;
		const second = fakeDestination().destination;
		const view = renderHook(({ player }) => usePublishRemoteState(player, channel), {
			initialProps: { player: first },
		});
		view.rerender({ player: second });
		await Promise.resolve();
		expect(remoteSetState).not.toHaveBeenCalledWith(IDLE_REMOTE_STATE);
		view.unmount();
	});

	it("leaves a newer player registered when an older one unmounts", () => {
		const older = fakeDestination().destination;
		const newer = fakeDestination().destination;
		const view = renderHook(() => usePublishRemoteState(older, channel));
		setMountedPlayer(newer);
		view.unmount();
		expect(getMountedPlayer()).toBe(newer);
	});

	it("sends nothing until a controller is connected", async () => {
		const { destination, push } = fakeDestination();
		renderHook(() => usePublishRemoteState(destination, channel));
		await waitFor(() => expect(handlers.has("remote://sessions")).toBe(true));
		push({ ...playingState, position: 9 });
		emit("remote://sessions", [session(false)]);
		expect(remoteSetState).not.toHaveBeenCalled();
	});

	it("sends the state at once and on every change while connected", async () => {
		vi.spyOn(performance, "now").mockReturnValue(0);
		const { destination, push, listeners } = fakeDestination();
		renderHook(() => usePublishRemoteState(destination, channel));
		await waitFor(() => expect(handlers.has("remote://sessions")).toBe(true));
		emit("remote://sessions", [session(true)]);
		expect(remoteSetState).toHaveBeenCalledTimes(1);
		expect(vi.mocked(remoteSetState).mock.calls[0][0]).toMatchObject({
			status: "playing",
			position: 5,
			item: { id: "live-1", name: "News" },
		});
		act(() => push({ ...playingState, status: "paused", position: 9 }));
		expect(vi.mocked(remoteSetState).mock.calls[1][0]).toMatchObject({
			status: "paused",
			position: 9,
		});
		emit("remote://sessions", []);
		expect(listeners.size, "stops listening when no one is connected").toBe(0);
		vi.restoreAllMocks();
	});

	it("keeps going when the backend refuses a state", async () => {
		vi.mocked(remoteSetState).mockRejectedValue("not running");
		const { destination } = fakeDestination();
		vi.mocked(remoteSessions).mockResolvedValueOnce([session(true)]);
		renderHook(() => usePublishRemoteState(destination, null));
		await waitFor(() => expect(remoteSetState).toHaveBeenCalled());
		expect(vi.mocked(remoteSetState).mock.calls[0][0].item).toBeNull();
	});
});
