// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/**
 * A Google Cast receiver as a {@link PlaybackDestination}. It plays this
 * device's channels: the receiver fetches the stream itself when it can
 * play it, and otherwise this computer converts it and serves it. The URLs
 * stay in the backend, which a load names by place.
 *
 * Its state is folded from the `cast://update` events the backend sends
 * for this receiver.
 */

import { createRestarts } from "@/lib/restarts";
import type {
	ExternalSubtitle,
	PlaybackCapabilities,
	PlaybackDestination,
	PlaybackError,
	PlaybackItem,
	PlaybackState,
	PlaybackStatus,
} from "@/lib/destination";
import { positionNow, UnsupportedError } from "@/lib/destination";
import { chooseRoute, type PlayRoute, type RouteDecision } from "@/lib/route";
import {
	castProfile,
	desktopSender,
	type ConverterSupport,
	type PlayingInfo,
	type StreamFormats,
} from "@/lib/route-profiles";
import { toWebVtt } from "@/lib/subtitle-parser";
import type { CastAction, CastReceiver, CastRoute, CastSubtitle, CastUpdate } from "@/lib/tauri";
import type { Channel } from "@/lib/types";

type MediaView = Extract<CastUpdate, { kind: "media" }>["media"];

/** What the backend has said about this cast so far. */
export interface CastSnapshot {
	/** Connecting until the receiver app runs, then ready, then closed. */
	phase: "connecting" | "ready" | "closed";
	/** Why it closed, when it did. */
	closedReason: Extract<CastUpdate, { kind: "closed" }>["reason"] | null;
	media: MediaView;
	/** When `media` arrived, as `performance.now()`. */
	mediaAt: number;
	/** 0 to 1, and 0 until the receiver says. */
	volume: number;
	volumeFixed: boolean;
	error: PlaybackError | null;
	item: { title: string; contentType: Channel["contentType"]; ref: string } | null;
	/** Where a converted stream started, in the item's seconds. The receiver
	 *  counts from 0. */
	offset: number;
	/** The item's length, when known. A converted stream has none of its own. */
	duration: number;
	/** Whether this computer converts the stream. */
	converted: boolean;
	/** A load was sent and nothing has played yet. */
	loading: boolean;
	/** Where the item was last known to be, in its seconds: where it was
	 *  asked to start, then what the receiver said. It stays when the media
	 *  goes, so a resume point keeps it. */
	position: number;
}

export const idleSnapshot: CastSnapshot = {
	phase: "connecting",
	closedReason: null,
	media: null,
	mediaAt: 0,
	volume: 0,
	volumeFixed: false,
	error: null,
	item: null,
	offset: 0,
	duration: 0,
	converted: false,
	loading: false,
	position: 0,
};

/** The snapshot after `update`, which arrived at `at`. */
export const applyUpdate = (
	snapshot: CastSnapshot,
	update: CastUpdate,
	at: number
): CastSnapshot => {
	switch (update.kind) {
		case "ready":
			return { ...snapshot, phase: "ready" };
		// The media stays, as the receiver may play on meanwhile.
		case "reconnecting":
			return { ...snapshot, phase: "connecting" };
		case "volume":
			return { ...snapshot, volume: update.level, volumeFixed: update.fixed };
		// The backend leaves out what the media from before a load reports
		// while the load waits, so any media here is the newest.
		case "media": {
			const played = update.media !== null && update.media.player !== "idle";
			return {
				...snapshot,
				media: update.media,
				mediaAt: at,
				position: update.media
					? snapshot.offset + update.media.position
					: snapshot.position,
				loading: snapshot.loading && !played && update.media?.idleReason !== "error",
				error: played ? null : snapshot.error,
			};
		}
		case "loadFailed":
			return { ...snapshot, loading: false, error: { code: "openFailed" } };
		case "playbackError":
			return { ...snapshot, error: { code: "failed" } };
		case "conversionFailed":
			return {
				...snapshot,
				loading: false,
				error: { code: update.refused ? "refused" : "loadFailed" },
			};
		// A command it turned down leaves the state as it was. A stopped
		// conversion does too, since the destination starts it again and
		// says so itself.
		case "conversionStopped":
		case "rejected":
			return snapshot;
		case "closed":
			return {
				...snapshot,
				phase: "closed",
				closedReason: update.reason,
				loading: false,
				media: null,
			};
	}
};

const statusOf = (s: CastSnapshot): PlaybackStatus => {
	// A load in flight wins over the last one's error.
	if (s.loading) return "opening";
	if (s.error !== null) return "error";
	switch (s.media?.player) {
		case "playing":
			return "playing";
		case "paused":
			return "paused";
		case "buffering":
			return "buffering";
		case "idle":
			return s.media.idleReason === "finished" ? "ended" : "idle";
		default:
			return "idle";
	}
};

/** The cast's state in the destination's terms. */
export const castPlaybackState = (s: CastSnapshot): PlaybackState => {
	const position = s.media ? s.offset + s.media.position : s.position;
	const duration = s.media?.live && !s.converted ? 0 : (s.media?.duration ?? s.duration);
	return {
		status: statusOf(s),
		item: s.item,
		position,
		positionAt: s.mediaAt,
		duration: s.converted ? s.duration : duration,
		volume: Math.round(s.volume * 100),
		subtitles: [],
		subtitleId: null,
		audio: [],
		audioId: null,
		connection:
			s.phase === "closed" && s.closedReason !== "stopped"
				? "lost"
				: s.phase === "connecting" && s.item !== null
					? "reconnecting"
					: "connected",
		error: s.error,
	};
};

/** What the receiver lets the player do now. A converted stream seeks by
 *  starting the conversion again from the new place. */
export const castCapabilities = (s: CastSnapshot): PlaybackCapabilities => ({
	seek: s.converted ? s.duration > 0 : s.media !== null && s.media.canSeek && !s.media.live,
	pause: s.media?.canPause ?? false,
	volume: s.volumeFixed ? "none" : "absolute",
	subtitles: "none",
	externalSubtitles: false,
	audioTracks: false,
	resumeAt: true,
	catalog: false,
});

/** The backend calls a Cast destination makes. Tests pass fakes. */
export interface CastBackend {
	getStreamFormats: (channel: Channel, playing?: PlayingInfo) => Promise<StreamFormats>;
	getConverterSupport: () => Promise<ConverterSupport>;
	castLoad: (
		receiverId: string,
		channel: Channel,
		route: CastRoute,
		startAt: number | undefined,
		restart: boolean,
		freed: boolean,
		subtitle?: CastSubtitle
	) => Promise<void>;
	castControl: (receiverId: string, action: CastAction) => Promise<void>;
	castStop: (receiverId: string) => Promise<void>;
	castRelease: (receiverId: string) => Promise<void>;
}

export interface CastOptions {
	/** What mpv says about the item while it plays here, so the provider
	 *  isn't asked again. */
	playing?: () => PlayingInfo | undefined;
	/** "Stream through this device": convert even what the receiver could
	 *  fetch itself, so the stream goes through this device's connection. */
	streamThrough?: () => boolean;
	now?: () => number;
	/** Runs `run` after `ms`, and returns what cancels it. Tests pass their
	 *  own. */
	schedule?: (run: () => void, ms: number) => () => void;
}

/** A destination for a Cast receiver, and the way to feed it. */
export interface CastDestination extends PlaybackDestination {
	/** An update the backend sent for this receiver. */
	receive(update: CastUpdate): void;
	/** Why the cast closed, once it has. */
	closedReason(): CastSnapshot["closedReason"];
	/** Whether this computer converts what the receiver plays now. */
	converted(): boolean;
	/** Has the receiver and this computer let go of the provider's stream,
	 *  and keeps the cast, for an account that allows one connection. It
	 *  shows as opening, since the next item is on its way. */
	release(): Promise<boolean>;
}

/** The backend's form of `route` for `formats`. */
export const castRouteOf = (route: PlayRoute, formats: StreamFormats): CastRoute => {
	if (route.via === "direct")
		return {
			via: "direct",
			generation: formats.generation,
			source: formats.sources[route.format],
			container: formats.formats[route.format].container,
		};
	if (route.via === "converted")
		return {
			via: "converted",
			generation: formats.generation,
			source: formats.sources[route.format],
			container: formats.formats[route.format].container,
			video: route.video,
			audio: route.audio,
		};
	throw new UnsupportedError(`Casting by way of ${route.via}`);
};

/** The direct route as a remux through this computer, for "Stream through
 *  this device". */
export const throughThisDevice = (route: PlayRoute, formats: StreamFormats): PlayRoute => {
	if (route.via !== "direct") return route;
	const format = formats.formats[route.format];
	return {
		via: "converted",
		format: route.format,
		video: format.video === null ? "none" : "copy",
		audio: format.audio === null ? "none" : "copy",
		output: "matroska",
		keep: "on",
	};
};

/** What `castLoad` rejects with when a direct playlist failed its check at
 *  cast time, so the item routes again without that format. */
const FORMAT_FAILED = ["notPlaylist", "cors"];

/**
 * How long a converted file can stay paused and still go on with Play. The
 * converter drops a receiver that stops reading for 15 s, and a paused one
 * stops once its buffer is full, so after this Play converts again from
 * where it paused.
 */
export const PAUSE_LIMIT_MS = 10_000;

export { RESTART_DELAYS_MS, STEADY_MS } from "@/lib/restarts";

/** How long a new subtitle delay has to stay before the cast loads again
 *  with it, so a slider's steps load once. */
export const SETTLE_MS = 1000;

/** Whether `a` and `b` are the same file, whatever their delays. */
const sameFile = (a: ExternalSubtitle, b: ExternalSubtitle): boolean =>
	a.cues === b.cues && a.name === b.name && a.language === b.language;

/** What `castLoad` rejects with when the provider refused the login, which
 *  trying again won't change. */
const REFUSED = "refused";

/** What `castLoad` rejects with when a newer load or a stop for the same
 *  receiver came while it ran. */
export const SUPERSEDED = "superseded";

/** What `castLoad` rejects with when the formats were listed before the
 *  backend's newest list of the item's URLs. */
export const STALE = "stale";

/** The Cast destination for `receiver`, which the backend reaches through
 *  `backend`. */
export const createCastDestination = (
	receiver: CastReceiver,
	backend: CastBackend,
	options: CastOptions = {}
): CastDestination => {
	const now = options.now ?? (() => performance.now());
	const schedule =
		options.schedule ??
		((run: () => void, ms: number) => {
			const timer = setTimeout(run, ms);
			return () => clearTimeout(timer);
		});
	let snapshot = idleSnapshot;
	let state = castPlaybackState(snapshot);
	// The same object until the state changes, which every capabilities
	// change comes with.
	let capabilities = castCapabilities(snapshot);
	const listeners = new Set<(state: PlaybackState) => void>();
	const publish = (next: CastSnapshot) => {
		snapshot = next;
		state = castPlaybackState(snapshot);
		capabilities = castCapabilities(snapshot);
		for (const listener of listeners) listener(state);
	};
	/** Each channel's formats, without those that failed at cast time. */
	const known = new Map<string, StreamFormats>();
	/** What's loaded, to load again from elsewhere when a converted stream
	 *  seeks. */
	let loaded: { channel: Channel; route: CastRoute; formats: StreamFormats } | null = null;
	/** When the user paused, while paused. */
	let pausedAt: number | null = null;
	/** The subtitle to show, which every load of the item takes along. */
	let subtitle: ExternalSubtitle | null = null;
	/** The subtitle the latest load took, shown or hidden. */
	let carried: ExternalSubtitle | null = null;
	/** Cancels the load waiting for a new delay to settle, if one is. */
	let cancelSettle = () => {};

	const channelOf = (item: PlaybackItem): Channel => {
		if (item.kind !== "local") throw new UnsupportedError("Casting another device's item");
		return item.channel;
	};
	const formatsFor = async (channel: Channel): Promise<StreamFormats> => {
		const cached = known.get(channel.id);
		if (cached) return cached;
		const formats = await backend.getStreamFormats(channel, options.playing?.());
		known.set(channel.id, formats);
		return formats;
	};
	const decide = async (channel: Channel): Promise<RouteDecision> => {
		const [formats, support] = await Promise.all([
			formatsFor(channel),
			backend.getConverterSupport(),
		]);
		const decision = chooseRoute(
			formats.formats,
			castProfile(receiver.model),
			desktopSender(support)
		);
		if (!decision.ok || !options.streamThrough?.()) return decision;
		return { ok: true, route: throughThisDevice(decision.route, formats) };
	};
	/** Drops the format at `source` from `channel`'s `formats`, after it
	 *  failed. */
	const forget = (channel: Channel, formats: StreamFormats, source: number) => {
		const keep = formats.sources.map((s) => s !== source);
		known.set(channel.id, {
			...formats,
			formats: formats.formats.filter((_, i) => keep[i]),
			sources: formats.sources.filter((_, i) => keep[i]),
		});
	};
	/** The newest load's token. A stop or a release puts in another, so
	 *  only the newest load's answer shows. */
	let newest: object = {};
	/** The tries to start the stream again since it last ran steadily. */
	const restarts = createRestarts(now);
	/** Cancels the try waiting to start the stream again, if one is. */
	let cancelRestart = () => {};
	/** Forgets the tries, for a load, a stop or a release the user asked
	 *  for. */
	const resetRestarts = () => {
		cancelRestart();
		restarts.reset();
	};
	/** `quiet` for a try to start the stream again, which says nothing when
	 *  it fails, since the next try or giving up does. */
	const send = async (
		channel: Channel,
		route: CastRoute,
		formats: StreamFormats,
		startAt?: number,
		quiet = false,
		freed = false
	) => {
		const converted = route.via === "converted";
		const sent = {};
		newest = sent;
		if (!quiet) resetRestarts();
		publish({
			...snapshot,
			// A closed cast connects again for this load.
			...(snapshot.phase === "closed" ? { phase: "connecting", closedReason: null } : {}),
			error: null,
			loading: true,
			item: { title: channel.name, contentType: channel.contentType, ref: channel.id },
			converted,
			offset: converted ? (startAt ?? 0) : 0,
			position: startAt ?? 0,
			duration: formats.duration ?? 0,
			media: null,
		});
		loaded = { channel, route, formats };
		restarts.sent();
		cancelSettle();
		// A live channel's cast shows none, as this device's player does.
		carried = channel.contentType === "live" ? null : subtitle;
		// A converted stream counts from 0 at `startAt`.
		const cues =
			carried === null
				? undefined
				: {
						vtt: toWebVtt(carried.cues, carried.delay, converted ? (startAt ?? 0) : 0),
						name: carried.name,
						language: carried.language,
					};
		await backend
			.castLoad(receiver.id, channel, route, startAt, quiet, freed, cues)
			.catch((e: unknown) => {
				// The backend stopped what played before it asked for this, so
				// nothing plays now. A newer load or a stop says for itself.
				if (sent === newest && !quiet)
					publish({
						...snapshot,
						loading: false,
						media: null,
						error: { code: "openFailed", message: String(e) },
					});
				throw e;
			});
	};
	const control = (action: CastAction) => backend.castControl(receiver.id, action);
	/** Says the stream stopped, after the tries to start it again ran out. */
	const giveUp = (code: "refused" | "loadFailed") =>
		publish({ ...snapshot, loading: false, media: null, error: { code } });
	/**
	 * Starts the converted stream again after the backend said it has to: a
	 * film from where it was, a live channel from now. It waits longer
	 * before each try that follows another within {@link STEADY_MS}, and
	 * says the stream stopped only once the tries run out, or at once when
	 * the provider refuses the login.
	 */
	const restart = () => {
		cancelRestart();
		// A cast that ended stays ended, whatever it played.
		if (loaded === null || snapshot.phase === "closed") return;
		const delay = restarts.nextDelay();
		if (delay === null) return giveUp("loadFailed");
		const { channel, route, formats } = loaded;
		const startAt = channel.contentType === "live" ? undefined : positionNow(state, now());
		publish({ ...snapshot, loading: true, error: null });
		// A load, a stop or a release the user asks for meanwhile cancels it.
		cancelRestart = schedule(() => {
			const attempt = send(channel, route, formats, startAt, true);
			const mine = newest;
			attempt.catch((e: unknown) => {
				if (mine !== newest) return;
				if (String(e) === REFUSED) giveUp("refused");
				else restart();
			});
		}, delay);
	};

	return {
		id: receiver.id,
		kind: "cast",
		name: receiver.name,
		catalog: { kind: "local" },
		get capabilities() {
			return capabilities;
		},
		route: async (item) => decide(channelOf(item)),
		load: async (item, opts) => {
			// A stop or a newer load while this one works out its route wins.
			const asked = newest;
			const channel = channelOf(item);
			let route = opts?.route;
			if (route === undefined) {
				const decision = await decide(channel);
				if (!decision.ok) throw new Error(decision.reason);
				route = decision.route;
			}
			const formats = await formatsFor(channel);
			const castRoute = castRouteOf(route, formats);
			// A live channel plays from now, whatever start it was given, so
			// the receiver's clock and the backend get none.
			const startAt = channel.contentType === "live" ? undefined : opts?.startAt;
			if (asked !== newest) throw SUPERSEDED;
			subtitle = opts?.subtitle ?? null;
			try {
				await send(channel, castRoute, formats, startAt, false, opts?.freed);
			} catch (e) {
				if (FORMAT_FAILED.includes(String(e))) forget(channel, formats, castRoute.source);
				// The backend has a newer list of the item's URLs, so ask again.
				if (String(e) === STALE) known.delete(channel.id);
				throw e;
			}
		},
		play: async () => {
			const since = pausedAt;
			pausedAt = null;
			// Stryker disable next-line OptionalChaining: A converted stream always has an item, which the load that converts it sets.
			const file = snapshot.converted && snapshot.item?.contentType !== "live";
			if (loaded === null || !file || since === null || now() - since < PAUSE_LIMIT_MS)
				return control({ action: "play" });
			await send(loaded.channel, loaded.route, loaded.formats, state.position);
		},
		pause: async () => {
			await control({ action: "pause" });
			pausedAt = now();
		},
		seek: async (seconds) => {
			if (!snapshot.converted || loaded === null)
				return control({ action: "seek", to: seconds });
			// The converter starts again from there.
			pausedAt = null;
			await send(loaded.channel, loaded.route, loaded.formats, seconds);
		},
		setVolume: (volume) => control({ action: "volume", level: volume / 100 }),
		setExternalSubtitle: (next) => {
			cancelSettle();
			subtitle = next;
			// The next load takes it along.
			const at = loaded;
			if (at === null || at.channel.contentType === "live") return;
			const reload = () => {
				if (loaded !== at) return;
				send(at.channel, at.route, at.formats, positionNow(state, now())).catch(() => {});
			};
			// The receiver only has a track the load gave it.
			if (carried === null) {
				if (next !== null) reload();
				return;
			}
			if (next === null || (sameFile(next, carried) && next.delay === carried.delay)) {
				control({ action: "tracks", on: next !== null }).catch(() => {});
				return;
			}
			if (sameFile(next, carried)) cancelSettle = schedule(reload, SETTLE_MS);
			else reload();
		},
		selectSubtitle: async () => {
			throw new UnsupportedError("Subtitles on a Cast receiver");
		},
		selectAudio: async () => {
			throw new UnsupportedError("Choosing the audio on a Cast receiver");
		},
		stop: async () => {
			loaded = null;
			newest = {};
			resetRestarts();
			await backend.castStop(receiver.id);
		},
		getState: () => state,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		receive: (update) => {
			publish(applyUpdate(snapshot, update, now()));
			if (update.kind === "conversionStopped") restart();
			// A cast that ended takes the tries to start it again with it.
			if (update.kind === "closed") resetRestarts();
			if (snapshot.media?.player === "playing") restarts.playing();
		},
		closedReason: () => snapshot.closedReason,
		converted: () => snapshot.converted,
		release: async () => {
			loaded = null;
			pausedAt = null;
			newest = {};
			resetRestarts();
			publish({ ...snapshot, loading: true, media: null, error: null });
			await backend.castRelease(receiver.id);
			return true;
		},
	};
};
