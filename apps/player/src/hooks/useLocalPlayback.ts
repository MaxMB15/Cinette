// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useMemo, useState } from "react";
import type { useMpv } from "@/hooks/useMpv";
import { useLatestRef } from "@/hooks/useLatestRef";
import {
	localCapabilities,
	localPlaybackState,
	UnsupportedError,
	type PlaybackDestination,
	type PlaybackState,
} from "@/lib/destination";
import type { Channel } from "@/lib/types";

/** The parts of `useMpv` the local destination wraps. */
export type LocalPlayer = Pick<
	ReturnType<typeof useMpv>,
	| "state"
	| "error"
	| "opening"
	| "buffering"
	| "reconnecting"
	| "loadFailed"
	| "openFailed"
	| "play"
	| "pause"
	| "seek"
	| "setVolume"
	| "stop"
>;

/**
 * This device's mpv as a {@link PlaybackDestination}. Every method but
 * `load` does what the matching `useMpv` function does. `load` goes through
 * `loadChannel`, the player's own way of starting an item, so a download is
 * preferred and the play is recorded. It resolves once mpv has opened the
 * item and rejects if it couldn't. `channel` is what's playing, for the
 * state's item.
 *
 * The destination stays the same object until what it can do changes, as
 * `seek` does once a stream's length is known. Its state comes from React,
 * so `getState` gives the state as of the last commit. The player's own
 * components read `useMpv`'s state, which is current while they render.
 */
export const useLocalPlayback = (
	player: LocalPlayer,
	channel: Channel | null,
	loadChannel: (channel: Channel, startAt?: number) => Promise<void>
): PlaybackDestination => {
	const {
		state: mpvState,
		error,
		opening,
		buffering,
		reconnecting,
		loadFailed,
		openFailed,
	} = player;
	const state = useMemo(
		() =>
			localPlaybackState(
				{
					state: mpvState,
					error,
					opening,
					buffering,
					reconnecting,
					loadFailed,
					openFailed,
				},
				channel
			),
		[mpvState, error, opening, buffering, reconnecting, loadFailed, openFailed, channel]
	);
	const stateRef = useLatestRef<PlaybackState>(state);
	// The player makes a new loadChannel on every render, and load only
	// runs from handlers, so it reads the newest one.
	const loadRef = useLatestRef(loadChannel);
	const [listeners] = useState(() => new Set<(state: PlaybackState) => void>());
	useEffect(() => {
		for (const listener of listeners) listener(state);
	}, [state, listeners]);

	const { play, pause, seek, setVolume, stop } = player;
	const seekable = mpvState.duration > 0;
	return useMemo<PlaybackDestination>(
		() => ({
			id: "local",
			kind: "local",
			name: "This device",
			catalog: { kind: "local" },
			capabilities: localCapabilities(seekable),
			// mpv plays everything this device's catalog holds.
			route: async (item) =>
				item.kind === "local"
					? { ok: true, route: { via: "local" } }
					: { ok: false, reason: "notFound" },
			load: async (item, opts) => {
				if (item.kind !== "local")
					throw new UnsupportedError("Playing another device's item");
				await loadRef.current(item.channel, opts?.startAt);
			},
			play,
			pause,
			seek,
			setVolume,
			stop,
			selectSubtitle: () => Promise.reject(new UnsupportedError("Choosing a subtitle track")),
			selectAudio: () => Promise.reject(new UnsupportedError("Choosing an audio track")),
			getState: () => stateRef.current,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		}),
		[seekable, loadRef, play, pause, seek, setVolume, stop, stateRef, listeners]
	);
};
