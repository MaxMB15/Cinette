// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/**
 * The TV something plays on, over AirPlay or Google Cast, for the whole
 * app. It outlives the player page, so leaving the page keeps the TV
 * playing. One send starts an item there, whichever kind of TV it is, and
 * the store keeps the item's resume point while it plays.
 */

import { SUPERSEDED, airplayBlockedMessage, airplayProgress } from "./airplay";
import type { PlaybackDestination, PlaybackState } from "./destination";
import { blockerText, tvFailureMessage } from "./device-picker";
import {
	EMPTY_PROGRESS,
	PROGRESS_SAVE_INTERVAL,
	progressFor,
	saveProgress,
	type PlaybackProgress,
} from "./playback";
import type { RouteDecision } from "./route";
import type { Channel } from "./types";

export interface NowPlayingState {
	/** The TV that plays, or `null`. */
	destination: PlaybackDestination | null;
	/** What it plays. */
	channel: Channel | null;
	/** Why the last TV ended by itself, until another starts or it's
	 *  dismissed. */
	ended: string | null;
}

export interface SendOptions {
	/** The route the picker already worked out for this TV, if it did. */
	decision?: RouteDecision;
	startAt?: number;
	/** Asks before this device converts the stream. A no sends nothing. */
	confirm?: (keep: "on" | "onScreen") => Promise<boolean>;
	/** Stops this device's player, since many accounts allow one connection
	 *  at a time. */
	stopLocal: () => Promise<void>;
	/** Why the TV is over after `state`, which ends it, or `null` while it
	 *  isn't. A switch to another item on the same TV keeps the last one's. */
	ends?: (state: PlaybackState) => string | null;
}

/** What a send came to. Where nothing was sent, `released` says the TV that
 *  plays let go of its stream to look at the route again, so it has
 *  stopped. */
export type Sent =
	| { ok: true }
	/** A newer send or a stop took over, and says for itself. */
	| { ok: false; why: "overtaken" }
	/** The user said no to converting. */
	| { ok: false; why: "declined"; released: boolean }
	| {
			ok: false;
			why: "blocked";
			decision: Extract<RouteDecision, { ok: false }>;
			released: boolean;
	  }
	/** The route couldn't be worked out. */
	| { ok: false; why: "unrouted"; error: unknown; released: boolean }
	/** The TV couldn't load it. A `switching` TV, which played something
	 *  before, keeps its session; any other has been stopped. */
	| { ok: false; why: "failed"; error: unknown; switching: boolean };

/**
 * How long to wait before each new look at an item, after something let go
 * of the stream. A receiver may take a moment to hang up on the provider.
 */
export const RELEASE_RETRY_MS = [0, 1000, 2000];

/** What the player says about a send to `target` that didn't go, or `null`
 *  for one that went, that something took over, or that the user called
 *  off. */
export const sentMessage = (target: PlaybackDestination, sent: Sent): string | null => {
	if (sent.ok || sent.why === "overtaken" || sent.why === "declined") return null;
	if (sent.why === "blocked")
		return target.kind === "airplay"
			? airplayBlockedMessage(sent.decision)
			: blockerText(sent.decision.reason, sent.decision.detail);
	const why = tvFailureMessage(target.name, sent.error);
	// A route that failed leaves the TV playing, unless it let go of its
	// stream to look again. A load that failed played nothing there.
	const stopped = sent.why === "failed" || sent.released;
	return stopped ? `${why} Nothing is playing.` : why;
};

/** `destination`, if it's a `kind` one. */
export const ofKind = <T extends PlaybackDestination>(
	destination: PlaybackDestination | null,
	kind: T["kind"]
): T | null => (destination?.kind === kind ? (destination as T) : null);

export interface NowPlaying {
	getState(): NowPlayingState;
	subscribe(listener: () => void): () => void;
	/**
	 * Plays `channel` on `target` from `startAt`: works out the route unless
	 * the picker did, asks before converting, stops this device's player,
	 * stops another TV that played, and loads. A route that fails while the
	 * target plays lets go of its stream and looks again, and a load right
	 * after this device let go of a stream asks the provider again if it's
	 * refused. The newest send wins.
	 */
	send(target: PlaybackDestination, channel: Channel, opts: SendOptions): Promise<Sent>;
	/** Stops the TV and forgets it, saving where it got to. */
	stop(): Promise<void>;
	/** Saves where the TV got to now. */
	flush(): Promise<void> | undefined;
	/** Forgets why the last TV ended. */
	dismiss(): void;
}

export const createNowPlaying = ({
	wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: {
	wait?: (ms: number) => Promise<void>;
} = {}): NowPlaying => {
	let state: NowPlayingState = { destination: null, channel: null, ended: null };
	const listeners = new Set<() => void>();
	/** The newest send's token. A newer send or a stop puts in another. */
	let token = {};
	let progress: PlaybackProgress = EMPTY_PROGRESS;
	let ends: SendOptions["ends"];
	let unfollow = () => {};

	const publish = (next: Partial<NowPlayingState>) => {
		state = { ...state, ...next };
		for (const listener of listeners) listener();
	};

	/** Ends a TV that's over, and keeps the resume point of `channel`, once
	 *  it got to where it was started from. */
	const follow = (channel: Channel) => (s: PlaybackState) => {
		const why = ends?.(s) ?? null;
		if (why !== null) {
			void stop().catch(() => {});
			publish({ ended: why });
			return;
		}
		const p = progress;
		if (!p.key || s.item?.ref !== channel.id) return;
		// Stryker disable next-line ConditionalExpression: With no start to wait for, null - 5 is below any position, so the check passes either way.
		if (p.pendingStart !== null) {
			if (s.position < p.pendingStart - 5) return;
			p.pendingStart = null;
		}
		const next = airplayProgress(p, s, Date.now(), PROGRESS_SAVE_INTERVAL);
		if (!next) return;
		Object.assign(p, next.progress);
		if (next.save) void saveProgress(p);
	};

	const activate = (destination: PlaybackDestination, channel: Channel, opts: SendOptions) => {
		void saveProgress(progress);
		unfollow();
		progress = progressFor(channel, opts.startAt);
		ends = opts.ends ?? (state.destination === destination ? ends : undefined);
		publish({ destination, channel, ended: null });
		unfollow = destination.subscribe(follow(channel));
	};

	const stop = async () => {
		token = {};
		const left = state.destination;
		if (!left) return;
		void saveProgress(progress);
		unfollow();
		unfollow = () => {};
		progress = EMPTY_PROGRESS;
		ends = undefined;
		publish({ destination: null, channel: null });
		try {
			await left.stop();
		} finally {
			left.dispose?.();
		}
	};

	const send: NowPlaying["send"] = async (target, channel, opts) => {
		const mine = {};
		token = mine;
		const newest = () => token === mine;
		const overtaken = { ok: false, why: "overtaken" } as const;
		/** What this send came to when it sent nothing. A TV that let go of
		 *  its stream for it has stopped, so it goes, unless a newer send or
		 *  a stop took over, which has the TV now. */
		const unsent = (sent: Sent & { released: boolean }): Sent => {
			if (!newest()) return overtaken;
			if (sent.released) void stop().catch(() => {});
			return sent;
		};
		const item = { kind: "local" as const, channel };
		let decision = opts.decision;
		let released = false;
		if (!decision) {
			const look = () =>
				target.route(item).then(
					(d): { decision: RouteDecision } | { error: unknown } => ({ decision: d }),
					(error: unknown) => ({ error })
				);
			let routed = await look();
			// The TV that plays may hold the provider's only connection. It lets
			// go of it, keeping its session, and looks again.
			if ("error" in routed && state.destination === target && target.release) {
				// One that couldn't say may have let go.
				released = await target.release().catch(() => true);
				if (released)
					for (const ms of RELEASE_RETRY_MS) {
						await wait(ms);
						if (!newest()) return overtaken;
						routed = await look();
						if (!("error" in routed)) break;
					}
			}
			if ("error" in routed)
				return unsent({ ok: false, why: "unrouted", error: routed.error, released });
			decision = routed.decision;
		}
		if (!newest()) return overtaken;
		if (!decision.ok) return unsent({ ok: false, why: "blocked", decision, released });
		const { route } = decision;
		if (route.via === "converted" && opts.confirm && !(await opts.confirm(route.keep)))
			return unsent({ ok: false, why: "declined", released });
		// Nothing is stopped for a send something overtook while it asked.
		if (!newest()) return overtaken;
		await opts.stopLocal();
		if (!newest()) return overtaken;
		const old = state.destination;
		const switching = old === target;
		if (old && !switching)
			void old
				.stop()
				.catch(() => {})
				.finally(() => old.dispose?.());
		activate(target, channel, opts);
		// Something just let go of the stream: this device's player, another
		// TV, or this TV for the route. A TV that only switches items closes
		// its own. The TV asks again if the provider still counts it.
		const freed = !switching || released;
		return target.load(item, { startAt: opts.startAt, route, freed }).then(
			() => ({ ok: true }) as const,
			(error: unknown): Sent => {
				// The backend says a newer load or a stop came, which says for itself.
				if (!newest() || error === SUPERSEDED) return overtaken;
				if (!switching) void stop().catch(() => {});
				return { ok: false, why: "failed", error, switching };
			}
		);
	};

	return {
		getState: () => state,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		send,
		stop,
		flush: () => saveProgress(progress),
		dismiss: () => publish({ ended: null }),
	};
};

/** The app's one store. */
export const nowPlaying = createNowPlaying();
