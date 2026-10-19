// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
	applyRemoteCommand,
	getMountedPlayer,
	remotePlayerState,
	PLAYER_OPENS_WITHIN_MS,
	setMountedPlayer,
	waitForMountedPlayer,
	type CommandTarget,
	type RemoteCommand,
} from "./remote-target";
import {
	localCapabilities,
	UnsupportedError,
	type PlaybackCapabilities,
	type PlaybackDestination,
	type PlaybackState,
} from "./destination";
import type { Channel } from "./types";

const channel: Channel = {
	id: "p1-live-7",
	name: "News",
	url: "http://iptv.example/live/user/pass/7.ts",
	logoUrl: "https://logos.example/news.png",
	groupTitle: "UK",
	isFavorite: false,
	contentType: "live",
	sources: [],
};

const episode: Channel = {
	...channel,
	id: "xt-ep-9-s1-2",
	name: "Pilot",
	contentType: "series",
	logoUrl: undefined,
	seriesTitle: "The Show",
	season: 1,
	episode: 2,
};

const state = (overrides: Partial<PlaybackState> = {}): PlaybackState => ({
	status: "playing",
	item: { title: "News", contentType: "live", ref: channel.id },
	position: 100,
	positionAt: 1_000,
	duration: 0,
	volume: 70,
	subtitles: [{ id: "s1", label: "English" }],
	subtitleId: "s1",
	audio: [{ id: "a1", label: "Main", language: "en" }],
	audioId: "a1",
	connection: "connected",
	error: null,
	...overrides,
});

describe("remotePlayerState", () => {
	it("moves a playing position on by the time since it was read", () => {
		const remote = remotePlayerState(state(), channel, localCapabilities(false), 3_500);
		expect(remote.position).toBe(102.5);
	});

	it("leaves a paused position where it is", () => {
		const remote = remotePlayerState(
			state({ status: "paused" }),
			channel,
			localCapabilities(true),
			3_500
		);
		expect(remote.position).toBe(100);
	});

	it("never moves a position back for a clock read before the state", () => {
		const remote = remotePlayerState(state(), channel, localCapabilities(false), 500);
		expect(remote.position).toBe(100);
	});

	it("names the channel with only the fields a controller may see", () => {
		const remote = remotePlayerState(state(), channel, localCapabilities(false), 1_000);
		expect(remote.item).toStrictEqual({
			id: "p1-live-7",
			name: "News",
			contentType: "live",
			group: "UK",
			logoUrl: "https://logos.example/news.png",
			seriesTitle: null,
			season: null,
			episode: null,
			streamHosts: ["iptv.example"],
		});
		expect(JSON.stringify(remote)).not.toContain("pass");
	});

	it("names every host the item streams from, and skips what isn't a URL", () => {
		const backed = {
			...channel,
			url: "http://user:pass@Panel.Example:8080/live/1.ts",
			sources: ["http://backup.example/1.ts", "not a url", "file:///local/1.ts"],
		};
		const remote = remotePlayerState(state(), backed, localCapabilities(false), 0);
		expect(remote.item?.streamHosts).toStrictEqual(["panel.example", "backup.example"]);
		expect(JSON.stringify(remote)).not.toContain("pass");
	});

	it("names an episode's show, season and number", () => {
		const remote = remotePlayerState(
			state({ item: { title: "Pilot", contentType: "series", ref: episode.id } }),
			episode,
			localCapabilities(true),
			1_000
		);
		expect(remote.item).toMatchObject({
			logoUrl: null,
			seriesTitle: "The Show",
			season: 1,
			episode: 2,
		});
	});

	it("has no item when nothing plays, even with a channel picked", () => {
		const idle = state({ status: "idle", item: null });
		expect(remotePlayerState(idle, channel, localCapabilities(false), 0).item).toBeNull();
		expect(remotePlayerState(state(), null, localCapabilities(false), 0).item).toBeNull();
	});

	it("passes the rest of the state through", () => {
		const remote = remotePlayerState(
			state({ status: "buffering", duration: 3_600 }),
			channel,
			localCapabilities(true),
			1_000
		);
		expect(remote).toMatchObject({
			status: "buffering",
			duration: 3_600,
			volume: 70,
			subtitles: [{ id: "s1", label: "English" }],
			subtitleId: "s1",
			audio: [{ id: "a1", label: "Main", language: "en" }],
			audioId: "a1",
			error: null,
		});
	});

	it("turns the capabilities into the protocol's flags", () => {
		const caps: PlaybackCapabilities = {
			seek: true,
			pause: false,
			volume: "absolute",
			subtitles: "select",
			externalSubtitles: true,
			audioTracks: true,
			resumeAt: false,
			catalog: false,
		};
		expect(remotePlayerState(state(), channel, caps, 1_000).capabilities).toStrictEqual({
			pause: false,
			seek: true,
			volume: true,
			subtitles: true,
			audioTracks: true,
			resumeAt: false,
		});
		const none = { ...caps, volume: "none" as const, subtitles: "none" as const };
		const remote = remotePlayerState(state(), channel, none, 1_000);
		expect(remote.capabilities.volume).toBe(false);
		expect(remote.capabilities.subtitles).toBe(false);
		expect(remote.volume, "no volume where it can't be set").toBeNull();
	});

	it("sends an error's code and never its message", () => {
		const withMessage = state({
			status: "error",
			error: { code: "failed", message: "http://iptv.example/user/pass/1.ts ended" },
		});
		expect(remotePlayerState(withMessage, channel, localCapabilities(false), 0).error).toBe(
			"failed"
		);
		const bare = state({ status: "error", error: { code: "refused" } });
		expect(remotePlayerState(bare, channel, localCapabilities(false), 0).error).toBe("refused");
	});
});

const fakePlayer = (current: PlaybackState = state()) => {
	const player = {
		load: vi.fn(() => Promise.resolve()),
		play: vi.fn(() => Promise.resolve()),
		pause: vi.fn(() => Promise.resolve()),
		seek: vi.fn<(seconds: number) => Promise<void>>(() => Promise.resolve()),
		setVolume: vi.fn<(volume: number) => Promise<void>>(() => Promise.resolve()),
		selectSubtitle: vi.fn<(trackId: string | null) => Promise<void>>(() => Promise.resolve()),
		selectAudio: vi.fn<(trackId: string) => Promise<void>>(() => Promise.resolve()),
		stop: vi.fn(() => Promise.resolve()),
		getState: () => current,
	};
	return player;
};

const target = (player: ReturnType<typeof fakePlayer> | null) => ({
	player: player as unknown as PlaybackDestination | null,
	findChannel: (id: string) => [channel, episode].find((c) => c.id === id),
	openPlayer: vi.fn<CommandTarget["openPlayer"]>(),
	waitForPlayer: vi.fn<CommandTarget["waitForPlayer"]>(async () => ({
		load: () => Promise.reject(new Error("not open")),
	})),
	stopWithoutPlayer: vi.fn<CommandTarget["stopWithoutPlayer"]>(() => Promise.resolve()),
});

describe("applyRemoteCommand", () => {
	afterEach(() => vi.restoreAllMocks());

	it("loads a channel on the open player at the start asked for", async () => {
		const player = fakePlayer();
		const t = target(player);
		const load: RemoteCommand = { action: "load", itemId: episode.id, startAt: 42 };
		await expect(applyRemoteCommand(load, t)).resolves.toBe("ok");
		expect(player.load).toHaveBeenCalledWith(
			{ kind: "local", channel: episode },
			{ startAt: 42 }
		);
		expect(t.openPlayer).not.toHaveBeenCalled();
	});

	it("opens the player for a load when none is open, and loads it there", async () => {
		const opened = fakePlayer();
		const t = target(null);
		t.waitForPlayer.mockResolvedValue(opened as unknown as PlaybackDestination);
		const load: RemoteCommand = { action: "load", itemId: channel.id, startAt: 5 };
		await expect(applyRemoteCommand(load, t)).resolves.toBe("ok");
		expect(t.openPlayer).toHaveBeenCalledTimes(1);
		expect(opened.load).toHaveBeenCalledWith({ kind: "local", channel }, { startAt: 5 });
	});

	it("fails a load when the player page doesn't open", async () => {
		const t = target(null);
		await expect(applyRemoteCommand({ action: "load", itemId: channel.id }, t)).resolves.toBe(
			"failed"
		);
		expect(t.openPlayer).toHaveBeenCalledTimes(1);
	});

	it("says a load of something this device doesn't have isn't found", async () => {
		const player = fakePlayer();
		const t = target(player);
		await expect(applyRemoteCommand({ action: "load", itemId: "nope" }, t)).resolves.toBe(
			"notFound"
		);
		expect(player.load).not.toHaveBeenCalled();
		expect(t.openPlayer).not.toHaveBeenCalled();
		expect(t.waitForPlayer).not.toHaveBeenCalled();
	});

	it("stops the open player, or mpv when no player page is open", async () => {
		const player = fakePlayer();
		const open = target(player);
		await expect(applyRemoteCommand({ action: "stop" }, open)).resolves.toBe("ok");
		expect(player.stop).toHaveBeenCalledTimes(1);
		expect(open.stopWithoutPlayer).not.toHaveBeenCalled();
		// Back leaves mpv playing, so a stop with no page stops it there.
		const closed = target(null);
		await expect(applyRemoteCommand({ action: "stop" }, closed)).resolves.toBe("ok");
		expect(closed.stopWithoutPlayer).toHaveBeenCalledTimes(1);
		closed.stopWithoutPlayer.mockRejectedValueOnce(new Error("mpv"));
		await expect(applyRemoteCommand({ action: "stop" }, closed)).resolves.toBe("failed");
	});

	it("fails other commands when no player is open", async () => {
		for (const command of [
			{ action: "play", itemId: channel.id },
			{ action: "volume", value: 10 },
		] satisfies RemoteCommand[]) {
			await expect(applyRemoteCommand(command, target(null))).resolves.toBe("failed");
		}
	});

	it("refuses a command about an item that's no longer playing", async () => {
		const player = fakePlayer();
		await expect(
			applyRemoteCommand({ action: "pause", itemId: "other" }, target(player))
		).resolves.toBe("staleItem");
		expect(player.pause).not.toHaveBeenCalled();
		const idle = fakePlayer(state({ item: null }));
		await expect(
			applyRemoteCommand({ action: "play", itemId: channel.id }, target(idle))
		).resolves.toBe("staleItem");
	});

	it("passes play, pause, volume and tracks to the player", async () => {
		const player = fakePlayer();
		const t = target(player);
		const id = channel.id;
		expect(await applyRemoteCommand({ action: "play", itemId: id }, t)).toBe("ok");
		expect(await applyRemoteCommand({ action: "pause", itemId: id }, t)).toBe("ok");
		expect(await applyRemoteCommand({ action: "volume", value: 35 }, t)).toBe("ok");
		expect(await applyRemoteCommand({ action: "subtitle", itemId: id, trackId: null }, t)).toBe(
			"ok"
		);
		expect(await applyRemoteCommand({ action: "audio", itemId: id, trackId: "a2" }, t)).toBe(
			"ok"
		);
		expect(player.play).toHaveBeenCalledTimes(1);
		expect(player.pause).toHaveBeenCalledTimes(1);
		expect(player.setVolume).toHaveBeenCalledWith(35);
		expect(player.selectSubtitle).toHaveBeenCalledWith(null);
		expect(player.selectAudio).toHaveBeenCalledWith("a2");
	});

	it("seeks to a position, kept inside the item", async () => {
		const player = fakePlayer(state({ status: "paused", duration: 600 }));
		const t = target(player);
		const id = channel.id;
		await applyRemoteCommand({ action: "seek", itemId: id, to: 250 }, t);
		await applyRemoteCommand({ action: "seek", itemId: id, to: 900 }, t);
		await applyRemoteCommand({ action: "seek", itemId: id, to: -5 }, t);
		await applyRemoteCommand({ action: "seek", itemId: id, to: 600 }, t);
		expect(player.seek.mock.calls.map(([s]) => s)).toEqual([250, 600, 0, 600]);
	});

	it("seeks by an amount from where a paused player is", async () => {
		const player = fakePlayer(state({ status: "paused", duration: 600 }));
		const t = target(player);
		await applyRemoteCommand({ action: "seek", itemId: channel.id, by: -30 }, t);
		await applyRemoteCommand({ action: "seek", itemId: channel.id }, t);
		expect(player.seek.mock.calls.map(([s]) => s)).toEqual([70, 100]);
	});

	it("seeks by an amount from where a playing player has got to", async () => {
		vi.spyOn(performance, "now").mockReturnValue(5_000);
		const player = fakePlayer(state({ status: "playing", duration: 0 }));
		await applyRemoteCommand({ action: "seek", itemId: channel.id, by: 10 }, target(player));
		expect(player.seek).toHaveBeenCalledWith(114);
	});

	it("doesn't count time from a clock read before the state", async () => {
		vi.spyOn(performance, "now").mockReturnValue(0);
		const player = fakePlayer(state({ status: "playing" }));
		await applyRemoteCommand({ action: "seek", itemId: channel.id, by: 10 }, target(player));
		expect(player.seek).toHaveBeenCalledWith(110);
	});

	it("says unsupported when the player rejects with that code", async () => {
		const player = fakePlayer();
		player.selectAudio.mockRejectedValue(new UnsupportedError("Choosing an audio track"));
		await expect(
			applyRemoteCommand(
				{ action: "audio", itemId: channel.id, trackId: "a2" },
				target(player)
			)
		).resolves.toBe("unsupported");
	});

	it("says failed for any other rejection", async () => {
		const player = fakePlayer();
		player.play.mockRejectedValue(new Error("mpv went away"));
		player.load.mockRejectedValue(null);
		const t = target(player);
		expect(await applyRemoteCommand({ action: "play", itemId: channel.id }, t)).toBe("failed");
		expect(await applyRemoteCommand({ action: "load", itemId: channel.id }, t)).toBe("failed");
	});
});

describe("the mounted player", () => {
	it("is whatever was set last", () => {
		expect(getMountedPlayer()).toBeNull();
		const player = fakePlayer() as unknown as PlaybackDestination;
		setMountedPlayer(player);
		expect(getMountedPlayer()).toBe(player);
		setMountedPlayer(null);
		expect(getMountedPlayer()).toBeNull();
	});

	it("is waited for until a page registers one", async () => {
		const player = fakePlayer() as unknown as PlaybackDestination;
		const first = waitForMountedPlayer();
		const second = waitForMountedPlayer();
		setMountedPlayer(null);
		setMountedPlayer(player);
		await expect(first).resolves.toBe(player);
		await expect(second).resolves.toBe(player);
		await expect(waitForMountedPlayer(), "one open already").resolves.toBe(player);
		setMountedPlayer(null);
	});

	it("loads nothing when no page registers one in time", async () => {
		vi.useFakeTimers();
		try {
			const waited = waitForMountedPlayer();
			vi.advanceTimersByTime(PLAYER_OPENS_WITHIN_MS - 1);
			const player = fakePlayer() as unknown as PlaybackDestination;
			const early = waitForMountedPlayer();
			vi.advanceTimersByTime(1);
			const none = await waited;
			await expect(none.load({ kind: "local", channel })).rejects.toThrow();
			// A page that opens later goes only to those still waiting.
			setMountedPlayer(player);
			await expect(early).resolves.toBe(player);
			setMountedPlayer(null);
		} finally {
			vi.useRealTimers();
		}
	});

	it("waits for the next page, not one that came and went before", async () => {
		vi.useFakeTimers();
		try {
			const first = fakePlayer() as unknown as PlaybackDestination;
			const waited = waitForMountedPlayer();
			setMountedPlayer(first);
			await expect(waited).resolves.toBe(first);
			setMountedPlayer(null);
			const again = waitForMountedPlayer();
			let got: Pick<PlaybackDestination, "load"> | undefined;
			void again.then((p) => (got = p));
			await vi.advanceTimersByTimeAsync(1);
			expect(got, "the old page is gone").toBeUndefined();
			const second = fakePlayer() as unknown as PlaybackDestination;
			setMountedPlayer(second);
			await expect(again).resolves.toBe(second);
			setMountedPlayer(null);
		} finally {
			vi.useRealTimers();
		}
	});
});
