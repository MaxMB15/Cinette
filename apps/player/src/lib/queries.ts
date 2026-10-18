// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// Every TanStack Query the app makes, with its key and the backend call that
// answers it. Each key starts with where the data comes from, so another
// device can later answer the same queries when the remote control browses
// its catalog.

import { queryOptions } from "@tanstack/react-query";
import {
	getAllChannels,
	getEpgForLiveChannels,
	getEpgProgrammes,
	fetchOmdbData,
	fetchWhatsonData,
	getGroupHierarchy,
	getPinnedGroups,
	getProviders,
	searchEpgProgrammes,
} from "./tauri";
import { nowSeconds } from "./date";
import type { TimeRange } from "./epg-window";
import type { EpgProgram } from "./types";

/** Where a query's data comes from. Only this device for now. */
export type Source = "local";

export const LOCAL: Source = "local";

/** The user's providers, with their settings and channel counts. */
export const providersQuery = (source: Source = LOCAL) =>
	queryOptions({
		queryKey: [source, "providers"] as const,
		queryFn: () => getProviders(),
	});

/** Every channel, movie and series of every provider. */
export const channelsQuery = (source: Source = LOCAL) =>
	queryOptions({
		queryKey: [source, "channels"] as const,
		queryFn: () => getAllChannels(),
	});

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
		queryFn: () => getGroupHierarchy(providerId, contentType),
	});

/** The groups pinned above the others, in order. */
export const pinnedGroupsQuery = (
	providerId: string,
	contentType: string,
	source: Source = LOCAL
) =>
	queryOptions({
		queryKey: [source, "pinnedGroups", providerId, contentType] as const,
		queryFn: () => getPinnedGroups(providerId, contentType),
	});

/**
 * Every live channel's programs over a range. `version` changes when the
 * guide or the channel list does, which makes it a new query.
 */
export const guideQuery = (range: TimeRange, version: string, source: Source = LOCAL) =>
	queryOptions({
		queryKey: [source, "guide", range.from, range.to, version, "all"] as const,
		queryFn: () => getEpgForLiveChannels(range.from, range.to),
	});

/** The guide ids asked for in the same moment, for one range, with the call that loads them. */
interface GuideBatch {
	ids: string[];
	answer: Promise<EpgProgram[]>;
}

const guideBatches = new Map<string, GuideBatch>();

/**
 * One channel's programs over a range. The ids that ask in the same moment
 * share one backend call, so a list of channels costs one call, as it did
 * before each id had its own query.
 */
export const loadChannelGuide = (range: TimeRange, id: string): Promise<EpgProgram[]> => {
	const batchKey = `${range.from}:${range.to}`;
	let batch = guideBatches.get(batchKey);
	if (!batch) {
		const ids: string[] = [];
		// The call waits for the other ids asked for in this moment.
		const answer = Promise.resolve().then(() => {
			guideBatches.delete(batchKey);
			return getEpgForLiveChannels(range.from, range.to, ids);
		});
		batch = { ids, answer };
		guideBatches.set(batchKey, batch);
	}
	batch.ids.push(id);
	return batch.answer.then((programs) => programs.filter((p) => p.channelId === id));
};

/** One live channel's programs over a range, by its guide id. */
export const channelGuideQuery = (
	range: TimeRange,
	version: string,
	id: string,
	source: Source = LOCAL
) =>
	queryOptions({
		queryKey: [source, "guide", range.from, range.to, version, "channel", id] as const,
		queryFn: () => loadChannelGuide(range, id),
	});

/** How far apart the schedule's start can be and still read the same cache. */
export const SCHEDULE_STEP = 600;

/**
 * One channel's schedule from 12 hours before `at` through 12 hours after.
 * `at` is the start of a step, so the schedule runs one step longer, which
 * covers the 12 hours ahead of any moment in it.
 */
export const scheduleQuery = (epgId: string, at: number, source: Source = LOCAL) =>
	queryOptions({
		queryKey: [source, "schedule", epgId, at] as const,
		queryFn: () => getEpgProgrammes(epgId, at - 12 * 3600, at + 12 * 3600 + SCHEDULE_STEP),
	});

/**
 * The programs whose title matches `term`, from now on. The answer depends on
 * the time, so it's kept for a minute and loads again after that.
 */
export const guideSearchQuery = (term: string, source: Source = LOCAL) =>
	queryOptions({
		queryKey: [source, "guideSearch", term] as const,
		queryFn: () => searchEpgProgrammes(term, nowSeconds()),
		staleTime: 60_000,
	});

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
		queryFn: () => fetchOmdbData(id, title, kind),
	});

/** Whatson's ratings for an IMDb id. A series is a "show" there. */
export const whatsonQuery = (imdbId: string, kind: "movie" | "series", source: Source = LOCAL) =>
	queryOptions({
		queryKey: [source, "whatson", imdbId, kind] as const,
		queryFn: () => fetchWhatsonData(imdbId, kind === "series" ? "show" : "movie"),
	});
