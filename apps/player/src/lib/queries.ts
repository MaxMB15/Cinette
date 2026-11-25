// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// Every TanStack Query the app makes, with its key and the backend call that
// answers it. Each key starts with where the data comes from: this device,
// or the device the remote control controls, which answers the same queries.

import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { getDownloadRetention, listDownloads } from "./tauri";
import { LOCAL, libraryOf, type Source } from "./library";
import { nowSeconds } from "./date";
import type { TimeRange } from "./epg-window";
import type { Channel, EpgProgram } from "./types";

export { LOCAL, type Source };

/** The user's providers, with their settings and channel counts. */
export const providersQuery = (source: Source = LOCAL) =>
	queryOptions({
		queryKey: [source, "providers"] as const,
		queryFn: () => libraryOf(source).getProviders(),
	});

/** Every channel, movie and series of every provider. */
export const channelsQuery = (source: Source = LOCAL) =>
	queryOptions({
		queryKey: [source, "channels"] as const,
		queryFn: () => libraryOf(source).getAllChannels(),
	});

/** Shows a channel's new favorite mark in the channel list, which isn't loaded again for it. */
export const showFavorite = (
	client: QueryClient,
	source: Source,
	channelId: string,
	isFavorite: boolean
) =>
	client.setQueryData(channelsQuery(source).queryKey, (prev: Channel[] | undefined) =>
		prev?.map((ch) => (ch.id === channelId ? { ...ch, isFavorite } : ch))
	);

/**
 * How a provider's groups of one content type sort into categories. Empty
 * until the user or Gemini sorts them.
 */
export const groupHierarchyQuery = (
	providerId: string,
	contentType: string,
	source: Source = LOCAL
) =>
	queryOptions({
		queryKey: [source, "groupHierarchy", providerId, contentType] as const,
		queryFn: () => libraryOf(source).getGroupHierarchy(providerId, contentType),
	});

/** The groups pinned above the others, in order. */
export const pinnedGroupsQuery = (
	providerId: string,
	contentType: string,
	source: Source = LOCAL
) =>
	queryOptions({
		queryKey: [source, "pinnedGroups", providerId, contentType] as const,
		queryFn: () => libraryOf(source).getPinnedGroups(providerId, contentType),
	});

/**
 * Every live channel's programs over a range. `version` changes when the
 * guide or the channel list does, which makes it a new query.
 */
export const guideQuery = (range: TimeRange, version: string, source: Source = LOCAL) =>
	queryOptions({
		queryKey: [source, "guide", range.from, range.to, version, "all"] as const,
		queryFn: () => libraryOf(source).getEpgForLiveChannels(range.from, range.to),
	});

/** The guide ids asked for in the same moment, for one range, with the call that loads them. */
interface GuideBatch {
	ids: string[];
	answer: Promise<EpgProgram[]>;
}

const guideBatches = new Map<string, GuideBatch>();

/** The most guide ids one call names, which is all another device takes. */
export const GUIDE_IDS_PER_CALL = 1000;

/**
 * One channel's programs over a range. The ids that ask in the same moment
 * share one backend call for each {@link GUIDE_IDS_PER_CALL} of them, so a
 * list of channels costs one call, as it did before each id had its own query.
 */
export const loadChannelGuide = (
	range: TimeRange,
	id: string,
	source: Source = LOCAL
): Promise<EpgProgram[]> => {
	const batchKey = `${source}:${range.from}:${range.to}`;
	let batch = guideBatches.get(batchKey);
	if (!batch) {
		const ids: string[] = [];
		// The call waits for the other ids asked for in this moment.
		const answer = Promise.resolve().then(() => {
			guideBatches.delete(batchKey);
			// Stryker disable next-line ArrayDeclaration: Each caller keeps only the programs of its own id, so an extra item in the list reaches no one.
			const calls: Promise<EpgProgram[]>[] = [];
			for (let at = 0; at < ids.length; at += GUIDE_IDS_PER_CALL) {
				const some = ids.slice(at, at + GUIDE_IDS_PER_CALL);
				calls.push(libraryOf(source).getEpgForLiveChannels(range.from, range.to, some));
			}
			return Promise.all(calls).then((answers) => answers.flat());
		});
		batch = { ids, answer };
		guideBatches.set(batchKey, batch);
	}
	batch.ids.push(id);
	return batch.answer.then((programs) => programs.filter((p) => p.channelId === id));
};

/** The start of the key of every guide query. */
export const guideKey = (source: Source = LOCAL) => [source, "guide"] as const;

/** The start of the key of every single channel's guide over a range. */
export const channelGuideKey = (range: TimeRange, version: string, source: Source = LOCAL) =>
	[...guideKey(source), range.from, range.to, version, "channel"] as const;

/** One live channel's programs over a range, by its guide id. */
export const channelGuideQuery = (
	range: TimeRange,
	version: string,
	id: string,
	source: Source = LOCAL
) =>
	queryOptions({
		queryKey: [...channelGuideKey(range, version, source), id] as const,
		queryFn: () => loadChannelGuide(range, id, source),
	});

/** How far apart the schedule's start can be and still read the same cache. */
export const SCHEDULE_STEP = 600;

/**
 * One channel's schedule from 12 hours before `at` through 12 hours after.
 * `at` is the start of a step, so the schedule runs one step longer, which
 * covers the 12 hours ahead of any moment in it. `version` goes up when a
 * provider's guide refreshes, which makes it a new query.
 */
export const scheduleQuery = (epgId: string, at: number, version: number, source: Source = LOCAL) =>
	queryOptions({
		queryKey: [source, "schedule", epgId, at, version] as const,
		queryFn: () =>
			libraryOf(source).getEpgProgrammes(
				epgId,
				at - 12 * 3600,
				at + 12 * 3600 + SCHEDULE_STEP
			),
	});

/**
 * The programs whose title matches `term`, from now on. The answer depends on
 * the time, so it's kept for a minute and loads again after that.
 */
export const guideSearchQuery = (term: string, source: Source = LOCAL) =>
	queryOptions({
		queryKey: [source, "guideSearch", term] as const,
		queryFn: () => libraryOf(source).searchEpgProgrammes(term, nowSeconds()),
		staleTime: 60_000,
	});

/**
 * Keeps details that were found until the app loads them again. No details,
 * as when no API key is saved yet, are asked for again the next time, since a
 * key saved in Settings since then may find them.
 */
const keepFound = (query: { state: { data: unknown } }) =>
	query.state.data == null ? 0 : Infinity;

/**
 * OMDb's details for a movie or show, by the channel the backend saves them
 * for and the title it searches.
 */
export const omdbQuery = (
	id: string,
	title: string,
	kind: "movie" | "series",
	source: Source = LOCAL
) =>
	queryOptions({
		queryKey: [source, "omdb", id, title, kind] as const,
		queryFn: () => libraryOf(source).fetchOmdbData(id, title, kind),
		staleTime: keepFound,
	});

/** Whatson's ratings for an IMDb id. A series is a "show" there. */
export const whatsonQuery = (imdbId: string, kind: "movie" | "series", source: Source = LOCAL) =>
	queryOptions({
		queryKey: [source, "whatson", imdbId, kind] as const,
		queryFn: () =>
			libraryOf(source).fetchWhatsonData(imdbId, kind === "series" ? "show" : "movie"),
		staleTime: keepFound,
	});

/**
 * Loads again, the next time they're shown, the details, ratings and guide
 * data that Settings' "Clear All Caches" deletes from the backend's cache.
 */
export const reloadClearedCaches = (client: QueryClient, source: Source = LOCAL) =>
	Promise.all(
		(["omdb", "whatson", "guide", "schedule", "guideSearch"] as const).map((name) =>
			client.invalidateQueries({ queryKey: [source, name] })
		)
	);

/** The start of every watch history query's key, to mark them all stale at once. */
export const historyKey = (source: Source = LOCAL) => [source, "history"] as const;

/** The newest watch history entries, of one content type or of all. */
export const watchHistoryQuery = (limit: number, contentType?: string, source: Source = LOCAL) =>
	queryOptions({
		queryKey: [...historyKey(source), contentType ?? "all", limit] as const,
		queryFn: () => libraryOf(source).getWatchHistory(limit, contentType),
	});

/**
 * Every download and recording. The backend's progress and removal events
 * keep the cached list up to date between loads.
 */
export const downloadsQuery = (source: Source = LOCAL) =>
	queryOptions({
		queryKey: [source, "downloads"] as const,
		queryFn: () => listDownloads(),
	});

/** Days finished downloads are kept, or null to keep them until removed. */
export const downloadRetentionQuery = (source: Source = LOCAL) =>
	queryOptions({
		queryKey: [source, "downloadRetention"] as const,
		queryFn: () => getDownloadRetention(),
	});
