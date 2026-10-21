// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { useLatestRef } from "@/hooks/useLatestRef";
import { usePlayerPref } from "@/hooks/usePlayerPref";
import { readStreamThrough, STREAM_THROUGH_EVENT } from "@/lib/player-prefs";
import {
	createCastDestination,
	type CastBackend,
	type CastDestination,
} from "@/lib/cast-destination";
import { castEndedMessage, castFailureMessage, castStatus, newerList } from "@/lib/cast";
import type { PlaybackState } from "@/lib/destination";
import { blockerText, type DestinationStatus } from "@/lib/device-picker";
import type { PlayRoute, RouteDecision } from "@/lib/route";
import {
	CAST_RECEIVERS_EVENT,
	CAST_UPDATE_EVENT,
	castControl,
	castLoad,
	castRelease,
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
	castRelease,
};

// Stryker disable next-line ArrowFunction: React skips an unsubscribe that isn't a function, and this one does nothing.
const noState = () => () => {};
// Stryker disable next-line ArrowFunction: The state is only read while there's a destination, which has its own snapshot.
const getNull = () => null;
const NO_RECEIVERS: CastReceiver[] = [];

/**
 * How long to wait before each new look at an item, after a switch let go
 * of the stream. The receiver may take a moment to hang up on the
 * provider.
 */
export const RELEASE_RETRY_MS = [0, 1000, 2000];

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What working out a route came to: a decision, or why it couldn't. */
type Routed = { decision: RouteDecision } | { error: unknown };

/** The key of a route the picker showed. */
const routeKey = (receiverId: string, channel: Channel) => `${receiverId}\n${channel.id}`;

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
	/** The same, as of now rather than the last render: a stop or a lost
	 *  cast clears it at once. */
	current: () => CastDestination | null;
	/** Its state, or `null` while nothing is cast. */
	state: PlaybackState | null;
	/**
	 * Casts `channel` to `receiverId` from `startAt`, by the route the picker
	 * showed for it, or one worked out now. When this computer would convert
	 * it, `confirm` asks first, and a no casts nothing. `stopLocal` then
	 * stops this device's player, since many accounts allow one connection
	 * at a time. Resolves to why it couldn't, or `null`.
	 */
	send: (
		receiverId: string,
		channel: Channel,
		opts: {
			startAt?: number;
			stopLocal: () => Promise<void>;
			confirm?: (keep: "on" | "onScreen") => Promise<boolean>;
		}
	) => Promise<string | null>;
	/** Ends the cast. */
	stop: () => Promise<void>;
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
	// "Stream through this computer", from Settings: convert even what a
	// receiver could fetch itself, so it never gets the provider's link.
	const throughRef = useLatestRef(usePlayerPref(readStreamThrough, STREAM_THROUGH_EVENT));
	const destinations = useRef(new Map<string, CastDestination>());
	/** The routes the picker showed, by receiver and channel. */
	const decisions = useRef(new Map<string, RouteDecision>());
	const active = useRef<CastDestination | null>(null);
	const checking = useRef(0);
	const [held, setHeld] = useState<string[]>([]);

	const destinationFor = useCallback(
		(receiver: CastReceiver): CastDestination => {
			let found = destinations.current.get(receiver.id);
			if (!found) {
				found = createCastDestination(receiver, backend, {
					streamThrough: () => throughRef.current,
				});
				destinations.current.set(receiver.id, found);
			}
			return found;
		},
		// Stryker disable next-line ArrayDeclaration: throughRef is a ref, so the function is the same with any deps.
		[throughRef]
	);

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
						decisions.current.set(routeKey(receiver.id, channel), decision);
						setStatuses((old) => new Map(old).set(receiver.id, castStatus(decision)));
					});
			}
		},
		// Stryker disable next-line ArrayDeclaration: destinationFor never changes and receiversRef is a ref, so the function is the same with any deps.
		[destinationFor, receiversRef]
	);

	const release = useCallback(
		() => {
			++checking.current;
			setHeld([]);
		},
		// Stryker disable next-line ArrayDeclaration: It only uses a ref and a state setter, so it's the same function with any deps.
		[]
	);

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
			reportRef.current(castEndedMessage(destination.name, destination.closedReason()));
		});
	}, [destination, reportRef]);

	const send: Cast["send"] = useCallback(
		async (receiverId, channel, opts) => {
			const receiver = receiversRef.current.find((r) => r.id === receiverId);
			if (!receiver) return "That receiver is gone.";
			const target = destinationFor(receiver);
			const item = { kind: "local" as const, channel };
			const look = (): Promise<Routed> =>
				target.route(item).then(
					(decision) => ({ decision }),
					(error: unknown) => ({ error })
				);
			let released = false;
			/** The route to load by, or why there's none. */
			const prepare = async (): Promise<{ route: PlayRoute } | { why: string | null }> => {
				const shown = decisions.current.get(routeKey(receiverId, channel));
				let routed: Routed = shown ? { decision: shown } : await look();
				// While this receiver plays, the provider may refuse a second
				// connection, as many accounts allow one. It lets go of the
				// stream, keeping the cast, and looks again.
				if ("error" in routed && active.current === target) {
					released = true;
					await target.release().catch(() => {});
					for (const ms of RELEASE_RETRY_MS) {
						await wait(ms);
						routed = await look();
						if (!("error" in routed)) break;
					}
					if ("error" in routed) {
						const why = castFailureMessage(receiver.name, routed.error);
						return { why: `${why} Nothing is playing.` };
					}
				}
				if ("error" in routed) return { why: blockerText("unreachable") };
				const { decision } = routed;
				if (!decision.ok) return { why: blockerText(decision.reason, decision.detail) };
				const { route } = decision;
				if (route.via === "converted" && opts.confirm && !(await opts.confirm(route.keep)))
					return { why: null };
				return { route };
			};
			const ready = await prepare();
			if ("why" in ready) {
				// A cast that let go of its stream has stopped.
				if (released) target.settle();
				return ready.why;
			}
			const { route } = ready;
			await opts.stopLocal();
			const old = active.current;
			if (old && old !== target) void old.stop().catch(() => {});
			active.current = target;
			setDestination(target);
			// On the promise, since the React Compiler can't compile a
			// condition inside `catch`.
			return target.load(item, { startAt: opts.startAt, route }).then(
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
		// Stryker disable next-line ArrayDeclaration: destinationFor never changes and receiversRef is a ref, so the function is the same with any deps.
		[destinationFor, receiversRef]
	);

	const stop = useCallback(
		async () => {
			const left = active.current;
			active.current = null;
			setDestination(null);
			if (left) await left.stop();
		},
		// Stryker disable next-line ArrayDeclaration: It only uses a ref and a state setter, so it's the same function with any deps.
		[]
	);

	return {
		receivers,
		localNetworkDenied: list?.localNetworkDenied ?? false,
		vpnActive,
		statuses,
		check,
		release,
		destination,
		// Stryker disable next-line ArrayDeclaration: It only reads a ref, so it's the same function with any deps.
		current: useCallback(() => active.current, []),
		state: destination ? state : null,
		send,
		stop,
	};
};
