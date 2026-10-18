// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/**
 * An AirPlay receiver as a {@link PlaybackDestination}. AVPlayer plays on
 * it while mpv is stopped. Apps can't list AirPlay receivers, so the user
 * picks one in the system picker and this only ever knows its name.
 *
 * The stream URL stays in the backend: a load names the format by its
 * place in `getStreamFormats`' list.
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
import { airplayTvProfile, type StreamFormats } from "@/lib/route-profiles";
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

/** What the destination needs from the backend, so tests can fake it. */
export interface AirPlayBridge {
	/** The formats `channel` comes in. Passes mpv's media info when the
	 *  channel plays here, so the provider isn't asked again. */
	formats: (channel: Channel) => Promise<StreamFormats>;
	load: (channel: Channel, source: number, startAt?: number) => Promise<void>;
	play: () => Promise<void>;
	pause: () => Promise<void>;
	seek: (position: number) => Promise<void>;
	selectSubtitle: (index: number | null) => Promise<void>;
	selectAudio: (index: number) => Promise<void>;
	stop: () => Promise<void>;
	/** Calls `handler` with every state event. Resolves to an unsubscribe. */
	listen: (handler: (state: AirPlayNativeState) => void) => Promise<() => void>;
	now: () => number;
}

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
	/** Each channel's URL places, from its last `route`. */
	const sources = new Map<string, number[]>();

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
			const found = await bridge.formats(target.channel);
			sources.set(target.channel.id, found.sources);
			return chooseRoute(found.formats, AIRPLAY_RECEIVER, AIRPLAY_SENDER);
		},
		load: async (target: PlaybackItem, opts?: { startAt?: number; route?: PlayRoute }) => {
			if (target.kind !== "local")
				throw new UnsupportedError("Playing another device's item");
			const { route, startAt } = opts ?? {};
			if (route?.via !== "direct")
				throw new UnsupportedError("Converting a stream on this device");
			const source = sources.get(target.channel.id)?.[route.format];
			if (source === undefined) throw new Error("Check the route before loading");
			const { channel } = target;
			live = channel.contentType === "live";
			item = { title: channel.name, contentType: channel.contentType, ref: channel.id };
			native = { ...IDLE_NATIVE_STATE, status: "opening" };
			publish();
			await bridge.load(channel, source, live ? undefined : startAt);
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
