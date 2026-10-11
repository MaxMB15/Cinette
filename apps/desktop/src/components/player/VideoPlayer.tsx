// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Controls } from "./Controls";
import { ConnectionStatusOverlay } from "./ConnectionStatusOverlay";
import { OpeningIndicator } from "./OpeningIndicator";
import { SubtitlePicker } from "./SubtitlePicker";
import { SubtitleOverlay } from "./SubtitleOverlay";
import { ResumePrompt } from "./ResumePrompt";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
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
	resolveLocalDownload,
	enqueueMovieDownload,
	enqueueEpisodeDownload,
	stopDownload,
	removeDownload,
} from "@/lib/tauri";
import { parseSrt } from "@/lib/subtitle-parser";
import type { Channel, OmdbData, WhatsonData, SubtitleCue, SubtitleEntry } from "@/lib/types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useFullscreen } from "@/lib/fullscreen-context";
import { useDownloads } from "@/hooks/useDownloads";
import { DownloadButton, type DownloadIconState } from "@/components/downloads/DownloadButton";
import { playbackKey, isFinished, shouldOfferResume, MIN_RESUME_SECONDS } from "@/lib/playback";
import { channelSources, withSource } from "@/lib/sources";
import { sortEpisodes } from "@/lib/episodes";
import { resolvePlayerHotkey, isTypingTarget, isKeyboardFocusedControl } from "@/lib/hotkeys";
import { formatTime } from "@/lib/format";
import { addWatchedTime } from "@/lib/browse-state";
import { usePlatform } from "@/hooks/usePlatform";
import { isMobilePlatform } from "@/lib/platform";
import { ChevronLeft } from "lucide-react";

/** How often (ms) watch progress is persisted while playing. */
const PROGRESS_SAVE_INTERVAL = 5000;
const MAX_VOLUME = 150;
const LOADED_URL_KEY = "mvp_lastLoadedUrl";
/** Position jumps larger than this between polls are seeks, not watching. */
const MAX_WATCH_STEP_SECONDS = 5;

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

const showTitle = (name: string): string => name.replace(/\s+S\d{1,3}E\d{1,3}.*/i, "").trim();

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
	// The phone layout hides the tab bar on this route, so the player needs
	// its own way back.
	const { layoutMode } = usePlatform();
	const showBack = layoutMode === "mobile";
	// Phones and tablets already play full screen, and the hardware buttons
	// set the volume. An Android TV box has no touch screen, so it keeps the
	// full screen, volume and shortcut controls for its remote.
	const touchDevice = isMobilePlatform() && navigator.maxTouchPoints > 0;
	const [enrichedMeta, setEnrichedMeta] = useState<EnrichedMeta | null>(null);
	const [showSubtitlePicker, setShowSubtitlePicker] = useState(false);
	const [selectedSubtitleId, setSelectedSubtitleId] = useState<number | null>(null);
	const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
	const [selectedSubtitleEntry, setSelectedSubtitleEntry] = useState<SubtitleEntry | null>(null);
	const [subtitleFontSize, setSubtitleFontSize] = useState(18);
	const [subtitleFontFamily, setSubtitleFontFamily] = useState("system-ui, sans-serif");
	const [subtitlePos, setSubtitlePos] = useState({ x: 50, y: 88 });
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

	// Auto-focus the player container so keyboard controls (space, arrows)
	// work immediately without requiring a click first.
	useEffect(() => {
		containerRef.current?.focus();
	}, []);

	// Re-focus after channel load completes (currentUrl changes). Leave focus
	// alone if it's already inside the player (e.g. on the resume prompt).
	useEffect(() => {
		if (mpv.state.currentUrl && !containerRef.current?.contains(document.activeElement)) {
			containerRef.current?.focus();
		}
	}, [mpv.state.currentUrl]);

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
	useEffect(() => {
		if (!subtitleEditMode) return;
		const handleKey = (e: KeyboardEvent) => {
			if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
			e.preventDefault();
			setSubtitlePos((p) => ({
				x:
					e.key === "ArrowLeft"
						? Math.max(5, p.x - 2)
						: e.key === "ArrowRight"
							? Math.min(95, p.x + 2)
							: p.x,
				y:
					e.key === "ArrowUp"
						? Math.max(3, p.y - 2)
						: e.key === "ArrowDown"
							? Math.min(97, p.y + 2)
							: p.y,
			}));
		};
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	}, [subtitleEditMode]);

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
			// Prefer a completed download so playback works offline; fall back to
			// the stream URL if there is none or the lookup fails.
			const loadId = ++loadRequestRef.current;
			resolveLocalDownload(ch.id)
				.catch(() => null)
				.then((local) => {
					if (loadId !== loadRequestRef.current) return;
					const target = local ?? ch.url;
					progress.url = target;
					sessionStorage.setItem(LOADED_URL_KEY, target);
					return mpv.load(target, startPos);
				})
				.catch(() => {});
			setActiveChannelName(ch.name);
			setActiveChannel(ch);
			apply?.();
		},
		[mpv]
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
				sessionStorage.setItem(LOADED_URL_KEY, navUrl);
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

	// mpv only knows the stream URL, so tell the lock screen the channel name
	// and whether it's live.
	const activeIsLive = activeChannel?.contentType === "live";
	useEffect(() => {
		if (!isMobilePlatform()) return;
		mpvSetMediaInfo(activeChannelName, activeIsLive).catch(() => {});
	}, [activeChannelName, activeIsLive]);

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
		setSubtitlePos({ x: 50, y: 88 });

		if (!activeChannel || activeChannel.contentType === "live") {
			setEnrichedMeta(null);
			return;
		}

		let cancelled = false;
		setEnrichedMeta(null);

		const mediaType = activeChannel.contentType === "series" ? "series" : "movie";
		const titleForOmdb = activeChannel.seriesTitle ?? showTitle(activeChannel.name);

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
		const title = activeChannel.seriesTitle ?? showTitle(activeChannel.name);
		return channels.filter(
			(ch) => ch.contentType === "series" && (ch.seriesTitle ?? showTitle(ch.name)) === title
		);
	}, [activeChannel, channels]);

	// Series container id used to group download records — matches the series
	// card id in the channel list so download state stays consistent.
	const seriesContainerId = useMemo(() => {
		if (!activeChannel) return "";
		if (activeChannel.contentType !== "series") return activeChannel.id;
		const title = activeChannel.seriesTitle ?? showTitle(activeChannel.name);
		const container = channels.find(
			(ch) => ch.contentType === "series" && (ch.seriesTitle ?? showTitle(ch.name)) === title
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
			sessionStorage.setItem(LOADED_URL_KEY, url);
			mpv.load(url, startPos).catch(() => {});
			setActiveChannel({ ...ch, url, sourceList: availableSources });
		},
		[mpv, flushProgress, availableSources]
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

	// Track the last position+duration seen while actively playing.
	// MPV resets position/duration to 0 when a video ends or a new one loads,
	// so we can't rely on mpvStateRef at the moment isPlaying goes false.
	const lastPlayingStateRef = useRef({ position: 0, duration: 0 });
	useEffect(() => {
		if (mpv.state.isPlaying && mpv.state.duration > 0) {
			lastPlayingStateRef.current = {
				position: mpv.state.position,
				duration: mpv.state.duration,
			};
		}
	}, [mpv.state.isPlaying, mpv.state.position, mpv.state.duration]);

	const prevIsPlayingRef = useRef(false);
	useEffect(() => {
		const wasPlaying = prevIsPlayingRef.current;
		prevIsPlayingRef.current = mpv.state.isPlaying;

		// Only react to the transition: was playing → now not playing.
		if (!wasPlaying || mpv.state.isPlaying) return;

		// Distinguish EOF from a user pause: check if position was near the end.
		// With keep-open=yes, EOF lands in isPaused=true (last frame frozen) — we can't
		// use isPaused=false as the EOF signal anymore, so we use position proximity instead.
		const { position, duration } = lastPlayingStateRef.current;
		if (duration <= 0 || position < duration - 5) return; // mid-video pause — do nothing

		// EOF reached. With autoplay on and a next episode available, advance.
		if (autoplayRef.current && activeChannelRef.current?.contentType === "series") {
			const next = nextEpisodeRef.current;
			if (next) playEpisode(next);
		}
		// Otherwise (autoplay off, or movie, or last episode): keep-open=yes already holds
		// MPV on the last frame with isPaused=true — controls remain visible, no action needed.
	}, [mpv.state.isPlaying, playEpisode]);

	// --- Controls visibility ---
	useEffect(() => {
		if (!showControls) return;
		const timer = setTimeout(() => setShowControls(false), 4000);
		return () => clearTimeout(timer);
	}, [showControls]);

	const handleMouseMove = useCallback(() => setShowControls(true), []);

	const goBack = useCallback(() => {
		// "default" is the first history entry, so there's nothing to go back to.
		if (location.key !== "default") navigate(-1);
		else navigate("/");
	}, [location.key, navigate]);

	// --- Fullscreen ---
	const toggleFullscreen = useCallback(() => {
		const next = !isFullscreen;
		setFullscreen(next);
		getCurrentWindow()
			.setFullscreen(next)
			.catch((e) => {
				console.error("[PlayerView] setFullscreen failed:", e);
			});
	}, [isFullscreen, setFullscreen]);

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
			// The resume prompt handles its own keys; Escape still cancels it if
			// focus ended up elsewhere in the player.
			if (pendingResume) {
				if (e.key === "Escape") resolveResume("cancel");
				return;
			}
			if (isTypingTarget(e.target)) return;
			// Space on a button reached with Tab presses that button.
			if (e.key === " " && isKeyboardFocusedControl(e.target)) return;
			// While the subtitle settings pane is open, arrow keys belong to subtitle
			// position/delay handlers — don't let them also seek or change volume.
			const isArrow = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key);
			if (subtitleEditMode && isArrow) return;

			const action = resolvePlayerHotkey(e);
			if (!action) return;
			if (showShortcuts && action.type !== "toggleShortcuts" && action.type !== "escape")
				return;
			e.preventDefault();

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
				case "seekBy": {
					const target = Math.max(0, s.position + action.seconds);
					mpv.seek(s.duration > 0 ? Math.min(target, s.duration - 1) : target);
					flashOsd(`${action.seconds > 0 ? "+" : "−"}${Math.abs(action.seconds)}s`);
					break;
				}
				case "seekToPercent":
					if (s.duration > 0) {
						const target = (s.duration * action.percent) / 100;
						mpv.seek(target);
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
					if (activeChannel) setShowInfoDrawer((v) => !v);
					break;
				case "toggleShortcuts":
					setShowShortcuts((v) => !v);
					break;
				case "escape":
					if (showShortcuts) {
						setShowShortcuts(false);
					} else if (isFullscreen) {
						setFullscreen(false);
						getCurrentWindow()
							.setFullscreen(false)
							.catch((e) => {
								console.error("[PlayerView] setFullscreen(false) failed:", e);
							});
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
			resolveResume,
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
			activeChannel,
			flushProgress,
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
	const showTitleForDrawer = activeChannel?.seriesTitle ?? showTitle(activeChannel?.name ?? "");

	// --- Player download control (movies + series episodes only) ---
	const playerDl = activeChannel ? byChannel.get(activeChannel.id) : undefined;
	const playerDownloadState: DownloadIconState =
		playerDl?.status === "completed"
			? "complete"
			: playerDl?.status === "downloading" || playerDl?.status === "queued"
				? "downloading"
				: playerDl?.status === "failed"
					? "failed"
					: "idle";
	const showPlayerDownload =
		!!activeChannel &&
		(activeChannel.contentType === "movie" || activeChannel.contentType === "series");
	const downloadSlot = showPlayerDownload ? (
		<DownloadButton
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
			onRemove={() => playerDl && void removeDownload(playerDl.id)}
		/>
	) : undefined;

	const retryStream = () => {
		const url = mpv.state.currentUrl;
		if (!url) return;
		// Preserve playback position across the hard restart so
		// the user resumes where they were when the stream broke,
		// not from the beginning of the movie/episode. We use the
		// sticky `getLastKnownPosition()` (rather than the polled
		// `state.position`) so the retry is symmetric with the
		// `online`-triggered auto-recovery and robust to the
		// transient position=0 window during the `loadfile`.
		const resumeAt = mpv.getLastKnownPosition();
		mpv.load(url, resumeAt > 1.0 ? resumeAt : undefined).catch(() => {});
	};

	return (
		<div
			ref={containerRef}
			className={
				isFullscreen
					? "player-container fixed inset-0 z-[9999] bg-transparent focus:outline-none"
					: "player-container relative h-full w-full bg-transparent focus:outline-none"
			}
			onMouseMove={handleMouseMove}
			onClick={() => setShowControls(true)}
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

			{/* Autoplay banner — shown for 3s before next episode starts */}
			{/* (simple version: no countdown, instant autoplay) */}

			{!mpv.fallbackActive && (
				<Controls
					state={{
						isPlaying: mpv.state.isPlaying,
						isPaused: mpv.state.isPaused,
						currentUrl: mpv.state.currentUrl,
						volume: mpv.state.volume,
						position: mpv.state.position,
						duration: mpv.state.duration,
						playbackStarted: mpv.state.playbackStarted,
						openFailed: mpv.state.openFailed,
					}}
					visible={showControls}
					isFullscreen={isFullscreen}
					onPlay={mpv.play}
					onPause={mpv.pause}
					onStop={handleStop}
					onSeek={mpv.seek}
					onVolumeChange={mpv.setVolume}
					onToggleMute={mpv.toggleMute}
					onFullscreen={touchDevice ? undefined : toggleFullscreen}
					onInfo={activeChannel ? () => setShowInfoDrawer(true) : undefined}
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

			{showShortcuts && <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />}

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
