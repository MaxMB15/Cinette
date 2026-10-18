// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import {
	AIRPLAY_AVAILABLE_EVENT,
	AIRPLAY_PICKER_CLOSED_EVENT,
	AIRPLAY_ROUTE_EVENT,
	AIRPLAY_STATE_EVENT,
	airplaySender,
	createAirPlayDestination,
	type AirPlayBridge,
	type AirPlayDestination,
	type AirPlayNativeState,
	type AirPlayRoute,
} from "@/lib/airplay";
import type { PlaybackState } from "@/lib/destination";
import type { RouteDecision } from "@/lib/route";
import type { ConverterSupport } from "@/lib/route-profiles";
import {
	airplayChoose,
	airplayConverterSupport,
	airplayEndConversion,
	airplayGetRoute,
	airplayLoad,
	airplayLoadConverted,
	airplayPause,
	airplayPlay,
	airplaySeek,
	airplaySelectAudio,
	airplaySelectSubtitle,
	airplaySetDetection,
	airplayStop,
	getStreamFormats,
	mpvGetMediaInfo,
} from "@/lib/tauri";
import type { Channel } from "@/lib/types";

/** How long after the picker closes a route change may still arrive. */
const ROUTE_GRACE_MS = 1000;

/** What a device that can't convert offers, until the backend says. */
const NO_CONVERTER: ConverterSupport = { convert: false, hardwareEncoder: false };

const bridge: AirPlayBridge = {
	// This device plays the channel while the picker is open, so mpv says
	// what it is, and the provider isn't asked for a second connection.
	formats: async (channel) => getStreamFormats(channel, await mpvGetMediaInfo()),
	load: airplayLoad,
	loadConverted: airplayLoadConverted,
	endConversion: airplayEndConversion,
	play: airplayPlay,
	pause: airplayPause,
	seek: airplaySeek,
	selectSubtitle: airplaySelectSubtitle,
	selectAudio: airplaySelectAudio,
	stop: airplayStop,
	listen: (handler) =>
		listen<AirPlayNativeState>(AIRPLAY_STATE_EVENT, (event) => handler(event.payload)),
	now: () => performance.now(),
};

// Stryker disable next-line ArrowFunction: React skips an unsubscribe that isn't a function, and this one does nothing.
const noState = () => () => {};
const getNull = () => null;

/** The receiver the user picks, or `null` if they close the picker. */
const choose = (anchor: DOMRect) =>
	new Promise<AirPlayRoute | null>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const listeners = [
			listen<AirPlayRoute | null>(AIRPLAY_ROUTE_EVENT, (e) => {
				if (e.payload) finish(e.payload);
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

/** What sending the current item to AirPlay came to. */
export type SendResult =
	| { sent: true }
	| { sent: false; why: "cancelled" }
	| { sent: false; why: "blocked"; decision: Extract<RouteDecision, { ok: false }> }
	| { sent: false; why: "failed"; error: unknown };

export interface AirPlay {
	/** A receiver is in reach, so the AirPlay button shows. */
	available: boolean;
	/** The receiver AirPlay video plays on, while it does. */
	destination: AirPlayDestination | null;
	/** The destination's state, or `null` while nothing plays over AirPlay. */
	state: PlaybackState | null;
	/**
	 * Has the user pick a receiver, then sends `channel` there from
	 * `startAt`. When this device has to convert the stream, `confirm` asks
	 * the user first. `stopLocal` stops this device's player once the route
	 * is settled, before the receiver connects, since many accounts allow
	 * one connection at a time.
	 */
	send: (
		channel: Channel,
		opts: {
			anchor: DOMRect;
			startAt?: number;
			stopLocal: () => Promise<void>;
			confirm: () => Promise<boolean>;
		}
	) => Promise<SendResult>;
	/** Stops AirPlay video. */
	stop: () => Promise<void>;
}

/**
 * AirPlay for the player page, on iOS. Off elsewhere, where every field
 * stays empty. Leaving the page stops AirPlay.
 */
export const useAirPlay = (enabled: boolean): AirPlay => {
	const [available, setAvailable] = useState(false);
	const [route, setRoute] = useState<AirPlayRoute | null>(null);
	const [destination, setDestination] = useState<AirPlayDestination | null>(null);
	const [support, setSupport] = useState(NO_CONVERTER);

	useEffect(() => {
		if (!enabled) return;
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
		void airplayConverterSupport()
			.then((s) => {
				if (current) setSupport(s);
			})
			.catch(() => {});
		return () => {
			current = false;
			for (const p of unlisten) void p.then((fn) => fn());
			void airplaySetDetection(false).catch(() => {});
		};
	}, [enabled]);

	// Leaving the page ends AirPlay, as the stop button ends local playback.
	useEffect(() => {
		if (!destination) return;
		return () => {
			void destination.stop().catch(() => {});
			destination.dispose();
		};
	}, [destination]);

	const subscribe = destination ? destination.subscribe : noState;
	const getState = destination ? destination.getState : getNull;
	const state = useSyncExternalStore(subscribe, getState);

	const send = useCallback<AirPlay["send"]>(
		async (channel, { anchor, startAt, stopLocal, confirm }) => {
			try {
				const picked = route ?? (await choose(anchor));
				if (!picked) return { sent: false, why: "cancelled" };
				const target = createAirPlayDestination(picked, bridge, airplaySender(support));
				const item = { kind: "local" as const, channel };
				const decision = await target.route(item);
				if (!decision.ok) {
					target.dispose();
					return { sent: false, why: "blocked", decision };
				}
				if (decision.route.via === "converted" && !(await confirm())) {
					target.dispose();
					return { sent: false, why: "cancelled" };
				}
				await stopLocal();
				setDestination(target);
				try {
					await target.load(item, { route: decision.route, startAt });
				} catch (error) {
					// Nothing plays on the TV, so the panel goes, and the player
					// says why. React may never have shown this destination, so
					// its cleanup can't be left to the effect.
					setDestination(null);
					await target.stop().catch(() => {});
					target.dispose();
					throw error;
				}
				return { sent: true };
			} catch (error) {
				return { sent: false, why: "failed", error };
			}
		},
		[route, support]
	);

	return {
		available: enabled && (available || route !== null),
		destination,
		state,
		send,
		stop: async () => setDestination(null),
	};
};
