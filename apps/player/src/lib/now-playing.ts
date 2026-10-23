// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/**
 * The TV something plays on, over AirPlay or Google Cast, for the whole
 * app. It outlives the player page, so leaving the page keeps the TV
 * playing. One send starts an item there, whichever kind of TV it is, and
 * the store keeps the item's resume point while it plays.
 */

import { airplayProgress } from "./airplay";
import type { PlaybackDestination, PlaybackState } from "./destination";
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
	/** Says why the TV ended, for one that ends when its connection is lost.
	 *  Without it, a lost TV stays until it's stopped. */
	lost?: () => string;
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
	let lost: (() => string) | undefined;
	let unfollow = () => {};

	const publish = (next: Partial<NowPlayingState>) => {
		state = { ...state, ...next };
		for (const listener of listeners) listener();
	};

	/** Keeps the resume point of what plays, once it got to where it was
	 *  started from, and ends a TV that ends when it's lost. */
	const follow = (destination: PlaybackDestination) => (s: PlaybackState) => {
		if (state.destination !== destination) return;
		if (s.connection === "lost" && lost) {
			const why = lost();
			void stop().catch(() => {});
			publish({ ended: why });
			return;
		}
		const p = progress;
		if (!p.key || s.item?.ref !== state.channel?.id) return;
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
		lost = opts.lost;
		publish({ destination, channel, ended: null });
		unfollow = destination.subscribe(follow(destination));
	};

	const stop = async () => {
		token = {};
		const left = state.destination;
		if (!left) return;
		void saveProgress(progress);
		unfollow();
		unfollow = () => {};
		progress = EMPTY_PROGRESS;
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
				released = true;
				await target.release().catch(() => {});
				for (const ms of RELEASE_RETRY_MS) {
					await wait(ms);
					if (!newest()) return overtaken;
					routed = await look();
					if (!("error" in routed)) break;
				}
			}
			if ("error" in routed)
				return { ok: false, why: "unrouted", error: routed.error, released };
			decision = routed.decision;
		}
		if (!newest()) return overtaken;
		if (!decision.ok) return { ok: false, why: "blocked", decision, released };
		const { route } = decision;
		if (route.via === "converted" && opts.confirm && !(await opts.confirm(route.keep)))
			return { ok: false, why: "declined", released };
		// Nothing is stopped for a send something overtook while it asked.
		if (!newest()) return overtaken;
		await opts.stopLocal();
		if (!newest()) return overtaken;
		const old = state.destination;
		const switching = old === target;
		if (old && !switching) {
			void old.stop().catch(() => {});
			old.dispose?.();
		}
		activate(target, channel, opts);
		// Unless the TV switches items, this device's player or another TV
		// just let go of the stream, and the TV asks again if the provider
		// still counts that connection.
		return target.load(item, { startAt: opts.startAt, route, freed: !switching }).then(
			() => ({ ok: true }) as const,
			(error: unknown): Sent => {
				if (!newest()) return overtaken;
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
		dismiss: () => publish({ ended: null }),
	};
};

/** The app's one store. */
export const nowPlaying = createNowPlaying();
