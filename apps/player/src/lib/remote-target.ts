// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/**
 * This device as a remote-control target: carrying out the commands other
 * Cinette devices send, and describing what plays for them.
 *
 * The Rust side has already checked each command against the last state it
 * sent (the item, the numbers, the capabilities), so these helpers only
 * carry it out.
 */

import type {
	PlaybackCapabilities,
	PlaybackDestination,
	PlaybackError,
	PlaybackState,
} from "@/lib/destination";
import type { Channel } from "@/lib/types";

/** A command from a controller, as `remote://command` carries it. */
export type RemoteCommand =
	| { action: "load"; itemId: string; startAt?: number }
	| { action: "play"; itemId: string }
	| { action: "pause"; itemId: string }
	| { action: "seek"; itemId: string; to?: number; by?: number }
	| { action: "volume"; value: number }
	| { action: "subtitle"; itemId: string; trackId: string | null }
	| { action: "audio"; itemId: string; trackId: string }
	| { action: "stop" };

/** What the player answers, for `remote_finish_command`. */
export type CommandOutcome = "ok" | "staleItem" | "unsupported" | "notFound" | "failed";

/** The player's state as `remote_set_state` takes it. */
export interface RemotePlayerState {
	status: PlaybackState["status"];
	item: {
		id: string;
		name: string;
		contentType: Channel["contentType"];
		group: string;
		logoUrl: string | null;
		seriesTitle: string | null;
		season: number | null;
		episode: number | null;
		/** The hosts it streams from. Rust only uses them to drop a logo on
		 *  the same site; they never go to a controller. */
		streamHosts: string[];
	} | null;
	position: number;
	duration: number;
	volume: number | null;
	subtitles: PlaybackState["subtitles"];
	subtitleId: string | null;
	audio: PlaybackState["audio"];
	audioId: string | null;
	capabilities: {
		pause: boolean;
		seek: boolean;
		volume: boolean;
		subtitles: boolean;
		audioTracks: boolean;
		resumeAt: boolean;
	};
	error: PlaybackError["code"] | null;
}

/**
 * The state controllers see. `now` is `performance.now()`, so a playing
 * position moves on by the time since it was read.
 */
export const remotePlayerState = (
	state: PlaybackState,
	channel: Channel | null,
	capabilities: PlaybackCapabilities,
	now: number
): RemotePlayerState => {
	const moving = state.status === "playing";
	const position = moving
		? state.position + Math.max(0, now - state.positionAt) / 1000
		: state.position;
	return {
		status: state.status,
		item:
			channel && state.item
				? {
						id: channel.id,
						name: channel.name,
						contentType: channel.contentType,
						group: channel.groupTitle,
						logoUrl: channel.logoUrl ?? null,
						seriesTitle: channel.seriesTitle ?? null,
						season: channel.season ?? null,
						episode: channel.episode ?? null,
						streamHosts: hostsOf([channel.url, ...channel.sources]),
					}
				: null,
		position,
		duration: state.duration,
		volume: capabilities.volume === "absolute" ? state.volume : null,
		subtitles: state.subtitles,
		subtitleId: state.subtitleId,
		audio: state.audio,
		audioId: state.audioId,
		capabilities: {
			pause: capabilities.pause,
			seek: capabilities.seek,
			volume: capabilities.volume === "absolute",
			subtitles: capabilities.subtitles === "select",
			audioTracks: capabilities.audioTracks,
			resumeAt: capabilities.resumeAt,
		},
		// Only the code: the player's message can hold a stream's address.
		error: state.error?.code ?? null,
	};
};

/** What a player sends when it closes: nothing playing, nothing to do. */
export const IDLE_REMOTE_STATE: RemotePlayerState = {
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

/** The hosts of `urls`, leaving out what isn't a URL. */
const hostsOf = (urls: string[]): string[] =>
	urls.flatMap((url) => {
		try {
			const { hostname } = new URL(url);
			return hostname ? [hostname.toLowerCase()] : [];
		} catch {
			return [];
		}
	});

/** What carrying out a command needs. */
export interface CommandTarget {
	/** The mounted player's destination, or null when no player is open. */
	player: PlaybackDestination | null;
	/** This device's channel with this id, if it has one. */
	findChannel: (id: string) => Channel | undefined;
	/** Opens the player page when none is open. */
	openPlayer: () => void;
	/** The player's destination once the page has opened, or one whose
	 *  load fails if it didn't in time. */
	waitForPlayer: () => Promise<Pick<PlaybackDestination, "load">>;
	/** Stops mpv when no player page is open. Leaving the page with Back
	 *  keeps it playing. */
	stopWithoutPlayer: () => Promise<void>;
}

const outcomeOf = async (run: () => Promise<void>): Promise<CommandOutcome> => {
	try {
		await run();
		return "ok";
	} catch (e) {
		return (e as { code?: string } | null)?.code === "unsupported" ? "unsupported" : "failed";
	}
};

/** Carries out one command on this device's player. */
export const applyRemoteCommand = async (
	command: RemoteCommand,
	target: CommandTarget
): Promise<CommandOutcome> => {
	const { player } = target;
	if (command.action === "load") {
		const channel = target.findChannel(command.itemId);
		if (!channel) return "notFound";
		// The open page plays it, so it goes in this device's history and
		// starts where the controller asked.
		let destination: Pick<PlaybackDestination, "load"> | null = player;
		if (!destination) {
			target.openPlayer();
			destination = await target.waitForPlayer();
		}
		const opened = destination;
		const startAt = command.startAt;
		return outcomeOf(() => opened.load({ kind: "local", channel }, { startAt }));
	}
	if (command.action === "stop") {
		// mpv can play on after its page closed, so stop it either way.
		return outcomeOf(() => (player ? player.stop() : target.stopWithoutPlayer()));
	}
	if (!player) return "failed";
	if (command.action !== "volume" && player.getState().item?.ref !== command.itemId)
		return "staleItem";
	switch (command.action) {
		case "play":
			return outcomeOf(() => player.play());
		case "pause":
			return outcomeOf(() => player.pause());
		case "seek": {
			const state = player.getState();
			// A relative seek counts from where the player is now.
			const elapsed =
				state.status === "playing"
					? Math.max(0, performance.now() - state.positionAt) / 1000
					: 0;
			const to = command.to ?? state.position + elapsed + (command.by ?? 0);
			const end = state.duration > 0 ? state.duration : Number.POSITIVE_INFINITY;
			return outcomeOf(() => player.seek(Math.min(Math.max(0, to), end)));
		}
		case "volume":
			return outcomeOf(() => player.setVolume(command.value));
		case "subtitle":
			return outcomeOf(() => player.selectSubtitle(command.trackId));
		case "audio":
			return outcomeOf(() => player.selectAudio(command.trackId));
	}
};

let mountedPlayer: PlaybackDestination | null = null;

/** What the pages that open next resolve, for whoever waits for one. */
let next: {
	opened: Promise<PlaybackDestination>;
	resolve: (p: PlaybackDestination) => void;
} | null = null;

/** The player page registers its destination while it's open. */
export const setMountedPlayer = (player: PlaybackDestination | null): void => {
	mountedPlayer = player;
	if (player && next) {
		next.resolve(player);
		next = null;
	}
};

/** How long a page that's opening has to register its player. */
export const PLAYER_OPENS_WITHIN_MS = 5_000;

/** Stands in for a player page that didn't open: nothing loads. */
const noPlayer: Pick<PlaybackDestination, "load"> = {
	load: () => Promise.reject(new Error()),
};

/** The player's destination as soon as a page registers one, or after
 *  {@link PLAYER_OPENS_WITHIN_MS} one that loads nothing. */
export const waitForMountedPlayer = (): Promise<Pick<PlaybackDestination, "load">> => {
	if (mountedPlayer) return Promise.resolve(mountedPlayer);
	if (!next) {
		let resolve: (p: PlaybackDestination) => void = () => {};
		const opened = new Promise<PlaybackDestination>((r) => (resolve = r));
		next = { opened, resolve };
	}
	const late = new Promise<typeof noPlayer>((r) =>
		setTimeout(() => r(noPlayer), PLAYER_OPENS_WITHIN_MS)
	);
	return Promise.race([next.opened, late]);
};

/** The open player's destination, or null. */
export const getMountedPlayer = (): PlaybackDestination | null => mountedPlayer;
