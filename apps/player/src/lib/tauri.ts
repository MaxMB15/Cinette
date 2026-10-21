// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { invoke } from "./invoke";
import type { AirPlayRoute } from "@/lib/airplay";
import type { CatalogItem } from "@/lib/cinette-destination";
import type { CommandOutcome, RemoteCommand, RemotePlayerState } from "@/lib/remote-target";
import type { ConverterSupport, PlayingInfo, StreamFormats } from "@/lib/route-profiles";
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

/** The playing item's container and codecs, for deciding how to cast it. */
export const mpvGetMediaInfo = (): Promise<PlayingInfo> => invoke("plugin:mpv|mpv_get_media_info");

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

/** What this computer's bundled ffmpeg can convert for a receiver. */
export const getConverterSupport = (): Promise<ConverterSupport> => invoke("get_converter_support");

/**
 * The formats `channel` comes in, for Cast and AirPlay. While mpv plays it,
 * the backend asks mpv, so the provider isn't asked for a second
 * connection. Rejects with `REFUSED` when the provider turns the login
 * down, and with `NOT_READY` while mpv is still opening it.
 */
export const getStreamFormats = (channel: Channel): Promise<StreamFormats> =>
	invoke("get_stream_formats", { channel });

/**
 * Plays `channel` on the chosen AirPlay receiver, from the URL at `source`
 * in the `getStreamFormats` list named `generation`. The URL stays in the
 * backend. Stop local playback first.
 */
export const airplayLoad = (
	channel: Channel,
	generation: number,
	source: number,
	startAt?: number
): Promise<void> => invoke("airplay_load", { channel, generation, source, startAt });

/**
 * Converts `channel` from the URL at `source` in the `getStreamFormats`
 * list named `generation`, on this device, and plays the
 * result on the chosen AirPlay receiver. Resolves once the receiver can
 * start. Rejects with `REFUSED` when the provider turns the login down, or
 * with a message to show.
 */
export const airplayLoadConverted = (
	channel: Channel,
	generation: number,
	source: number,
	startAt?: number
): Promise<void> => invoke("airplay_load_converted", { channel, generation, source, startAt });

/** Stops this device's AirPlay conversion, if one runs. */
export const airplayEndConversion = (): Promise<void> => invoke("airplay_end_conversion");

/** What this device can convert for AirPlay. */
export const airplayConverterSupport = (): Promise<ConverterSupport> =>
	invoke("airplay_converter_support");

/** Looks for AirPlay receivers while the player is open. It costs power. */
export const airplaySetDetection = (enabled: boolean): Promise<void> =>
	invoke("plugin:mpv|airplay_set_detection", { enabled });

/** Opens the system's AirPlay picker over a rect in CSS pixels. */
export const airplayChoose = (rect: {
	x: number;
	y: number;
	width: number;
	height: number;
}): Promise<void> => invoke("plugin:mpv|airplay_choose", rect);

export const airplayGetRoute = (): Promise<AirPlayRoute | null> =>
	invoke("plugin:mpv|airplay_get_route");

export const airplayPlay = (): Promise<void> => invoke("plugin:mpv|airplay_play");

export const airplayPause = (): Promise<void> => invoke("plugin:mpv|airplay_pause");

export const airplaySeek = (position: number): Promise<void> =>
	invoke("plugin:mpv|airplay_seek", { position });

export const airplaySelectSubtitle = (index: number | null): Promise<void> =>
	invoke("plugin:mpv|airplay_select_subtitle", { index });

export const airplaySelectAudio = (index: number): Promise<void> =>
	invoke("plugin:mpv|airplay_select_audio", { index });

export const airplayStop = (): Promise<void> => invoke("plugin:mpv|airplay_stop");

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

/** Saves that an item was watched to the end. It isn't offered to resume. */
export const markPositionFinished = (contentKey: string, durationSeconds: number): Promise<void> =>
	invoke<void>("mark_position_finished", { contentKey, durationSeconds });

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

/** A Cast receiver on the local network, as `_googlecast._tcp` browsing found it. */
export interface CastReceiver {
	/** `cast:` and the receiver's own id, which stays the same across renames. */
	id: string;
	name: string;
	/** Such as "Chromecast Ultra", for `castProfile`. */
	model: string;
	/** What it shows now, such as "YouTube", when it says. */
	status: string | null;
	/** False once it went away while held, or couldn't be reached. */
	available: boolean;
}

/** The receivers, as `getCastReceivers` and `CAST_RECEIVERS_EVENT` give them. */
export interface CastReceiverList {
	/** Higher for a newer list. */
	revision: number;
	receivers: CastReceiver[];
	/** macOS refuses this app local network access, so nothing can be found
	 *  until it's allowed in System Settings. Show that instead of an empty
	 *  list. */
	localNetworkDenied: boolean;
}

/**
 * The event that carries the whole list, as a `CastReceiverList`, after a
 * change, at most one every 200 ms. The reply to `getCastReceivers` and
 * these events can arrive in any order, so listen before calling it, and
 * keep whichever list has the highest `revision`.
 */
export const CAST_RECEIVERS_EVENT = "cast://receivers";

/** The Cast receivers found so far. The first call starts looking for them. */
export const getCastReceivers = (): Promise<CastReceiverList> => invoke("get_cast_receivers");

/**
 * Keep these receivers listed, as unavailable, if they go away: the active
 * destination and the rows an open picker shows. Each call replaces the last.
 */
export const holdCastReceivers = (ids: string[]): Promise<void> =>
	invoke("hold_cast_receivers", { ids });

/** Who may control this device from another Cinette device. */
export type RemoteControlMode = "always" | "ask" | "never";

/** The remote-control settings and this device's id. */
export interface RemoteSettings {
	discoverable: boolean;
	remoteControl: RemoteControlMode;
	/** The name the user gave this device, or null for the default. */
	deviceName: string | null;
	/** The name used when none is given: the device type, like "Mac". */
	defaultName: string;
	deviceId: string;
}

/** A device controlling this one, connected or waiting to resume. */
export interface RemoteSession {
	sessionId: string;
	deviceId: string;
	name: string;
	deviceType: string;
	connected: boolean;
}

export const remoteGetSettings = (): Promise<RemoteSettings> => invoke("remote_get_settings");

/** Never allow ends every session at once. */
export const remoteSetSettings = (settings: {
	discoverable: boolean;
	remoteControl: RemoteControlMode;
	deviceName: string | null;
}): Promise<RemoteSettings> => invoke("remote_set_settings", { settings });

/** A new device id. Every session ends. */
export const remoteResetIdentity = (): Promise<RemoteSettings> => invoke("remote_reset_identity");

export const remoteAnswerConsent = (request: number, allow: boolean): Promise<void> =>
	invoke("remote_answer_consent", { request, allow });

export const remoteSessions = (): Promise<RemoteSession[]> => invoke("remote_sessions");

/** Which parts of the history a transfer copies. */
export interface TransferWhat {
	history: boolean;
	favorites: boolean;
	pins: boolean;
}

/** How many of each the device the history comes from has. */
export interface TransferCounts {
	history: number;
	positions: number;
	favorites: number;
	pins: number;
}

/** A provider as a request names it, before any login goes out. */
export interface ProviderName {
	name: string;
	kind: "m3u" | "xtream";
}

/** A transfer a controller asks for, as the consent dialog shows it. */
export type RemoteAsked =
	| {
			kind: "history";
			/** From the asking device's side: "send" writes here, "import" reads here. */
			direction: "send" | "import";
			what: TransferWhat;
			counts?: TransferCounts;
	  }
	| { kind: "providers"; providers: ProviderName[] };

/** A device asking to control this one, or, with `asked`, for a transfer,
 *  as `remote://consent` brings it. */
export interface RemoteConsentEvent {
	request: number;
	deviceId: string;
	name: string;
	deviceType: string;
	code: string;
	expiresInMs: number;
	asked?: RemoteAsked;
}

/** What became of one provider sent to another device. */
export interface ProviderResult {
	name: string;
	outcome: "added" | "exists" | "failed" | "unknown";
	error?: string;
	/** The name it was saved under, when the other device had one like it. */
	savedAs?: string;
}

/** An error code as the remote-control protocol spells it. */
export type RemoteErrorCode =
	| "invalid"
	| "unsupported"
	| "not_found"
	| "stale_item"
	| "rate_limited"
	| "failed"
	| "denied"
	| "expired"
	| "busy"
	| "cancelled"
	| "unknown";

/** How far a transfer has got. */
export type TransferProgress =
	| { state: "sending"; data: { done: number; total: number } }
	| { state: "receiving"; data: { received: number } }
	| { state: "saving" }
	| { state: "done"; data: unknown }
	| { state: "providersDone"; data: ProviderResult[] }
	| { state: "failed"; data: RemoteErrorCode };

/** A transfer this device asked for, as `remote://transfer` brings it. */
export type RemoteTransferNotice = { deviceId: string; link: number } & (
	| { step: "pending"; expiresInMs: number }
	| { step: "refused"; code: RemoteErrorCode }
	| { step: "progress"; transfer: string; progress: TransferProgress }
	| { step: "preview"; transfer: string; counts: TransferCounts }
);

/** How one kind of row fared in a history transfer. */
export interface TransferTally {
	added: number;
	updated: number;
	unchanged: number;
}

/** Something a history transfer couldn't place. */
export interface TransferUnmatched {
	name: string;
	kind: "live" | "movie" | "series" | "episode" | "pinnedGroup";
	reason: "missing" | "ambiguous";
}

/** What a history transfer did on the device that wrote it. */
export interface TransferReport {
	history: TransferTally;
	positions: TransferTally;
	favorites: TransferTally;
	pins: TransferTally;
	unmatched: TransferUnmatched[];
	unmatchedTotal: number;
	resume?: { channelId: string; name: string; position?: number };
}

/** History written here, as `remote://history-imported` brings it. */
export interface RemoteHistoryImported {
	from: string;
	report: TransferReport;
	/** The channel to continue watching, when it matched one here. */
	channel?: Channel;
}

/** Asks the device link `link` controls to copy history. For "send",
 *  `playing` is the channel this device's player has open. */
export const remoteAskHistory = (
	link: number,
	direction: "send" | "import",
	what: TransferWhat,
	playing: string | null
): Promise<void> => invoke("remote_ask_history", { link, direction, what, playing });

/** How many of each this device would send. */
export const remoteHistoryCounts = (what: TransferWhat): Promise<TransferCounts> =>
	invoke("remote_history_counts", { what });

/** Starts an import the other device allowed, after its preview. */
export const remoteStartImport = (link: number, transfer: string): Promise<void> =>
	invoke("remote_start_import", { link, transfer });

/** Says the player saved its position, as `remote://save-progress` asked. */
export const remoteProgressSaved = (playing: string | null): Promise<void> =>
	invoke("remote_progress_saved", { playing });

/** A transfer another device runs with this one, as `remote://transfer-target` brings it. */
export interface RemoteTargetTransfer {
	deviceId: string;
	name: string;
	transfer: string;
	kind: "history" | "providers";
	progress: TransferProgress;
}

/** Providers another device sent, saved here, as `remote://providers-added` brings them. */
export interface RemoteProvidersAdded {
	from: string;
	names: string[];
}

/** Asks the device link `link` controls to take these providers. Only their
 *  names go now; the rest comes as `remote://transfer`. */
export const remoteSendProviders = (link: number, providerIds: string[]): Promise<void> =>
	invoke("remote_send_providers", { link, providerIds });

/** Stops the transfer on link `link`. Nothing is written on either device. */
export const remoteCancelTransfer = (link: number): Promise<void> =>
	invoke("remote_cancel_transfer", { link });

/** The request on screen now, for a page that wasn't listening when it came. */
export const remotePendingConsent = (): Promise<RemoteConsentEvent | null> =>
	invoke("remote_pending_consent");

export const remoteDisconnect = (sessionId: string): Promise<void> =>
	invoke("remote_disconnect", { sessionId });

// States go out one after another, so a slow "playing" can't land after
// the idle state a closing player sends next.
let lastRemoteState: Promise<void> = Promise.resolve();

export const remoteSetState = (state: RemotePlayerState): Promise<void> => {
	const result = lastRemoteState.then(() => invoke<void>("remote_set_state", { state }));
	lastRemoteState = result.then(
		() => {},
		() => {}
	);
	return result;
};

export const remoteFinishCommand = (token: number, outcome: CommandOutcome): Promise<void> =>
	invoke("remote_finish_command", { token, outcome });

/** Another Cinette device on the network. */
export interface RemoteDevice {
	deviceId: string;
	name: string;
	/** Like `mac`, `linux-pc` or `fire-tv`. */
	deviceType: string;
	/** False when that device is set to Never allow. */
	controlAllowed: boolean;
	/** False when discovery lost it. */
	available: boolean;
}

export const remoteDevices = (): Promise<RemoteDevice[]> => invoke("remote_devices");

/** Whether macOS refuses Cinette the local network, so no device can be found. */
export const remoteLocalNetworkDenied = (): Promise<boolean> =>
	invoke("remote_local_network_denied");

/** Asks a device for control. Progress comes as `remote://controller`.
 *  `link` is a number this side picks; that link's events carry it, and its
 *  commands name it. */
export const remoteConnect = (deviceId: string, link: number): Promise<void> =>
	invoke("remote_connect", { deviceId, link });

/** The link the backend holds now, if any. */
export const remoteLink = (): Promise<number | null> => invoke("remote_link");

/** Ends link `link` to the controlled device, or stops it asking. That
 *  device keeps playing. A link that took its place stays, and a connect
 *  numbered at or below `link` is refused from then on. */
export const remoteLeave = (link: number): Promise<void> => invoke("remote_leave", { link });

/** Resolves with the other device's state version once it carried the
 *  command out. Rejects with the protocol's error code, like `stale_item`,
 *  or `link_not_connected`. */
export const remoteCommand = (link: number, command: RemoteCommand): Promise<number> =>
	invoke("remote_command", { command, link });

/** A query for the controlled device's catalog. */
export type CatalogQuery =
	| { kind: "groups"; contentType: string; cursor?: string; limit: number }
	| { kind: "items"; contentType: string; group: string; cursor?: string; limit: number }
	| { kind: "search"; query: string; contentType?: string; limit: number }
	| { kind: "episodes"; seriesId: string; cursor?: string; limit: number };

/** A page of the catalog of the device link `link` goes to. */
export const remoteCatalog = (
	link: number,
	catalogQuery: CatalogQuery
): Promise<{ items: CatalogItem[]; next: string | null }> =>
	invoke("remote_catalog", { catalogQuery, link });
