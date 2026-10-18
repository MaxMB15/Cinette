// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/**
 * The one interface every place video can play implements: this device's
 * mpv, a Google Cast receiver, an AirPlay route and another Cinette device.
 * The player's controls talk only to the active destination.
 */

import type { PlayRoute, RouteDecision } from "@/lib/route";
import type { Channel, PolledMpvState } from "@/lib/types";

export type DestinationKind = "local" | "cast" | "airplay" | "cinette";

/** Where a destination's channels and search come from. */
export type CatalogSource = { kind: "local" } | { kind: "remote"; deviceId: string };

/**
 * Something to play. Local mpv, Cast and AirPlay play a channel from this
 * device. Another Cinette device plays an item from its own catalog, known
 * here only by its id, never by a URL.
 */
export type PlaybackItem =
	{ kind: "local"; channel: Channel } | { kind: "remote"; itemId: string; title: string };

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
	item: { title: string; contentType: Channel["contentType"]; ref: string } | null;
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
	readonly capabilities: PlaybackCapabilities;

	/** How the item would reach this destination, or why it can't. Called
	 *  before `load`, so the UI can warn about a converted route first. */
	route(item: PlaybackItem): Promise<RouteDecision>;
	/** `route` is what `route()` gave for this item, so the destination plays
	 *  the format the UI warned about. */
	load(item: PlaybackItem, opts?: { startAt?: number; route?: PlayRoute }): Promise<void>;
	play(): Promise<void>;
	pause(): Promise<void>;
	/** To an absolute position, in seconds. */
	seek(seconds: number): Promise<void>;
	setVolume(volume: number): Promise<void>;
	selectSubtitle(trackId: string | null): Promise<void>;
	selectAudio(trackId: string): Promise<void>;
	stop(): Promise<void>;

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
