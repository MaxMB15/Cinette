// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { seriesKey, useCatalog } from "@/hooks/useCatalog";
import { useChannels } from "@/hooks/useChannels";
import { useHistoryStaleOnLeave } from "@/hooks/useWatchHistory";
import { seriesTitleOf } from "@/lib/channels";
import { sortEpisodes } from "@/lib/episodes";
import { setZapList } from "@/lib/tv-zap";
import type { Channel, WatchHistoryEntry } from "@/lib/types";
import { TvDetails } from "./TvDetails";
import { TvFavorites } from "./TvFavorites";
import { TvGuidePage } from "./TvGuide";
import { TvHistory } from "./TvHistory";
import { TvLive } from "./TvLive";
import { TvPosters } from "./TvPosters";
import { TvSearch } from "./TvSearch";
import { TvButton, TvEmpty } from "./ui";
import { useRemembered, useTvNav } from "./tv-nav";

/** The channels page on a TV: the section the rail has open, and a movie or show opened from it. */
export const TvBrowse = () => {
	const { section, openSection } = useTvNav();
	const { channels, loading, loadFailed, refreshProviders, refreshChannels } = useChannels();
	const { byType, movieTitles, seriesShows, episodesOf, openHistoryEntry } = useCatalog(channels);
	const navigate = useNavigate();
	const [details, setDetails] = useRemembered<Channel | null>("details", null);
	const [opening, setOpening] = useState(false);
	const [missingId, setMissingId] = useState<string | null>(null);
	useHistoryStaleOnLeave();

	const kinds = useMemo(
		() => [
			{ name: "Live TV", items: byType.live },
			{ name: "Movies", items: movieTitles },
			{ name: "Series", items: seriesShows },
		],
		[byType.live, movieTitles, seriesShows]
	);

	const favorites = useMemo(() => {
		const favoriteShows = new Set(
			byType.series.filter((ch) => ch.isFavorite).map((ch) => seriesKey(seriesTitleOf(ch)))
		);
		// A show counts if any of its episodes is a favorite.
		const isFavorite = (ch: Channel) =>
			ch.contentType === "series" ? favoriteShows.has(seriesKey(ch.name)) : ch.isFavorite;
		return kinds.map((kind) => ({ ...kind, items: kind.items.filter(isFavorite) }));
	}, [kinds, byType.series]);

	const play = (channel: Channel, episodes?: Channel[]) =>
		navigate("/player", {
			state: {
				url: channel.url,
				channelName: channel.name,
				channel,
				...(episodes ? { seriesEpisodes: sortEpisodes(episodes) } : {}),
			},
		});

	const playChannel = (channel: Channel, list: readonly Channel[]) => {
		setZapList(list);
		play(channel);
	};

	const open = (item: Channel, list?: readonly Channel[]) => {
		if (item.contentType === "movie" || item.contentType === "series") setDetails(item);
		else playChannel(item, list ?? byType.live);
	};

	const openEntry = (entry: WatchHistoryEntry) => {
		if (opening) return;
		const missing = () => setMissingId(entry.channelId);
		setMissingId(null);
		openHistoryEntry(entry, {
			playEpisode: play,
			pickEpisode: (showTitle, _episodes, seriesChannelId) => {
				const show = seriesShows.find(
					(s) => s.id === seriesChannelId || s.name === showTitle
				);
				if (show) setDetails(show);
			},
			showMovie: setDetails,
			setLoading: setOpening,
			onMissing: missing,
			playOther: (other) => {
				const channel = byType.live.find((c) => c.id === other.channelId);
				if (channel) playChannel(channel, byType.live);
				else missing();
			},
		});
	};

	if (channels.length === 0) {
		if (loading) return <TvEmpty title="Loading channels" />;
		if (loadFailed) {
			return (
				<TvEmpty title="Couldn't load your channels">
					<TvButton
						onClick={() => {
							void refreshProviders();
							void refreshChannels();
						}}
					>
						Try again
					</TvButton>
				</TvEmpty>
			);
		}
		return (
			<TvEmpty title="Add a provider to see channels here">
				<TvButton onClick={() => openSection("settings")}>Go to Settings</TvButton>
			</TvEmpty>
		);
	}

	return (
		<>
			{section === "search" && <TvSearch kinds={kinds} onOpen={(item) => open(item)} />}
			{section === "live" && <TvLive live={byType.live} onPlay={playChannel} />}
			{section === "guide" && <TvGuidePage live={byType.live} onPlay={playChannel} />}
			{section === "movie" && (
				<TvPosters
					title="Movies"
					memoryKey="movie"
					items={movieTitles}
					onOpen={(item) => open(item)}
				/>
			)}
			{section === "series" && (
				<TvPosters
					title="Series"
					memoryKey="series"
					items={seriesShows}
					onOpen={(item) => open(item)}
				/>
			)}
			{section === "favorites" && <TvFavorites groups={favorites} onOpen={open} />}
			{section === "history" && (
				<TvHistory onOpen={openEntry} opening={opening} missingId={missingId} />
			)}
			{details && (
				<TvDetails
					item={details}
					onClose={() => setDetails(null)}
					onPlay={play}
					episodesOf={episodesOf}
				/>
			)}
		</>
	);
};
