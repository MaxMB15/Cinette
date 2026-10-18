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
	remotePlayerState,
	setMountedPlayer,
	type RemoteCommand,
} from "@/lib/remote-target";
import {
	remoteFinishCommand,
	remoteSessions,
	remoteSetState,
	type RemoteSession,
} from "@/lib/tauri";
import type { Channel } from "@/lib/types";

/**
 * Listens to a Tauri event for as long as the component is mounted. The
 * handler is read when an event comes, so it can change without
 * listening again.
 */
const useTauriEvent = <T>(event: string, handler: (payload: T) => void): void => {
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
 * once, in `App`. A load with no player open opens it the way the channel
 * list does, so the play is this device's own and goes in its history.
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
				openPlayer: (channel) =>
					navigateRef.current("/player", {
						state: { url: channel.url, channelName: channel.name, channel },
					}),
			})
				.then((outcome) => remoteFinishCommand(token, outcome))
				.catch(() => {});
		}
	);
};

/** The devices controlling this one, kept up to date. Empty where remote
 *  control doesn't run. */
export const useRemoteSessions = (): RemoteSession[] => {
	const [sessions, setSessions] = useState<RemoteSession[]>([]);
	useTauriEvent<RemoteSession[]>("remote://sessions", setSessions);
	useEffect(
		() => {
			let current = true;
			remoteSessions()
				.then((list) => {
					// Anything but a list, as from a backend without remote control, is none.
					if (current) setSessions(Array.isArray(list) ? list : []);
				})
				.catch(() => {});
			return () => {
				current = false;
			};
		},
		// Stryker disable next-line ArrayDeclaration: any list that never changes runs the effect once, as this one does.
		[]
	);
	return sessions;
};

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
			if (getMountedPlayer() === player) setMountedPlayer(null);
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
