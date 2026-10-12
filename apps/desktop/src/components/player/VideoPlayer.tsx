// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Controls } from "./Controls";
import { ConnectionStatusOverlay } from "./ConnectionStatusOverlay";
import { OpeningIndicator } from "./OpeningIndicator";
import { SubtitlePicker } from "./SubtitlePicker";
import { SubtitleOverlay } from "./SubtitleOverlay";
import { ResumePrompt } from "./ResumePrompt";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { VideoTapLayer } from "./VideoTapLayer";
import { SkipSegmentPrompt } from "./SkipSegmentPrompt";
import { MovieInfoDrawer } from "@/components/channels/MovieInfoDrawer";
import { SeriesDetailModal } from "@/components/channels/SeriesDetailModal";
import { LiveInfoDrawer } from "@/components/channels/LiveInfoDrawer";
import { useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useMpv } from "@/hooks/useMpv";
import { useChannels } from "@/hooks/useChannels";
import {
	mpvSetBounds,
	mpvSetMediaInfo,
	recordPlayStart,
	recordPlayEnd,
	fetchOmdbData,
	fetchWhatsonData,
	searchSubtitles,
	downloadSubtitle,
	readSubtitleFile,
	mpvSubAdd,
	mpvSubRemove,
	mpvGetState,
	getPlaybackPosition,
	savePlaybackPosition,
	deletePlaybackPosition,
	handOffProgress,
	resolveLocalDownload,
	enqueueMovieDownload,
	enqueueEpisodeDownload,
	stopDownload,
	removeDownload,
} from "@/lib/tauri";
import { parseSrt } from "@/lib/subtitle-parser";
import type { Channel, OmdbData, WhatsonData, SubtitleCue, SubtitleEntry } from "@/lib/types";
import { useFullscreen } from "@/lib/fullscreen-context";
import { useLeaveFullscreenOnUnmount } from "@/hooks/useLeaveFullscreenOnUnmount";
import { useDownloads } from "@/hooks/useDownloads";
import { DownloadButton } from "@/components/downloads/DownloadButton";
import { playbackKey, isFinished, shouldOfferResume, MIN_RESUME_SECONDS } from "@/lib/playback";
import { channelSources, withSource } from "@/lib/sources";
import { downloadIconState } from "@/lib/download-status";
import { sortEpisodes } from "@/lib/episodes";
import { seriesTitleOf } from "@/lib/channels";
import {
	resolvePlayerHotkey,
	isInside,
	isTypingTarget,
	isKeyboardFocusedControl,
	repeatsWhenHeld,
} from "@/lib/hotkeys";
import { usePlayerFocus } from "@/hooks/usePlayerFocus";
import { useSubtitleNudge } from "@/hooks/useSubtitleNudge";
import { DEFAULT_SUBTITLE_POSITION } from "@/lib/subtitle-position";
import { formatSkip, formatTime } from "@/lib/format";
import {
	readSkipIntervals,
	readSkipSegmentModes,
	SKIP_INTERVALS_EVENT,
	SKIP_SEGMENT_MODES_EVENT,
	type SkipSegmentModes,
} from "@/lib/player-prefs";
import { nextSkip, type SkipRun } from "@/lib/skip";
import { addWatchedTime } from "@/lib/browse-state";
import { usePlatform } from "@/hooks/usePlatform";
import { usePlayerPref } from "@/hooks/usePlayerPref";
import { useSkipSegments } from "@/hooks/useSkipSegments";
import { skipButtonShows, useSegmentSkipping } from "@/hooks/useSegmentSkipping";
import { isMobilePlatform } from "@/lib/platform";
import { hasFullscreenButton } from "@/lib/fullscreen";
import { ChevronLeft } from "lucide-react";

/** How often (ms) watch progress is persisted while playing. */
const PROGRESS_SAVE_INTERVAL = 5000;
const MAX_VOLUME = 150;
const LOADED_URL_KEY = "mvp_lastLoadedUrl";
/** Position jumps larger than this between polls are seeks, not watching. */
const MAX_WATCH_STEP_SECONDS = 5;
/** How long the controls stay up after they appear or the player is clicked or tapped. */
const CONTROLS_HIDE_MS = 4000;

interface PlaybackProgress {
	/** Resume key (see playbackKey); null for live or nothing playing. */
	key: string | null;
	/** URL the progress belongs to — mpv state for any other URL is ignored. */
	url: string | null;
	position: number;
	duration: number;
	/** Position changed since the last save. */
	dirty: boolean;
	lastSaved: number;
	/**
	 * Resume point the load was started at. Until playback reaches it, earlier
	 * positions (mpv reporting the start of the file before the seek lands) are
	 * ignored so they can't overwrite or delete the saved resume point.
	 */
	pendingStart: number | null;
}

const EMPTY_PROGRESS: PlaybackProgress = {
	key: null,
	url: null,
	position: 0,
	duration: 0,
	dirty: false,
	lastSaved: 0,
	pendingStart: null,
};

const progressFor = (ch: Channel, startPos?: number, url = ch.url): PlaybackProgress => ({
	key: playbackKey(ch),
	url,
	position: startPos ?? 0,
	duration: 0,
	dirty: false,
	lastSaved: Date.now(),
	pendingStart: startPos ?? null,
});

/** Same season + episode (duplicate entries of one episode from different sources). */
const isSameEpisode = (a: Channel, b: Channel): boolean =>
	a.season != null && a.episode != null && a.season === b.season && a.episode === b.episode;

interface PendingResume {
	channel: Channel;
	position: number;
	duration: number;
	/** "nav" = opened from outside the player; cancelling goes back. */
	origin: "nav" | "player";
	/** Something was playing (and got paused) when the prompt opened. */
	wasPlaying: boolean;
	apply?: () => void;
}

/** Extract season/episode numbers from a channel name like "Show S01E05". */
const parseSeasonEpisode = (name: string): { season?: number; episode?: number } => {
	const m = name.match(/S(\d{1,3})E(\d{1,3})/i);
	if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
	return {};
};

interface EnrichedMeta {
	omdbData: OmdbData | null;
	whatsonData: WhatsonData | null;
}

/** Used in place of Settings while the skip prompt can't show. */
const SKIPPING_OFF: SkipSegmentModes = { opening: "off", ending: "off" };

export const PlayerView = () => {
	const mpv = useMpv();
	const { channels } = useChannels();
	const { byChannel } = useDownloads();

	const location = useLocation();
	const navigate = useNavigate();
	const [showControls, setShowControls] = useState(true);
	const containerRef = useRef<HTMLDivElement>(null);
	const [showInfoDrawer, setShowInfoDrawer] = useState(false);
	const [activeChannelName, setActiveChannelName] = useState<string | null>(null);
	const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
	// Episode list for series navigation — set when navigating from SeriesDetailModal
	const [seriesEpisodes, setSeriesEpisodes] = useState<Channel[]>([]);
	const { isFullscreen, setFullscreen } = useFullscreen();
	useLeaveFullscreenOnUnmount();
	// The phone layout hides the tab bar on this route, so the player needs
	// its own way back.
	const { layoutMode } = usePlatform();
	const showBack = layoutMode === "mobile";
	// Phones and tablets set the volume with the hardware buttons. An Android
	// TV box has no touch screen, so it keeps the volume and shortcut
	// controls for its remote.
	const touchDevice = isMobilePlatform() && navigator.maxTouchPoints > 0;
	const fullscreenButton = hasFullscreenButton(touchDevice, layoutMode);
	const [enrichedMeta, setEnrichedMeta] = useState<EnrichedMeta | null>(null);
	const [showSubtitlePicker, setShowSubtitlePicker] = useState(false);
	const [selectedSubtitleId, setSelectedSubtitleId] = useState<number | null>(null);
	const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
	const [selectedSubtitleEntry, setSelectedSubtitleEntry] = useState<SubtitleEntry | null>(null);
	const [subtitleFontSize, setSubtitleFontSize] = useState(18);
	const [subtitleFontFamily, setSubtitleFontFamily] = useState("system-ui, sans-serif");
	const [subtitlePos, setSubtitlePos] = useState(DEFAULT_SUBTITLE_POSITION);
	const [subtitleDelay, setSubtitleDelay] = useState(0);
	const [subtitleEditMode, setSubtitleEditMode] = useState(false);
	const [autoplay, setAutoplay] = useState(true);
	const [pendingResume, setPendingResume] = useState<PendingResume | null>(null);
	const [showShortcuts, setShowShortcuts] = useState(false);
	// Brief centre-screen feedback for keyboard actions ("+10s", "Volume 80%", …).
	const [osdText, setOsdText] = useState<{ text: string; id: number } | null>(null);
	const osdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const mpvStateRef = useRef(mpv.state);
	mpvStateRef.current = mpv.state;
	const activeChannelRef = useRef(activeChannel);
	activeChannelRef.current = activeChannel;
	const playStartTimeRef = useRef<number | null>(null);
	const progressRef = useRef<PlaybackProgress>(EMPTY_PROGRESS);
	// The URL mpv was last asked to play. For a download it's the file's path
	// rather than the channel's URL.
	const [loadedUrl, setLoadedUrl] = useState(() => sessionStorage.getItem(LOADED_URL_KEY));
	const rememberLoadedUrl = useCallback((url: string) => {
		sessionStorage.setItem(LOADED_URL_KEY, url);
		setLoadedUrl(url);
	}, []);
	// Guards against out-of-order resolution when items are opened in quick succession.
	const startRequestRef = useRef(0);
	const loadRequestRef = useRef(0);

	// Remembers which language + rank-within-language the user last picked so the
	// same subtitle can be auto-selected when navigating to the next episode.
	const [subtitlePreference, setSubtitlePreference] = useState<{
		languageCode: string;
		rankInLanguage: number;
	} | null>(null);
	// Refs used by the auto-load effect to avoid stale closures.
	const subtitlePreferenceRef = useRef(subtitlePreference);
	subtitlePreferenceRef.current = subtitlePreference;
	// Incremented each time an episode navigation should trigger subtitle auto-load.
	// Using state (not a ref) so the effect dependency is tracked by React.
	const [autoLoadTrigger, setAutoLoadTrigger] = useState(0);

	const navState = location.state as {
		url?: string;
		channelName?: string;
		channel?: Channel;
		seriesEpisodes?: Channel[];
	} | null;

	// useLayoutEffect ensures the background is set BEFORE the browser paints,
	// preventing a transparent flash when navigating to the player page.
	useLayoutEffect(() => {
		document.documentElement.style.backgroundColor = mpv.firstFrameReady
			? "transparent"
			: "black";
		document.body.style.backgroundColor = mpv.firstFrameReady ? "transparent" : "black";
		return () => {
			document.documentElement.style.backgroundColor = "";
			document.body.style.backgroundColor = "";
		};
	}, [mpv.firstFrameReady]);

	usePlayerFocus(containerRef, mpv.state.currentUrl);

	// Report video container bounds to the Rust renderer. The CSD header bar
	// offset is applied on the Rust side via LinuxGlRenderer::csd_offset (x, y),
	// so the frontend just sends raw getBoundingClientRect values.
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const report = () => {
			const r = el.getBoundingClientRect();
			mpvSetBounds(r.x, r.y, r.width, r.height).catch(() => {});
		};
		report();
		const ro = new ResizeObserver(report);
		ro.observe(el);
		return () => ro.disconnect();
	}, [mpv.state.currentUrl]);

	// Arrow keys reposition subtitle overlay when settings pane is open
	useSubtitleNudge(subtitleEditMode, setSubtitlePos);

	// --- Watch progress (resume support) ---

	// Persist the tracked position for the current item. Finished items are
	// forgotten, as are items rewound to the very start (e.g. "Start over"),
	// so they don't keep offering a stale resume point.
	const flushProgress = useCallback(() => {
		const p = progressRef.current;
		if (!p.key || !p.dirty || p.duration <= 0) return;
		p.dirty = false;
		p.lastSaved = Date.now();
		if (isFinished(p.position, p.duration) || p.position < MIN_RESUME_SECONDS) {
			deletePlaybackPosition(p.key).catch(() => {});
		} else {
			savePlaybackPosition(p.key, p.position, p.duration).catch(() => {});
		}
	}, []);

	useEffect(() => {
		const p = progressRef.current;
		const { currentUrl, position, duration, isPaused } = mpv.state;
		if (!p.key || !currentUrl || currentUrl !== p.url) return;
		if (duration <= 0 || position <= 1) return;
		if (p.pendingStart !== null) {
			if (position < p.pendingStart - 5) return;
			p.pendingStart = null;
		}
		if (position !== p.position || duration !== p.duration) {
			p.position = position;
			p.duration = duration;
			p.dirty = true;
		}
		if (isPaused || Date.now() - p.lastSaved >= PROGRESS_SAVE_INTERVAL) flushProgress();
	}, [mpv.state, flushProgress]);

	useEffect(() => () => flushProgress(), [flushProgress]);

	// This page can't save progress while it's hidden, because iOS stops its
	// timers once the app is in the background though audio keeps playing, or
	// after it closes with the item still playing. Rust saves it until the
	// player is visible again.
	useEffect(() => {
		const handOff = () => {
			const p = progressRef.current;
			// Rust saves from here on. The position held here goes stale, and
			// flushing it later, say on a stop right after the app comes back,
			// would overwrite the newer one Rust saved.
			p.dirty = false;
			const { key, url, pendingStart } = p;
			handOffProgress(key && url ? { key, url, pendingStart } : null).catch(() => {});
		};
		const onVisibilityChange = () => {
			if (document.visibilityState === "hidden") handOff();
			else handOffProgress(null).catch(() => {});
		};
		handOffProgress(null).catch(() => {});
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			document.removeEventListener("visibilitychange", onVisibilityChange);
			handOff();
		};
	}, []);

	// Watch time: the channel list keeps its search unless the user watched for
	// a while (see lib/browse-state). Only forward playback counts, so time spent
	// paused, buffering or loading doesn't.
	const watchTickRef = useRef<{ url: string | null; position: number }>({
		url: null,
		position: 0,
	});
	useEffect(() => {
		const { currentUrl, position, isPlaying, isPaused } = mpv.state;
		const last = watchTickRef.current;
		watchTickRef.current = { url: currentUrl, position };
		if (!currentUrl || currentUrl !== last.url || !isPlaying || isPaused) return;
		const advanced = position - last.position;
		if (advanced > 0 && advanced <= MAX_WATCH_STEP_SECONDS) addWatchedTime(advanced * 1000);
	}, [mpv.state]);

	/** Actually start playing `ch` (optionally from `startPos`), replacing whatever is playing. */
	const commitPlayback = useCallback(
		(ch: Channel, startPos?: number, apply?: () => void) => {
			if (activeChannelRef.current && playStartTimeRef.current !== null) {
				const elapsed = Math.floor((Date.now() - playStartTimeRef.current) / 1000);
				recordPlayEnd(activeChannelRef.current.id, elapsed).catch(() => {});
			}
			playStartTimeRef.current = Date.now();
			recordPlayStart(ch.id, ch.name, ch.logoUrl ?? null, ch.contentType).catch(() => {});

			const progress = progressFor(ch, startPos);
			progressRef.current = progress;
			// Until the new stream loads, nothing may pair the old one's URL
			// and length with the new channel, such as the skip time lookup.
			setLoadedUrl(null);
			// Prefer a completed download so playback works offline; fall back to
			// the stream URL if there is none or the lookup fails.
			const loadId = ++loadRequestRef.current;
			resolveLocalDownload(ch.id)
				.catch(() => null)
				.then((local) => {
					if (loadId !== loadRequestRef.current) return;
					const target = local ?? ch.url;
					progress.url = target;
					rememberLoadedUrl(target);
					return mpv.load(target, startPos);
				})
				.catch(() => {});
			setActiveChannelName(ch.name);
			setActiveChannel(ch);
			apply?.();
		},
		[mpv, rememberLoadedUrl]
	);

	/**
	 * Entry point for every "play this item" action. Movies and episodes with
	 * a saved mid-way position first show the resume prompt; everything else
	 * starts immediately. `apply` runs once playback actually starts (e.g.
	 * clearing subtitle state for a new episode).
	 */
	const startPlayback = useCallback(
		async (ch: Channel, origin: "nav" | "player", apply?: () => void) => {
			const requestId = ++startRequestRef.current;
			flushProgress();
			const key = playbackKey(ch);
			const saved = key ? await getPlaybackPosition(key).catch(() => null) : null;
			if (requestId !== startRequestRef.current) return;
			if (saved && shouldOfferResume(saved.positionSeconds, saved.durationSeconds)) {
				const s = mpvStateRef.current;
				const wasPlaying = s.isPlaying && !s.isPaused;
				if (wasPlaying) mpv.pause();
				setPendingResume({
					channel: ch,
					position: saved.positionSeconds,
					duration: saved.durationSeconds,
					origin,
					wasPlaying,
					apply,
				});
				return;
			}
			commitPlayback(ch, undefined, apply);
		},
		[mpv, flushProgress, commitPlayback]
	);

	const resolveResume = useCallback(
		(choice: "resume" | "restart" | "cancel") => {
			const pending = pendingResume;
			if (!pending) return;
			setPendingResume(null);
			containerRef.current?.focus();
			if (choice === "cancel") {
				if (pending.wasPlaying) mpv.play();
				if (pending.origin === "nav") navigate(-1);
				return;
			}
			if (choice === "restart") {
				// Forget the old resume point now; progress tracking only clears it
				// once playback moves, which a quick stop would skip.
				const key = playbackKey(pending.channel);
				if (key) deletePlaybackPosition(key).catch(() => {});
			}
			commitPlayback(
				pending.channel,
				choice === "resume" ? pending.position : undefined,
				pending.apply
			);
		},
		[pendingResume, mpv, navigate, commitPlayback]
	);

	// When the player is re-entered with a new item while the previous one kept
	// playing in the background, capture the previous item's latest position so
	// the flush in startPlayback saves it.
	const adoptBackgroundProgress = async (): Promise<void> => {
		const saved = sessionStorage.getItem("mvp_lastChannel");
		if (!saved || progressRef.current.key) return;
		try {
			const prev: Channel = JSON.parse(saved);
			const loaded = sessionStorage.getItem(LOADED_URL_KEY) ?? prev.url;
			const s = await mpvGetState();
			if (s.currentUrl === loaded && s.duration > 0 && s.position > 1) {
				progressRef.current = {
					...progressFor(prev, undefined, loaded),
					position: s.position,
					duration: s.duration,
					dirty: true,
				};
			}
		} catch {}
	};

	useEffect(() => {
		if (navState?.url) {
			if (navState.seriesEpisodes?.length) {
				setSeriesEpisodes(navState.seriesEpisodes);
			}
			const navChannel = navState.channel;
			const navUrl = navState.url;
			if (navChannel) {
				const ch = navChannel.url === navUrl ? navChannel : withSource(navChannel, navUrl);
				adoptBackgroundProgress().finally(() => startPlayback(ch, "nav"));
			} else {
				loadRequestRef.current++;
				rememberLoadedUrl(navUrl);
				mpv.load(navUrl).catch(() => {});
				setActiveChannelName(navState.channelName ?? null);
				setActiveChannel(null);
			}
		} else {
			// Navigating back to player without a new channel (e.g. via sidebar menu)
			const saved = sessionStorage.getItem("mvp_lastChannel");
			if (saved) {
				try {
					const ch: Channel = JSON.parse(saved);
					setActiveChannel(ch);
					setActiveChannelName(ch.name);
					progressRef.current = progressFor(
						ch,
						undefined,
						sessionStorage.getItem(LOADED_URL_KEY) ?? ch.url
					);
				} catch {}
			}
			const savedEpisodes = sessionStorage.getItem("mvp_lastSeriesEpisodes");
			if (savedEpisodes) {
				try {
					setSeriesEpisodes(JSON.parse(savedEpisodes));
				} catch {}
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on URL only; re-running on mpv/channel refs would cause loops
	}, [navState?.url]);

	// mpv only knows the stream URL, so tell the lock screen the channel name,
	// whether it's live, and the logo to show.
	const activeIsLive = activeChannel?.contentType === "live";
	const activeLogo = activeChannel?.logoUrl ?? null;
	useEffect(() => {
		if (!isMobilePlatform()) return;
		mpvSetMediaInfo(activeChannelName, activeIsLive, activeLogo).catch(() => {});
	}, [activeChannelName, activeIsLive, activeLogo]);

	// Persist last active channel and series episode list so they can be restored when navigating back
	useEffect(() => {
		if (activeChannel) {
			sessionStorage.setItem("mvp_lastChannel", JSON.stringify(activeChannel));
		}
	}, [activeChannel]);

	useEffect(() => {
		if (seriesEpisodes.length > 0) {
			sessionStorage.setItem("mvp_lastSeriesEpisodes", JSON.stringify(seriesEpisodes));
		}
	}, [seriesEpisodes]);

	// Pre-fetch enriched metadata when activeChannel changes to a movie or series
	useEffect(() => {
		setShowSubtitlePicker(false);
		setSelectedSubtitleId(null);
		setSubtitleCues([]);
		setSelectedSubtitleEntry(null);
		setSubtitleEditMode(false);
		setSubtitleDelay(0);
		setSubtitlePos(DEFAULT_SUBTITLE_POSITION);

		// Only movies and series have details to look up. A recording is live TV.
		if (
			!activeChannel ||
			(activeChannel.contentType !== "movie" && activeChannel.contentType !== "series")
		) {
			setEnrichedMeta(null);
			return;
		}

		let cancelled = false;
		setEnrichedMeta(null);

		const mediaType = activeChannel.contentType === "series" ? "series" : "movie";
		const titleForOmdb = seriesTitleOf(activeChannel);

		fetchOmdbData(activeChannel.id, titleForOmdb, mediaType as "movie" | "series")
			.then((omdbData) => {
				if (cancelled) return;
				setEnrichedMeta({ omdbData, whatsonData: null });

				if (omdbData?.imdbId) {
					const whatsonMediaType =
						activeChannel.contentType === "series" ? "show" : "movie";
					fetchWhatsonData(omdbData.imdbId, whatsonMediaType)
						.then((whatsonData) => {
							if (cancelled) return;
							setEnrichedMeta({ omdbData, whatsonData });
						})
						.catch(() => {});
				}
			})
			.catch(() => {
				if (cancelled) return;
				setEnrichedMeta({ omdbData: null, whatsonData: null });
			});

		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on ID only to avoid re-fetching when channel object ref changes
	}, [activeChannel?.id]);

	const activeImdbId = enrichedMeta?.omdbData?.imdbId ?? null;
	// A recording has no info drawer.
	const hasInfo = !!activeChannel && activeChannel.contentType !== "recording";
	const canShowSubtitles =
		activeImdbId !== null &&
		(activeChannel?.contentType === "movie" || activeChannel?.contentType === "series");

	// Season/episode for subtitle search: prefer structured channel data, fall back to parsing the name
	const { season: parsedSeason, episode: parsedEpisode } = activeChannel
		? parseSeasonEpisode(activeChannel.name)
		: {};
	const subtitleSeason = activeChannel?.season ?? parsedSeason;
	const subtitleEpisode = activeChannel?.episode ?? parsedEpisode;

	// Refs so the auto-load effect can read fresh values without stale closures.
	const subtitleSeasonRef = useRef(subtitleSeason);
	subtitleSeasonRef.current = subtitleSeason;
	const subtitleEpisodeRef = useRef(subtitleEpisode);
	subtitleEpisodeRef.current = subtitleEpisode;

	// Auto-load: fires when playEpisode increments autoLoadTrigger, then waits for
	// activeImdbId to resolve. Using a trigger counter avoids the cancellation bug
	// where setEnrichedMeta(null) → activeImdbId → null mid-flight would kill the search.
	useEffect(() => {
		if (autoLoadTrigger === 0) return; // no episode navigation yet
		if (!activeImdbId) return; // OMDB still in-flight; re-run when it resolves
		const pref = subtitlePreferenceRef.current;
		if (!pref) return;

		let cancelled = false;

		searchSubtitles(activeImdbId, subtitleSeasonRef.current, subtitleEpisodeRef.current)
			.then(async (result) => {
				if (cancelled) return;
				const langEntries = (result?.entries ?? []).filter(
					(e) => e.languageCode === pref.languageCode
				);
				if (langEntries.length === 0) return; // preferred language not available — keep none
				const entry = langEntries[Math.min(pref.rankInLanguage, langEntries.length - 1)];
				await mpvSubRemove(-1).catch(() => {});
				const localPath = await downloadSubtitle(entry.fileId);
				mpvSubAdd(localPath).catch(() => {});
				const content = await readSubtitleFile(localPath);
				const cues = parseSrt(content);
				if (cancelled) return;
				setSelectedSubtitleId(entry.fileId);
				setSubtitleCues(cues);
				setSelectedSubtitleEntry(entry);
			})
			.catch(() => {}); // silent — subtitle is best-effort

		return () => {
			cancelled = true;
		};
	}, [autoLoadTrigger, activeImdbId]);

	// --- Series episode navigation ---

	// Derive episodes from passed list (Xtream) or local cache (M3U)
	const localSeriesEpisodes = useMemo(() => {
		if (!activeChannel || activeChannel.contentType !== "series") return [];
		const title = seriesTitleOf(activeChannel);
		return channels.filter((ch) => ch.contentType === "series" && seriesTitleOf(ch) === title);
	}, [activeChannel, channels]);

	// Series container id used to group download records — matches the series
	// card id in the channel list so download state stays consistent.
	const seriesContainerId = useMemo(() => {
		if (!activeChannel) return "";
		if (activeChannel.contentType !== "series") return activeChannel.id;
		const title = seriesTitleOf(activeChannel);
		const container = channels.find(
			(ch) => ch.contentType === "series" && seriesTitleOf(ch) === title
		);
		return container?.id ?? activeChannel.id;
	}, [activeChannel, channels]);

	const sortedEpisodes = useMemo(() => {
		const source = seriesEpisodes.length > 0 ? seriesEpisodes : localSeriesEpisodes;
		return sortEpisodes(source);
	}, [seriesEpisodes, localSeriesEpisodes]);

	// Match by id first: the URL changes when the user switches source.
	const currentEpIdx = useMemo(() => {
		if (!activeChannel) return -1;
		const byId = sortedEpisodes.findIndex((ep) => ep.id === activeChannel.id);
		if (byId >= 0) return byId;
		const urls = channelSources(activeChannel);
		return sortedEpisodes.findIndex((ep) => urls.includes(ep.url));
	}, [activeChannel, sortedEpisodes]);

	// Skip over duplicate entries of the current episode (same S/E from another source).
	const { prevEpisode, nextEpisode } = useMemo(() => {
		if (currentEpIdx < 0 || !activeChannel) return { prevEpisode: null, nextEpisode: null };
		const current = sortedEpisodes[currentEpIdx];
		const differs = (ep: Channel) => !isSameEpisode(ep, current) && ep.id !== current.id;
		const prev = sortedEpisodes.slice(0, currentEpIdx).reverse().find(differs) ?? null;
		const next = sortedEpisodes.slice(currentEpIdx + 1).find(differs) ?? null;
		return { prevEpisode: prev, nextEpisode: next };
	}, [activeChannel, sortedEpisodes, currentEpIdx]);

	// Every stream URL for the current item: its own sources plus, for series,
	// duplicate entries of the same episode elsewhere in the episode list.
	const availableSources = useMemo(() => {
		if (!activeChannel) return [];
		const urls = [...channelSources(activeChannel)];
		if (activeChannel.contentType === "series") {
			for (const ep of sortedEpisodes) {
				if (isSameEpisode(ep, activeChannel)) urls.push(...channelSources(ep));
			}
		}
		return [...new Set(urls)];
	}, [activeChannel, sortedEpisodes]);

	/** Switch the current item to another source, keeping the playback position. */
	const switchSource = useCallback(
		(url: string) => {
			const ch = activeChannelRef.current;
			if (!ch || url === ch.url) return;
			const resumeAt = ch.contentType === "live" ? 0 : mpv.getLastKnownPosition();
			flushProgress();
			const startPos = resumeAt > 1 ? resumeAt : undefined;
			progressRef.current = {
				...progressRef.current,
				url,
				lastSaved: Date.now(),
				pendingStart: startPos ?? null,
			};
			loadRequestRef.current++;
			rememberLoadedUrl(url);
			mpv.load(url, startPos).catch(() => {});
			setActiveChannel({ ...ch, url, sourceList: availableSources });
		},
		[mpv, flushProgress, availableSources, rememberLoadedUrl]
	);

	const playEpisode = useCallback(
		(ep: Channel) => {
			setShowInfoDrawer(false);
			startPlayback(ep, "player", () => {
				setSelectedSubtitleId(null);
				setSubtitleCues([]);
				setSelectedSubtitleEntry(null);
				setSubtitleEditMode(false);
				setSubtitleDelay(0);
				// Increment trigger so the auto-load effect fires for this episode.
				setAutoLoadTrigger((t) => t + 1);
			});
		},
		[startPlayback]
	);

	// --- Autoplay next episode ---
	// Use refs to avoid stale closures while keeping the effect dependency minimal
	const nextEpisodeRef = useRef(nextEpisode);
	nextEpisodeRef.current = nextEpisode;
	// On unmount, record end of play
	useEffect(() => {
		return () => {
			if (activeChannelRef.current && playStartTimeRef.current !== null) {
				const elapsed = Math.floor((Date.now() - playStartTimeRef.current) / 1000);
				recordPlayEnd(activeChannelRef.current.id, elapsed).catch(() => {});
				playStartTimeRef.current = null;
			}
		};
	}, []);

	const autoplayRef = useRef(autoplay);
	autoplayRef.current = autoplay;

	// Advance when the episode reaches its end, not when it stops near it. A
	// pause in the last seconds, or the resume prompt pausing the player, leaves
	// reachedEnd false. With keep-open=yes, mpv then holds the last frame,
	// paused, so with autoplay off, on a movie or on the last episode the
	// controls stay up and nothing else needs doing.
	//
	// Only an end this player saw coming counts. The ref holds the stream it
	// last saw short of its end, so coming back from another page to an
	// episode that ended there leaves it on the last frame.
	const seenShortOfEndRef = useRef<string | null>(null);
	// iOS stops this page's timers in the background while mpv plays on, so
	// the first poll after the app comes back can report an end from hours
	// ago. Hiding the page forgets what it saw. Where polls go on while the
	// window is hidden, the next one sees the episode short of its end again.
	useEffect(() => {
		const onVisibilityChange = () => {
			if (document.visibilityState === "hidden") seenShortOfEndRef.current = null;
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => document.removeEventListener("visibilitychange", onVisibilityChange);
	}, []);
	useEffect(() => {
		// A poll can still describe the previous stream after the app loads
		// another one, such as from the Next episode button near the end.
		if (!loadedUrl || mpv.state.currentUrl !== loadedUrl) return;
		if (!mpv.state.reachedEnd) {
			seenShortOfEndRef.current = loadedUrl;
			return;
		}
		if (seenShortOfEndRef.current !== loadedUrl) return;
		seenShortOfEndRef.current = null;
		if (autoplayRef.current && activeChannelRef.current?.contentType === "series") {
			const next = nextEpisodeRef.current;
			if (next) playEpisode(next);
		}
	}, [mpv.state.reachedEnd, mpv.state.currentUrl, loadedUrl, playEpisode]);

	// --- Controls visibility ---
	// Bumped by each click or tap so pressing a button, such as skip a few
	// times in a row, keeps the controls up.
	const [controlsActivity, setControlsActivity] = useState(0);
	useEffect(() => {
		if (!showControls) return;
		const timer = setTimeout(() => setShowControls(false), CONTROLS_HIDE_MS);
		return () => clearTimeout(timer);
	}, [showControls, controlsActivity]);

	const revealControls = useCallback(() => {
		setShowControls(true);
		setControlsActivity((n) => n + 1);
	}, []);
	const handleMouseMove = useCallback(() => setShowControls(true), []);
	// A tap on a touch screen also sends a mousemove, which would undo the
	// tap's toggle, so there only a real mouse or trackpad shows the controls.
	const handlePointerMove = useCallback((e: React.PointerEvent) => {
		if (e.pointerType === "mouse") setShowControls(true);
	}, []);

	// --- Skipping ---
	const skip = usePlayerPref(readSkipIntervals, SKIP_INTERVALS_EVENT);
	// Same test as the seek bar, which live channels usually don't get.
	const seekable = mpv.state.duration > 0;

	// Skips in a row add up, as nextSkip describes. The returned total is how
	// far the run of skips has moved.
	const lastSkipRef = useRef<SkipRun | null>(null);
	useEffect(() => {
		lastSkipRef.current = null;
	}, [mpv.state.currentUrl]);
	const skipBy = useCallback(
		(seconds: number): number => {
			const s = mpvStateRef.current;
			const run = nextSkip(lastSkipRef.current, s.position, s.duration, seconds, Date.now());
			lastSkipRef.current = run;
			mpv.seek(run.target);
			return run.total;
		},
		[mpv]
	);
	// The tap layer keeps its clicks from the player, so a double-tap skip
	// restarts the hide timer here, as a press on a skip button does. Hidden
	// controls stay hidden.
	const skipFromTap = useCallback(
		(seconds: number): number => {
			setControlsActivity((n) => n + 1);
			return skipBy(seconds);
		},
		[skipBy]
	);
	const seekTo = useCallback(
		(position: number) => {
			lastSkipRef.current = null;
			mpv.seek(position);
		},
		[mpv]
	);

	// --- Intros, recaps, credits and previews ---
	const savedSegmentModes = usePlayerPref(readSkipSegmentModes, SKIP_SEGMENT_MODES_EVENT);
	// mpv's own window has no prompt, so nothing is skipped there.
	const segmentModes = mpv.fallbackActive ? SKIPPING_OFF : savedSegmentModes;
	const { video, segments } = useSkipSegments({
		imdbId: activeImdbId,
		contentType: activeChannel?.contentType,
		season: subtitleSeason,
		episode: subtitleEpisode,
		// The polled length belongs to the stream mpv reports, which trails
		// the one asked for by a moment after switching.
		url: loadedUrl === mpv.state.currentUrl ? loadedUrl : null,
		duration: mpv.state.duration,
		enabled: segmentModes.opening !== "off" || segmentModes.ending !== "off",
	});
	const playNextEpisode = useCallback(() => {
		const next = nextEpisodeRef.current;
		if (next) playEpisode(next);
	}, [playEpisode]);
	// Something open over the prompt holds it, so the player doesn't skip
	// where the notice and its Undo can't be seen.
	const skipHeld = showShortcuts || !!pendingResume || showSubtitlePicker || showInfoDrawer;
	// A stream that's reconnecting holds the countdown, as a pause does.
	const videoPlaying = mpv.state.isPlaying && !mpv.state.isPaused && !mpv.reconnecting;
	const skipping = useSegmentSkipping({
		video,
		segments,
		position: mpv.state.position,
		duration: mpv.state.duration,
		reconnecting: mpv.reconnecting,
		playing: videoPlaying && !skipHeld,
		modes: segmentModes,
		autoplay,
		hasNext: nextEpisode !== null,
		seek: seekTo,
		onNextEpisode: playNextEpisode,
	});
	// Enter presses the prompt's button, so only while one is on screen.
	const skipSegment = !skipHeld && skipButtonShows(skipping, showControls) ? skipping.skip : null;

	const goBack = useCallback(() => {
		// "default" is the first history entry, so there's nothing to go back to.
		if (location.key !== "default") navigate(-1);
		else navigate("/");
	}, [location.key, navigate]);

	// --- Fullscreen ---
	const toggleFullscreen = useCallback(
		() => setFullscreen(!isFullscreen),
		[isFullscreen, setFullscreen]
	);

	// An iPad Split View pane narrow enough for the phone layout has no full
	// screen button, so it leaves full screen instead of keeping the sidebar
	// hidden.
	useEffect(() => {
		if (!fullscreenButton && isFullscreen) setFullscreen(false);
	}, [fullscreenButton, isFullscreen, setFullscreen]);

	// --- Keyboard ---
	const flashOsd = useCallback((text: string) => {
		if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
		setOsdText({ text, id: Date.now() });
		osdTimerRef.current = setTimeout(() => setOsdText(null), 900);
	}, []);
	useEffect(
		() => () => {
			if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
		},
		[]
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			// A confirm opened from the controls renders in a portal, and it keeps
			// its keys while it's open.
			if (!isInside(containerRef.current, e.target)) return;
			// The resume prompt handles its own keys. Its dialog takes Escape
			// first, even when focus is on the player behind it.
			if (pendingResume) return;
			if (isTypingTarget(e.target)) return;
			// Space or Enter on a button reached with Tab presses that button.
			if ((e.key === " " || e.key === "Enter") && isKeyboardFocusedControl(e.target)) return;
			// While the subtitle settings pane is open, arrow keys belong to subtitle
			// position/delay handlers — don't let them also seek or change volume.
			const isArrow = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key);
			if (subtitleEditMode && isArrow) return;

			const action = resolvePlayerHotkey(e, skip);
			if (!action) return;
			if (showShortcuts && action.type !== "toggleShortcuts" && action.type !== "escape")
				return;
			// Enter is only taken when the skip prompt shows a button, so it
			// still presses a button that has focus. Held down, it skips once.
			if (action.type === "skipSegment") {
				if (!e.repeat && skipSegment?.()) e.preventDefault();
				return;
			}
			e.preventDefault();
			if (e.repeat && !repeatsWhenHeld(action)) return;

			const s = mpv.state;
			switch (action.type) {
				case "togglePlay":
					if (s.isPaused || !s.isPlaying) {
						mpv.play();
					} else {
						mpv.pause();
					}
					break;
				case "toggleFullscreen":
					toggleFullscreen();
					break;
				case "toggleMute":
					mpv.toggleMute();
					flashOsd(s.volume > 0 ? "Muted" : "Unmuted");
					break;
				case "seekBy":
					flashOsd(formatSkip(skipBy(action.seconds)));
					break;
				case "seekToPercent":
					if (s.duration > 0) {
						const target = (s.duration * action.percent) / 100;
						seekTo(target);
						flashOsd(formatTime(target));
					}
					break;
				case "volumeBy": {
					const v = Math.min(
						MAX_VOLUME,
						Math.max(0, Math.round(s.volume + action.delta))
					);
					mpv.setVolume(v);
					flashOsd(`Volume ${v}%`);
					break;
				}
				case "nextEpisode":
					if (nextEpisode) playEpisode(nextEpisode);
					break;
				case "prevEpisode":
					if (prevEpisode) playEpisode(prevEpisode);
					break;
				case "toggleSubtitles":
					if (canShowSubtitles) setShowSubtitlePicker((v) => !v);
					break;
				case "toggleInfo":
					if (hasInfo) setShowInfoDrawer((v) => !v);
					break;
				case "toggleShortcuts":
					setShowShortcuts((v) => !v);
					break;
				case "escape":
					if (showShortcuts) {
						setShowShortcuts(false);
					} else if (isFullscreen) {
						setFullscreen(false);
					} else if (showInfoDrawer) {
						setShowInfoDrawer(false);
					} else if (showSubtitlePicker) {
						setShowSubtitlePicker(false);
						setSubtitleEditMode(false);
					} else {
						// Note: playStartTimeRef is NOT nulled here intentionally.
						// The unmount cleanup records the elapsed time when the route changes.
						flushProgress();
						mpv.stop();
						navigate("/");
					}
					break;
			}
			setShowControls(true);
		},
		[
			mpv,
			pendingResume,
			showShortcuts,
			isFullscreen,
			showInfoDrawer,
			showSubtitlePicker,
			navigate,
			setFullscreen,
			subtitleEditMode,
			toggleFullscreen,
			flashOsd,
			nextEpisode,
			prevEpisode,
			playEpisode,
			canShowSubtitles,
			hasInfo,
			flushProgress,
			skip,
			skipBy,
			seekTo,
			skipSegment,
		]
	);

	const handleStop = useCallback(() => {
		if (activeChannelRef.current && playStartTimeRef.current !== null) {
			const elapsed = Math.floor((Date.now() - playStartTimeRef.current) / 1000);
			recordPlayEnd(activeChannelRef.current.id, elapsed).catch(() => {});
			playStartTimeRef.current = null;
		}
		flushProgress();
		mpv.stop();
		navigate("/");
	}, [mpv, navigate, flushProgress]);

	// --- Info drawer episode source ---
	const episodesForDrawer = sortedEpisodes.length > 0 ? sortedEpisodes : localSeriesEpisodes;
	const showTitleForDrawer = activeChannel ? seriesTitleOf(activeChannel) : "";

	// --- Player download control (movies + series episodes only) ---
	const playerDl = activeChannel ? byChannel.get(activeChannel.id) : undefined;
	const playerDownloadState = downloadIconState(playerDl);
	const showPlayerDownload =
		!!activeChannel &&
		(activeChannel.contentType === "movie" || activeChannel.contentType === "series");
	const downloadSlot = showPlayerDownload ? (
		<DownloadButton
			itemId={activeChannel.id}
			state={playerDownloadState}
			onStart={() => {
				if (!activeChannel) return;
				if (activeChannel.contentType === "series") {
					void enqueueEpisodeDownload(
						activeChannel,
						seriesContainerId,
						showTitleForDrawer
					);
				} else {
					void enqueueMovieDownload(activeChannel.id);
				}
			}}
			onStop={() => playerDl && void stopDownload(playerDl.id)}
			onRemove={() => playerDl && removeDownload(playerDl.id)}
		/>
	) : undefined;

	// Resumes where the stream broke, not from the start of the movie or episode.
	const retryStream = () => {
		mpv.reload().catch(() => {});
	};

	return (
		<div
			ref={containerRef}
			className={
				isFullscreen
					? "player-container fixed inset-0 z-[9999] bg-transparent focus:outline-none"
					: "player-container relative h-full w-full bg-transparent focus:outline-none"
			}
			onMouseMove={touchDevice ? undefined : handleMouseMove}
			onPointerMove={touchDevice ? handlePointerMove : undefined}
			onClick={revealControls}
			onKeyDown={handleKeyDown}
			tabIndex={0}
		>
			{mpv.fallbackActive && (
				<div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-lg border border-yellow-500/40 bg-yellow-950/80 px-4 py-2 text-yellow-200 text-sm shadow-lg backdrop-blur-sm max-w-xl">
					<span>⚠</span>
					<span>
						Video is playing in a separate window with native controls (embedded
						renderer unavailable).
					</span>
				</div>
			)}

			<ConnectionStatusOverlay
				reconnecting={mpv.reconnecting}
				reconnectAttempt={mpv.reconnectAttempt}
				// Buffering before the first frame is part of opening, which has
				// its own spinner. Failures and reconnects still outrank it.
				buffering={mpv.buffering && !mpv.opening}
				loadFailed={mpv.loadFailed}
				openFailed={mpv.openFailed}
				recentlyRecovered={mpv.recentlyRecovered}
				onRetry={retryStream}
				belowTopBar={showBack}
			/>

			<div
				className="absolute inset-0 flex flex-col items-center justify-center bg-transparent"
				onDoubleClick={touchDevice ? undefined : toggleFullscreen}
			>
				{mpv.error && (
					<div className="text-center p-6 max-w-md">
						<p className="text-destructive text-sm mb-2">{mpv.error}</p>
						{!isMobilePlatform() && (
							<p className="text-muted-foreground text-xs">
								Check that libmpv is installed. See README for setup instructions.
							</p>
						)}
					</div>
				)}
				{!mpv.error &&
					!mpv.opening &&
					!mpv.state.currentUrl &&
					!mpv.state.isPlaying &&
					!mpv.state.isPaused && (
						<p className="text-muted-foreground text-lg">
							Select a channel to start watching
						</p>
					)}
				{mpv.opening && <OpeningIndicator key={mpv.loadId} onRetry={retryStream} />}
			</div>

			{touchDevice && (
				<VideoTapLayer
					seekable={seekable}
					skip={skip}
					onSkip={skipFromTap}
					onTap={() => setShowControls((v) => !v)}
				/>
			)}

			{(activeChannelName || showBack) && showControls && (
				<div className="absolute top-0 left-0 right-0 flex items-center gap-1 bg-gradient-to-b from-black/60 to-transparent p-4 pt-[calc(1rem_+_env(safe-area-inset-top))] pl-[calc(1rem_+_env(safe-area-inset-left))] pr-[calc(1rem_+_env(safe-area-inset-right))]">
					{showBack && (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								goBack();
							}}
							aria-label="Back"
							className="-my-2 -ml-3 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white active:bg-white/10"
						>
							<ChevronLeft className="h-6 w-6" />
						</button>
					)}
					{activeChannelName && (
						<p className="min-w-0 truncate text-white text-sm font-medium">
							{activeChannelName}
						</p>
					)}
				</div>
			)}

			{osdText && (
				<div
					key={osdText.id}
					className="pointer-events-none absolute top-1/4 left-1/2 -translate-x-1/2 z-30 rounded-lg bg-black/70 px-4 py-2 text-sm font-medium text-white tabular-nums shadow-lg"
				>
					{osdText.text}
				</div>
			)}

			{!mpv.fallbackActive && (
				<SkipSegmentPrompt
					skipping={skipping}
					controlsVisible={showControls}
					playing={videoPlaying}
					held={skipHeld}
					onFocusLost={() => containerRef.current?.focus()}
				/>
			)}

			{!mpv.fallbackActive && (
				<Controls
					state={{
						isPlaying: mpv.state.isPlaying,
						isPaused: mpv.state.isPaused,
						currentUrl: mpv.state.currentUrl,
						volume: mpv.state.volume,
						position: mpv.state.position,
						duration: mpv.state.duration,
					}}
					visible={showControls}
					isFullscreen={isFullscreen}
					onPlay={mpv.play}
					onPause={mpv.pause}
					onStop={handleStop}
					onSeek={seekTo}
					skip={seekable ? skip : undefined}
					onSkip={(seconds) => flashOsd(formatSkip(skipBy(seconds)))}
					touchLayout={touchDevice}
					// Play, pause and skip do nothing useful while the stream opens
					// or after it fails, and the spinner or the error has the middle
					// to itself.
					hideCenterControls={mpv.opening || mpv.openFailed || mpv.loadFailed}
					onVolumeChange={mpv.setVolume}
					onToggleMute={mpv.toggleMute}
					onFullscreen={fullscreenButton ? toggleFullscreen : undefined}
					onInfo={hasInfo ? () => setShowInfoDrawer(true) : undefined}
					onPrevEpisode={prevEpisode ? () => playEpisode(prevEpisode) : undefined}
					onNextEpisode={nextEpisode ? () => playEpisode(nextEpisode) : undefined}
					autoplay={autoplay}
					onAutoplayChange={setAutoplay}
					hasSubtitles={selectedSubtitleId !== null}
					onSubtitles={
						canShowSubtitles ? () => setShowSubtitlePicker((v) => !v) : undefined
					}
					sources={availableSources}
					currentSource={activeChannel?.url ?? null}
					onSelectSource={switchSource}
					onShortcuts={touchDevice ? undefined : () => setShowShortcuts((v) => !v)}
					showVolumeSlider={!touchDevice}
					downloadSlot={downloadSlot}
				/>
			)}

			{showSubtitlePicker && activeImdbId && (
				<SubtitlePicker
					imdbId={activeImdbId}
					season={subtitleSeason}
					episode={subtitleEpisode}
					onClose={() => {
						setShowSubtitlePicker(false);
						setSubtitleEditMode(false);
					}}
					onSubtitleSelected={(id, cues, entry, rankInLanguage) => {
						setSelectedSubtitleId(id);
						setSubtitleCues(cues ?? []);
						setSelectedSubtitleEntry(entry ?? null);
						if (entry && rankInLanguage !== undefined) {
							setSubtitlePreference({
								languageCode: entry.languageCode,
								rankInLanguage,
							});
						} else {
							// User clicked None — clear preference so next episode gets no subtitle.
							setSubtitlePreference(null);
						}
					}}
					currentSelectedId={selectedSubtitleId}
					currentSelectedEntry={selectedSubtitleEntry}
					subtitleFontSize={subtitleFontSize}
					subtitleFontFamily={subtitleFontFamily}
					subtitleDelay={subtitleDelay}
					onFontSizeChange={setSubtitleFontSize}
					onFontFamilyChange={setSubtitleFontFamily}
					onDelayChange={(d) => {
						setSubtitleDelay(d);
						import("@/lib/tauri").then(({ mpvSetSubDelay }) =>
							mpvSetSubDelay(d).catch(() => {})
						);
					}}
					onSettingsModeChange={(active) => setSubtitleEditMode(active)}
				/>
			)}

			{(subtitleCues.length > 0 || subtitleEditMode) && (
				<SubtitleOverlay
					cues={subtitleCues}
					position={mpv.state.position}
					fontSize={subtitleFontSize}
					fontFamily={subtitleFontFamily}
					posX={subtitlePos.x}
					posY={subtitlePos.y}
					delay={subtitleDelay}
					editMode={subtitleEditMode}
					onPositionChange={(x, y) => setSubtitlePos({ x, y })}
				/>
			)}

			{/* Info drawers */}
			{showInfoDrawer && activeChannel && activeChannel.contentType === "series" && (
				<SeriesDetailModal
					showTitle={showTitleForDrawer}
					episodes={episodesForDrawer}
					seriesChannelId={seriesContainerId}
					onClose={() => setShowInfoDrawer(false)}
					currentUrl={activeChannel.url}
					onPlay={(ch) => {
						// Same episode, different source → switch in place and keep the position.
						if (isSameEpisode(ch, activeChannel)) {
							setShowInfoDrawer(false);
							switchSource(ch.url);
						} else {
							playEpisode(ch);
						}
					}}
					prefetchedOmdbData={enrichedMeta?.omdbData}
					prefetchedWhatsonData={enrichedMeta?.whatsonData}
				/>
			)}

			{showInfoDrawer && activeChannel && activeChannel.contentType === "movie" && (
				<MovieInfoDrawer
					movie={activeChannel}
					onClose={() => setShowInfoDrawer(false)}
					onPlay={(ch) => {
						setShowInfoDrawer(false);
						// Same movie, different source → switch in place and keep the position.
						if (ch.id === activeChannel.id) {
							switchSource(ch.url);
						} else {
							startPlayback(ch, "player");
						}
					}}
					prefetchedOmdbData={enrichedMeta?.omdbData}
					prefetchedWhatsonData={enrichedMeta?.whatsonData}
				/>
			)}

			{showInfoDrawer && activeChannel && activeChannel.contentType === "live" && (
				<LiveInfoDrawer channel={activeChannel} onClose={() => setShowInfoDrawer(false)} />
			)}

			{showShortcuts && (
				<ShortcutsOverlay skip={skip} onClose={() => setShowShortcuts(false)} />
			)}

			{pendingResume && (
				<ResumePrompt
					title={pendingResume.channel.name}
					position={pendingResume.position}
					duration={pendingResume.duration}
					onResume={() => resolveResume("resume")}
					onStartOver={() => resolveResume("restart")}
					onCancel={() => resolveResume("cancel")}
				/>
			)}
		</div>
	);
};
