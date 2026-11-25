// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ChannelList } from "@/components/channels/ChannelList";
import { ChannelsContext, useChannels } from "@/hooks/useChannels";
import { NoDownloadsProvider } from "@/hooks/useDownloads";
import { LibraryProvider, type PlayState } from "@/hooks/useLibrary";
import { deriveCategories } from "@/lib/channels";
import type { PlaybackItem } from "@/lib/destination";
import { libraryOf, remoteItemId, remoteSource } from "@/lib/library";
import { channelsQuery, providersQuery, showFavorite } from "@/lib/queries";
import type { Link } from "@/lib/remote-control";
import type { Channel, Provider } from "@/lib/types";

// The lists before their first load, kept the same between renders.
const NO_CHANNELS: Channel[] = [];
const NO_PROVIDERS: Provider[] = [];

/**
 * How long the other device's channel list stays loaded once no screen
 * shows it, so coming back from its player shows it straight away.
 */
const KEEP_MS = 60 * 60 * 1000;

/**
 * This device's channel screens, showing the library of the device `link`
 * controls. Picking an item there plays it on that device, and a change to a
 * favorite, a pinned group or the history changes it there.
 */
export const RemoteLibrary = ({ link }: { link: Link }) => {
	const source = remoteSource(link.id);
	const own = useChannels();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const channels = useQuery({ ...channelsQuery(source), gcTime: KEEP_MS });
	const providers = useQuery({ ...providersQuery(source), gcTime: KEEP_MS });
	const list = channels.data ?? NO_CHANNELS;
	const categories = useMemo(() => deriveCategories(list), [list]);
	const [message, setMessage] = useState<string | null>(null);
	// The latest item picked; one a newer pick replaced, or that answers
	// after the screens closed, opens nothing.
	const pickRef = useRef<object | null>(null);
	useEffect(
		() => () => {
			pickRef.current = null;
		},
		// Stryker disable next-line ArrayDeclaration: A list that never changes runs the cleanup only on unmount, whatever it holds.
		[]
	);

	const play = (state: PlayState) => {
		setMessage(null);
		const pick = {};
		pickRef.current = pick;
		const item: PlaybackItem = {
			kind: "remote",
			itemId: remoteItemId(state.channel),
			title: state.channelName,
		};
		link.destination.load(item).then(
			() => {
				if (pickRef.current === pick) void navigate("/player");
			},
			() => {
				if (pickRef.current === pick)
					setMessage(`${link.name} couldn't play ${state.channelName}.`);
			}
		);
	};

	const toggleFavorite = async (id: string) => {
		try {
			showFavorite(queryClient, source, id, await libraryOf(source).toggleFavorite(id));
		} catch {
			setMessage(`Couldn't change the favorites on ${link.name}.`);
		}
	};

	if (channels.isError) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
				<p className="text-sm text-muted-foreground">
					Couldn&apos;t load the channels on {link.name}.
				</p>
				<Button size="sm" onClick={() => void channels.refetch()}>
					Try again
				</Button>
			</div>
		);
	}

	if (channels.isSuccess && list.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
				<p className="text-base font-semibold">No channels on {link.name}</p>
				<p className="text-sm text-muted-foreground">
					Add a playlist there to watch it from here.
				</p>
			</div>
		);
	}

	return (
		<LibraryProvider value={{ source, play }}>
			<ChannelsContext.Provider
				value={{
					...own,
					channels: list,
					categories,
					providers: providers.data ?? NO_PROVIDERS,
					loading: channels.isPending,
					toggleFavorite,
					// This device's guide refreshes say nothing about that one's.
					guideVersion: 0,
				}}
			>
				<NoDownloadsProvider>
					<div className="h-full flex flex-col">
						{message && (
							<p role="alert" className="px-4 py-2 text-sm text-red-500">
								{message}
							</p>
						)}
						<div className="relative flex-1 min-h-0">
							<ChannelList />
						</div>
					</div>
				</NoDownloadsProvider>
			</ChannelsContext.Provider>
		</LibraryProvider>
	);
};
