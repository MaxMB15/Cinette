// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { vi } from "vitest";
import type { PlaybackCapabilities, PlaybackDestination, PlaybackState } from "@/lib/destination";

/** A movie playing 10 minutes in, as a destination reports it. */
export const playbackState = (patch: Partial<PlaybackState> = {}): PlaybackState => ({
	status: "playing",
	item: { title: "A Film", contentType: "movie", ref: "mv1" },
	position: 600,
	positionAt: performance.now(),
	duration: 5400,
	volume: 40,
	subtitles: [],
	subtitleId: null,
	audio: [],
	audioId: null,
	connection: "connected",
	error: null,
	...patch,
});

/** A destination that can seek, pause, set the volume and resume. */
export const playbackCapabilities = (
	patch: Partial<PlaybackCapabilities> = {}
): PlaybackCapabilities => ({
	seek: true,
	pause: true,
	volume: "absolute",
	subtitles: "none",
	externalSubtitles: false,
	audioTracks: false,
	resumeAt: true,
	catalog: false,
	...patch,
});

/**
 * A destination whose commands are mocks. It keeps `state` until a test
 * sets another, with `set`, which tells its listeners as a real one does,
 * or with `getState.mockReturnValue`, which doesn't.
 */
export const fakeDestination = <K extends PlaybackDestination["kind"]>(
	kind: K,
	name: string,
	state = playbackState(),
	capabilities = playbackCapabilities()
) => {
	const listeners = new Set<(state: PlaybackState) => void>();
	const done = () => Promise.resolve();
	const getState = vi.fn<() => PlaybackState>().mockReturnValue(state);
	return {
		id: `${kind}:tv`,
		kind,
		name,
		catalog: { kind: "local" as const },
		capabilities,
		route: vi.fn(),
		load: vi.fn<PlaybackDestination["load"]>(done),
		play: vi.fn<() => Promise<void>>(done),
		pause: vi.fn<() => Promise<void>>(done),
		seek: vi.fn<(to: number) => Promise<void>>(done),
		setVolume: vi.fn<(volume: number) => Promise<void>>(done),
		selectSubtitle: vi.fn<(id: string | null) => Promise<void>>(done),
		selectAudio: vi.fn<(id: string) => Promise<void>>(done),
		stop: vi.fn<() => Promise<void>>(done),
		getState,
		subscribe: (listener: (state: PlaybackState) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		set: (next: PlaybackState) => {
			getState.mockReturnValue(next);
			for (const listener of listeners) listener(next);
		},
	};
};
