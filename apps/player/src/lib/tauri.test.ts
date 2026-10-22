// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { deferred } from "@/test/deferred";
import { mpvLoad, mpvStop } from "./tauri";
import * as tauri from "./tauri";
import type { Channel } from "./types";
import type { RemotePlayerState } from "./remote-target";
import commandArguments from "../../src-tauri/src/commands/tests/arguments.json";

const ARGUMENTS_FILE = "src-tauri/src/commands/tests/arguments.json";

const flush = () => new Promise((r) => setTimeout(r, 0));

const commands = () => invoke.mock.calls.map(([cmd]) => cmd);

describe("remote states", () => {
	beforeEach(() => invoke.mockReset());

	it("go out in order, each after the one before has its answer", async () => {
		const first = deferred();
		invoke.mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
		const playing = { status: "playing" } as RemotePlayerState;
		const idle = { status: "idle" } as RemotePlayerState;

		const sent = tauri.remoteSetState(playing);
		const closed = tauri.remoteSetState(idle);
		await flush();
		expect(invoke.mock.calls).toEqual([["remote_set_state", { state: playing }]]);

		first.reject(new Error("not running"));
		await expect(sent).rejects.toThrow("not running");
		await closed;
		expect(invoke.mock.calls).toEqual([
			["remote_set_state", { state: playing }],
			["remote_set_state", { state: idle }],
		]);
	});
});

describe("mpv load and stop", () => {
	beforeEach(() => invoke.mockReset());

	it("sends a load only after the stop before it finishes", async () => {
		const stop = deferred();
		invoke.mockReturnValueOnce(stop.promise).mockResolvedValueOnce(undefined);

		void mpvStop();
		const load = mpvLoad("http://example.com/live.ts");
		await flush();
		expect(commands()).toEqual(["plugin:mpv|mpv_stop"]);

		stop.resolve();
		await load;
		expect(commands()).toEqual(["plugin:mpv|mpv_stop", "plugin:mpv|mpv_load"]);
	});

	it("keeps going after a failed call and still reports the failure", async () => {
		const load = deferred();
		invoke.mockReturnValueOnce(load.promise).mockResolvedValueOnce(undefined);

		const failed = mpvLoad("http://example.com/bad.ts");
		const stopped = mpvStop();
		load.reject(new Error("load failed"));

		await expect(failed).rejects.toThrow("load failed");
		await stopped;
		expect(commands()).toEqual(["plugin:mpv|mpv_load", "plugin:mpv|mpv_stop"]);
	});

	it("sends subtitle changes only after the load before them finishes", async () => {
		const load = deferred();
		invoke.mockReturnValueOnce(load.promise).mockResolvedValue(undefined);

		void mpvLoad("http://example.com/movie.mkv");
		const added = tauri.mpvSubAdd("/tmp/a.srt", false, "http://example.com/movie.mkv");
		const removed = tauri.mpvSubRemove(-1);
		await flush();
		expect(commands()).toEqual(["plugin:mpv|mpv_load"]);

		load.resolve();
		await added;
		await removed;
		expect(commands()).toEqual([
			"plugin:mpv|mpv_load",
			"plugin:mpv|mpv_sub_add",
			"plugin:mpv|mpv_sub_remove",
		]);
		// A remove for no stream in particular takes the track that plays.
		expect(invoke.mock.calls[2]).toStrictEqual([
			"plugin:mpv|mpv_sub_remove",
			{ id: -1, url: undefined },
		]);
	});
});

describe("mpvLoad arguments", () => {
	beforeEach(() => invoke.mockReset().mockResolvedValue(undefined));

	it("starts from the beginning with hardware decoding unless told otherwise", async () => {
		await mpvLoad("http://example.com/live.ts");
		expect(invoke).toHaveBeenLastCalledWith("plugin:mpv|mpv_load", {
			url: "http://example.com/live.ts",
			startPos: null,
			hwdec: true,
			keepSubtitles: false,
		});
	});

	it("passes a resume position and software decoding through", async () => {
		await mpvLoad("http://example.com/movie.mkv", 125, false);
		expect(invoke).toHaveBeenLastCalledWith("plugin:mpv|mpv_load", {
			url: "http://example.com/movie.mkv",
			startPos: 125,
			hwdec: false,
			keepSubtitles: false,
		});
	});

	it("asks to keep the subtitles when told to", async () => {
		await mpvLoad("http://example.com/movie.mkv", undefined, true, true);
		expect(invoke).toHaveBeenLastCalledWith("plugin:mpv|mpv_load", {
			url: "http://example.com/movie.mkv",
			startPos: null,
			hwdec: true,
			keepSubtitles: true,
		});
	});
});

/**
 * Tauri matches arguments by name, after turning the Rust parameter names
 * into camelCase. A misspelled key doesn't fail to compile, the command just
 * gets nothing, so each wrapper's command and keys are checked here against
 * the `#[command]` functions in src-tauri and the mpv plugin.
 */
describe("backend commands", () => {
	beforeEach(() => invoke.mockReset());

	const episode = { id: "ep-1", name: "Pilot" } as Channel;
	const episodes = [episode, { id: "ep-2", name: "Second" } as Channel];
	const samples: [string, string[]][] = [["News", ["CNN", "BBC"]]];

	type Case = [name: string, call: () => Promise<unknown>, command: string, args?: object];

	const remoteState: RemotePlayerState = {
		status: "idle",
		item: null,
		position: 0,
		duration: 0,
		volume: null,
		subtitles: [],
		subtitleId: null,
		audio: [],
		audioId: null,
		capabilities: {
			pause: false,
			seek: false,
			volume: false,
			subtitles: false,
			audioTracks: false,
			resumeAt: false,
		},
		error: null,
	};

	const cases: Case[] = [
		// mpv
		["mpvPlay", () => tauri.mpvPlay(), "plugin:mpv|mpv_play"],
		["mpvPause", () => tauri.mpvPause(), "plugin:mpv|mpv_pause"],
		["mpvStop", () => tauri.mpvStop(), "plugin:mpv|mpv_stop"],
		["mpvSeek", () => tauri.mpvSeek(42.5), "plugin:mpv|mpv_seek", { position: 42.5 }],
		["mpvSetVolume", () => tauri.mpvSetVolume(80), "plugin:mpv|mpv_set_volume", { volume: 80 }],
		["mpvGetState", () => tauri.mpvGetState(), "plugin:mpv|mpv_get_state"],
		["mpvGetMediaInfo", () => tauri.mpvGetMediaInfo(), "plugin:mpv|mpv_get_media_info"],
		[
			"mpvSetVisible",
			() => tauri.mpvSetVisible(false),
			"plugin:mpv|mpv_set_visible",
			{ visible: false },
		],
		[
			"mpvSetMediaInfo",
			() => tauri.mpvSetMediaInfo("News at Ten", true, "http://logos.example.test/news.png"),
			"plugin:mpv|mpv_set_media_info",
			{ title: "News at Ten", live: true, artwork: "http://logos.example.test/news.png" },
		],
		[
			"mpvSetSkipIntervals",
			() => tauri.mpvSetSkipIntervals(5, 30),
			"plugin:mpv|mpv_set_skip_intervals",
			{ back: 5, forward: 30 },
		],
		[
			"mpvSetBounds",
			() => tauri.mpvSetBounds(1, 2, 3, 4),
			"plugin:mpv|mpv_set_bounds",
			{ x: 1, y: 2, w: 3, h: 4 },
		],
		[
			"mpvSubAdd",
			() => tauri.mpvSubAdd("/tmp/a.srt", true, "http://example.com/movie.mkv"),
			"plugin:mpv|mpv_sub_add",
			{ path: "/tmp/a.srt", overlay: true, url: "http://example.com/movie.mkv" },
		],
		[
			"mpvSubRemove",
			() => tauri.mpvSubRemove(3, "http://example.com/movie.mkv"),
			"plugin:mpv|mpv_sub_remove",
			{ id: 3, url: "http://example.com/movie.mkv" },
		],
		[
			"mpvSetSubDelay",
			() => tauri.mpvSetSubDelay(-0.5),
			"plugin:mpv|mpv_set_sub_delay",
			{ delay: -0.5 },
		],
		// Providers and channels
		[
			"loadM3uPlaylist",
			() => tauri.loadM3uPlaylist("Home", "http://example.com/list.m3u"),
			"load_m3u_playlist",
			{ name: "Home", url: "http://example.com/list.m3u" },
		],
		[
			"loadM3uFile",
			() => tauri.loadM3uFile("Local", "/music/list.m3u"),
			"load_m3u_file",
			{ name: "Local", path: "/music/list.m3u" },
		],
		[
			"loadXtreamProvider",
			() => tauri.loadXtreamProvider("Xt", "http://xt.example", "user", "secret"),
			"load_xtream_provider",
			{ name: "Xt", url: "http://xt.example", username: "user", password: "secret" },
		],
		["getProviders", () => tauri.getProviders(), "get_providers"],
		["getConverterSupport", () => tauri.getConverterSupport(), "get_converter_support"],
		[
			"getStreamFormats",
			() => tauri.getStreamFormats(episode),
			"get_stream_formats",
			{ channel: episode },
		],
		[
			"airplayLoad",
			() => tauri.airplayLoad(episode, 7, 1, 30),
			"airplay_load",
			{ channel: episode, generation: 7, source: 1, startAt: 30 },
		],
		[
			"airplayLoadConverted",
			() => tauri.airplayLoadConverted(episode, 7, 0, 12),
			"airplay_load_converted",
			{ channel: episode, generation: 7, source: 0, startAt: 12 },
		],
		["airplayEndConversion", () => tauri.airplayEndConversion(), "airplay_end_conversion"],
		[
			"airplayConverterSupport",
			() => tauri.airplayConverterSupport(),
			"airplay_converter_support",
		],
		[
			"airplaySetDetection",
			() => tauri.airplaySetDetection(true),
			"plugin:mpv|airplay_set_detection",
			{ enabled: true },
		],
		[
			"airplayChoose",
			() => tauri.airplayChoose({ x: 1, y: 2, width: 3, height: 4 }),
			"plugin:mpv|airplay_choose",
			{ x: 1, y: 2, width: 3, height: 4 },
		],
		["airplayGetRoute", () => tauri.airplayGetRoute(), "plugin:mpv|airplay_get_route"],
		["airplayPlay", () => tauri.airplayPlay(), "plugin:mpv|airplay_play"],
		["airplayPause", () => tauri.airplayPause(), "plugin:mpv|airplay_pause"],
		["airplaySeek", () => tauri.airplaySeek(12), "plugin:mpv|airplay_seek", { position: 12 }],
		[
			"airplaySelectSubtitle",
			() => tauri.airplaySelectSubtitle(null),
			"plugin:mpv|airplay_select_subtitle",
			{ index: null },
		],
		[
			"airplaySelectAudio",
			() => tauri.airplaySelectAudio(2),
			"plugin:mpv|airplay_select_audio",
			{ index: 2 },
		],
		["airplayStop", () => tauri.airplayStop(), "plugin:mpv|airplay_stop"],
		["removeProvider", () => tauri.removeProvider("p1"), "remove_provider", { id: "p1" }],
		["getAllChannels", () => tauri.getAllChannels(), "get_all_channels"],
		[
			"toggleFavorite",
			() => tauri.toggleFavorite("c1"),
			"toggle_favorite",
			{ channelId: "c1" },
		],
		["refreshProvider", () => tauri.refreshProvider("p1"), "refresh_provider", { id: "p1" }],
		[
			"updateProvider",
			() => tauri.updateProvider("p1", "Renamed", "http://new.example", "user", "secret"),
			"update_provider",
			{
				id: "p1",
				name: "Renamed",
				url: "http://new.example",
				username: "user",
				password: "secret",
			},
		],
		[
			"getXtreamSeriesEpisodes",
			() => tauri.getXtreamSeriesEpisodes("s1"),
			"get_xtream_series_episodes",
			{ channelId: "s1" },
		],
		// EPG
		["refreshEpg", () => tauri.refreshEpg("p1"), "refresh_epg", { providerId: "p1" }],
		[
			"getEpgProgrammes",
			() => tauri.getEpgProgrammes("c1", 100, 200),
			"get_epg_programmes",
			{ channelId: "c1", rangeStart: 100, rangeEnd: 200 },
		],
		[
			"getEpgForLiveChannels",
			() => tauri.getEpgForLiveChannels(100, 200, ["news.tv"]),
			"get_epg_for_live_channels",
			{ rangeStart: 100, rangeEnd: 200, channelIds: ["news.tv"] },
		],
		[
			"searchEpgProgrammes",
			() => tauri.searchEpgProgrammes("match", 100),
			"search_epg_programmes",
			{ query: "match", rangeStart: 100 },
		],
		[
			"setEpgUrl",
			() => tauri.setEpgUrl("p1", "http://epg.example/guide.xml"),
			"set_epg_url",
			{ providerId: "p1", epgUrl: "http://epg.example/guide.xml" },
		],
		["detectEpgUrl", () => tauri.detectEpgUrl("p1"), "detect_epg_url", { id: "p1" }],
		// Metadata services
		["getOmdbApiKey", () => tauri.getOmdbApiKey(), "get_omdb_api_key"],
		["setOmdbApiKey", () => tauri.setOmdbApiKey("k1"), "set_omdb_api_key", { key: "k1" }],
		[
			"fetchOmdbData",
			() => tauri.fetchOmdbData("c1", "Heat", "movie"),
			"fetch_omdb_data",
			{ channelId: "c1", title: "Heat", contentType: "movie" },
		],
		["getMdbListApiKey", () => tauri.getMdbListApiKey(), "get_mdblist_api_key"],
		[
			"setMdbListApiKey",
			() => tauri.setMdbListApiKey("k2"),
			"set_mdblist_api_key",
			{ key: "k2" },
		],
		["testOmdbApiKey", () => tauri.testOmdbApiKey("k1"), "test_omdb_api_key", { key: "k1" }],
		[
			"testMdbListApiKey",
			() => tauri.testMdbListApiKey("k2"),
			"test_mdblist_api_key",
			{ key: "k2" },
		],
		[
			"fetchMdbListData",
			() => tauri.fetchMdbListData("tt0113277", "movie"),
			"fetch_mdblist_data",
			{ imdbId: "tt0113277", mediaType: "movie" },
		],
		[
			"fetchWhatsonData",
			() => tauri.fetchWhatsonData("tt0113277", "show"),
			"fetch_whatson_data",
			{ imdbId: "tt0113277", mediaType: "show" },
		],
		// Skip segments
		[
			"getSkipSegments",
			() => tauri.getSkipSegments("tt0903747", 1, 2, 2820),
			"get_skip_segments",
			{ imdbId: "tt0903747", season: 1, episode: 2, duration: 2820 },
		],
		// Subtitles
		[
			"getOpenSubtitlesApiKey",
			() => tauri.getOpenSubtitlesApiKey(),
			"get_opensubtitles_api_key",
		],
		[
			"setOpenSubtitlesApiKey",
			() => tauri.setOpenSubtitlesApiKey("k3"),
			"set_opensubtitles_api_key",
			{ key: "k3" },
		],
		[
			"testOpenSubtitlesApiKey",
			() => tauri.testOpenSubtitlesApiKey("k3"),
			"test_opensubtitles_api_key",
			{ key: "k3" },
		],
		[
			"searchSubtitles",
			() => tauri.searchSubtitles("tt0903747", 2, 7),
			"search_subtitles",
			{ imdbId: "tt0903747", season: 2, episode: 7 },
		],
		[
			"downloadSubtitle",
			() => tauri.downloadSubtitle(991),
			"download_subtitle",
			{ fileId: 991 },
		],
		[
			"readSubtitleFile",
			() => tauri.readSubtitleFile("/tmp/b.srt"),
			"read_subtitle_file",
			{ path: "/tmp/b.srt" },
		],
		// Watch history and resume points
		[
			"recordPlayStart",
			() => tauri.recordPlayStart("c1", "CNN", "http://logo.example/cnn.png", "live"),
			"record_play_start",
			{
				channelId: "c1",
				channelName: "CNN",
				channelLogo: "http://logo.example/cnn.png",
				contentType: "live",
			},
		],
		[
			"recordPlayEnd",
			() => tauri.recordPlayEnd("c1", 360),
			"record_play_end",
			{ channelId: "c1", durationSeconds: 360 },
		],
		[
			"getWatchHistory",
			() => tauri.getWatchHistory(50, "movie"),
			"get_watch_history",
			{ limit: 50, contentType: "movie" },
		],
		[
			"deleteHistoryEntry",
			() => tauri.deleteHistoryEntry("c1"),
			"delete_history_entry",
			{ channelId: "c1" },
		],
		[
			"deleteHistorySeries",
			() => tauri.deleteHistorySeries("Lost"),
			"delete_history_series",
			{ seriesTitle: "Lost" },
		],
		["clearWatchHistory", () => tauri.clearWatchHistory(), "clear_watch_history"],
		[
			"clearWatchHistoryOfType",
			() => tauri.clearWatchHistoryOfType("series"),
			"clear_watch_history_of_type",
			{ contentType: "series" },
		],
		[
			"savePlaybackPosition",
			() => tauri.savePlaybackPosition("movie:c1", 600, 7200),
			"save_playback_position",
			{ contentKey: "movie:c1", positionSeconds: 600, durationSeconds: 7200 },
		],
		[
			"getPlaybackPosition",
			() => tauri.getPlaybackPosition("movie:c1"),
			"get_playback_position",
			{ contentKey: "movie:c1" },
		],
		[
			"markPositionFinished",
			() => tauri.markPositionFinished("movie:heat", 6000),
			"mark_position_finished",
			{ contentKey: "movie:heat", durationSeconds: 6000 },
		],
		[
			"deletePlaybackPosition",
			() => tauri.deletePlaybackPosition("movie:c1"),
			"delete_playback_position",
			{ contentKey: "movie:c1" },
		],
		[
			"handOffProgress",
			() =>
				tauri.handOffProgress({
					key: "movie:c1",
					url: "http://v.example",
					pendingStart: 30,
				}),
			"hand_off_progress",
			{ item: { key: "movie:c1", url: "http://v.example", pendingStart: 30 } },
		],
		["clearAllCaches", () => tauri.clearAllCaches(), "clear_all_caches"],
		// Category hierarchy and pinned groups
		[
			"getGroupHierarchy",
			() => tauri.getGroupHierarchy("p1", "live"),
			"get_group_hierarchy",
			{ providerId: "p1", contentType: "live" },
		],
		[
			"reorderGroupHierarchyEntry",
			() => tauri.reorderGroupHierarchyEntry("p1", "live", "News", 300),
			"reorder_group_hierarchy_entry",
			{ providerId: "p1", contentType: "live", groupName: "News", newSortOrder: 300 },
		],
		[
			"updateGroupHierarchyEntry",
			() => tauri.updateGroupHierarchyEntry("p1", "live", "News", "World", 400),
			"update_group_hierarchy_entry",
			{
				providerId: "p1",
				contentType: "live",
				groupName: "News",
				newSuperCategory: "World",
				newSortOrder: 400,
			},
		],
		[
			"deleteGroupHierarchy",
			() => tauri.deleteGroupHierarchy("p1", "live"),
			"delete_group_hierarchy",
			{ providerId: "p1", contentType: "live" },
		],
		[
			"pinGroup",
			() => tauri.pinGroup("p1", "live", "News", 100),
			"pin_group",
			{ providerId: "p1", contentType: "live", groupName: "News", sortOrder: 100 },
		],
		[
			"unpinGroup",
			() => tauri.unpinGroup("p1", "live", "News"),
			"unpin_group",
			{ providerId: "p1", contentType: "live", groupName: "News" },
		],
		[
			"getPinnedGroups",
			() => tauri.getPinnedGroups("p1", "live"),
			"get_pinned_groups",
			{ providerId: "p1", contentType: "live" },
		],
		// Gemini category sorting
		["getGeminiApiKey", () => tauri.getGeminiApiKey(), "get_gemini_api_key"],
		["setGeminiApiKey", () => tauri.setGeminiApiKey("k4"), "set_gemini_api_key", { key: "k4" }],
		[
			"testGeminiApiKey",
			() => tauri.testGeminiApiKey("k4"),
			"test_gemini_api_key",
			{ key: "k4" },
		],
		[
			"categorizeProvider",
			() => tauri.categorizeProvider("p1", "live", "k4", samples),
			"categorize_provider",
			{ providerId: "p1", contentType: "live", apiKey: "k4", groupsWithSamples: samples },
		],
		[
			"fixUncategorizedGroups",
			() => tauri.fixUncategorizedGroups("p1", "live", "k4", samples, ["Sports"]),
			"fix_uncategorized_groups",
			{
				providerId: "p1",
				contentType: "live",
				apiKey: "k4",
				uncategorizedGroups: samples,
				existingCategories: ["Sports"],
			},
		],
		[
			"renameSuperCategory",
			() => tauri.renameSuperCategory("p1", "live", "World", "International"),
			"rename_super_category",
			{ providerId: "p1", contentType: "live", oldName: "World", newName: "International" },
		],
		[
			"deleteSuperCategory",
			() => tauri.deleteSuperCategory("p1", "live", "World"),
			"delete_super_category",
			{ providerId: "p1", contentType: "live", categoryName: "World" },
		],
		// Install and updates
		["getInstallInfo", () => tauri.getInstallInfo(), "get_install_info"],
		["packageUpdate", () => tauri.packageUpdate(), "package_update"],
		// Downloads
		[
			"enqueueMovieDownload",
			() => tauri.enqueueMovieDownload("m1"),
			"enqueue_movie_download",
			{ channelId: "m1" },
		],
		[
			"enqueueEpisodeDownload",
			() => tauri.enqueueEpisodeDownload(episode, "s1", "Lost"),
			"enqueue_episode_download",
			{ episode, seriesChannelId: "s1", seriesTitle: "Lost" },
		],
		[
			"enqueueEpisodesBatch",
			() => tauri.enqueueEpisodesBatch(episodes, "s1", "Lost"),
			"enqueue_episodes_batch",
			{ episodes, seriesChannelId: "s1", seriesTitle: "Lost" },
		],
		["listDownloads", () => tauri.listDownloads(), "list_downloads"],
		[
			"cacheSeriesEpisodes",
			() => tauri.cacheSeriesEpisodes("s1", episodes),
			"cache_series_episodes",
			{ seriesChannelId: "s1", episodes },
		],
		[
			"getCachedSeriesEpisodes",
			() => tauri.getCachedSeriesEpisodes("s1"),
			"get_cached_series_episodes",
			{ seriesChannelId: "s1" },
		],
		["stopDownload", () => tauri.stopDownload("d1"), "stop_download", { id: "d1" }],
		[
			"stopDownloads",
			() => tauri.stopDownloads(["d1", "d2"]),
			"stop_downloads",
			{ ids: ["d1", "d2"] },
		],
		["removeDownload", () => tauri.removeDownload("d1"), "remove_download", { id: "d1" }],
		[
			"removeDownloads",
			() => tauri.removeDownloads(["d1", "d2"]),
			"remove_downloads",
			{ ids: ["d1", "d2"] },
		],
		[
			"getDownloadConcurrency",
			() => tauri.getDownloadConcurrency(),
			"get_download_concurrency",
		],
		[
			"setDownloadConcurrency",
			() => tauri.setDownloadConcurrency(3),
			"set_download_concurrency",
			{ n: 3 },
		],
		["getDownloadFolder", () => tauri.getDownloadFolder(), "get_download_folder"],
		[
			"setDownloadFolder",
			() => tauri.setDownloadFolder("/Movies"),
			"set_download_folder",
			{ path: "/Movies" },
		],
		[
			"resolveLocalDownload",
			() => tauri.resolveLocalDownload("m1"),
			"resolve_local_download",
			{ channelId: "m1" },
		],
		[
			"setDownloadKeep",
			() => tauri.setDownloadKeep("d1", true),
			"set_download_keep",
			{ id: "d1", keep: true },
		],
		["getDownloadRetention", () => tauri.getDownloadRetention(), "get_download_retention"],
		[
			"setDownloadRetention",
			() => tauri.setDownloadRetention(14),
			"set_download_retention",
			{ days: 14 },
		],
		[
			"countDownloadsDue",
			() => tauri.countDownloadsDue(null),
			"count_downloads_due",
			{ days: null },
		],
		[
			"scheduleRecording",
			() =>
				tauri.scheduleRecording("ch1", 1_000, 4_900, {
					title: "Evening News",
					start: 1_120,
					end: 4_600,
				}),
			"schedule_recording",
			{
				channelId: "ch1",
				startAt: 1_000,
				endAt: 4_900,
				program: { title: "Evening News", start: 1_120, end: 4_600 },
			},
		],
		["stopRecording", () => tauri.stopRecording("r1"), "stop_recording", { id: "r1" }],
		["getCastReceivers", () => tauri.getCastReceivers(), "get_cast_receivers"],
		[
			"castLoad",
			() =>
				tauri.castLoad(
					"cast:tv",
					episode,
					{ via: "direct", generation: 3, source: 1, container: "hls-ts" },
					30,
					true
				),
			"cast_load",
			{
				receiverId: "cast:tv",
				channel: episode,
				route: { via: "direct", generation: 3, source: 1, container: "hls-ts" },
				startAt: 30,
				restart: true,
			},
		],
		[
			"castControl",
			() => tauri.castControl("cast:tv", { action: "seek", to: 12 }),
			"cast_control",
			{ receiverId: "cast:tv", action: { action: "seek", to: 12 } },
		],
		["castStop", () => tauri.castStop("cast:tv"), "cast_stop", { receiverId: "cast:tv" }],
		[
			"castRelease",
			() => tauri.castRelease("cast:tv"),
			"cast_release",
			{ receiverId: "cast:tv" },
		],
		["getVpnActive", () => tauri.getVpnActive(), "get_vpn_active"],
		[
			"holdCastReceivers",
			() => tauri.holdCastReceivers(["cast:tv"]),
			"hold_cast_receivers",
			{ ids: ["cast:tv"] },
		],
		// remote control
		["remoteGetSettings", () => tauri.remoteGetSettings(), "remote_get_settings"],
		[
			"remoteSetSettings",
			() =>
				tauri.remoteSetSettings({
					discoverable: false,
					remoteControl: "never",
					deviceName: "Den",
				}),
			"remote_set_settings",
			{ settings: { discoverable: false, remoteControl: "never", deviceName: "Den" } },
		],
		["remoteResetIdentity", () => tauri.remoteResetIdentity(), "remote_reset_identity"],
		[
			"remoteAnswerConsent",
			() => tauri.remoteAnswerConsent(3, true),
			"remote_answer_consent",
			{ request: 3, allow: true },
		],
		["remoteSessions", () => tauri.remoteSessions(), "remote_sessions"],
		["remotePendingConsent", () => tauri.remotePendingConsent(), "remote_pending_consent"],
		[
			"remoteDisconnect",
			() => tauri.remoteDisconnect("s1"),
			"remote_disconnect",
			{ sessionId: "s1" },
		],
		[
			"remoteSetState",
			() => tauri.remoteSetState(remoteState),
			"remote_set_state",
			{ state: remoteState },
		],
		[
			"remoteFinishCommand",
			() => tauri.remoteFinishCommand(9, "staleItem"),
			"remote_finish_command",
			{ token: 9, outcome: "staleItem" },
		],
		["remoteOpen", () => tauri.remoteOpen(), "remote_open"],
		["remoteDevices", () => tauri.remoteDevices(), "remote_devices"],
		[
			"remoteLocalNetworkDenied",
			() => tauri.remoteLocalNetworkDenied(),
			"remote_local_network_denied",
		],
		[
			"remoteConnect",
			() => tauri.remoteConnect("abc", 5),
			"remote_connect",
			{ deviceId: "abc", link: 5 },
		],
		["remoteLink", () => tauri.remoteLink(), "remote_link"],
		["remoteLeave", () => tauri.remoteLeave(4), "remote_leave", { link: 4 }],
		[
			"remoteCommand",
			() => tauri.remoteCommand(5, { action: "seek", itemId: "live-1", to: 30 }),
			"remote_command",
			{ command: { action: "seek", itemId: "live-1", to: 30 }, link: 5 },
		],
		[
			"remoteCatalog",
			() => tauri.remoteCatalog(5, { kind: "search", query: "news", limit: 20 }),
			"remote_catalog",
			{ catalogQuery: { kind: "search", query: "news", limit: 20 }, link: 5 },
		],
		[
			"remoteSendProviders",
			() => tauri.remoteSendProviders(5, ["xt-1"]),
			"remote_send_providers",
			{ link: 5, providerIds: ["xt-1"] },
		],
		[
			"remoteAskHistory",
			() =>
				tauri.remoteAskHistory(
					5,
					"send",
					{ history: true, favorites: false, pins: true },
					"c1"
				),
			"remote_ask_history",
			{
				link: 5,
				direction: "send",
				what: { history: true, favorites: false, pins: true },
				playing: "c1",
			},
		],
		[
			"remoteHistoryCounts",
			() => tauri.remoteHistoryCounts({ history: true, favorites: true, pins: true }),
			"remote_history_counts",
			{ what: { history: true, favorites: true, pins: true } },
		],
		[
			"remoteStartImport",
			() => tauri.remoteStartImport(5, "t1"),
			"remote_start_import",
			{ link: 5, transfer: "t1" },
		],
		[
			"remoteProgressSaved",
			() => tauri.remoteProgressSaved(null),
			"remote_progress_saved",
			{ playing: null },
		],
		[
			"remoteCancelTransfer",
			() => tauri.remoteCancelTransfer(5),
			"remote_cancel_transfer",
			{ link: 5 },
		],
	];

	const rows = cases.map(([name, call, command, args]) => ({ name, call, command, args }));

	it.each(rows)("$name sends $command with its arguments", async ({ call, command, args }) => {
		await call();
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(invoke.mock.calls[0]).toStrictEqual(
			args === undefined ? [command] : [command, args]
		);
	});

	it.each(rows)("$name resolves to what the backend returns", async ({ call }) => {
		const answer = { from: "backend" };
		invoke.mockResolvedValue(answer);
		await expect(call()).resolves.toBe(answer);
	});

	it("passes a backend error on to the caller", async () => {
		invoke.mockRejectedValueOnce("provider not found");
		await expect(tauri.removeProvider("missing")).rejects.toBe("provider not found");
	});

	it("listens for receivers on the event cast/mod.rs emits", () => {
		expect(tauri.CAST_RECEIVERS_EVENT).toBe("cast://receivers");
	});

	it("listens for cast updates on the event cast/playback.rs emits", () => {
		expect(tauri.CAST_UPDATE_EVENT).toBe("cast://update");
	});

	/**
	 * The backend's tests check each command against the arguments listed in
	 * `arguments.json`. Holding the wrappers to the same list means a name
	 * changed on only one side fails a test instead of a call in the app.
	 * Every wrapper sends its optional arguments too, even when they're
	 * undefined, so the keys must match the row exactly. That also catches a
	 * row that still lists an argument the frontend stopped sending.
	 */
	const backendArguments: Record<string, { required?: string[]; optional?: string[] }> =
		commandArguments;

	const backendRows = rows.filter(({ command }) => !command.startsWith("plugin:"));

	it.each(backendRows)(
		"$name sends $command the arguments the backend tests check",
		async ({ call, command }) => {
			await call();
			const [, sent = {}] = invoke.mock.calls[0];
			const listed = backendArguments[command];
			expect(listed, `${command} has no row in ${ARGUMENTS_FILE}`).toBeDefined();
			const { required = [], optional = [] } = listed;
			expect(
				Object.keys(sent).sort(),
				`the arguments of ${command} in ${ARGUMENTS_FILE}`
			).toEqual([...required, ...optional].sort());
		}
	);

	it("calls every command the backend registers", () => {
		const called = new Set(backendRows.map(({ command }) => command));
		expect([...called].sort(), `the commands in ${ARGUMENTS_FILE}`).toEqual(
			Object.keys(backendArguments).sort()
		);
	});

	it("covers every wrapper the bridge exports", () => {
		const exported = Object.entries(tauri)
			.filter(([, value]) => typeof value === "function")
			.map(([name]) => name)
			.filter((name) => name !== "mpvLoad");
		expect(cases.map(([name]) => name).sort()).toEqual(exported.sort());
	});
});
