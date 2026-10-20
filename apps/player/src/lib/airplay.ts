// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/**
 * An AirPlay receiver as a {@link PlaybackDestination}. AVPlayer plays on
 * it while mpv is stopped. Apps can't list AirPlay receivers, so the user
 * picks one in the system picker and this only ever knows its name.
 *
 * The stream URL stays in the backend: a load names the format by its
 * place in `getStreamFormats`' list and that list's generation.
 */

import {
	UnsupportedError,
	type PlaybackCapabilities,
	type PlaybackDestination,
	type PlaybackError,
	type PlaybackItem,
	type PlaybackState,
	type Track,
} from "@/lib/destination";
import { chooseRoute, type PlayRoute, type RouteDecision, type SenderProfile } from "@/lib/route";

type Blocked = Extract<RouteDecision, { ok: false }>;
import { airplayTvProfile, NOT_READY, type StreamFormats } from "@/lib/route-profiles";
import type { PlayerAction } from "@/lib/hotkeys";
import type { Channel } from "@/lib/types";

/** The receiver the audio route goes to, from the backend. */
export interface AirPlayRoute {
	/** `airplay:<uid>`. */
	id: string;
	name: string;
}

/** AVPlayer's state as the backend reports it. */
export interface AirPlayNativeState {
	status: PlaybackState["status"];
	position: number;
	/** 0 for live. */
	duration: number;
	subtitles: { label: string; language?: string }[];
	subtitleId: string | null;
	audio: { label: string; language?: string }[];
	audioId: string | null;
	connection: PlaybackState["connection"];
	error: {
		code: PlaybackError["code"];
		/** The receiver couldn't play the stream as it is. */
		unsupported?: boolean;
	} | null;
}

export const AIRPLAY_AVAILABLE_EVENT = "airplay://available";
export const AIRPLAY_ROUTE_EVENT = "airplay://route";
export const AIRPLAY_PICKER_CLOSED_EVENT = "airplay://picker-closed";
export const AIRPLAY_STATE_EVENT = "airplay://state";

export const IDLE_NATIVE_STATE: AirPlayNativeState = {
	status: "idle",
	position: 0,
	duration: 0,
	subtitles: [],
	subtitleId: null,
	audio: [],
	audioId: null,
	connection: "connected",
	error: null,
};

/**
 * Every AirPlay receiver gets the AirPlay 2 TV profile, since iOS doesn't
 * say whether it picked an Apple TV.
 */
export const AIRPLAY_RECEIVER = airplayTvProfile;

/** This iPhone or iPad. It doesn't convert yet, so only direct routes work.
 *  Once it does, this becomes `iosSender` with the converter's support. */
export const AIRPLAY_SENDER: SenderProfile = {
	convert: false,
	hardwareEncoder: false,
	convertNeedsScreen: false,
};

const tracks = (list: AirPlayNativeState["subtitles"]): Track[] =>
	list.map((t, i) => ({ id: String(i), label: t.label, language: t.language }));

/** What the player says about an error AVPlayer reported. */
export const airplayErrorMessage = (error: NonNullable<AirPlayNativeState["error"]>) => {
	if (error.code === "refused")
		return "The provider refused the stream. The login may have expired, or another device may be using it.";
	if (error.unsupported) return "The TV can't play this stream as it is.";
	if (error.code === "openFailed") return "Couldn't start the stream on the TV.";
	return "The stream stopped on the TV.";
};

const NAMES: Record<string, string> = {
	mkv: "MKV files",
	ts: "this raw MPEG-TS stream",
	other: "this kind of stream",
	hevc: "HEVC video",
	mpeg2: "MPEG-2 video",
	ac3: "Dolby Digital audio",
	eac3: "Dolby Digital Plus audio",
	mp2: "MP2 audio",
	dts: "DTS audio",
	opus: "Opus audio",
};

/** Why an item can't go to an AirPlay receiver, for the player to show. */
export const airplayBlockedMessage = ({ reason, detail }: Blocked): string => {
	const what = (detail && NAMES[detail]) ?? "this stream";
	switch (reason) {
		case "container":
		case "videoCodec":
		case "audioCodec":
			return `AirPlay can't play ${what}.`;
		case "interlaced":
			return "AirPlay can't play interlaced video.";
		case "audioOnly":
			return "AirPlay TVs don't play streams without video.";
		default:
			return "Couldn't check the stream for AirPlay.";
	}
};

/** The backend's state in the destination's terms. */
export const airplayPlaybackState = (
	native: AirPlayNativeState,
	item: PlaybackState["item"],
	positionAt: number
): PlaybackState => ({
	status: native.status,
	item,
	position: native.position,
	positionAt,
	duration: native.duration,
	// The TV's volume follows the phone's buttons, which the app can't read.
	volume: 100,
	subtitles: tracks(native.subtitles),
	subtitleId: native.subtitleId,
	audio: tracks(native.audio),
	audioId: native.audioId,
	connection: native.connection,
	error: native.error
		? { code: native.error.code, message: airplayErrorMessage(native.error) }
		: null,
});

/** What AirPlay can do for the item it plays. */
export const airplayCapabilities = (
	native: AirPlayNativeState,
	live: boolean
): PlaybackCapabilities => ({
	seek: !live && native.duration > 0,
	pause: true,
	volume: "none",
	subtitles: native.subtitles.length > 0 ? "select" : "none",
	// AVPlayer can't add a subtitle file to a stream it fetches by URL.
	externalSubtitles: false,
	audioTracks: native.audio.length > 1,
	resumeAt: !live,
	catalog: false,
});

/** The resume point the player keeps, as far as AirPlay touches it. */
export interface AirPlayProgress {
	position: number;
	duration: number;
	dirty: boolean;
	lastSaved: number;
}

/**
 * The resume point after the receiver reports `state`, and whether to save
 * it now: when it's paused, or `interval` ms after the last save. A
 * reading with no length yet, or from the very start, changes nothing.
 */
export const airplayProgress = (
	progress: AirPlayProgress,
	state: PlaybackState,
	now: number,
	interval: number
): { progress: AirPlayProgress; save: boolean } | null => {
	if (state.duration <= 0 || state.position <= 1) return null;
	const moved = state.position !== progress.position || state.duration !== progress.duration;
	const next = moved
		? { ...progress, position: state.position, duration: state.duration, dirty: true }
		: progress;
	const save = state.status === "paused" || now - progress.lastSaved >= interval;
	return { progress: next, save };
};

/** What a player hotkey does while AirPlay plays. */
export type AirPlayKey =
	| { kind: "play" }
	| { kind: "pause" }
	| { kind: "seek"; to: number }
	/** The player handles it as usual: full screen, the shortcut list, Escape. */
	| { kind: "pass" }
	/** Nothing: the volume is the phone's, and episodes, subtitles and the
	 *  info sheet would start or change playback here. */
	| { kind: "ignore" };

/** What `action` does while AirPlay plays `state`. Nothing starts here, so
 *  the provider never sees a second connection. */
export const airplayKey = (
	action: PlayerAction,
	state: PlaybackState,
	capabilities: PlaybackCapabilities
): AirPlayKey => {
	const seekTo = (to: number): AirPlayKey =>
		capabilities.seek
			? { kind: "seek", to: Math.min(Math.max(0, to), state.duration) }
			: { kind: "ignore" };
	switch (action.type) {
		case "togglePlay":
			if (state.status !== "playing" && state.status !== "buffering") return { kind: "play" };
			return capabilities.pause ? { kind: "pause" } : { kind: "ignore" };
		case "seekBy":
			return seekTo(state.position + action.seconds);
		case "seekToPercent":
			return seekTo((state.duration * action.percent) / 100);
		case "toggleFullscreen":
		case "toggleShortcuts":
		case "escape":
			return { kind: "pass" };
		default:
			return { kind: "ignore" };
	}
};

/** What the destination needs from the backend, so tests can fake it. */
export interface AirPlayBridge {
	/** The formats `channel` comes in. Rejects with `NOT_READY` while mpv
	 *  is still opening it here. */
	formats: (channel: Channel) => Promise<StreamFormats>;
	load: (channel: Channel, generation: number, source: number, startAt?: number) => Promise<void>;
	play: () => Promise<void>;
	pause: () => Promise<void>;
	seek: (position: number) => Promise<void>;
	selectSubtitle: (index: number | null) => Promise<void>;
	selectAudio: (index: number) => Promise<void>;
	stop: () => Promise<void>;
	/** Calls `handler` with every state event. Resolves to an unsubscribe. */
	listen: (handler: (state: AirPlayNativeState) => void) => Promise<() => void>;
	now: () => number;
	/** Resolves after `ms`. */
	sleep: (ms: number) => Promise<void>;
}

/** How long `route` waits before asking again while mpv opens the item. */
const NOT_READY_WAIT_MS = 500;
/** How many times `route` asks, about 5 s in all. */
const NOT_READY_TRIES = 10;

/** `channel`'s formats, asked again while mpv is still opening it. */
const formatsWhenReady = async (bridge: AirPlayBridge, channel: Channel) => {
	for (let tried = 1; ; tried++) {
		try {
			return await bridge.formats(channel);
		} catch (error) {
			if (error !== NOT_READY || tried === NOT_READY_TRIES) throw error;
			await bridge.sleep(NOT_READY_WAIT_MS);
		}
	}
};

export interface AirPlayDestination extends PlaybackDestination {
	readonly kind: "airplay";
	/** Stops listening. The destination can't be used after. */
	dispose(): void;
}

/** The AirPlay destination for `receiver`. */
export const createAirPlayDestination = (
	receiver: AirPlayRoute,
	bridge: AirPlayBridge
): AirPlayDestination => {
	let native = IDLE_NATIVE_STATE;
	let item: PlaybackState["item"] = null;
	let live = false;
	let state = airplayPlaybackState(native, item, bridge.now());
	const listeners = new Set<(state: PlaybackState) => void>();
	/** Each channel's URL places and their list's generation, from its last
	 *  `route`. */
	const sources = new Map<string, Pick<StreamFormats, "sources" | "generation">>();

	const publish = () => {
		state = airplayPlaybackState(native, item, bridge.now());
		for (const listener of listeners) listener(state);
	};

	let unlisten: (() => void) | null = null;
	let disposed = false;
	void bridge
		.listen((next) => {
			native = next;
			publish();
		})
		.then((stop) => {
			if (disposed) stop();
			else unlisten = stop;
		});

	const index = (trackId: string) => {
		const i = Number(trackId);
		if (!Number.isInteger(i) || i < 0) throw new Error(`No track ${trackId}`);
		return i;
	};

	return {
		id: receiver.id,
		kind: "airplay",
		name: receiver.name,
		catalog: { kind: "local" },
		get capabilities() {
			return airplayCapabilities(native, live);
		},
		route: async (target: PlaybackItem): Promise<RouteDecision> => {
			if (target.kind !== "local") return { ok: false, reason: "notFound" };
			const found = await formatsWhenReady(bridge, target.channel);
			sources.set(target.channel.id, found);
			return chooseRoute(found.formats, AIRPLAY_RECEIVER, AIRPLAY_SENDER);
		},
		load: async (target: PlaybackItem, opts?: { startAt?: number; route?: PlayRoute }) => {
			if (target.kind !== "local")
				throw new UnsupportedError("Playing another device's item");
			const { route, startAt } = opts ?? {};
			if (route?.via !== "direct")
				throw new UnsupportedError("Converting a stream on this device");
			const listed = sources.get(target.channel.id);
			const source = listed?.sources[route.format];
			if (!listed || source === undefined) throw new Error("Check the route before loading");
			const { channel } = target;
			live = channel.contentType === "live";
			item = { title: channel.name, contentType: channel.contentType, ref: channel.id };
			native = { ...IDLE_NATIVE_STATE, status: "opening" };
			publish();
			await bridge.load(channel, listed.generation, source, live ? undefined : startAt);
		},
		play: () => bridge.play(),
		pause: () => bridge.pause(),
		seek: (seconds) => bridge.seek(seconds),
		setVolume: () => Promise.reject(new UnsupportedError("Setting the TV's volume")),
		selectSubtitle: async (trackId) =>
			bridge.selectSubtitle(trackId === null ? null : index(trackId)),
		selectAudio: async (trackId) => bridge.selectAudio(index(trackId)),
		stop: async () => {
			await bridge.stop();
			native = IDLE_NATIVE_STATE;
			item = null;
			publish();
		},
		getState: () => state,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		dispose: () => {
			disposed = true;
			unlisten?.();
			unlisten = null;
			listeners.clear();
		},
	};
};
