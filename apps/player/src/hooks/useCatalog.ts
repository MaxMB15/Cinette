// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useCallback, useMemo } from "react";
import { dedupeByTitle, seriesTitleOf } from "@/lib/channels";
import { findEpisode } from "@/lib/episodes";
import { getXtreamSeriesEpisodes } from "@/lib/tauri";
import type { Channel, WatchHistoryEntry } from "@/lib/types";

/** Grouping key for series titles, tolerant of case and spacing differences. */
export const seriesKey = (title: string): string => title.trim().toLowerCase().replace(/\s+/g, " ");

/** Whether a channel belongs to a show, whose spellings share one card. */
const isOfShow = (channel: Channel, showName: string): boolean =>
	seriesKey(seriesTitleOf(channel)) === seriesKey(showName);

const XTREAM_SERIES = "xtream://series/";

/** What opening a watch history entry leads to. */
export interface HistoryActions {
	playEpisode: (episode: Channel, episodes: Channel[]) => void;
	/** The watched episode is gone, so the viewer picks another. */
	pickEpisode: (showTitle: string, episodes: Channel[], seriesChannelId: string) => void;
	showMovie: (movie: Channel) => void;
	/** Any other entry: a channel, which plays right away. */
	playOther: (entry: WatchHistoryEntry) => void;
	/** True while the episodes of an Xtream show load. */
	setLoading: (loading: boolean) => void;
	/** There's nothing to open: it left the playlist, or its episodes didn't load. */
	onMissing: () => void;
}

/** The provider's channels by what they are, and the lists made from them. */
export const useCatalog = (channels: Channel[]) => {
	const byType = useMemo(() => {
		const map: Record<"live" | "movie" | "series", Channel[]> = {
			live: [],
			movie: [],
			series: [],
		};
		for (const ch of channels) {
			const t = ch.contentType as "live" | "movie" | "series";
			if (t in map) map[t].push(ch);
			else map.live.push(ch);
		}
		return map;
	}, [channels]);

	const seriesShows = useMemo(() => {
		const seen = new Map<string, Channel>();
		for (const ch of byType.series) {
			const title = seriesTitleOf(ch);
			const key = seriesKey(title);
			if (!seen.has(key)) seen.set(key, { ...ch, name: title, sources: [] });
		}
		return Array.from(seen.values());
	}, [byType.series]);

	// Xtream lists the same show as separate series entries (other categories,
	// languages, servers). They're shown as one card, so keep every entry per
	// title to load all their episodes — the duplicates become extra sources.
	const xtreamSeriesByTitle = useMemo(() => {
		const map = new Map<string, Channel[]>();
		for (const ch of byType.series) {
			if (!ch.url.startsWith(XTREAM_SERIES)) continue;
			const key = seriesKey(seriesTitleOf(ch));
			const list = map.get(key);
			if (list) list.push(ch);
			else map.set(key, [ch]);
		}
		return map;
	}, [byType.series]);

	/** Episodes of every Xtream series entry sharing this show's title. */
	const fetchXtreamShowEpisodes = useCallback(
		async (showName: string, container: Channel): Promise<Channel[]> => {
			const containers = xtreamSeriesByTitle.get(seriesKey(showName)) ?? [];
			// The clicked entry first so its episodes stay the default source.
			const ordered = [container, ...containers.filter((c) => c.id !== container.id)];
			const results = await Promise.allSettled(
				ordered.map((c) => getXtreamSeriesEpisodes(c.id))
			);
			const first = results[0];
			if (first.status === "rejected") throw first.reason;
			return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
		},
		[xtreamSeriesByTitle]
	);

	/** A show's episodes, which an Xtream provider only hands out on request. */
	const episodesOf = useCallback(
		(show: Channel): Promise<Channel[]> => {
			const showName = seriesTitleOf(show);
			return show.url.startsWith(XTREAM_SERIES)
				? fetchXtreamShowEpisodes(showName, show)
				: Promise.resolve(byType.series.filter((ep) => isOfShow(ep, showName)));
		},
		[byType.series, fetchXtreamShowEpisodes]
	);

	const movieTitles = useMemo(() => dedupeByTitle(byType.movie), [byType.movie]);

	/** Opens a watch history entry. Recordings are the caller's to handle. */
	const openHistoryEntry = useCallback(
		(entry: WatchHistoryEntry, actions: HistoryActions) => {
			if (entry.contentType === "series") {
				// The history names the show the same way the Recently Played row does.
				const seriesName = entry.seriesTitle ?? seriesTitleOf({ name: entry.channelName });
				// Find the series container to handle Xtream lazy-load
				const seriesContainer = byType.series.find((s) => isOfShow(s, seriesName));
				const seriesChannelId = seriesContainer?.id ?? entry.channelId;
				// Play the watched episode directly; if it's no longer listed, fall
				// back to the series picker.
				const playOrPick = (eps: Channel[]) => {
					const ep = findEpisode(eps, entry.channelId, entry.channelName);
					if (ep) actions.playEpisode(ep, eps);
					else if (eps.length > 0) actions.pickEpisode(seriesName, eps, seriesChannelId);
					else actions.onMissing();
				};
				if (seriesContainer && seriesContainer.url.startsWith(XTREAM_SERIES)) {
					actions.setLoading(true);
					fetchXtreamShowEpisodes(seriesName, seriesContainer)
						.then(playOrPick)
						.catch((e) => {
							console.error("[Xtream] failed to fetch series episodes:", e);
							actions.onMissing();
						})
						.finally(() => actions.setLoading(false));
				} else {
					playOrPick(byType.series.filter((ep) => isOfShow(ep, seriesName)));
				}
			} else if (entry.contentType === "movie") {
				const movie = byType.movie.find((ch) => ch.name === entry.channelName);
				if (movie) actions.showMovie(movie);
				else actions.onMissing();
			} else {
				actions.playOther(entry);
			}
		},
		[byType.series, byType.movie, fetchXtreamShowEpisodes]
	);

	return {
		byType,
		seriesShows,
		movieTitles,
		fetchXtreamShowEpisodes,
		episodesOf,
		openHistoryEntry,
	};
};
