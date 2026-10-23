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
	positionNow,
	UnsupportedError,
	type PlaybackCapabilities,
	type PlaybackDestination,
	type PlaybackError,
	type PlaybackItem,
	type PlaybackState,
	type Track,
} from "@/lib/destination";
import { convertWarning, REFUSED_MESSAGE, tvFailureMessage } from "@/lib/device-picker";
import { chooseRoute, type PlayRoute, type RouteDecision, type SenderProfile } from "@/lib/route";

type Blocked = Extract<RouteDecision, { ok: false }>;
import {
	airplayTvProfile,
	iosSender,
	NOT_READY,
	REFUSED,
	type ConverterSupport,
	type StreamFormats,
} from "@/lib/route-profiles";
import type { PlayerAction } from "@/lib/hotkeys";
import { createRestarts } from "@/lib/restarts";
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
		/** No receiver took the video: on a Mac, the picker closed without
		 *  one, or with this Mac. The player plays here again, as if AirPlay
		 *  never started, so it shows as opening, with no error. */
		notPicked?: boolean;
		/** This device's converter stopped by itself, so converting again
		 *  might work. */
		conversionStopped?: boolean;
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

/** This device, for AirPlay. On an iPhone or iPad, a conversion keeps
 *  going with the screen locked, through the audio background mode. A Mac
 *  converts with the bundled ffmpeg and stays awake while it does, so its
 *  `desktopSender` is this same profile. */
export const airplaySender = (support: ConverterSupport): SenderProfile =>
	iosSender(support, { needsScreen: false });

/** What the confirm step says before an iPhone or iPad converts. */
export const CONVERT_WARNING =
	"This iPhone converts the stream and sends it to the TV. Keep it on Wi-Fi and charged. It can lock.";

/** The confirm step's warning for this device, sending to `name`. A Mac
 *  says what Cast says. */
export const airplayConvertWarning = (mac: boolean, name = "the TV") =>
	mac ? convertWarning(name, "on") : CONVERT_WARNING;

const tracks = (list: AirPlayNativeState["subtitles"]): Track[] =>
	list.map((t, i) => ({ id: String(i), label: t.label, language: t.language }));

/** What the player says about an error AVPlayer reported. */
export const airplayErrorMessage = (error: NonNullable<AirPlayNativeState["error"]>) => {
	if (error.code === "refused") return REFUSED_MESSAGE;
	if (error.unsupported) return "The TV can't play this stream as it is.";
	if (error.code === "openFailed") return "Couldn't start the stream on the TV.";
	return "The stream stopped on the TV.";
};

/** Why AirPlay ended when no TV took the video, on a Mac. */
export const NOT_PICKED = "No TV took the video.";

/** What a converted load answers when a later load or a stop came first.
 *  The same text as `SUPERSEDED` in src-tauri/src/airplay/conversion.rs. */
export const SUPERSEDED = "superseded";

/** What the player says when a seek on the TV failed. */
export const airplaySeekMessage = (error: unknown): string =>
	tvFailureMessage("the TV", error, "Couldn't move the stream on the TV.");

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
		case "hdr":
			return "AirPlay can't play this HDR stream as it is, and Cinette doesn't convert HDR.";
		case "audioOnly":
			return "AirPlay TVs don't play streams without video.";
		default:
			return "Couldn't check the stream for AirPlay.";
	}
};

/** The backend's state in the destination's terms. A pick that found no
 *  receiver is still opening, since the player takes the item back. */
export const airplayPlaybackState = (
	native: AirPlayNativeState,
	item: PlaybackState["item"],
	positionAt: number
): PlaybackState => ({
	status: native.error?.notPicked ? "opening" : native.status,
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
	error:
		native.error && !native.error.notPicked
			? { code: native.error.code, message: airplayErrorMessage(native.error) }
			: null,
});

/** What AirPlay can do for the item it plays. A converted live stream
 *  can't pause: the converter can't hold back a live source. */
export const airplayCapabilities = (
	native: AirPlayNativeState,
	live: boolean,
	converted: boolean
): PlaybackCapabilities => ({
	seek: !live && native.duration > 0,
	pause: !(live && converted),
	volume: "none",
	subtitles: native.subtitles.length > 0 ? "select" : "none",
	// AVPlayer can't add a subtitle file to a stream it fetches by URL.
	externalSubtitles: false,
	// The converter keeps one audio track.
	audioTracks: !converted && native.audio.length > 1,
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
 *  the provider never sees a second connection, and nothing plays while
 *  the TV is lost. */
export const airplayKey = (
	action: PlayerAction,
	state: PlaybackState,
	capabilities: PlaybackCapabilities,
	now = state.positionAt
): AirPlayKey => {
	const seekTo = (to: number): AirPlayKey =>
		capabilities.seek
			? { kind: "seek", to: Math.min(Math.max(0, to), state.duration) }
			: { kind: "ignore" };
	switch (action.type) {
		case "togglePlay":
			if (state.connection === "lost") return { kind: "ignore" };
			if (state.status !== "playing" && state.status !== "buffering") return { kind: "play" };
			return capabilities.pause ? { kind: "pause" } : { kind: "ignore" };
		case "seekBy":
			// From where it is now, not where it last said.
			return seekTo(positionNow(state, now) + action.seconds);
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
	/** Converts on this device and plays that on the receiver. */
	loadConverted: (
		channel: Channel,
		generation: number,
		source: number,
		startAt?: number
	) => Promise<void>;
	endConversion: () => Promise<void>;
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
	/** No receiver took the video, on a Mac, so the player plays it here
	 *  again. */
	readonly notPicked: boolean;
	/** Whether this device converts what plays. */
	converted(): boolean;
	/** Ends this device's conversion, if one runs, so the provider allows
	 *  another connection, and keeps the item. Resolves to whether one ran:
	 *  a TV that fetches the stream itself keeps it. */
	release(): Promise<boolean>;
	/** Stops listening. The destination can't be used after. */
	dispose(): void;
}

/** The AirPlay destination for `receiver`, from a device that converts as
 *  `sender` says. */
export const createAirPlayDestination = (
	receiver: AirPlayRoute,
	bridge: AirPlayBridge,
	sender: SenderProfile
): AirPlayDestination => {
	let native = IDLE_NATIVE_STATE;
	let item: PlaybackState["item"] = null;
	let live = false;
	/** The converted item and its source, so a seek can start it again. */
	let converted: { channel: Channel; generation: number; source: number } | null = null;
	let state = airplayPlaybackState(native, item, bridge.now());
	const listeners = new Set<(state: PlaybackState) => void>();
	/** Each channel's URL places and their list's generation, from its last
	 *  `route`. */
	const sources = new Map<string, Pick<StreamFormats, "sources" | "generation">>();

	/** The tries to convert again after the converter stopped by itself,
	 *  with Cast's waits. */
	const restarts = createRestarts(bridge.now);
	/** The try that waits or runs. A load, a seek or a stop overtakes it. */
	let restarting: object | null = null;
	/** The user asked for something else, so the tries start again. */
	const takeOver = () => {
		restarting = null;
		restarts.reset();
	};

	const publish = () => {
		// While it converts again, the TV is waiting, not stopped.
		const shown: AirPlayNativeState = restarting
			? { ...native, status: "buffering", error: null }
			: native;
		state = airplayPlaybackState(shown, item, bridge.now());
		for (const listener of listeners) listener(state);
	};

	/** The end of a conversion the TV's state ended, so whatever plays next
	 *  waits for it to hang up on the provider. */
	let ending: Promise<void> = Promise.resolve();
	let unlisten: (() => void) | null = null;
	let disposed = false;
	void bridge
		.listen((next) => {
			native = next;
			if (next.status === "playing") restarts.playing();
			// The converter stopped by itself: convert again, as Cast does,
			// until the tries run out.
			const stopped = next.error?.conversionStopped && next.error.code !== "refused";
			if (converted && stopped && (restarting !== null || convertAgain(converted))) {
				publish();
				return;
			}
			// The TV is gone, it took nothing, or the item failed, so nothing
			// will fetch what this device converts.
			if (converted && (next.connection === "lost" || next.error)) {
				converted = null;
				ending = bridge.endConversion().catch(() => {});
			}
			publish();
		})
		.then((stop) => {
			if (disposed) stop();
			else unlisten = stop;
		});

	/** The converted seek that runs, and the position asked for since. A
	 *  seek converts again from there, so quick seeks wait for the one
	 *  running, and only the last of them runs next. */
	let seeking: Promise<void> | null = null;
	let wanted: number | null = null;

	const reconvert = async (from: NonNullable<typeof converted>) => {
		while (wanted !== null) {
			const at = wanted;
			wanted = null;
			await bridge
				.loadConverted(from.channel, from.generation, from.source, at)
				// A later seek or a stop took over, which is fine.
				.catch((error: unknown) => {
					if (error !== SUPERSEDED) throw error;
				});
		}
	};

	/**
	 * Converts `from` again after the converter stopped by itself: a movie
	 * from where the TV was, a live channel from now. Returns false once the
	 * tries have run out. A try that fails to start makes the next one.
	 */
	const convertAgain = (from: NonNullable<typeof converted>): boolean => {
		const delay = restarts.nextDelay();
		if (delay === null) return false;
		const mine = {};
		restarting = mine;
		const at = live ? undefined : positionNow(state, bridge.now());
		const attempt = async () => {
			await bridge.sleep(delay);
			if (restarting !== mine) return;
			restarts.sent();
			await bridge.loadConverted(from.channel, from.generation, from.source, at);
			if (restarting === mine) restarting = null;
		};
		attempt().catch((error: unknown) => {
			if (restarting !== mine || error === SUPERSEDED) return;
			restarting = null;
			// Refused won't change, and the tries may have run out, either of
			// which shows the stop.
			if (error === REFUSED || !convertAgain(from)) {
				converted = null;
				ending = bridge.endConversion().catch(() => {});
			}
			publish();
		});
		return true;
	};

	const seekConverted = (from: NonNullable<typeof converted>, seconds: number) => {
		takeOver();
		wanted = seconds;
		if (!seeking)
			seeking = reconvert(from).finally(() => {
				seeking = null;
			});
		return seeking;
	};

	/** Ends the conversion that runs, if one does, and waits until the
	 *  provider's connection is closed, before something else plays.
	 *  Resolves to whether one ran. */
	const letGo = async () => {
		takeOver();
		const wasConverted = converted !== null;
		converted = null;
		if (wasConverted) await bridge.endConversion();
		else await ending;
		return wasConverted;
	};

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
			return airplayCapabilities(native, live, converted !== null);
		},
		get notPicked() {
			return native.error?.notPicked === true;
		},
		route: async (target: PlaybackItem): Promise<RouteDecision> => {
			if (target.kind !== "local") return { ok: false, reason: "notFound" };
			const found = await formatsWhenReady(bridge, target.channel);
			sources.set(target.channel.id, found);
			return chooseRoute(found.formats, AIRPLAY_RECEIVER, sender);
		},
		load: async (target: PlaybackItem, opts?: { startAt?: number; route?: PlayRoute }) => {
			if (target.kind !== "local")
				throw new UnsupportedError("Playing another device's item");
			const { route, startAt } = opts ?? {};
			if (route?.via !== "direct" && route?.via !== "converted")
				throw new UnsupportedError("Playing this route on AirPlay");
			const listed = sources.get(target.channel.id);
			const source = listed?.sources[route.format];
			if (!listed || source === undefined) throw new Error("Check the route before loading");
			const { channel } = target;
			// Whatever this device converted for the last item lets go first.
			// The load goes even if that fails, and says for itself if it can't
			// play.
			const released = letGo().catch(() => {});
			live = channel.contentType === "live";
			const mine = { title: channel.name, contentType: channel.contentType, ref: channel.id };
			item = mine;
			native = { ...IDLE_NATIVE_STATE, status: "opening" };
			const { generation } = listed;
			converted = route.via === "converted" ? { channel, generation, source } : null;
			// The capabilities change with the route, so the new state goes out
			// after it's set, and subscribers read both together.
			publish();
			const from = live ? undefined : startAt;
			await released;
			const loading = converted
				? bridge.loadConverted(channel, generation, source, from)
				: bridge.load(channel, generation, source, from);
			// One that didn't start shows why, unless another took over.
			await loading.catch((error: unknown) => {
				if (item === mine && error !== SUPERSEDED) {
					native = {
						...native,
						status: "error",
						error: { code: error === REFUSED ? "refused" : "openFailed" },
					};
					publish();
				}
				throw error;
			});
		},
		// Nothing plays or pauses while the TV is lost: a Mac would play it
		// itself.
		play: async () => {
			if (native.connection !== "lost") await bridge.play();
		},
		pause: async () => {
			if (native.connection !== "lost") await bridge.pause();
		},
		// A converted movie only has the segments around where it plays, so
		// a seek converts again from there.
		seek: (seconds) =>
			converted && !live ? seekConverted(converted, seconds) : bridge.seek(seconds),
		setVolume: () => Promise.reject(new UnsupportedError("Setting the TV's volume")),
		selectSubtitle: async (trackId) =>
			bridge.selectSubtitle(trackId === null ? null : index(trackId)),
		selectAudio: async (trackId) => bridge.selectAudio(index(trackId)),
		converted: () => converted !== null,
		release: letGo,
		stop: async () => {
			await letGo();
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
