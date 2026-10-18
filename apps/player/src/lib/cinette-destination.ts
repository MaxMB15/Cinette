// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/**
 * Another Cinette device as a {@link PlaybackDestination}. It plays items
 * from its own catalog, known here only by their ids, with its own mpv, so
 * every format plays there. Its state comes from the `remote://state`
 * messages the Rust side passes on, newest first already.
 */

import type {
	PlaybackCapabilities,
	PlaybackDestination,
	PlaybackError,
	PlaybackState,
	PlaybackStatus,
	Track,
} from "@/lib/destination";
import { UnsupportedError } from "@/lib/destination";
import type { RemoteCommand } from "@/lib/remote-target";
import type { Channel } from "@/lib/types";

/** One item of the other device's catalog. */
export interface CatalogItem {
	id: string;
	name: string;
	contentType: string;
	group: string;
	logo?: string;
	seriesTitle?: string;
	season?: number;
	episode?: number;
	nowPlaying?: string;
}

/** The other device's state, as its player reports it. */
export interface RemoteSnapshot {
	status: PlaybackStatus;
	item: CatalogItem | null;
	position: number;
	duration: number;
	volume: number | null;
	subtitles: Track[];
	subtitleId: string | null;
	audio: Track[];
	audioId: string | null;
	capabilities: {
		pause: boolean;
		seek: boolean;
		volume: boolean;
		subtitles: boolean;
		audioTracks: boolean;
		resumeAt: boolean;
	};
	/** A playback error's code; one from a newer Cinette reads as "unknown". */
	error: string | null;
}

/** Where the connection to the other device stands. */
export type LinkPhase =
	| { phase: "connecting" }
	| { phase: "verifying"; code: string; name: string }
	| { phase: "pending"; expiresInMs: number }
	| { phase: "connected" }
	| { phase: "reconnecting"; attempt: number }
	| { phase: "closed"; reason: LinkEnded };

/** Why a connection ended: the other device's reason, or one of these. */
export type LinkEnded = { target: string } | "unreachable" | "lost" | "left";

/** The content types besides live, which is what anything else shows as. */
const contentTypes: readonly Channel["contentType"][] = ["movie", "series", "recording"];

const contentTypeOf = (t: string): Channel["contentType"] =>
	contentTypes.find((known) => known === t) ?? "live";

/** The error codes besides failed, which is what anything else shows as. */
const errorCodes: readonly PlaybackError["code"][] = ["openFailed", "loadFailed", "refused"];

const errorCodeOf = (code: string): PlaybackError["code"] =>
	errorCodes.find((known) => known === code) ?? "failed";

/** The other device's state in the destination's terms. `at` is
 *  `performance.now()` when it arrived. */
export const remotePlaybackState = (
	snapshot: RemoteSnapshot,
	connection: PlaybackState["connection"],
	at: number
): PlaybackState => {
	const error: PlaybackError | null = snapshot.error
		? { code: errorCodeOf(snapshot.error) }
		: null;
	return {
		status: snapshot.status,
		item: snapshot.item
			? {
					title: snapshot.item.name,
					contentType: contentTypeOf(snapshot.item.contentType),
					ref: snapshot.item.id,
				}
			: null,
		position: snapshot.position,
		positionAt: at,
		duration: snapshot.duration,
		volume: snapshot.volume ?? 0,
		subtitles: snapshot.subtitles,
		subtitleId: snapshot.subtitleId,
		audio: snapshot.audio,
		audioId: snapshot.audioId,
		connection,
		error,
	};
};

/** How a connection in this phase shows in the player. */
export const connectionOf = (phase: LinkPhase): PlaybackState["connection"] => {
	switch (phase.phase) {
		case "connected":
			return "connected";
		case "closed":
			return "lost";
		default:
			return "reconnecting";
	}
};

/** What the other device's player can do now. */
export const remoteCapabilities = (snapshot: RemoteSnapshot): PlaybackCapabilities => ({
	seek: snapshot.capabilities.seek,
	pause: snapshot.capabilities.pause,
	volume: snapshot.capabilities.volume ? "absolute" : "none",
	subtitles: snapshot.capabilities.subtitles ? "select" : "none",
	// Subtitle files are this device's; the other one has its own.
	externalSubtitles: false,
	audioTracks: snapshot.capabilities.audioTracks,
	resumeAt: snapshot.capabilities.resumeAt,
	catalog: true,
});

const nothingPlaying: RemoteSnapshot = {
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
};

/** Sends one command, resolving once the other device carried it out, with
 *  its state version then. */
export type SendCommand = (command: RemoteCommand) => Promise<unknown>;

/** The other device's state, with the version that orders it. */
export interface VersionedSnapshot {
	epoch: string;
	version: number;
	state: RemoteSnapshot;
}

/** A command the other device, or the link to it, turned down. `code` is
 *  the protocol's, like `stale_item`, or `notConnected`, `timedOut` or `busy`. */
export class RemoteCommandError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(`The other device didn't carry it out: ${code}`);
		this.name = "RemoteCommandError";
		this.code = code;
	}
}

/** What a rejected command becomes: the destination's own error for what
 *  isn't supported there, and a {@link RemoteCommandError} for the rest. */
export const commandError = (e: unknown): Error => {
	const code = typeof e === "string" ? e : "failed";
	return code === "unsupported"
		? new UnsupportedError("That on the other device")
		: new RemoteCommandError(code);
};

/** A destination for another Cinette device, and the way to feed it. */
export interface CinetteDestination extends PlaybackDestination {
	/** A newer state from the other device. */
	receive(snapshot: VersionedSnapshot, at: number): void;
	/** The connection moved on. */
	setPhase(phase: LinkPhase): void;
}

/**
 * The destination for the device `deviceId`, called `name`. Commands go
 * out through `send`. A command about the item playing names it, so the
 * other device refuses it if the item changed meanwhile.
 */
export const createCinetteDestination = (
	deviceId: string,
	name: string,
	send: SendCommand
): CinetteDestination => {
	let snapshot = nothingPlaying;
	let capabilities = remoteCapabilities(snapshot);
	// Not connected yet.
	let connection: PlaybackState["connection"] = "reconnecting";
	let arrived = 0;
	let state = remotePlaybackState(snapshot, connection, arrived);
	const listeners = new Set<(state: PlaybackState) => void>();
	const publish = () => {
		state = remotePlaybackState(snapshot, connection, arrived);
		for (const listener of listeners) listener(state);
	};
	const sent = async (command: RemoteCommand): Promise<unknown> => {
		try {
			return await send(command);
		} catch (e) {
			throw commandError(e);
		}
	};
	const current = (): string => {
		const id = snapshot.item?.id;
		if (id === undefined) throw new UnsupportedError("Controlling nothing");
		return id;
	};
	const run = async (command: () => RemoteCommand): Promise<void> => {
		await sent(command());
	};
	return {
		id: `cinette:${deviceId}`,
		kind: "cinette",
		name,
		catalog: { kind: "remote", deviceId },
		get capabilities() {
			return capabilities;
		},
		route: async (item) =>
			item.kind === "remote"
				? { ok: true, route: { via: "cinette" } }
				: { ok: false, reason: "notFound" },
		load: async (item, opts) => {
			if (item.kind !== "remote")
				throw new UnsupportedError("Playing this device's channel on another device");
			const startAt = opts?.startAt;
			await sent(
				startAt === undefined
					? { action: "load", itemId: item.itemId }
					: { action: "load", itemId: item.itemId, startAt }
			);
			// It's opening there now. Until that device's next state says
			// more, this one names the new item, so a command right after
			// names it too.
			snapshot = {
				...snapshot,
				status: "opening",
				// Stryker disable next-line StringLiteral: an empty type reads as live too, and the group shows nowhere.
				item: { id: item.itemId, name: item.title, contentType: "live", group: "" },
				position: startAt ?? 0,
				duration: 0,
				error: null,
			};
			arrived = performance.now();
			publish();
		},
		play: () => run(() => ({ action: "play", itemId: current() })),
		pause: () => run(() => ({ action: "pause", itemId: current() })),
		seek: (seconds) => run(() => ({ action: "seek", itemId: current(), to: seconds })),
		setVolume: (volume) => run(() => ({ action: "volume", value: Math.round(volume) })),
		selectSubtitle: (trackId) =>
			run(() => ({ action: "subtitle", itemId: current(), trackId })),
		selectAudio: (trackId) => run(() => ({ action: "audio", itemId: current(), trackId })),
		stop: () => run(() => ({ action: "stop" })),
		getState: () => state,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		receive: (next, at) => {
			snapshot = next.state;
			const now = remoteCapabilities(snapshot);
			// The same object until something in it changes.
			if (JSON.stringify(now) !== JSON.stringify(capabilities)) capabilities = now;
			arrived = at;
			publish();
		},
		setPhase: (next) => {
			const changed = connectionOf(next);
			if (changed === connection) return;
			connection = changed;
			publish();
		},
	};
};
