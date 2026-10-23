// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/**
 * The one interface every place video can play implements: this device's
 * mpv, a Google Cast receiver, an AirPlay route and another Cinette device.
 * The player's controls talk only to the active destination.
 */

import type { PlayRoute, RouteDecision } from "@/lib/route";
import type { Channel, PlayerState, PolledMpvState } from "@/lib/types";

export type DestinationKind = "local" | "cast" | "airplay" | "cinette";

/** Where a destination's channels and search come from. */
export type CatalogSource = { kind: "local" } | { kind: "remote"; deviceId: string };

/**
 * Something to play. Local mpv, Cast and AirPlay play a channel from this
 * device. Another Cinette device plays an item from its own catalog, known
 * here only by its id, never by a URL.
 */
export type PlaybackItem =
	| { kind: "local"; channel: Channel }
	/** An item of another device's catalog, with its series for an
	 *  episode, where that device names it. */
	| { kind: "remote"; itemId: string; title: string; seriesId?: string };

export type PlaybackStatus =
	"idle" | "opening" | "playing" | "paused" | "buffering" | "ended" | "error";

export interface Track {
	id: string;
	label: string;
	language?: string;
}

export interface PlaybackError {
	/** `openFailed`: the stream stopped before it ever played. `loadFailed`:
	 *  reconnecting ran out of tries. `refused`: the provider answered 401 or
	 *  403, so the login may have expired. `failed`: anything else. */
	code: "openFailed" | "loadFailed" | "refused" | "failed";
	message?: string;
}

export interface PlaybackState {
	status: PlaybackStatus;
	item: {
		title: string;
		contentType: Channel["contentType"];
		ref: string;
		/** For an episode, its series, where the destination knows it. */
		seriesId?: string;
	} | null;
	/** Seconds, as of `positionAt`. */
	position: number;
	/** `performance.now()` on this device when `position` was read. */
	positionAt: number;
	/** Seconds. 0 for live channels. */
	duration: number;
	volume: number;
	subtitles: Track[];
	subtitleId: string | null;
	audio: Track[];
	audioId: string | null;
	connection: "connected" | "reconnecting" | "lost";
	error: PlaybackError | null;
}

export interface PlaybackCapabilities {
	seek: boolean;
	pause: boolean;
	volume: "absolute" | "none";
	/** Picking one of the destination's own subtitle tracks. */
	subtitles: "select" | "none";
	/** Subtitle files this device downloads and draws, local only. */
	externalSubtitles: boolean;
	audioTracks: boolean;
	/** Loading at a start position. */
	resumeAt: boolean;
	/** The destination has a catalog of its own, as another Cinette device does. */
	catalog: boolean;
}

/** Where a destination is now: the last position it reported, moved on by
 *  the time since while it plays. */
export const positionNow = (state: PlaybackState, now: number): number => {
	if (state.status !== "playing") return state.position;
	const moved = state.position + Math.max(0, now - state.positionAt) / 1000;
	return state.duration > 0 ? Math.min(moved, state.duration) : moved;
};

/** What the player's controls show for a destination, and which of them
 *  it has. */
export interface DestinationControls {
	/** The state the controls show, with the position as of `now`. */
	player: PlayerState;
	/** It stopped: lost, failed, at the end, or idle with its item. Only the
	 *  ways out are left then. */
	over: boolean;
	pause: boolean;
	/** A seek bar and skips: it can seek and the item has a length. */
	seek: boolean;
	volume: boolean;
}

/** Maps a destination's state and capabilities to the player's controls at
 *  `now`. A control it can't carry out isn't offered. */
export const destinationControls = (
	state: PlaybackState,
	capabilities: PlaybackCapabilities,
	now: number
): DestinationControls => {
	const over =
		state.connection === "lost" ||
		state.error !== null ||
		state.status === "ended" ||
		state.status === "error" ||
		(state.status === "idle" && state.item !== null);
	const seek = !over && capabilities.seek && state.duration > 0;
	return {
		player: {
			isPlaying: state.status === "playing" || state.status === "buffering",
			isPaused: state.status === "paused",
			currentUrl: state.item?.ref ?? null,
			volume: state.volume,
			position: positionNow(state, now),
			// No length, no seek bar.
			duration: seek ? state.duration : 0,
		},
		over,
		pause: !over && capabilities.pause,
		seek,
		volume: !over && capabilities.volume === "absolute",
	};
};

/** What a destination's view says about where playback stands, or null
 *  while it plays. `failure` words an error's message where the destination
 *  has its own words for it. */
export const destinationStatus = (
	state: PlaybackState,
	name: string,
	failure: (message: string) => string = (message) => message
): string | null => {
	if (state.connection === "lost") return `Lost the connection to ${name}.`;
	if (state.error)
		return state.error.message ? failure(state.error.message) : `It stopped on ${name}.`;
	if (state.connection === "reconnecting") return "Reconnecting…";
	if (state.status === "opening") return `Starting on ${name}…`;
	if (state.status === "buffering") return "Buffering…";
	if (state.status === "ended") return "Finished.";
	return null;
};

/** A method a destination doesn't support rejects with this. */
export class UnsupportedError extends Error {
	readonly code = "unsupported";
	constructor(what: string) {
		super(`${what} isn't supported here`);
		this.name = "UnsupportedError";
	}
}

export interface PlaybackDestination {
	readonly id: string;
	readonly kind: DestinationKind;
	readonly name: string;
	readonly catalog: CatalogSource;
	/** What it can do with the current item, which can change with the item,
	 *  as `seek` does once a stream's length is known. A change always comes
	 *  with a new state, so a listener reads this again when it's called. */
	readonly capabilities: PlaybackCapabilities;

	/** How the item would reach this destination, or why it can't. Called
	 *  before `load`, so the UI can warn about a converted route first. */
	route(item: PlaybackItem): Promise<RouteDecision>;
	/** `route` is what `route()` gave for this item, so the destination plays
	 *  the format the UI warned about. `freed` says something on this device
	 *  just let go of the provider's stream, which a provider can count for
	 *  a moment after. Resolves once the item has started loading there, and
	 *  rejects if it couldn't. */
	load(
		item: PlaybackItem,
		opts?: { startAt?: number; route?: PlayRoute; freed?: boolean }
	): Promise<void>;
	play(): Promise<void>;
	pause(): Promise<void>;
	/** To an absolute position, in seconds. */
	seek(seconds: number): Promise<void>;
	setVolume(volume: number): Promise<void>;
	selectSubtitle(trackId: string | null): Promise<void>;
	selectAudio(trackId: string): Promise<void>;
	stop(): Promise<void>;
	/** Lets go of the provider's stream and keeps the session, so the
	 *  provider allows another connection, where the destination can.
	 *  Resolves to whether it let go of anything. */
	release?(): Promise<boolean>;
	/** Lets go of what it holds once it's done with, where it holds any. */
	dispose?(): void;
	/** Whether this device converts what plays there, where it can. */
	converted?(): boolean;

	/** The latest state. The same object until the state changes, so it
	 *  works with `useSyncExternalStore`. */
	getState(): PlaybackState;
	/** Called with every new state. Returns an unsubscribe function. */
	subscribe(listener: (state: PlaybackState) => void): () => void;
}

/** What `useMpv` reports that the local destination's state comes from. */
export interface LocalPlayerReport {
	state: PolledMpvState;
	error: string | null;
	opening: boolean;
	buffering: boolean;
	reconnecting: boolean;
	loadFailed: boolean;
	openFailed: boolean;
}

const localStatus = (report: LocalPlayerReport): PlaybackStatus => {
	const { state } = report;
	if (report.error !== null || report.loadFailed || report.openFailed) return "error";
	if (report.opening) return "opening";
	if (report.reconnecting || report.buffering) return "buffering";
	if (state.reachedEnd) return "ended";
	if (state.isPaused) return "paused";
	if (state.isPlaying) return "playing";
	return "idle";
};

const localError = (report: LocalPlayerReport): PlaybackError | null => {
	if (report.loadFailed) return { code: "loadFailed" };
	if (report.openFailed) return { code: "openFailed" };
	if (report.error !== null) return { code: "failed", message: report.error };
	return null;
};

/** The local player's state in the destination's terms. */
export const localPlaybackState = (
	report: LocalPlayerReport,
	channel: Channel | null
): PlaybackState => ({
	status: localStatus(report),
	item: channel
		? { title: channel.name, contentType: channel.contentType, ref: channel.id }
		: null,
	position: report.state.position,
	positionAt: report.state.positionAt,
	duration: report.state.duration,
	volume: report.state.volume,
	// mpv's own tracks aren't offered yet. Subtitles come from files the
	// app downloads, as `externalSubtitles` says.
	subtitles: [],
	subtitleId: null,
	audio: [],
	audioId: null,
	connection: "connected",
	error: localError(report),
});

/** What this device's player can do. Seeking needs a known length, so live
 *  channels can't seek. */
export const localCapabilities = (seekable: boolean): PlaybackCapabilities => ({
	seek: seekable,
	pause: true,
	volume: "absolute",
	subtitles: "none",
	externalSubtitles: true,
	audioTracks: false,
	resumeAt: true,
	catalog: false,
});

/** A destination as the device picker lists it. */
export interface DestinationSummary {
	id: string;
	kind: DestinationKind;
	name: string;
	/** For another Cinette device, its type from discovery, like `fire-tv`. */
	deviceType?: string;
}

const pickerRank = (d: DestinationSummary): number => {
	switch (d.kind) {
		case "local":
			return 0;
		case "cinette":
			return d.deviceType === "android-tv" || d.deviceType === "fire-tv" ? 1 : 2;
		case "cast":
			return 3;
		case "airplay":
			return 4;
	}
};

/**
 * The device picker's order: this device, then TVs running Cinette, which
 * play every format through mpv, then other Cinette devices, then Cast,
 * then AirPlay. Names sort within each group.
 */
export const orderDestinations = <T extends DestinationSummary>(list: readonly T[]): T[] =>
	[...list].sort(
		(a, b) =>
			pickerRank(a) - pickerRank(b) ||
			a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
			a.id.localeCompare(b.id)
	);
