// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { useLatestRef } from "@/hooks/useLatestRef";
import {
	createCastDestination,
	type CastBackend,
	type CastDestination,
} from "@/lib/cast-destination";
import { castEndedMessage, castFailureMessage, castStatus, newerList } from "@/lib/cast";
import type { PlaybackState } from "@/lib/destination";
import { blockerText, type DestinationStatus } from "@/lib/device-picker";
import type { RouteDecision } from "@/lib/route";
import {
	CAST_RECEIVERS_EVENT,
	CAST_UPDATE_EVENT,
	castControl,
	castLoad,
	castStop,
	getCastReceivers,
	getConverterSupport,
	getStreamFormats,
	getVpnActive,
	holdCastReceivers,
	type CastReceiver,
	type CastReceiverList,
	type CastUpdate,
} from "@/lib/tauri";
import type { Channel } from "@/lib/types";

const backend: CastBackend = {
	// While this device plays the channel, the backend asks mpv, so the
	// provider isn't asked for a second connection.
	getStreamFormats,
	getConverterSupport,
	castLoad,
	castControl,
	castStop,
};

/** Where "Stream through this computer" is kept. */
const THROUGH_KEY = "cinette.cast.streamThrough";

const readThrough = (): boolean => {
	try {
		return localStorage.getItem(THROUGH_KEY) === "1";
	} catch {
		return false;
	}
};

const writeThrough = (on: boolean) => {
	const value = on ? "1" : "0";
	try {
		localStorage.setItem(THROUGH_KEY, value);
	} catch {
		// Kept for this run only.
	}
};

// Stryker disable next-line ArrowFunction: React skips an unsubscribe that isn't a function, and this one does nothing.
const noState = () => () => {};
const getNull = () => null;
const NO_RECEIVERS: CastReceiver[] = [];

export interface Cast {
	/** The receivers found, those that went away while held included. */
	receivers: CastReceiver[];
	/** macOS keeps Cinette off the local network. */
	localNetworkDenied: boolean;
	/** A VPN holds this device's default route, which often blocks the
	 *  local network. Asked again each time the picker opens. */
	vpnActive: boolean;
	/** How the item checked last would reach each receiver. */
	statuses: ReadonlyMap<string, DestinationStatus>;
	/** Works out each receiver's route for `channel`, for the picker, and
	 *  keeps the receivers listed while it's open. */
	check: (channel: Channel) => void;
	/** The picker closed. */
	release: () => void;
	/** The receiver the player's controls drive, while casting. */
	destination: CastDestination | null;
	/** Its state, or `null` while nothing is cast. */
	state: PlaybackState | null;
	/**
	 * Casts `channel` to `receiverId` from `startAt`. `stopLocal` stops this
	 * device's player first, since many accounts allow one connection at a
	 * time. Resolves to why it couldn't, or `null`.
	 */
	send: (
		receiverId: string,
		channel: Channel,
		opts: { startAt?: number; stopLocal: () => Promise<void> }
	) => Promise<string | null>;
	/** Ends the cast. */
	stop: () => Promise<void>;
	/** "Stream through this computer": convert even what a receiver could
	 *  fetch itself, so the receiver never gets the provider's link. */
	streamThrough: boolean;
	setStreamThrough: (on: boolean) => void;
}

/**
 * Google Cast for the player page, on macOS and Linux. Off elsewhere,
 * where every list stays empty. Leaving the page ends the cast. `report`
 * says why a cast ended by itself.
 */
export const useCast = (enabled: boolean, report: (message: string) => void): Cast => {
	const [list, setList] = useState<CastReceiverList | null>(null);
	const [statuses, setStatuses] = useState<ReadonlyMap<string, DestinationStatus>>(new Map());
	const [destination, setDestination] = useState<CastDestination | null>(null);
	const [vpnActive, setVpnActive] = useState(false);
	const reportRef = useLatestRef(report);
	const [streamThrough, setThrough] = useState(readThrough);
	const throughRef = useRef(streamThrough);
	const destinations = useRef(new Map<string, CastDestination>());
	const decisions = useRef(new Map<string, RouteDecision>());
	const active = useRef<CastDestination | null>(null);
	const checking = useRef(0);
	const [held, setHeld] = useState<string[]>([]);

	const destinationFor = useCallback((receiver: CastReceiver): CastDestination => {
		let found = destinations.current.get(receiver.id);
		if (!found) {
			found = createCastDestination(receiver, backend, {
				streamThrough: () => throughRef.current,
			});
			destinations.current.set(receiver.id, found);
		}
		return found;
	}, []);

	useEffect(() => {
		if (!enabled) return;
		let current = true;
		const unlisten = [
			listen<CastReceiverList>(CAST_RECEIVERS_EVENT, (e) =>
				setList((old) => newerList(old, e.payload))
			),
			listen<{ receiverId: string; update: CastUpdate }>(CAST_UPDATE_EVENT, (e) =>
				destinations.current.get(e.payload.receiverId)?.receive(e.payload.update)
			),
		];
		void getCastReceivers()
			.then((l) => {
				if (current) setList((old) => newerList(old, l));
			})
			.catch(() => {});
		void getVpnActive()
			.then((on) => {
				if (current) setVpnActive(on);
			})
			.catch(() => {});
		return () => {
			current = false;
			for (const p of unlisten) void p.then((fn) => fn());
			// Leaving the page ends the cast, as the stop button ends local
			// playback.
			const left = active.current;
			active.current = null;
			if (left) void left.stop().catch(() => {});
		};
	}, [enabled]);

	// The active receiver and an open picker's rows stay listed if they go.
	const activeId = destination?.id;
	useEffect(() => {
		if (!enabled) return;
		const ids = activeId && !held.includes(activeId) ? [...held, activeId] : held;
		void holdCastReceivers(ids).catch(() => {});
	}, [enabled, held, activeId]);

	const receivers = list?.receivers ?? NO_RECEIVERS;
	const receiversRef = useLatestRef(receivers);

	const check = useCallback(
		(channel: Channel) => {
			const run = ++checking.current;
			decisions.current = new Map();
			setStatuses(new Map());
			const available = receiversRef.current.filter((r) => r.available);
			setHeld(receiversRef.current.map((r) => r.id));
			void getVpnActive()
				.then((on) => {
					if (run === checking.current) setVpnActive(on);
				})
				.catch(() => {});
			for (const receiver of available) {
				destinationFor(receiver)
					.route({ kind: "local", channel })
					.catch((): RouteDecision => ({ ok: false, reason: "unreachable" }))
					.then((decision) => {
						if (run !== checking.current) return;
						decisions.current.set(receiver.id, decision);
						setStatuses((old) => new Map(old).set(receiver.id, castStatus(decision)));
					});
			}
		},
		[destinationFor, receiversRef]
	);

	const release = useCallback(() => {
		++checking.current;
		setHeld([]);
	}, []);

	const state = useSyncExternalStore(
		destination?.subscribe ?? noState,
		destination?.getState ?? getNull
	);

	// A cast that's lost goes back to this device, and says why.
	useEffect(() => {
		if (!destination) return;
		return destination.subscribe((next) => {
			if (next.connection !== "lost" || active.current !== destination) return;
			active.current = null;
			setDestination(null);
			reportRef.current(
				castEndedMessage(destination.name, destination.closedReason()) ??
					`Lost the connection to ${destination.name}.`
			);
		});
	}, [destination, reportRef]);

	const send: Cast["send"] = useCallback(
		async (receiverId, channel, opts) => {
			const receiver = receiversRef.current.find((r) => r.id === receiverId);
			if (!receiver) return "That receiver is gone.";
			const target = destinationFor(receiver);
			const item = { kind: "local" as const, channel };
			const decision =
				decisions.current.get(receiverId) ??
				(await target
					.route(item)
					.catch((): RouteDecision => ({ ok: false, reason: "unreachable" })));
			if (!decision.ok) return blockerText(decision.reason, decision.detail);
			await opts.stopLocal();
			const old = active.current;
			if (old && old !== target) void old.stop().catch(() => {});
			active.current = target;
			setDestination(target);
			// On the promise, since the React Compiler can't compile a
			// condition inside `catch`.
			return target.load(item, { startAt: opts.startAt, route: decision.route }).then(
				() => null,
				(e: unknown) => {
					if (active.current === target) {
						active.current = null;
						setDestination(null);
						void target.stop().catch(() => {});
					}
					return `${castFailureMessage(receiver.name, e)} Nothing is playing.`;
				}
			);
		},
		[destinationFor, receiversRef]
	);

	const stop = useCallback(async () => {
		const left = active.current;
		active.current = null;
		setDestination(null);
		if (left) await left.stop();
	}, []);

	const setStreamThrough = useCallback((on: boolean) => {
		throughRef.current = on;
		setThrough(on);
		writeThrough(on);
	}, []);

	return {
		receivers,
		localNetworkDenied: list?.localNetworkDenied ?? false,
		vpnActive,
		statuses,
		check,
		release,
		destination,
		state: destination ? state : null,
		send,
		stop,
		streamThrough,
		setStreamThrough,
	};
};
