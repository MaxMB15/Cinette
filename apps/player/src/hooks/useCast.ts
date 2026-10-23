// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useLatestRef } from "@/hooks/useLatestRef";
import { useDestinationState } from "@/hooks/useDestinationState";
import { useNowPlaying } from "@/hooks/useNowPlaying";
import { readStreamThrough } from "@/lib/player-prefs";
import {
	createCastDestination,
	type CastBackend,
	type CastDestination,
} from "@/lib/cast-destination";
import { castEndedMessage, castStatus, newerList } from "@/lib/cast";
import type { ExternalSubtitle, PlaybackState } from "@/lib/destination";
import type { DestinationStatus } from "@/lib/device-picker";
import { nowPlaying, ofKind, sentMessage } from "@/lib/now-playing";
import type { RouteDecision } from "@/lib/route";
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

const NO_RECEIVERS: CastReceiver[] = [];

/** Each receiver's destination. They outlive the player page, as a cast
 *  does, so the one that plays keeps getting its receiver's updates. */
const destinations = new Map<string, CastDestination>();
let following: Promise<unknown> | null = null;

/** Passes the receivers' updates to their destinations from the first
 *  use on, for as long as the app runs. */
const followUpdates = () => {
	following ??= listen<{ receiverId: string; update: CastUpdate }>(CAST_UPDATE_EVENT, (e) =>
		destinations.get(e.payload.receiverId)?.receive(e.payload.update)
	).catch(() => {
		following = null;
	});
};

const destinationFor = (receiver: CastReceiver): CastDestination => {
	let found = destinations.get(receiver.id);
	if (!found) {
		// "Stream through this computer", from Settings: convert even what a
		// receiver could fetch itself, so it never gets the provider's link.
		found = createCastDestination(receiver, backend, { streamThrough: readStreamThrough });
		destinations.set(receiver.id, found);
	}
	return found;
};

/** The cast playing, if what plays is one. */
const castPlaying = () => ofKind<CastDestination>(nowPlaying.getState().destination, "cast");

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
			subtitle?: ExternalSubtitle | null;
			stopLocal: () => Promise<void>;
			confirm?: (keep: "on" | "onScreen") => Promise<boolean>;
		}
	) => Promise<string | null>;
	/** Ends the cast. */
	stop: () => Promise<void>;
}

/**
 * Google Cast, on macOS and Linux: the receivers, the picker's routes, and
 * sending to one. Off elsewhere, where every list stays empty. A cast keeps
 * playing when the player page closes; the now-playing store holds it.
 */
export const useCast = (enabled: boolean): Cast => {
	const [list, setList] = useState<CastReceiverList | null>(null);
	const [statuses, setStatuses] = useState<ReadonlyMap<string, DestinationStatus>>(new Map());
	const [vpnActive, setVpnActive] = useState(false);
	const playing = useNowPlaying().destination;
	const destination = ofKind<CastDestination>(playing, "cast");
	/** The routes the picker showed, by receiver and channel. */
	const decisions = useRef(new Map<string, RouteDecision>());
	const checking = useRef(0);
	/** What the open picker checks, and the receivers it asked about. */
	const picking = useRef<{ channel: Channel; asked: Set<string> } | null>(null);
	const [held, setHeld] = useState<string[]>([]);

	useEffect(() => {
		if (!enabled) return;
		let current = true;
		followUpdates();
		const unlisten = [
			listen<CastReceiverList>(CAST_RECEIVERS_EVENT, (e) =>
				setList((old) => newerList(old, e.payload))
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

	/** Works out `receiver`'s route for `channel`, for the picker's run
	 *  `run`, and notes in `asked` that it did. */
	const ask = useCallback(
		(receiver: CastReceiver, channel: Channel, run: number, asked: Set<string>) => {
			asked.add(receiver.id);
			destinationFor(receiver)
				.route({ kind: "local", channel })
				.catch((): RouteDecision => ({ ok: false, reason: "unreachable" }))
				.then((decision) => {
					if (run !== checking.current) return;
					decisions.current.set(routeKey(receiver.id, channel), decision);
					setStatuses((old) => new Map(old).set(receiver.id, castStatus(decision)));
				});
		},
		// Stryker disable next-line ArrayDeclaration: It only uses module functions, refs and a state setter, so it's the same function with any deps.
		[]
	);

	const check = useCallback(
		(channel: Channel) => {
			const run = ++checking.current;
			decisions.current = new Map();
			setStatuses(new Map());
			const asked = new Set<string>();
			picking.current = { channel, asked };
			setHeld(receiversRef.current.map((r) => r.id));
			void getVpnActive()
				.then((on) => {
					if (run === checking.current) setVpnActive(on);
				})
				.catch(() => {});
			for (const receiver of receiversRef.current.filter((r) => r.available))
				ask(receiver, channel, run, asked);
		},
		// Stryker disable next-line ArrayDeclaration: ask never changes and receiversRef is a ref, so the function is the same with any deps.
		[ask, receiversRef]
	);

	// A receiver found, or back, while the picker is open is checked too.
	useEffect(() => {
		const open = picking.current;
		if (!open) return;
		for (const receiver of receivers)
			if (receiver.available && !open.asked.has(receiver.id))
				ask(receiver, open.channel, checking.current, open.asked);
	}, [receivers, ask]);

	const release = useCallback(
		() => {
			++checking.current;
			picking.current = null;
			setHeld([]);
		},
		// Stryker disable next-line ArrayDeclaration: It only uses a ref and a state setter, so it's the same function with any deps.
		[]
	);

	const state = useDestinationState(destination);

	const send: Cast["send"] = useCallback(
		async (receiverId, channel, opts) => {
			const receiver = receiversRef.current.find((r) => r.id === receiverId);
			if (!receiver) return "That receiver is gone.";
			const target = destinationFor(receiver);
			const sent = await nowPlaying.send(target, channel, {
				...opts,
				decision: decisions.current.get(routeKey(receiverId, channel)),
				// A cast that's lost goes back to this device, and says why.
				ends: (s) =>
					s.connection === "lost"
						? castEndedMessage(target.name, target.closedReason())
						: null,
			});
			return sentMessage(target, sent);
		},
		// Stryker disable next-line ArrayDeclaration: receiversRef is a ref, so the function is the same with any deps.
		[receiversRef]
	);

	const stop = useCallback(
		async () => {
			if (castPlaying()) await nowPlaying.stop();
		},
		// Stryker disable next-line ArrayDeclaration: It only uses module functions, so it's the same function with any deps.
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
		current: castPlaying,
		state: destination ? state : null,
		send,
		stop,
	};
};
