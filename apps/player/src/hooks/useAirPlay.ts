// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import {
	AIRPLAY_AVAILABLE_EVENT,
	AIRPLAY_PICKER_CLOSED_EVENT,
	AIRPLAY_ROUTE_EVENT,
	AIRPLAY_STATE_EVENT,
	createAirPlayDestination,
	type AirPlayBridge,
	type AirPlayDestination,
	type AirPlayNativeState,
	type AirPlayRoute,
} from "@/lib/airplay";
import type { PlaybackState } from "@/lib/destination";
import type { RouteDecision } from "@/lib/route";
import {
	airplayChoose,
	airplayGetRoute,
	airplayLoad,
	airplayPause,
	airplayPlay,
	airplaySeek,
	airplaySelectAudio,
	airplaySelectSubtitle,
	airplaySetDetection,
	airplayStop,
	getStreamFormats,
} from "@/lib/tauri";
import type { Channel } from "@/lib/types";

/** How long after the picker closes a route change may still arrive. */
const ROUTE_GRACE_MS = 1000;

const bridge: AirPlayBridge = {
	// This device plays the channel while the picker is open, so the
	// backend asks mpv, and the provider isn't asked for a second connection.
	formats: getStreamFormats,
	load: airplayLoad,
	play: airplayPlay,
	pause: airplayPause,
	seek: airplaySeek,
	selectSubtitle: airplaySelectSubtitle,
	selectAudio: airplaySelectAudio,
	stop: airplayStop,
	listen: (handler) =>
		listen<AirPlayNativeState>(AIRPLAY_STATE_EVENT, (event) => handler(event.payload)),
	now: () => performance.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// Stryker disable next-line ArrowFunction: React skips an unsubscribe that isn't a function, and this one does nothing.
const noState = () => () => {};
const getNull = () => null;

/** Where AirPlay's route check runs before a receiver is known. The route
 *  doesn't depend on the receiver, since every one gets the same profile. */
// Stryker disable next-line ObjectLiteral, StringLiteral: Nothing shows this receiver or plays on it: it only checks the route, which is the same for every receiver.
const ANY_RECEIVER: AirPlayRoute = { id: "airplay", name: "AirPlay" };

/**
 * Opens the system picker and resolves once the audio route goes where
 * `done` wants, or with `null` when the picker closes without that. A route
 * change can come just after the picker closes, so it waits a moment.
 */
const pick = (anchor: DOMRect, done: (route: AirPlayRoute | null) => boolean) =>
	new Promise<AirPlayRoute | null>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const listeners = [
			listen<AirPlayRoute | null>(AIRPLAY_ROUTE_EVENT, (e) => {
				if (done(e.payload)) finish(e.payload);
			}),
			listen(AIRPLAY_PICKER_CLOSED_EVENT, () => {
				timer = setTimeout(() => finish(null), ROUTE_GRACE_MS);
			}),
		];
		const unlisten = () => {
			for (const p of listeners) void p.then((fn) => fn());
		};
		const finish = (picked: AirPlayRoute | null) => {
			clearTimeout(timer);
			unlisten();
			resolve(picked);
		};
		airplayChoose({
			x: anchor.x,
			y: anchor.y,
			width: anchor.width,
			height: anchor.height,
		}).catch((e) => {
			unlisten();
			reject(e);
		});
	});

/** The receiver the user picks, or `null` if they close the picker. */
const choose = (anchor: DOMRect) => pick(anchor, (route) => route !== null);

/** The picker again, for the user to pick this device, so the sound comes
 *  back with the picture. */
const chooseHere = (anchor: DOMRect) => pick(anchor, (route) => route === null);

/** What sending the current item to AirPlay came to. `stopped` says local
 *  playback was already stopped when it failed, so nothing plays. */
export type SendResult =
	| { sent: true }
	| { sent: false; why: "cancelled" }
	| { sent: false; why: "blocked"; decision: Extract<RouteDecision, { ok: false }> }
	| { sent: false; why: "failed"; error: unknown; stopped: boolean };

export interface AirPlay {
	/** A receiver is in reach, so the AirPlay button shows. */
	available: boolean;
	/** The receiver AirPlay video plays on, while it does. */
	destination: AirPlayDestination | null;
	/** The destination's state, or `null` while nothing plays over AirPlay. */
	state: PlaybackState | null;
	/**
	 * Has the user pick a receiver, then sends `channel` there from
	 * `startAt`. `stopLocal` stops this device's player once the route is
	 * known, before the receiver connects, since many accounts allow one
	 * connection at a time.
	 */
	send: (
		channel: Channel,
		opts: { anchor: DOMRect; startAt?: number; stopLocal: () => Promise<void> }
	) => Promise<SendResult>;
	/** Stops AirPlay video, and resolves once it has. */
	stop: () => Promise<void>;
	/**
	 * Opens the system picker for the user to pick this device, so the sound
	 * comes back too, then stops AirPlay. Stopping AirPlay alone leaves the
	 * sound on the receiver.
	 */
	returnHere: (anchor: DOMRect) => Promise<void>;
}

/**
 * AirPlay for the player page, on iOS. Off elsewhere, where every field
 * stays empty. Leaving the page stops AirPlay.
 */
export const useAirPlay = (enabled: boolean): AirPlay => {
	const [available, setAvailable] = useState(false);
	const [route, setRoute] = useState<AirPlayRoute | null>(null);
	const [destination, setDestination] = useState<AirPlayDestination | null>(null);
	// The destination AirPlay plays on, for the cleanup when the page goes
	// and for sends that finish after it has.
	const active = useRef<AirPlayDestination | null>(null);
	// Stryker disable next-line BooleanLiteral: The effect below sets it before any send can run.
	const mounted = useRef(false);

	useEffect(() => {
		mounted.current = true;
		// Leaving the page ends AirPlay, as the stop button ends local
		// playback.
		const leave = () => {
			mounted.current = false;
			const left = active.current;
			active.current = null;
			if (left) {
				void left.stop().catch(() => {});
				left.dispose();
			}
		};
		if (!enabled) return leave;
		let current = true;
		const unlisten = [
			listen<boolean>(AIRPLAY_AVAILABLE_EVENT, (e) => setAvailable(e.payload)),
			listen<AirPlayRoute | null>(AIRPLAY_ROUTE_EVENT, (e) => setRoute(e.payload)),
		];
		void airplaySetDetection(true).catch(() => {});
		void airplayGetRoute()
			.then((r) => {
				if (current) setRoute(r);
			})
			.catch(() => {});
		return () => {
			current = false;
			for (const p of unlisten) void p.then((fn) => fn());
			void airplaySetDetection(false).catch(() => {});
			leave();
		};
	}, [enabled]);

	const subscribe = destination ? destination.subscribe : noState;
	const getState = destination ? destination.getState : getNull;
	const state = useSyncExternalStore(subscribe, getState);

	/** Stops `target`, the one playing, and forgets it. */
	const end = async (target: AirPlayDestination) => {
		active.current = null;
		setDestination(null);
		await target.stop().catch(() => {});
		target.dispose();
	};

	const send = useCallback<AirPlay["send"]>(
		async (channel, { anchor, startAt, stopLocal }) => {
			const item = { kind: "local" as const, channel };
			// Whether this device stopped, which a failure reports. The React
			// Compiler can't compile a try with a throw or a `??` in it, so
			// failures are caught on the promise.
			const progress = { stopped: false };
			const attempt = async (): Promise<SendResult> => {
				// The item is checked before the picker opens: picking a TV
				// moves this device's sound there, even for an item it can't
				// play.
				const check = createAirPlayDestination(ANY_RECEIVER, bridge);
				const decision = await check.route(item).finally(() => check.dispose());
				if (!decision.ok) return { sent: false, why: "blocked", decision };
				if (!mounted.current) return { sent: false, why: "cancelled" };
				const picked = route ?? (await choose(anchor));
				if (!picked || !mounted.current) return { sent: false, why: "cancelled" };
				const target = createAirPlayDestination(picked, bridge);
				const settled = await target.route(item);
				// The page went while the check ran: nothing starts, and this
				// device keeps playing.
				if (!mounted.current || !settled.ok) {
					target.dispose();
					return settled.ok
						? { sent: false, why: "cancelled" }
						: { sent: false, why: "blocked", decision: settled };
				}
				await stopLocal();
				progress.stopped = true;
				if (!mounted.current) {
					target.dispose();
					return { sent: false, why: "cancelled" };
				}
				active.current = target;
				setDestination(target);
				const failed = await target.load(item, { route: settled.route, startAt }).then(
					() => null,
					(error: unknown) => ({ error })
				);
				if (failed) {
					// Nothing plays on the TV, so the panel goes, and the player
					// says why.
					await end(target);
					return { sent: false, why: "failed", error: failed.error, stopped: true };
				}
				return { sent: true };
			};
			return attempt().catch((error: unknown): SendResult => ({
				sent: false,
				why: "failed",
				error,
				stopped: progress.stopped,
			}));
		},
		[route]
	);

	const stop = async () => {
		const playing = active.current;
		if (playing) await end(playing);
	};

	const returnHere = async (anchor: DOMRect) => {
		// Only an AirPlay route has the sound somewhere else.
		if (route) await chooseHere(anchor).catch(() => {});
		await stop();
	};

	return {
		available: enabled && (available || route !== null),
		destination,
		state,
		send,
		stop,
		returnHere,
	};
};
