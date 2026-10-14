// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { invoke } from "@tauri-apps/api/core";
import type {
	MpvPlayerState,
	Channel,
	Provider,
	EpgProgram,
	EpgSearchResult,
	OmdbData,
	MdbListData,
	WhatsonData,
	SkipSegment,
	WatchHistoryEntry,
	SubtitleSearchResult,
	GroupHierarchyEntry,
	PinnedGroup,
	PlaybackPosition,
	DownloadRecord,
	GuideProgram,
} from "./types";

// --- MPV Player Commands ---

// Loads, stops and subtitle changes reach mpv one at a time, in the order
// they were called. Rust runs each command on its own thread, so a stop sent
// without waiting for it could otherwise land after a newer load and end that
// stream. A subtitle add names its stream. Sent while that stream still
// loads, it could reach mpv first and fail.
let lastTransition: Promise<void> = Promise.resolve();

const inOrder = (run: () => Promise<void>): Promise<void> => {
	const result = lastTransition.then(run);
	lastTransition = result.then(
		() => {},
		() => {}
	);
	return result;
};

/**
 * Starts `url` in a new player. `keepSubtitles` carries the subtitle file the
 * last one added, and its delay, over to it. Set it only when the same item
 * loads again, as for a retry or another source.
 */
export const mpvLoad = (
	url: string,
	startPos?: number,
	hwdec = true,
	keepSubtitles = false
): Promise<void> =>
	inOrder(() =>
		invoke("plugin:mpv|mpv_load", { url, startPos: startPos ?? null, hwdec, keepSubtitles })
	);

export const mpvPlay = (): Promise<void> => invoke("plugin:mpv|mpv_play");

export const mpvPause = (): Promise<void> => invoke("plugin:mpv|mpv_pause");

export const mpvStop = (): Promise<void> => inOrder(() => invoke("plugin:mpv|mpv_stop"));

export const mpvSeek = (position: number): Promise<void> =>
	invoke("plugin:mpv|mpv_seek", { position });

export const mpvSetVolume = (volume: number): Promise<void> =>
	invoke("plugin:mpv|mpv_set_volume", { volume });

export const mpvGetState = (): Promise<MpvPlayerState> => invoke("plugin:mpv|mpv_get_state");

export const mpvSetVisible = (visible: boolean): Promise<void> =>
	invoke("plugin:mpv|mpv_set_visible", { visible });

/** The lock screen's title, live flag and logo address. Only iOS uses them. */
export const mpvSetMediaInfo = (
	title: string | null,
	live: boolean,
	artwork: string | null
): Promise<void> => invoke("plugin:mpv|mpv_set_media_info", { title, live, artwork });

/** How many seconds the lock screen's skip buttons jump. Only iOS has them. */
export const mpvSetSkipIntervals = (back: number, forward: number): Promise<void> =>
	invoke("plugin:mpv|mpv_set_skip_intervals", { back, forward });

export const mpvSetBounds = (x: number, y: number, w: number, h: number): Promise<void> =>
	invoke("plugin:mpv|mpv_set_bounds", { x, y, w, h });

// --- Core IPTV Commands ---

export const loadM3uPlaylist = (name: string, url: string): Promise<Channel[]> =>
	invoke("load_m3u_playlist", { name, url });

export const loadM3uFile = (name: string, path: string): Promise<Channel[]> =>
	invoke("load_m3u_file", { name, path });

export const loadXtreamProvider = (
	name: string,
	url: string,
	username: string,
	password: string
): Promise<Channel[]> => invoke("load_xtream_provider", { name, url, username, password });

export const getProviders = (): Promise<Provider[]> => invoke("get_providers");

export const removeProvider = (id: string): Promise<void> => invoke("remove_provider", { id });

export const getAllChannels = (): Promise<Channel[]> => invoke("get_all_channels");

export const toggleFavorite = (channelId: string): Promise<boolean> =>
	invoke("toggle_favorite", { channelId });

export const refreshProvider = (id: string): Promise<void> => invoke("refresh_provider", { id });

export const updateProvider = (
	id: string,
	name: string,
	url: string,
	username?: string,
	password?: string
): Promise<void> => invoke("update_provider", { id, name, url, username, password });

export const getXtreamSeriesEpisodes = (channelId: string): Promise<Channel[]> =>
	invoke("get_xtream_series_episodes", { channelId });

/**
 * Downloads a provider's guide and saves it. Resolves to the number of
 * programs saved, which is 0 when the guide came back empty and the saved one
 * was kept.
 */
export const refreshEpg = (providerId: string): Promise<number> =>
	invoke("refresh_epg", { providerId });

export const getEpgProgrammes = (
	channelId: string,
	rangeStart: number,
	rangeEnd: number
): Promise<EpgProgram[]> => invoke("get_epg_programmes", { channelId, rangeStart, rangeEnd });

/**
 * The guide's programs between two times for the channels with these guide
 * ids, or for every channel when `channelIds` is left out.
 */
export const getEpgForLiveChannels = (
	rangeStart: number,
	rangeEnd: number,
	channelIds?: readonly string[]
): Promise<EpgProgram[]> =>
	invoke("get_epg_for_live_channels", { rangeStart, rangeEnd, channelIds });

export const searchEpgProgrammes = (
	query: string,
	rangeStart: number
): Promise<EpgSearchResult[]> => invoke("search_epg_programmes", { query, rangeStart });

export const setEpgUrl = (providerId: string, epgUrl: string | null): Promise<void> =>
	invoke("set_epg_url", { providerId, epgUrl });

export const detectEpgUrl = (providerId: string): Promise<string | null> =>
	invoke<string | null>("detect_epg_url", { id: providerId });

// --- OMDB Commands ---

export const getOmdbApiKey = (): Promise<string | null> => invoke("get_omdb_api_key");

export const setOmdbApiKey = (key: string): Promise<void> => invoke("set_omdb_api_key", { key });

/** Whether OMDb takes `key`, which needn't be saved. Rejects when OMDb can't be reached. */
export const testOmdbApiKey = (key: string): Promise<boolean> =>
	invoke("test_omdb_api_key", { key });

export const fetchOmdbData = (
	channelId: string,
	title: string,
	contentType: "movie" | "series"
): Promise<OmdbData | null> => invoke("fetch_omdb_data", { channelId, title, contentType });

// --- MDBList Commands ---

export const getMdbListApiKey = (): Promise<string | null> => invoke("get_mdblist_api_key");

export const setMdbListApiKey = (key: string): Promise<void> =>
	invoke("set_mdblist_api_key", { key });

export const testMdbListApiKey = (key: string): Promise<boolean> =>
	invoke("test_mdblist_api_key", { key });

export const fetchMdbListData = (imdbId: string, mediaType: string): Promise<MdbListData | null> =>
	invoke("fetch_mdblist_data", { imdbId, mediaType });

// --- Whatson Commands ---

export const fetchWhatsonData = (imdbId: string, mediaType: string): Promise<WhatsonData | null> =>
	invoke("fetch_whatson_data", { imdbId, mediaType });

// --- Skip Segments ---

/**
 * The intro, recap, credits and preview of a movie, or of an episode when
 * `season` and `episode` are set. `duration` is the length of the video being
 * played, in seconds, which the backend checks the times against. Empty when
 * no OMDb key is set or nothing is known.
 */
export const getSkipSegments = (
	imdbId: string,
	season: number | null,
	episode: number | null,
	duration: number
): Promise<SkipSegment[]> => invoke("get_skip_segments", { imdbId, season, episode, duration });

// --- OpenSubtitles Commands ---

export const getOpenSubtitlesApiKey = (): Promise<string | null> =>
	invoke("get_opensubtitles_api_key");

export const setOpenSubtitlesApiKey = (key: string): Promise<void> =>
	invoke("set_opensubtitles_api_key", { key });

export const testOpenSubtitlesApiKey = (key: string): Promise<boolean> =>
	invoke("test_opensubtitles_api_key", { key });

export const searchSubtitles = (
	imdbId: string,
	season?: number,
	episode?: number
): Promise<SubtitleSearchResult | null> => invoke("search_subtitles", { imdbId, season, episode });

export const downloadSubtitle = (fileId: number): Promise<string> =>
	invoke("download_subtitle", { fileId });

export const readSubtitleFile = (path: string): Promise<string> =>
	invoke("read_subtitle_file", { path });

/**
 * Adds a subtitle file to the stream at `url`, and fails once another stream
 * plays. `overlay` is whether the app draws the subtitles itself. mpv then
 * only draws them in its fallback window.
 */
export const mpvSubAdd = (path: string, overlay: boolean, url: string): Promise<void> =>
	inOrder(() => invoke("plugin:mpv|mpv_sub_add", { path, overlay, url }));

/**
 * Removes a subtitle track, or the one in use when `id` is -1. With a `url`,
 * it fails once another stream plays. Without one, the track goes from
 * whatever plays.
 */
export const mpvSubRemove = (id: number, url?: string): Promise<void> =>
	inOrder(() => invoke("plugin:mpv|mpv_sub_remove", { id, url }));

export const mpvSetSubPos = (pos: number): Promise<void> =>
	invoke("plugin:mpv|mpv_set_sub_pos", { pos });

export const mpvSetSubDelay = (delay: number): Promise<void> =>
	invoke("plugin:mpv|mpv_set_sub_delay", { delay });

// --- Watch History Commands ---

export const recordPlayStart = (
	channelId: string,
	channelName: string,
	channelLogo: string | null,
	contentType: string
): Promise<void> =>
	invoke<void>("record_play_start", {
		channelId,
		channelName,
		channelLogo,
		contentType,
	});

export const recordPlayEnd = (channelId: string, durationSeconds: number): Promise<void> =>
	invoke<void>("record_play_end", { channelId, durationSeconds });

/** The newest `limit` history entries, only those of `contentType` when given. */
export const getWatchHistory = (
	limit: number,
	contentType?: WatchHistoryEntry["contentType"]
): Promise<WatchHistoryEntry[]> =>
	invoke<WatchHistoryEntry[]>("get_watch_history", { limit, contentType });

export const deleteHistoryEntry = (channelId: string): Promise<void> =>
	invoke<void>("delete_history_entry", { channelId });

/**
 * Deletes the history of every episode of a show, matched by the
 * `seriesTitle` the history entries carry. Episodes older than any loaded
 * page go too.
 */
export const deleteHistorySeries = (seriesTitle: string): Promise<void> =>
	invoke<void>("delete_history_series", { seriesTitle });

export const clearWatchHistory = (): Promise<void> => invoke<void>("clear_watch_history");

/** Deletes the history of one content type. Resume positions are kept. */
export const clearWatchHistoryOfType = (
	contentType: WatchHistoryEntry["contentType"]
): Promise<void> => invoke<void>("clear_watch_history_of_type", { contentType });

// --- Playback Position (resume) Commands ---

export const savePlaybackPosition = (
	contentKey: string,
	positionSeconds: number,
	durationSeconds: number
): Promise<void> =>
	invoke<void>("save_playback_position", { contentKey, positionSeconds, durationSeconds });

export const getPlaybackPosition = (contentKey: string): Promise<PlaybackPosition | null> =>
	invoke<PlaybackPosition | null>("get_playback_position", { contentKey });

export const deletePlaybackPosition = (contentKey: string): Promise<void> =>
	invoke<void>("delete_playback_position", { contentKey });

/**
 * Has Rust save `item`'s resume point every few seconds while the player page
 * can't, or stops when `item` is null. See `src-tauri/src/progress.rs`.
 */
export const handOffProgress = (
	item: { key: string; url: string; pendingStart: number | null } | null
): Promise<void> => invoke<void>("hand_off_progress", { item });

export const clearAllCaches = (): Promise<void> => invoke<void>("clear_all_caches");

// --- Group Hierarchy Commands ---

export const getGroupHierarchy = (
	providerId: string,
	contentType: string
): Promise<GroupHierarchyEntry[]> =>
	invoke<GroupHierarchyEntry[]>("get_group_hierarchy", { providerId, contentType });

export const reorderGroupHierarchyEntry = (
	providerId: string,
	contentType: string,
	groupName: string,
	newSortOrder: number
): Promise<void> =>
	invoke("reorder_group_hierarchy_entry", {
		providerId,
		contentType,
		groupName,
		newSortOrder,
	});

export const updateGroupHierarchyEntry = (
	providerId: string,
	contentType: string,
	groupName: string,
	newSuperCategory: string | null,
	newSortOrder: number
): Promise<void> =>
	invoke("update_group_hierarchy_entry", {
		providerId,
		contentType,
		groupName,
		newSuperCategory,
		newSortOrder,
	});

export const deleteGroupHierarchy = (providerId: string, contentType: string): Promise<void> =>
	invoke("delete_group_hierarchy", { providerId, contentType });

export const pinGroup = (
	providerId: string,
	contentType: string,
	groupName: string,
	sortOrder: number
): Promise<void> => invoke("pin_group", { providerId, contentType, groupName, sortOrder });

export const unpinGroup = (
	providerId: string,
	contentType: string,
	groupName: string
): Promise<void> => invoke("unpin_group", { providerId, contentType, groupName });

export const getPinnedGroups = (providerId: string, contentType: string): Promise<PinnedGroup[]> =>
	invoke<PinnedGroup[]>("get_pinned_groups", { providerId, contentType });

// --- Gemini API Commands ---

export const getGeminiApiKey = (): Promise<string | null> =>
	invoke<string | null>("get_gemini_api_key");

export const setGeminiApiKey = (key: string): Promise<void> =>
	invoke("set_gemini_api_key", { key });

export const testGeminiApiKey = (key: string): Promise<boolean> =>
	invoke<boolean>("test_gemini_api_key", { key });

export const categorizeProvider = (
	providerId: string,
	contentType: string,
	apiKey: string,
	groupsWithSamples: [string, string[]][]
): Promise<GroupHierarchyEntry[]> =>
	invoke<GroupHierarchyEntry[]>("categorize_provider", {
		providerId,
		contentType,
		apiKey,
		groupsWithSamples,
	});

export const fixUncategorizedGroups = (
	providerId: string,
	contentType: string,
	apiKey: string,
	uncategorizedGroups: [string, string[]][],
	existingCategories: string[]
): Promise<GroupHierarchyEntry[]> =>
	invoke<GroupHierarchyEntry[]>("fix_uncategorized_groups", {
		providerId,
		contentType,
		apiKey,
		uncategorizedGroups,
		existingCategories,
	});

export const renameSuperCategory = (
	providerId: string,
	contentType: string,
	oldName: string,
	newName: string
): Promise<void> => invoke("rename_super_category", { providerId, contentType, oldName, newName });

export const deleteSuperCategory = (
	providerId: string,
	contentType: string,
	categoryName: string
): Promise<void> => invoke("delete_super_category", { providerId, contentType, categoryName });

// --- Install Info ---

export interface InstallInfo {
	installType: string; // "appimage" | "deb" | "rpm" | "native"
	releaseUrl: string;
}

export const getInstallInfo = (): Promise<InstallInfo> => invoke<InstallInfo>("get_install_info");

export const packageUpdate = (): Promise<void> => invoke("package_update");

// --- Downloads ---

export const enqueueMovieDownload = (channelId: string): Promise<string> =>
	invoke("enqueue_movie_download", { channelId });

export const enqueueEpisodeDownload = (
	episode: Channel,
	seriesChannelId: string,
	seriesTitle: string
): Promise<string> => invoke("enqueue_episode_download", { episode, seriesChannelId, seriesTitle });

export const enqueueEpisodesBatch = (
	episodes: Channel[],
	seriesChannelId: string,
	seriesTitle: string
): Promise<string[]> =>
	invoke("enqueue_episodes_batch", { episodes, seriesChannelId, seriesTitle });

export const listDownloads = (): Promise<DownloadRecord[]> => invoke("list_downloads");

export const cacheSeriesEpisodes = (seriesChannelId: string, episodes: Channel[]): Promise<void> =>
	invoke("cache_series_episodes", { seriesChannelId, episodes });

export const getCachedSeriesEpisodes = (seriesChannelId: string): Promise<Channel[]> =>
	invoke("get_cached_series_episodes", { seriesChannelId });

export const stopDownload = (id: string): Promise<void> => invoke("stop_download", { id });

export const stopDownloads = (ids: string[]): Promise<void> => invoke("stop_downloads", { ids });

export const removeDownload = (id: string): Promise<void> => invoke("remove_download", { id });

export const removeDownloads = (ids: string[]): Promise<void> =>
	invoke("remove_downloads", { ids });

export const getDownloadConcurrency = (): Promise<number> => invoke("get_download_concurrency");

export const setDownloadConcurrency = (n: number): Promise<void> =>
	invoke("set_download_concurrency", { n });

export const getDownloadFolder = (): Promise<string> => invoke("get_download_folder");

export const setDownloadFolder = (path: string): Promise<void> =>
	invoke("set_download_folder", { path });

export const resolveLocalDownload = (channelId: string): Promise<string | null> =>
	invoke("resolve_local_download", { channelId });

export const setDownloadKeep = (id: string, keep: boolean): Promise<void> =>
	invoke("set_download_keep", { id, keep });

/** Days finished downloads are kept, or null to keep them until removed. */
export const getDownloadRetention = (): Promise<number | null> => invoke("get_download_retention");

/** Resolves to how many downloads the new setting deleted right away. */
export const setDownloadRetention = (days: number | null): Promise<number> =>
	invoke("set_download_retention", { days });

export const countDownloadsDue = (days: number | null): Promise<number> =>
	invoke("count_downloads_due", { days });

/**
 * Record the live channel `channelId` from `startAt` to `endAt`, in Unix
 * seconds, for the guide's `program` when there is one. A start that has
 * passed records from now.
 */
export const scheduleRecording = (
	channelId: string,
	startAt: number,
	endAt: number,
	program: GuideProgram | null
): Promise<DownloadRecord> => invoke("schedule_recording", { channelId, startAt, endAt, program });

/** Stop a recording and keep what it recorded, or cancel one that hasn't started. */
export const stopRecording = (id: string): Promise<void> => invoke("stop_recording", { id });
