// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// The library the channel screens show: this device's, or that of the device
// it controls, with the same calls for both, so the screens are the same.

import * as tauri from "./tauri";
import type { Channel } from "./types";

/** Where a query's data comes from: this device, or the device link `n` controls. */
export type Source = "local" | `remote:${number}`;

export const LOCAL: Source = "local";

/** The source of the library of the device link `link` controls. */
export const remoteSource = (link: number): Source => `remote:${link}`;

/** What the channel screens read and change of a library. */
export type Library = Pick<
	typeof tauri,
	| "getAllChannels"
	| "getProviders"
	| "getGroupHierarchy"
	| "getPinnedGroups"
	| "getEpgForLiveChannels"
	| "getEpgProgrammes"
	| "searchEpgProgrammes"
	| "getWatchHistory"
	| "getXtreamSeriesEpisodes"
	| "getCachedSeriesEpisodes"
	| "fetchOmdbData"
	| "fetchWhatsonData"
	| "toggleFavorite"
	| "pinGroup"
	| "unpinGroup"
	| "deleteHistoryEntry"
	| "deleteHistorySeries"
	| "clearWatchHistory"
	| "clearWatchHistoryOfType"
>;

/** The library of the device link `link` controls, through `remote_library`. */
const remoteLibrary = (link: number): Library => {
	const ask = <T>(call: tauri.LibraryCall) => tauri.remoteLibrary<T>(link, call);
	const episodes = (seriesId: string) => ask<Channel[]>({ name: "seriesEpisodes", seriesId });
	return {
		getAllChannels: () => ask({ name: "channels" }),
		getProviders: () => ask({ name: "providers" }),
		getGroupHierarchy: (providerId, contentType) =>
			ask({ name: "groupHierarchy", providerId, contentType }),
		getPinnedGroups: (providerId, contentType) =>
			ask({ name: "pinnedGroups", providerId, contentType }),
		getEpgForLiveChannels: (from, to, ids) => ask({ name: "guide", from, to, ids }),
		getEpgProgrammes: (epgId, from, to) => ask({ name: "schedule", epgId, from, to }),
		searchEpgProgrammes: (query, from) => ask({ name: "guideSearch", query, from }),
		getWatchHistory: (limit, contentType) => ask({ name: "history", limit, contentType }),
		getXtreamSeriesEpisodes: episodes,
		// That device has no downloads to show here, so its list is the one it loads.
		getCachedSeriesEpisodes: episodes,
		fetchOmdbData: (id, title, kind) => ask({ name: "omdb", id, title, kind }),
		fetchWhatsonData: (imdbId, kind) => ask({ name: "whatson", imdbId, kind }),
		toggleFavorite: (id) => ask({ name: "toggleFavorite", id }),
		pinGroup: (providerId, contentType, group, order) =>
			ask({ name: "pinGroup", providerId, contentType, group, order }),
		unpinGroup: (providerId, contentType, group) =>
			ask({ name: "unpinGroup", providerId, contentType, group }),
		deleteHistoryEntry: (channelId) => ask({ name: "deleteHistory", channelId }),
		deleteHistorySeries: (seriesTitle) => ask({ name: "deleteHistorySeries", seriesTitle }),
		clearWatchHistory: () => ask({ name: "clearHistory" }),
		clearWatchHistoryOfType: (contentType) => ask({ name: "clearHistory", contentType }),
	};
};

/**
 * The library `source` names. This device's is the backend's own commands,
 * looked up on each call, so a test's mock of one is the one called.
 */
export const libraryOf = (source: Source): Library =>
	source === LOCAL ? tauri : remoteLibrary(Number(source.slice("remote:".length)));

/** What a controller puts in place of the URL of an item on the other device. */
export const REMOTE_URL = "cinette-remote:";

/**
 * The id, on the device it's from, of what `channel` plays. A source picked
 * from an episode's list names another item there, by its URL.
 */
export const remoteItemId = (channel: Channel): string =>
	channel.url.startsWith(REMOTE_URL) ? channel.url.slice(REMOTE_URL.length) : channel.id;
