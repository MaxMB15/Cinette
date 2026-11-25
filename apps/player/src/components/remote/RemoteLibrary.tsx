// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ChannelList } from "@/components/channels/ChannelList";
import { RemoteLoading } from "@/components/remote/RemoteLoading";
import { ChannelsContext, useChannels } from "@/hooks/useChannels";
import { NoDownloadsProvider } from "@/hooks/useDownloads";
import { LibraryProvider, type PlayState } from "@/hooks/useLibrary";
import { deriveCategories } from "@/lib/channels";
import type { PlaybackItem } from "@/lib/destination";
import { libraryOf, remoteItemId, remoteSource, type Source } from "@/lib/library";
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
 * The last link to each device, by its id. A new link to the same device
 * shows what that one loaded at once, while its own copy loads.
 */
const lastLinks = new Map<string, number>();

/**
 * How long a list stays as it is. One an earlier link loaded, which has no
 * load time, loads again; one this link loaded stays.
 */
const loadIfEarlier = (query: { state: { dataUpdatedAt: number } }) =>
	query.state.dataUpdatedAt === 0 ? 0 : Infinity;

/**
 * This device's channel screens, showing the library of the device `link`
 * controls. Picking an item there plays it on that device, and a change to a
 * favorite, a pinned group or the history changes it there. Until the
 * library loads, it shows how far it got and `onLeave` disconnects.
 */
export const RemoteLibrary = ({ link, onLeave }: { link: Link; onLeave: () => void }) => {
	const source = remoteSource(link.id);
	const own = useChannels();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const earlier = lastLinks.get(link.deviceId);
	/** What the earlier link to this device loaded for `query`, if anything. */
	const earlierData = <T,>(query: (source: Source) => { queryKey: readonly unknown[] }) =>
		earlier === undefined
			? undefined
			: queryClient.getQueryData<T>(query(remoteSource(earlier)).queryKey);
	const reuse = { gcTime: KEEP_MS, staleTime: loadIfEarlier, initialDataUpdatedAt: 0 };
	const channels = useQuery({
		...channelsQuery(source),
		...reuse,
		initialData: () => earlierData<Channel[]>(channelsQuery),
	});
	const providers = useQuery({
		...providersQuery(source),
		...reuse,
		initialData: () => earlierData<Provider[]>(providersQuery),
	});
	useEffect(
		() => {
			lastLinks.set(link.deviceId, link.id);
		},
		// Stryker disable next-line ArrayDeclaration: the page keys this by the link, so neither changes while it shows.
		[link.deviceId, link.id]
	);
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
			// A copy that was loading may have been read before the change.
			const { queryKey } = channelsQuery(source);
			if (queryClient.isFetching({ queryKey }) > 0)
				void queryClient.refetchQueries({ queryKey });
		} catch {
			setMessage(`Couldn't change the favorites on ${link.name}.`);
		}
	};

	if (channels.data === undefined && !channels.isError) {
		return <RemoteLoading link={link} onLeave={onLeave} />;
	}

	if (channels.data === undefined) {
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

	if (list.length === 0) {
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
					loading: false,
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
