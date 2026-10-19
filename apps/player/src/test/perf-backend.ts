// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// A made-up backend for the measured flows in src/dev/flows.perf.test.tsx.
// It answers like the Rust side would for one Xtream provider of about the
// size a real one has, and never reaches a network.

import type {
	Channel,
	DownloadRecord,
	EpgProgram,
	MpvPlayerState,
	OmdbData,
	Provider,
	WatchHistoryEntry,
} from "@/lib/types";

export const LIVE_COUNT = 3000;
export const MOVIE_COUNT = 2000;
export const SERIES_COUNT = 400;
const LIVE_GROUPS = 40;
const VOD_GROUPS = 25;

/** A fixed clock, so every run builds the same guide. 2026-10-18 12:00 UTC. */
export const PERF_NOW_SECONDS = 1_792_324_800;

export const PERF_PROVIDER: Provider = {
	id: "xt-perf",
	name: "Perf Provider",
	type: "xtream",
	url: "http://perf.example.test",
	username: "perf-user",
	password: "perf-pass",
	lastUpdated: new Date(PERF_NOW_SECONDS * 1000).toISOString(),
	channelCount: LIVE_COUNT + MOVIE_COUNT + SERIES_COUNT,
};

const streamUrl = (kind: string, id: number, ext: string) =>
	`http://perf.example.test/${kind}/perf-user/perf-pass/${id}.${ext}`;

const buildChannels = (): Channel[] => {
	const out: Channel[] = [];
	for (let i = 0; i < LIVE_COUNT; i++) {
		out.push({
			id: `live-${i}`,
			name: `${i % 7 === 0 ? "News" : "Channel"} ${i}`,
			url: streamUrl("live", i, "ts"),
			logoUrl: `http://perf.example.test/logo/${i}.png`,
			groupTitle: `Live Group ${i % LIVE_GROUPS}`,
			tvgId: `tvg.${i}`,
			isFavorite: i % 97 === 0,
			contentType: "live",
			sources: [],
		});
	}
	for (let i = 0; i < MOVIE_COUNT; i++) {
		out.push({
			id: `movie-${i}`,
			name: `Movie ${i} (${1980 + (i % 45)})`,
			url: streamUrl("movie", i, "mp4"),
			logoUrl: `http://perf.example.test/poster/${i}.jpg`,
			groupTitle: `Movie Group ${i % VOD_GROUPS}`,
			isFavorite: false,
			contentType: "movie",
			// A movie with a source opens its details before it plays.
			sources: [streamUrl("movie", i, "mp4")],
		});
	}
	for (let i = 0; i < SERIES_COUNT; i++) {
		out.push({
			id: `series-${i}`,
			name: `Series ${i}`,
			url: "",
			logoUrl: `http://perf.example.test/cover/${i}.jpg`,
			groupTitle: `Series Group ${i % VOD_GROUPS}`,
			isFavorite: false,
			contentType: "series",
			sources: [],
		});
	}
	return out;
};

/** Three hours of half-hour programs around now, for one channel. */
const programsFor = (channelId: string, from: number, to: number): EpgProgram[] => {
	const slot = 1800;
	const out: EpgProgram[] = [];
	for (let start = Math.floor(from / slot) * slot; start < to; start += slot) {
		out.push({ channelId, title: `Show at ${start}`, startTime: start, endTime: start + slot });
	}
	return out;
};

const history: WatchHistoryEntry[] = Array.from({ length: 20 }, (_, i) => ({
	channelId: i % 2 === 0 ? `live-${i}` : `movie-${i}`,
	channelName: i % 2 === 0 ? `Channel ${i}` : `Movie ${i}`,
	contentType: i % 2 === 0 ? "live" : "movie",
	firstWatchedAt: PERF_NOW_SECONDS - 86_400 * (i + 1),
	lastWatchedAt: PERF_NOW_SECONDS - 3600 * (i + 1),
	totalDurationSeconds: 1200,
	playCount: 1,
	seriesTitle: null,
}));

const downloads: DownloadRecord[] = [3, 5].map((i) => ({
	id: `dl-${i}`,
	channelId: `movie-${i}`,
	title: `Movie ${i}`,
	kind: "movie",
	seriesChannelId: null,
	status: "completed",
	destPath: `/downloads/movie-${i}.mp4`,
	totalBytes: 1000,
	downloadedBytes: 1000,
	avgRateBps: null,
	error: null,
	createdAt: PERF_NOW_SECONDS - 86_400,
	finishedAt: PERF_NOW_SECONDS - 86_000,
	keep: false,
	lastPlayedAt: null,
}));

const omdb = (title: string): OmdbData => ({
	title,
	year: "2001",
	runtime: "120 min",
	genre: "Drama",
	plot: "A made-up plot.",
	imdbRating: "7.1",
	imdbId: "tt0000001",
});

const idleMpv: MpvPlayerState = {
	isPlaying: false,
	isPaused: false,
	currentUrl: null,
	volume: 100,
	position: 0,
	duration: 0,
	playbackStarted: false,
	openFailed: false,
	reachedEnd: false,
	waiting: false,
	fallbackActive: false,
};

/**
 * The backend's state for one run. `invoke` answers a command the way Rust
 * would, and `unknown` collects the commands it has no answer for, so a
 * flow that starts calling something new shows up.
 */
export const createPerfBackend = () => {
	const channels = buildChannels();
	let mpv: MpvPlayerState = idleMpv;
	let pollsSinceLoad = 0;
	const unknown = new Set<string>();

	const invoke = async (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => {
		switch (cmd) {
			case "get_providers":
				return [PERF_PROVIDER];
			case "get_all_channels":
				return channels;
			case "get_group_hierarchy":
			case "get_pinned_groups":
			case "get_cached_series_episodes":
			case "search_epg_programmes":
				return [];
			case "get_watch_history":
				return history;
			case "list_downloads":
				return downloads;
			case "get_download_retention":
			case "get_playback_position":
			case "get_mdblist_api_key":
			case "get_opensubtitles_api_key":
			case "get_gemini_api_key":
			case "fetch_mdblist_data":
			case "fetch_whatson_data":
			case "resolve_local_download":
				return null;
			case "get_omdb_api_key":
				return "perf-omdb-key";
			case "fetch_omdb_data":
				return omdb(String(args.title));
			case "get_skip_segments":
				return [];
			case "get_epg_for_live_channels": {
				const ids = (args.channelIds as string[] | null) ?? [];
				const from = args.rangeStart as number;
				const to = args.rangeEnd as number;
				return ids.flatMap((id) => programsFor(id, from, to));
			}
			case "get_epg_programmes":
				return programsFor(
					args.channelId as string,
					args.rangeStart as number,
					args.rangeEnd as number
				);
			case "get_install_info":
				return { installType: "native", releaseUrl: "https://example.test/releases" };
			case "plugin:mpv|mpv_load":
				mpv = {
					...idleMpv,
					isPlaying: true,
					currentUrl: args.url as string,
					waiting: true,
				};
				pollsSinceLoad = 0;
				return undefined;
			case "plugin:mpv|mpv_stop":
				mpv = idleMpv;
				return undefined;
			case "plugin:mpv|mpv_get_state":
				// The stream opens between the first poll and the second, so the
				// player always shows that it's opening for one poll.
				pollsSinceLoad += 1;
				if (pollsSinceLoad === 2 && mpv.currentUrl) {
					mpv = { ...mpv, waiting: false, playbackStarted: true };
				}
				return mpv;
			case "hand_off_progress":
			case "record_play_start":
			case "record_play_end":
			case "save_playback_position":
			case "plugin:mpv|mpv_set_visible":
			case "plugin:mpv|mpv_set_bounds":
			case "plugin:mpv|mpv_set_volume":
			case "plugin:mpv|mpv_set_media_info":
			case "plugin:mpv|mpv_set_skip_intervals":
			case "plugin:mpv|mpv_play":
			case "plugin:mpv|mpv_pause":
				return undefined;
			default:
				unknown.add(cmd);
				return undefined;
		}
	};

	return { invoke, unknown };
};
