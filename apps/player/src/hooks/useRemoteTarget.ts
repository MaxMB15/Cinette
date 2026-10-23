// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { listen } from "@tauri-apps/api/event";
import { useChannels } from "@/hooks/useChannels";
import { useLatestRef } from "@/hooks/useLatestRef";
import type { PlaybackDestination } from "@/lib/destination";
import {
	applyRemoteCommand,
	getMountedPlayer,
	IDLE_REMOTE_STATE,
	remotePlayerState,
	setMountedPlayer,
	waitForMountedPlayer,
	type RemoteCommand,
} from "@/lib/remote-target";
import {
	mpvStop,
	remoteAnswerConsent,
	remoteBlocked,
	type BlockedDevice,
	type ConsentAnswer,
	remotePendingConsent,
	remoteFinishCommand,
	remoteSessions,
	remoteProgressSaved,
	remoteSetState,
	type RemoteAsked,
	type RemoteSession,
} from "@/lib/tauri";
import type { Channel } from "@/lib/types";
import { saveProgressNow } from "@/lib/player-progress";

/**
 * Listens to a Tauri event for as long as the component is mounted. The
 * handler is read when an event comes, so it can change without
 * listening again.
 */
export const useTauriEvent = <T>(event: string, handler: (payload: T) => void): void => {
	const handlerRef = useLatestRef(handler);
	useEffect(
		() => {
			let current = true;
			let unlisten: (() => void) | undefined;
			listen<T>(event, ({ payload }) => handlerRef.current(payload))
				.then((stop) => {
					if (current) unlisten = stop;
					else stop();
				})
				.catch(() => {});
			return () => {
				current = false;
				unlisten?.();
			};
		},
		// Stryker disable next-line ArrayDeclaration: every caller passes a fixed event name, and the ref never changes, so the effect runs once either way.
		[event, handlerRef]
	);
};

/**
 * Carries out the commands other Cinette devices send this one. Mounted
 * once, in `App`. A load with no player open opens the player page and
 * plays through it, so the play is this device's own and goes in its history.
 */
export const useRemoteTarget = (): void => {
	const { channels } = useChannels();
	const navigate = useNavigate();
	const channelsRef = useLatestRef(channels);
	const navigateRef = useLatestRef(navigate);
	useTauriEvent<{ token: number; command: RemoteCommand; channel?: Channel }>(
		"remote://command",
		({ token, command, channel }) => {
			void applyRemoteCommand(command, {
				player: getMountedPlayer(),
				// An episode comes with the command, since the channel list has none.
				findChannel: (id) =>
					channel?.id === id ? channel : channelsRef.current.find((c) => c.id === id),
				openPlayer: () => navigateRef.current("/player"),
				waitForPlayer: waitForMountedPlayer,
				stopWithoutPlayer: mpvStop,
			})
				.then((outcome) => remoteFinishCommand(token, outcome))
				.catch(() => {});
		}
	);
	// A controller is copying this device's history: the player saves where
	// it is first, and says what it has open.
	useTauriEvent<null>("remote://save-progress", () => {
		void saveProgressNow()
			.then((playing) => remoteProgressSaved(playing))
			.catch(() => {});
	});
};

/** A list the backend keeps: `load` once, then each `event` in its place.
 *  Empty where remote control doesn't run. */
const useBackendList = <T>(event: string, load: () => Promise<T[]>): T[] => {
	const [list, setList] = useState<T[]>([]);
	useTauriEvent<T[]>(event, setList);
	useEffect(
		() => {
			let current = true;
			load()
				.then((got) => {
					// Anything but a list, as from a backend without remote control, is none.
					if (current) setList(Array.isArray(got) ? got : []);
				})
				.catch(() => {});
			return () => {
				current = false;
			};
		},
		// Stryker disable next-line ArrayDeclaration: each caller passes a module function, which never changes, so the effect runs once either way.
		[load]
	);
	return list;
};

/** The devices controlling this one, kept up to date. */
export const useRemoteSessions = (): RemoteSession[] =>
	useBackendList("remote://sessions", remoteSessions);

/** The devices the user denied, kept up to date. */
export const useRemoteBlocked = (): BlockedDevice[] =>
	useBackendList("remote://blocked", remoteBlocked);

/**
 * Makes the player's destination the one remote commands act on, and while
 * a controller is connected, sends it every state the player reports.
 */
export const usePublishRemoteState = (
	player: PlaybackDestination,
	channel: Channel | null
): void => {
	const connected = useRemoteSessions().some((s) => s.connected);
	const channelRef = useLatestRef(channel);

	useEffect(() => {
		setMountedPlayer(player);
		return () => {
			if (getMountedPlayer() !== player) return;
			setMountedPlayer(null);
			// The page closed before it could report the player idle, so
			// controllers would keep showing what played. A new destination
			// for the same page takes over in the same commit, and says more.
			queueMicrotask(() => {
				if (getMountedPlayer() === null) remoteSetState(IDLE_REMOTE_STATE).catch(() => {});
			});
		};
	}, [player]);

	useEffect(() => {
		if (!connected) return;
		const send = (state: ReturnType<PlaybackDestination["getState"]>) => {
			const remote = remotePlayerState(
				state,
				channelRef.current,
				player.capabilities,
				performance.now()
			);
			remoteSetState(remote).catch(() => {});
		};
		send(player.getState());
		const unsubscribe = player.subscribe(send);
		return unsubscribe;
	}, [connected, player, channelRef]);
};

/** A device asking to control this one, as `remote://consent` brings it. */
export interface ConsentRequest {
	request: number;
	deviceId: string;
	name: string;
	deviceType: string;
	code: string;
	/** `performance.now()` when the request runs out. */
	expiresAt: number;
	/** A transfer the device asks for, or nothing for control. */
	asked?: RemoteAsked;
}

type ConsentEvent = Omit<ConsentRequest, "expiresAt"> & { expiresInMs: number };

/**
 * The request on screen, if any, and the way to answer it. The Rust side
 * keeps the queue and says which one to show, so there's one at a time.
 */
export const useConsentRequest = (): {
	request: ConsentRequest | null;
	answer: (request: ConsentRequest, answer: ConsentAnswer) => void;
} => {
	const [request, setRequest] = useState<ConsentRequest | null>(null);
	useTauriEvent<ConsentEvent>("remote://consent", ({ expiresInMs, ...event }) =>
		setRequest({ ...event, expiresAt: performance.now() + expiresInMs })
	);
	// One that came before this page listened, as after a reload, would
	// wait unseen until it ran out. An event since says more.
	useEffect(
		() => {
			let current = true;
			remotePendingConsent()
				.then((pending) => {
					if (!current || !pending) return;
					const { expiresInMs, ...event } = pending;
					const shown = { ...event, expiresAt: performance.now() + expiresInMs };
					setRequest((seen) => seen ?? shown);
				})
				.catch(() => {});
			return () => {
				current = false;
			};
		},
		// Stryker disable next-line ArrayDeclaration: any list that never changes runs the effect once, as this one does.
		[]
	);
	useTauriEvent<{ request: number }>("remote://consent-hidden", ({ request: hidden }) =>
		setRequest((shown) => (shown?.request === hidden ? null : shown))
	);
	const answer = (shown: ConsentRequest, given: ConsentAnswer) => {
		// Off screen at once; the Rust side shows the next one, if any.
		setRequest(null);
		remoteAnswerConsent(shown.request, given).catch(() => {});
	};
	return { request, answer };
};
