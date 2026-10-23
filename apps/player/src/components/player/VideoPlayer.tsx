// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Controls } from "./Controls";
import { ConnectionStatusOverlay } from "./ConnectionStatusOverlay";
import { OpeningIndicator } from "./OpeningIndicator";
import { SubtitlePicker, type SubtitlePick } from "./SubtitlePicker";
import { SubtitleOverlay } from "./SubtitleOverlay";
import { ResumePrompt } from "./ResumePrompt";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { VideoTapLayer } from "./VideoTapLayer";
import { SkipSegmentPrompt } from "./SkipSegmentPrompt";
import { MovieInfoDrawer } from "@/components/channels/MovieInfoDrawer";
import { SeriesDetailModal } from "@/components/channels/SeriesDetailModal";
import { LiveInfoDrawer } from "@/components/channels/LiveInfoDrawer";
import { useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { useLocation, useNavigate } from "react-router";
import { useMpv } from "@/hooks/useMpv";
import { useLocalPlayback } from "@/hooks/useLocalPlayback";
import { useAirPlay } from "@/hooks/useAirPlay";
import { useCast } from "@/hooks/useCast";
import { useRemoteControl } from "@/hooks/useRemoteControl";
import { useRemoteEpisodes } from "@/hooks/useRemoteEpisodes";
import { nowPlaying, sentMessage } from "@/lib/now-playing";
import { airplayConvertWarning, airplaySeekMessage, airplayKey } from "@/lib/airplay";
import { AirPlayButton } from "@/components/player/AirPlayButton";
import { CastButton } from "@/components/player/CastButton";
import { DestinationView } from "@/components/player/DestinationView";
import { castControlMessage, castFailureMessage, showsCastButton } from "@/lib/cast";
import { convertWarning } from "@/lib/device-picker";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { CatalogItem } from "@/lib/cinette-destination";
import type { PlaybackDestination } from "@/lib/destination";
import { usePublishRemoteState } from "@/hooks/useRemoteTarget";
import { setProgressSaver } from "@/lib/player-progress";
import { useLatestRef } from "@/hooks/useLatestRef";
import { useChanged } from "@/hooks/useChanged";
import { useMediaDetails } from "@/hooks/useMediaDetails";
import { useChannels } from "@/hooks/useChannels";
import {
	mpvSetBounds,
	mpvSetMediaInfo,
	recordPlayStart,
	recordPlayEnd,
	searchSubtitles,
	downloadSubtitle,
	readSubtitleFile,
	mpvSubAdd,
	mpvSubRemove,
	mpvSetSubDelay,
	mpvGetState,
	getPlaybackPosition,
	deletePlaybackPosition,
	handOffProgress,
	resolveLocalDownload,
	enqueueMovieDownload,
	enqueueEpisodeDownload,
	stopDownload,
	removeDownload,
	warmStreamFormats,
} from "@/lib/tauri";
import { parseSrt } from "@/lib/subtitle-parser";
import type { Channel, SubtitleCue, SubtitleEntry } from "@/lib/types";
import { useFullscreen } from "@/lib/fullscreen-context";
import { useLeaveFullscreenOnUnmount } from "@/hooks/useLeaveFullscreenOnUnmount";
import { useDownloads } from "@/hooks/useDownloads";
import { DownloadButton } from "@/components/downloads/DownloadButton";
import {
	EMPTY_PROGRESS,
	PROGRESS_SAVE_INTERVAL,
	playbackKey,
	progressFor,
	saveProgress,
	shouldOfferResume,
	type PlaybackProgress,
} from "@/lib/playback";
import { channelSources, withSource } from "@/lib/sources";
import { downloadIconState } from "@/lib/download-status";
import { episodeNeighbors, isSameEpisode, sortEpisodes } from "@/lib/episodes";
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
import {
	readSubtitleSession,
	saveSubtitleSession,
	updateSubtitleSession,
	type SubtitlePreference,
	type SubtitleSession,
} from "@/lib/subtitle-session";
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
import { controlsOthers, getPlatform, isMobilePlatform } from "@/lib/platform";
import { hasFullscreenButton } from "@/lib/fullscreen";
import { Airplay, Cast, ChevronLeft, MonitorSmartphone, X } from "lucide-react";

/** How long a note about AirPlay or Cast stays up. */
const NOTICE_MS = 6000;

/** A note on the player, and whether it's about a cast or about AirPlay. */
interface PlayerNotice {
	text: string;
	cast: boolean;
}

/**
 * What the player says when a control failed on `tv`, called `name`, from
 * a key or a click, or `null`. A cast says why in its own words while it's
 * connected, and says for itself when it's going. AirPlay says why a seek
 * failed; the rest shows on the TV. Another Cinette device couldn't be
 * reached.
 */
const controlFailure = (
	tv: PlaybackDestination,
	name: string,
	error: unknown,
	seeking: boolean
): PlayerNotice | null => {
	if (tv.kind === "cast")
		return tv.getState().connection === "connected"
			? { text: castControlMessage(name, error), cast: true }
			: null;
	if (tv.kind === "cinette") return { text: `Couldn't reach ${name}.`, cast: false };
	return seeking ? { text: airplaySeekMessage(error), cast: false } : null;
};

/**
 * The player's note once a cast was asked for: why it didn't go, or, when
 * it went, no note about an earlier cast, which would only mislead next to
 * one that plays. A note about something else stays.
 */
const afterCast =
	(why: string | null) =>
	(notice: PlayerNotice | null): PlayerNotice | null => {
		if (why) return { text: why, cast: true };
		return notice?.cast ? null : notice;
	};
const MAX_VOLUME = 150;
const LOADED_URL_KEY = "mvp_lastLoadedUrl";
/** Position jumps larger than this between polls are seeks, not watching. */
const MAX_WATCH_STEP_SECONDS = 5;
/** How long the controls stay up after they appear or the player is clicked or tapped. */
const CONTROLS_HIDE_MS = 4000;
/**
 * A poll this close to an episode's end counts as seeing the end coming. Polls
 * come every second, so a hidden window whose polls slow to every few seconds
 * still gets one.
 */
const END_LEAD_SECONDS = 10;
/**
 * The poll that finds the end has to come within this long (ms) of the last one
 * that saw it coming. A longer gap most likely means this page's timers were
 * stopped while mpv played on, as iOS does in the background.
 */
const END_SEEN_WITHIN_MS = 30_000;
/**
 * How many times a player page has read the subtitles the last one saved. A
 * pick that mpv adds after its page closed only goes in them until another
 * page reads them.
 */
let subtitleSessionReads = 0;

/**
 * Has Rust save `p`'s position from now on, or stop saving when `p` has
 * nothing to save. The position `p` holds goes stale from here, and flushing
 * it later, say on a stop right after the app comes back, would overwrite the
 * newer one Rust saved.
 */
const handOffToRust = (p: PlaybackProgress) => {
	p.dirty = false;
	const { key, url, pendingStart } = p;
	handOffProgress(key && url ? { key, url, pendingStart } : null).catch(() => {});
};

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
	const { layoutMode, platform } = usePlatform();
	const showBack = layoutMode === "mobile";
	// Phones and tablets set the volume with the hardware buttons. An Android
	// TV box has no touch screen, so it keeps the volume and shortcut
	// controls for its remote.
	const touchDevice = isMobilePlatform() && navigator.maxTouchPoints > 0;
	// A TV is driven by its remote's D-pad.
	const remote = getPlatform() === "tv";
	const fullscreenButton = hasFullscreenButton(touchDevice, layoutMode);
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

	const mpvStateRef = useLatestRef(mpv.state);
	const activeChannelRef = useLatestRef(activeChannel);
	const playStartTimeRef = useRef<number | null>(null);
	const progressRef = useRef<PlaybackProgress>(EMPTY_PROGRESS);
	// The URL mpv was last asked to play. For a download it's the file's path
	// rather than the channel's URL.
	const [loadedUrl, setLoadedUrl] = useState(() => sessionStorage.getItem(LOADED_URL_KEY));
	const loadedUrlRef = useLatestRef(loadedUrl);
	const rememberLoadedUrl = useCallback((url: string) => {
		sessionStorage.setItem(LOADED_URL_KEY, url);
		setLoadedUrl(url);
	}, []);
	// Guards against out-of-order resolution when items are opened in quick succession.
	const startRequestRef = useRef(0);
	const loadRequestRef = useRef(0);
	// Set when the viewer stops playback, which also forgets the subtitles.
	const stoppedRef = useRef(false);
	// False once the page closes. A subtitle the viewer picked, which mpv
	// draws and adds after that, goes to the ones the page saved, as long as
	// no other page has read them since. Any other subtitle that loads after
	// the page closed is dropped. An item still waiting to start doesn't
	// start, since the page that would show it is gone.
	const openRef = useRef(false);
	// The value of subtitleSessionReads when this page opened, or when it last
	// read the saved subtitles.
	const readsSeenRef = useRef(0);
	// Counts the viewer's subtitle picks, so a subtitle still downloading for
	// an earlier pick, or for the auto-load, gives way to a newer one.
	const subtitlePickRef = useRef(0);
	/**
	 * Starts a subtitle choice for the item playing now. One the viewer makes
	 * replaces any choice before it. The auto-load replaces none, and gives way
	 * to the viewer's next pick.
	 */
	const followSubtitlePick = useCallback(
		(byViewer: boolean): SubtitlePick => {
			const pick = byViewer ? ++subtitlePickRef.current : subtitlePickRef.current;
			const channelId = activeChannelRef.current?.id;
			const latest = () => pick === subtitlePickRef.current;
			return {
				latest,
				stream: () =>
					latest() && openRef.current && activeChannelRef.current?.id === channelId
						? loadedUrlRef.current
						: null,
				// The page saved its subtitles when it closed, and the next one
				// opens with them, so the pick goes there. Once another page has
				// read them, it shows what it read.
				keep: (url, entry, rankInLanguage) =>
					!openRef.current &&
					subtitleSessionReads === readsSeenRef.current &&
					channelId !== undefined &&
					updateSubtitleSession(channelId, url, {
						fileId: entry.fileId,
						entry,
						cues: [],
						preference: { languageCode: entry.languageCode, rankInLanguage },
						autoLoad: false,
					}),
			};
		},
		[activeChannelRef, loadedUrlRef]
	);

	// Remembers which language + rank-within-language the user last picked so the
	// same subtitle can be auto-selected when navigating to the next episode.
	const [subtitlePreference, setSubtitlePreference] = useState<SubtitlePreference | null>(null);
	// Refs used by the auto-load effect to avoid stale closures.
	const subtitlePreferenceRef = useLatestRef(subtitlePreference);
	// Incremented each time an episode navigation should trigger subtitle auto-load.
	// Using state (not a ref) so the effect dependency is tracked by React.
	const [autoLoadTrigger, setAutoLoadTrigger] = useState(0);
	// The last trigger whose load finished, so the page knows when it closes
	// whether one was still running.
	const [autoLoadFinished, setAutoLoadFinished] = useState(0);

	const navState = location.state as {
		url?: string;
		channelName?: string;
		channel?: Channel;
		seriesEpisodes?: Channel[];
	} | null;
	// Opened without a new item, the page shows the one that played on while
	// it was closed, and the subtitles it had then.
	const [keptSubtitles, setKeptSubtitles] = useState(() =>
		navState?.url ? null : readSubtitleSession()
	);

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

	// Persists the tracked position for the current item.
	const flushProgress = useCallback(
		() => saveProgress(progressRef.current),
		// Stryker disable next-line ArrayDeclaration: It only reads a ref, so it's the same function with any deps.
		[]
	);

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

	useEffect(
		() => () => {
			void flushProgress();
		},
		// Stryker disable next-line ArrayDeclaration: flushProgress never changes, so the cleanup runs only on unmount either way.
		[flushProgress]
	);

	// This page can't save progress while it's hidden, because iOS stops its
	// timers once the app is in the background though audio keeps playing, or
	// after it closes with the item still playing. Rust saves it until the
	// player is visible again.
	useEffect(() => {
		const handOff = () => handOffToRust(progressRef.current);
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

	/** Saves how long the current item played, once per start. */
	const recordEnd = useCallback(() => {
		const ch = activeChannelRef.current;
		const startedAt = playStartTimeRef.current;
		if (!ch || startedAt === null) return;
		playStartTimeRef.current = null;
		recordPlayEnd(ch.id, Math.floor((Date.now() - startedAt) / 1000)).catch(() => {});
	}, [activeChannelRef]);

	// Why AirPlay or Cast stopped or didn't start, or a control failed.
	const [notice, setNotice] = useState<PlayerNotice | null>(null);
	useEffect(() => {
		const timer = setTimeout(() => setNotice(null), NOTICE_MS);
		return () => clearTimeout(timer);
	}, [notice]);
	const castNotice = (text: string) => setNotice({ text, cast: true });
	// AirPlay's, and another Cinette device's.
	const deviceNotice = (text: string) => setNotice({ text, cast: false });
	// Google Cast from a computer.
	const cast = useCast(platform === "macos" || platform === "linux");
	const castRef = useLatestRef(cast);
	// AirPlay video on iOS and macOS.
	const mac = platform === "macos";
	const airplay = useAirPlay(platform === "ios" || mac, mac);
	const airplayRef = useLatestRef(airplay);
	/** Asks before a cast switches to a route this computer converts. */
	const [castConfirm, setCastConfirm] = useState<{
		name: string;
		keep: "on" | "onScreen";
		answer: (ok: boolean) => void;
	} | null>(null);
	// The question waiting for an answer, so a newer one, or leaving the
	// page, answers it with no and the cast it holds up ends.
	// A question already answered takes no second answer, so the last one
	// asked stays here.
	const castQuestion = useRef<((ok: boolean) => void) | null>(null);
	const confirmCast = useCallback(
		(name: string, keep: "on" | "onScreen") =>
			new Promise<boolean>((answer) => {
				castQuestion.current?.(false);
				castQuestion.current = answer;
				setCastConfirm({ name, keep, answer });
			}),
		// Stryker disable next-line ArrayDeclaration: It only uses a ref and a state setter, so it's the same function with any deps.
		[]
	);
	// Stryker disable next-line ArrayDeclaration: The cleanup reads the ref when it runs, so any deps that never change run it only on unmount.
	useEffect(() => () => castQuestion.current?.(false), []);

	/**
	 * Actually start playing `ch` (optionally from `startPos`), replacing
	 * whatever is playing. While a TV plays, over Cast or AirPlay, `ch` goes
	 * there instead, by its own route for that TV, after the confirm step
	 * when this device starts converting for it. Resolves once mpv has opened the stream, or at once
	 * if another item replaced this one first, and rejects if mpv couldn't
	 * open it. The player shows that error itself, so callers can ignore it.
	 */
	const commitPlayback = useCallback(
		(ch: Channel, startPos?: number, apply?: () => void): Promise<void> => {
			// Nothing plays here while a TV does, so this only moves the player
			// to the new item once it's going to the TV.
			const moveTo = async () => {
				recordEnd();
				playStartTimeRef.current = Date.now();
				recordPlayStart(ch.id, ch.name, ch.logoUrl ?? null, ch.contentType).catch(() => {});
				setActiveChannelName(ch.name);
				setActiveChannel(ch);
				apply?.();
			};
			// The TV drops a live channel's start, and a live channel has no
			// resume point to keep one in. One that already converts doesn't
			// ask again.
			const tv = castRef.current.current() ?? airplayRef.current.current();
			if (tv) {
				return nowPlaying
					.send(tv, ch, {
						startAt: startPos,
						confirm: tv.converted?.()
							? undefined
							: (keep) => confirmCast(tv.name, keep),
						stopLocal: moveTo,
					})
					.then((sent) => {
						const why = sentMessage(tv, sent);
						// A cast's note goes once a cast goes; AirPlay's stays.
						if (tv.kind === "cast") setNotice(afterCast(why));
						else if (why) setNotice({ text: why, cast: false });
					});
			}
			recordEnd();
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
			const loaded = resolveLocalDownload(ch.id)
				.catch(() => null)
				.then((local) => {
					if (loadId !== loadRequestRef.current) return;
					const target = local ?? ch.url;
					progress.url = target;
					rememberLoadedUrl(target);
					// A page that closed while the player looked for a download
					// saved its subtitles with no stream. They're for this one.
					if (!openRef.current) updateSubtitleSession(ch.id, null, { url: target });
					return mpv.load(target, startPos);
				});
			loaded.catch(() => {});
			setActiveChannelName(ch.name);
			setActiveChannel(ch);
			apply?.();
			return loaded;
		},
		// Stryker disable next-line ArrayDeclaration: mpv's load is the one useMpv keeps with useCallback, recordEnd and rememberLoadedUrl only read refs, castRef and airplayRef are refs, and confirmCast never changes.
		[mpv, rememberLoadedUrl, recordEnd, castRef, airplayRef, confirmCast]
	);

	/**
	 * Starts `ch` for the destination's `load`. The caller picked the start
	 * position, so no resume prompt shows. As a press in the player does, it
	 * saves the last item's progress first, and a start that's still looking
	 * up its resume point, or a resume prompt on screen, gives way to it.
	 * The destination keeps the newest one in a ref, so it needs no memo.
	 */
	const loadFromDestination = (ch: Channel, startAt?: number): Promise<void> => {
		++startRequestRef.current;
		setPendingResume(null);
		flushProgress();
		return commitPlayback(ch, startAt);
	};
	// The player's controls go through the active destination, which is
	// always this device for now. It starts an item the way the player does.
	const playback = useLocalPlayback(mpv, activeChannel, loadFromDestination);
	// The receiver the player's controls drive instead of mpv, while one plays.
	// Another Cinette device this one controls, where it can control others.
	const { link } = useRemoteControl();
	const linked = link?.phase.phase === "connected" || link?.phase.phase === "reconnecting";
	const remoteLink = controlsOthers() && linked ? link : null;
	const tv: PlaybackDestination | null =
		airplay.destination ?? cast.destination ?? remoteLink?.destination ?? null;
	// The name the view shows, which for the link follows a rename. There's
	// one whenever there's a TV.
	const tvName = airplay.destination?.name ?? cast.destination?.name ?? remoteLink?.name;
	/** Says why a control on the TV failed, from a key or the view. */
	const reportFailure = (error: unknown, seeking: boolean) => {
		const failure = tv && controlFailure(tv, tvName!, error, seeking);
		if (failure) setNotice(failure);
	};
	const tvRef = useLatestRef(tv);
	// The other device's episodes, where a link plays one.
	const remoteEpisodes = useRemoteEpisodes(remoteLink);
	const reportFailureRef = useLatestRef(reportFailure);
	/** Stops what plays here before something else takes over, keeping
	 *  where it got to. */
	const stopLocal = async () => {
		flushProgress();
		await playback.stop();
	};
	const stopLocalRef = useLatestRef(stopLocal);
	// Controlling another device takes over the player, so nothing plays
	// here under it, as when a cast or AirPlay starts.
	const remoteId = remoteLink?.id;
	useEffect(() => {
		if (remoteId !== undefined) void stopLocalRef.current();
	}, [remoteId, stopLocalRef]);
	// Once a TV is in reach, the panel is asked ahead what a send would wait
	// on, so the button opens the picker sooner.
	const canSend = airplay.available || showsCastButton(cast);
	useEffect(() => {
		if (canSend && activeChannel) void warmStreamFormats(activeChannel).catch(() => {});
	}, [canSend, activeChannel]);
	// The now-playing store keeps the TV's resume point, also with the page
	// closed.
	const tvState = airplay.state ?? cast.state;
	// Where the item was when it went to AirPlay. On a Mac, closing the
	// picker without a TV, or with this Mac, sends it nowhere, and it plays
	// here again from there, as if AirPlay never started.
	const airplayFrom = useRef<number | undefined>(undefined);
	const playHereAgain = useLatestRef(async () => {
		// AirPlay ended already, and nothing needs saying.
		nowPlaying.dismiss();
		// Stryker disable next-line ConditionalExpression: A send needs a channel, and nothing clears it while AirPlay plays.
		if (!activeChannel) return;
		await playback
			.load({ kind: "local", channel: activeChannel }, { startAt: airplayFrom.current })
			.catch(() => deviceNotice("Couldn't play it on this device."));
	});
	useEffect(() => {
		if (airplay.notPicked) void playHereAgain.current();
	}, [airplay.notPicked, playHereAgain]);
	// Other Cinette devices control this player and see what it plays.
	usePublishRemoteState(playback, activeChannel);
	// A history transfer saves where this player is before it reads the history.
	useEffect(
		() =>
			setProgressSaver(async () => {
				// A TV's position too, which goes on with the page closed.
				await Promise.all([flushProgress(), nowPlaying.flush()]);
				// Stryker disable next-line OptionalChaining: with no channel, the throw is caught by saveProgressNow, which gives the same null.
				return activeChannelRef.current?.id ?? null;
			}),
		// Stryker disable next-line ArrayDeclaration: flushProgress and the ref never change, so it registers once either way.
		[flushProgress, activeChannelRef]
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
			if (requestId !== startRequestRef.current || !openRef.current) return;
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
		[mpv, mpvStateRef, flushProgress, commitPlayback]
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
				const progress = {
					...progressFor(prev, undefined, loaded),
					position: s.position,
					duration: s.duration,
					dirty: true,
				};
				progressRef.current = progress;
				// The page closed while it waited for mpv, when it had nothing
				// to hand Rust yet, so nothing else would save this item's
				// progress until the player opens again.
				if (!openRef.current) handOffToRust(progress);
			}
		} catch {}
	};

	// The player's handler for arriving on its page. It takes what to play from
	// the router, or from sessionStorage when the page opens without it, and
	// starts mpv. It runs again when the router's URL changes on a mounted
	// player, as when the sidebar's Player link is clicked on the player page,
	// so starting values for the state wouldn't cover it.
	useEffect(() => {
		if (navState?.url) {
			const navEpisodes = navState.seriesEpisodes?.length ? navState.seriesEpisodes : null;
			const navChannel = navState.channel;
			const navUrl = navState.url;
			if (navChannel) {
				const ch = navChannel.url === navUrl ? navChannel : withSource(navChannel, navUrl);
				// The episode list belongs with the item, so it changes only if
				// the item starts, not when the start is cancelled or dropped.
				const apply = navEpisodes ? () => setSeriesEpisodes(navEpisodes) : undefined;
				adoptBackgroundProgress().finally(() => startPlayback(ch, "nav", apply));
			} else {
				// eslint-disable-next-line react-hooks/set-state-in-effect -- applies the navigation, see above
				if (navEpisodes) setSeriesEpisodes(navEpisodes);
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
					// A page that opens has no item yet, so it reads the subtitles
					// here, after a closed page could still change them. The page
					// can also be open already, as over a resume prompt for another
					// item, and then it read no subtitles when it opened.
					if (ch.id !== activeChannel?.id) {
						readsSeenRef.current = ++subtitleSessionReads;
						setKeptSubtitles(readSubtitleSession());
					}
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

	// A new item starts with no subtitles. Resetting them while rendering keeps
	// the old item's from showing with it for a frame. The item that played on
	// while the page was closed gets back the subtitles it had, as long as the
	// player hasn't loaded anything else for it since.
	const channelChanged = useChanged(activeChannel?.id);
	if (channelChanged) {
		const kept =
			keptSubtitles?.channelId === activeChannel?.id && keptSubtitles?.url === loadedUrl
				? keptSubtitles
				: null;
		setKeptSubtitles(null);
		setShowSubtitlePicker(false);
		setSelectedSubtitleId(kept?.fileId ?? null);
		setSubtitleCues(kept?.cues ?? []);
		setSelectedSubtitleEntry(kept?.entry ?? null);
		setSubtitleEditMode(false);
		setSubtitleDelay(kept?.delay ?? 0);
		setSubtitlePos(kept?.position ?? DEFAULT_SUBTITLE_POSITION);
		if (kept) {
			setSubtitleFontSize(kept.fontSize);
			setSubtitleFontFamily(kept.fontFamily);
			setSubtitlePreference(kept.preference);
			// The next episode's subtitles were still loading, so load them again.
			if (kept.autoLoad) setAutoLoadTrigger((t) => t + 1);
		}
	}

	// mpv doesn't draw the subtitles the overlay draws, so keep them for when
	// this page opens again while the item plays on.
	const subtitleSessionRef = useLatestRef<SubtitleSession | null>(
		activeChannel && {
			channelId: activeChannel.id,
			url: loadedUrl,
			fileId: selectedSubtitleId,
			entry: selectedSubtitleEntry,
			cues: subtitleCues,
			delay: subtitleDelay,
			position: subtitlePos,
			fontSize: subtitleFontSize,
			fontFamily: subtitleFontFamily,
			preference: subtitlePreference,
			autoLoad:
				autoLoadTrigger > autoLoadFinished &&
				subtitlePreference !== null &&
				selectedSubtitleId === null,
		}
	);
	// Layout effects, so the page counts as closed and has saved its
	// subtitles once it's off the screen. A navigation runs passive cleanups
	// later, and a subtitle that loads in between would go to the closed page.
	// The page takes the count of reads as it opens, since one opened with a
	// new item never reads the saved subtitles, and checks its own late pick
	// against that.
	useLayoutEffect(() => {
		openRef.current = true;
		readsSeenRef.current = subtitleSessionReads;
		return () => {
			openRef.current = false;
		};
	}, []);
	useLayoutEffect(
		() => () => {
			if (stoppedRef.current) saveSubtitleSession(null);
			// A page that never started an item, as when the viewer cancels the
			// resume prompt, leaves the subtitles of the one that plays on.
			else if (subtitleSessionRef.current) saveSubtitleSession(subtitleSessionRef.current);
		},
		[subtitleSessionRef]
	);

	// Load the details up front for a movie or series, so the info sheet opens
	// with them and subtitles can search by IMDb id. A recording is live TV.
	const mediaKind =
		activeChannel?.contentType === "movie" || activeChannel?.contentType === "series"
			? activeChannel.contentType
			: null;
	const mediaDetails = useMediaDetails(
		activeChannel && mediaKind
			? { id: activeChannel.id, title: seriesTitleOf(activeChannel), kind: mediaKind }
			: null
	);
	// The sheets load their own until OMDb has answered here.
	const prefetchedOmdbData = mediaDetails.loading ? undefined : mediaDetails.omdbData;
	const prefetchedWhatsonData = mediaDetails.loading ? undefined : mediaDetails.whatsonData;

	const activeImdbId = mediaDetails.omdbData?.imdbId ?? null;
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
	const subtitleSeasonRef = useLatestRef(subtitleSeason);
	const subtitleEpisodeRef = useLatestRef(subtitleEpisode);

	// Auto-load: fires when playEpisode increments autoLoadTrigger, then waits for
	// activeImdbId to resolve. Using a trigger counter avoids the cancellation bug
	// where a new item's activeImdbId goes null mid-flight and kills the search.
	// A load still to run waits while the player finds out whether a download
	// of the item plays, and so which stream the subtitles go to. One that
	// finished doesn't run again when the same item restarts.
	const autoLoadWaits = autoLoadTrigger > autoLoadFinished && loadedUrl === null;
	useEffect(() => {
		if (autoLoadTrigger === 0) return; // no episode navigation yet
		if (!activeImdbId) return; // OMDB still in-flight; re-run when it resolves
		if (autoLoadWaits) return;
		const pref = subtitlePreferenceRef.current;
		if (!pref) return;

		const pick = followSubtitlePick(false);
		let cancelled = false;

		searchSubtitles(activeImdbId, subtitleSeasonRef.current, subtitleEpisodeRef.current)
			.then(async (result) => {
				if (cancelled) return;
				const langEntries = (result?.entries ?? []).filter(
					(e) => e.languageCode === pref.languageCode
				);
				if (langEntries.length === 0) return; // preferred language not available, keep none
				const entry = langEntries[Math.min(pref.rankInLanguage, langEntries.length - 1)];
				const localPath = await downloadSubtitle(entry.fileId);
				// mpv also reads a file that isn't UTF-8, and draws any file the
				// overlay can't read.
				const cues = await readSubtitleFile(localPath).then(parseSrt, () => []);
				const url = pick.stream();
				if (cancelled || url === null) return;
				// When the overlay read no cues, only mpv can show the
				// subtitles, so the choice changes once mpv has the track.
				const added = mpvSubAdd(localPath, cues.length > 0, url);
				if (cues.length > 0) added.catch(() => {});
				else {
					await added;
					// mpv draws this track itself. A pick the viewer made during
					// the add replaces it on its own. When the page closed or the
					// player moved on, the track comes out again, so it doesn't
					// show over the subtitles the player keeps.
					if (!pick.latest()) return;
					if (cancelled || pick.stream() === null) {
						await mpvSubRemove(-1, url).catch(() => {});
						return;
					}
				}
				setSelectedSubtitleId(entry.fileId);
				setSubtitleCues(cues);
				setSelectedSubtitleEntry(entry);
			})
			.catch(() => {}) // silent, subtitle is best-effort
			.finally(() => {
				if (!cancelled) setAutoLoadFinished(autoLoadTrigger);
			});

		return () => {
			cancelled = true;
		};
	}, [
		autoLoadTrigger,
		activeImdbId,
		autoLoadWaits,
		followSubtitlePick,
		subtitlePreferenceRef,
		subtitleSeasonRef,
		subtitleEpisodeRef,
	]);

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
	const { prev: prevEpisode, next: nextEpisode } = useMemo(
		() => episodeNeighbors(sortedEpisodes, currentEpIdx),
		[sortedEpisodes, currentEpIdx]
	);

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
			// The item stays the same, so its subtitles stay too. Before its
			// first stream loads, mpv still has the last item's, so drop those.
			const keepSubtitles = loadedUrlRef.current !== null;
			progressRef.current = {
				...progressRef.current,
				url,
				lastSaved: Date.now(),
				pendingStart: startPos ?? null,
			};
			loadRequestRef.current++;
			rememberLoadedUrl(url);
			mpv.load(url, startPos, keepSubtitles).catch(() => {});
			setActiveChannel({ ...ch, url, sourceList: availableSources });
		},
		[mpv, activeChannelRef, loadedUrlRef, flushProgress, availableSources, rememberLoadedUrl]
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

	// On unmount, record end of play
	useEffect(() => recordEnd, [recordEnd]);

	// --- Autoplay next episode ---
	// Use refs to avoid stale closures while keeping the effect dependency minimal
	const nextEpisodeRef = useLatestRef(nextEpisode);
	const autoplayRef = useLatestRef(autoplay);
	/** Plays the next episode, when autoplay is on. Only an episode of a
	 *  series has one. */
	const autoplayNext = useCallback(
		() => {
			const next = nextEpisodeRef.current;
			if (autoplayRef.current && next) playEpisode(next);
		},
		// Stryker disable next-line ArrayDeclaration: The rest are refs, and playEpisode only changes with mpv's state, while an older one starts the episode the same way through mpv's same actions.
		[playEpisode, autoplayRef, nextEpisodeRef]
	);

	// Advance when the episode reaches its end, not when it stops near it. A
	// pause in the last seconds, or the resume prompt pausing the player, leaves
	// reachedEnd false. At the end, with keep-open=yes, mpv holds the last frame,
	// paused, so with autoplay off, on a movie or on the last episode the
	// controls stay up and nothing else needs doing.
	//
	// Only an end this player saw coming counts. The ref holds the stream that
	// a poll last saw in its final seconds and when, and any poll from further
	// back clears it. Coming back from another page to an episode that ended
	// there leaves it on the last frame. So does coming back to the app after
	// iOS held this page's timers in the background for longer than
	// END_SEEN_WITHIN_MS while mpv played on.
	const seenNearEndRef = useRef<{ url: string; at: number } | null>(null);
	useEffect(() => {
		// A poll can still describe the previous stream after the app loads
		// another one, such as from the Next episode button near the end.
		if (!loadedUrl || mpv.state.currentUrl !== loadedUrl) return;
		const { reachedEnd, position, duration } = mpv.state;
		if (!reachedEnd) {
			// useMpv sets a new state on every poll, paused or not, so a long
			// pause in the last seconds keeps this time fresh.
			const nearEnd = duration > 0 && duration - position <= END_LEAD_SECONDS;
			seenNearEndRef.current = nearEnd ? { url: loadedUrl, at: Date.now() } : null;
			return;
		}
		const seen = seenNearEndRef.current;
		if (!seen || seen.url !== loadedUrl) return;
		seenNearEndRef.current = null;
		if (Date.now() - seen.at > END_SEEN_WITHIN_MS) return;
		autoplayNext();
	}, [mpv.state, loadedUrl, autoplayNext]);
	// A TV that reaches the end of the episode the player has goes on too,
	// while this page is open.
	const tvEnded = tvState?.status === "ended" && tvState.item?.ref === activeChannel?.id;
	useEffect(() => {
		if (tvEnded) autoplayNext();
	}, [tvEnded, autoplayNext]);

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
			playback.seek(run.target);
			return run.total;
		},
		// Stryker disable next-line ArrayDeclaration: The seek it calls is the one useMpv keeps with useCallback, and mpvStateRef is a ref.
		[playback, mpvStateRef]
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
			playback.seek(position);
		},
		// Stryker disable next-line ArrayDeclaration: The seek it calls is the one useMpv keeps with useCallback, so the first render's works as well as the last.
		[playback]
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
	}, [playEpisode, nextEpisodeRef]);
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

	/** Plays `item` of the other device's catalog there. */
	const playOn = (device: PlaybackDestination, item: CatalogItem) =>
		void device
			.load({ kind: "remote", itemId: item.id, title: item.name, seriesId: item.seriesId })
			.catch((error: unknown) => reportFailure(error, false));
	// The episodes around the one that plays, which the controls, a TV's view
	// and the keys go to: another Cinette device's, from its catalog, or this
	// player's.
	const { prev: remotePrev, next: remoteNext } = remoteEpisodes;
	const episodes =
		tv?.kind === "cinette"
			? {
					onPrevEpisode: remotePrev ? () => playOn(tv, remotePrev) : undefined,
					onNextEpisode: remoteNext ? () => playOn(tv, remoteNext) : undefined,
				}
			: {
					onPrevEpisode: prevEpisode ? () => playEpisode(prevEpisode) : undefined,
					onNextEpisode: nextEpisode ? () => playEpisode(nextEpisode) : undefined,
				};
	const episodesRef = useLatestRef(episodes);

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
			// The resume prompt and the cast question handle their own keys.
			// Their dialogs take Escape first, even when focus is on the
			// player behind them.
			if (pendingResume || castConfirm) return;
			if (isTypingTarget(e.target)) return;
			// Space or Enter on a button reached with Tab presses that button.
			if ((e.key === " " || e.key === "Enter") && isKeyboardFocusedControl(e.target)) return;
			// While the subtitle settings pane is open, arrow keys belong to subtitle
			// position/delay handlers — don't let them also seek or change volume.
			const isArrow = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key);
			if (subtitleEditMode && isArrow) return;
			// The remote is a TV's only way to the controls, so any key shows
			// them, and each one keeps them up while focus moves between them.
			if (remote) revealControls();
			// On a TV the D-pad moves between the controls once one has focus.
			if (remote && isArrow && isKeyboardFocusedControl(e.target)) return;

			const action = resolvePlayerHotkey(e, skip, remote);
			if (!action) return;
			if (showShortcuts && action.type !== "toggleShortcuts" && action.type !== "escape")
				return;
			// Enter is only taken when the skip prompt shows a button, so it
			// still presses a button that has focus. Held down, it skips once.
			if (action.type === "skipSegment") {
				if (!e.repeat && skipSegment?.()) e.preventDefault();
				// A remote's center button plays and pauses when there's nothing to skip.
				else if (!e.repeat && remote) {
					e.preventDefault();
					if (mpv.state.isPaused || !mpv.state.isPlaying) playback.play();
					else playback.pause();
				}
				return;
			}
			e.preventDefault();
			if (e.repeat && !repeatsWhenHeld(action)) return;

			// While the TV plays, the keys drive it, and nothing starts here. The
			// next or previous episode goes where the controls send it, there too.
			const tv = tvRef.current;
			const episode = action.type === "nextEpisode" || action.type === "prevEpisode";
			if (tv && !episode) {
				const key = airplayKey(action, tv.getState(), tv.capabilities, performance.now());
				const failed = (seeking: boolean) => (error: unknown) =>
					reportFailureRef.current(error, seeking);
				if (key.kind === "play") void tv.play().catch(failed(false));
				if (key.kind === "pause") void tv.pause().catch(failed(false));
				if (key.kind === "seek") void tv.seek(key.to).catch(failed(true));
				if (key.kind !== "pass") return;
			}

			const s = mpv.state;
			switch (action.type) {
				case "togglePlay":
					if (s.isPaused || !s.isPlaying) {
						playback.play();
					} else {
						playback.pause();
					}
					break;
				case "play":
					playback.play();
					break;
				case "pause":
					playback.pause();
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
					playback.setVolume(v);
					flashOsd(`Volume ${v}%`);
					break;
				}
				case "nextEpisode":
					episodesRef.current.onNextEpisode?.();
					break;
				case "prevEpisode":
					episodesRef.current.onPrevEpisode?.();
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
						stoppedRef.current = true;
						mpv.stop();
						navigate("/");
					}
					break;
			}
			setShowControls(true);
		},
		[
			mpv,
			playback,
			tvRef,
			episodesRef,
			reportFailureRef,
			pendingResume,
			castConfirm,
			showShortcuts,
			isFullscreen,
			showInfoDrawer,
			showSubtitlePicker,
			navigate,
			setFullscreen,
			subtitleEditMode,
			toggleFullscreen,
			flashOsd,
			canShowSubtitles,
			hasInfo,
			flushProgress,
			skip,
			skipBy,
			seekTo,
			skipSegment,
			remote,
			revealControls,
		]
	);

	const handleStop = useCallback(() => {
		recordEnd();
		flushProgress();
		stoppedRef.current = true;
		mpv.stop();
		navigate("/");
	}, [mpv, navigate, flushProgress, recordEnd]);

	// Closing mpv's own window stops playback, like the stop button.
	const handleStopRef = useLatestRef(handleStop);
	useEffect(() => {
		if (mpv.windowClosedId > 0) handleStopRef.current();
	}, [mpv.windowClosedId, handleStopRef]);

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

	/**
	 * Where a receiver should start the item. Until mpv reaches the start it
	 * was given, as just after a resume, that start; mpv still reports the
	 * beginning then. After that, mpv's last known position, which a
	 * reconnect doesn't reset to 0. A live channel, or an item that hasn't
	 * got going, starts where the receiver does.
	 */
	const sendFrom = (channel: Channel): number | undefined => {
		if (channel.contentType === "live") return undefined;
		const pending = progressRef.current.pendingStart;
		if (pending !== null) return pending;
		// 0 until mpv has played past the first second.
		const at = mpv.getLastKnownPosition();
		return at > 0 ? at : undefined;
	};
	/** Sends `channel` to AirPlay. Resolves to why it couldn't, if it couldn't. */
	const sendToAirPlay = async (
		channel: Channel,
		anchor: DOMRect,
		confirm: () => Promise<boolean>
	): Promise<string | null> => {
		const startAt = sendFrom(channel);
		airplayFrom.current = startAt;
		const why = await airplay.send(channel, { anchor, startAt, confirm, stopLocal });
		if (why) deviceNotice(why);
		return null;
	};
	/** Casts `channel` to `receiverId`, from where it plays here for a movie
	 *  or episode, and says why when it can't. */
	const sendToCast = (receiverId: string, channel: Channel): Promise<void> =>
		cast
			.send(receiverId, channel, {
				startAt: sendFrom(channel),
				stopLocal,
			})
			.then((why) => setNotice(afterCast(why)));
	// Each kind of receiver has its own button, and a Mac can show both:
	// AirPlay while an AirPlay TV is in reach, and Cast once it has found a
	// Cast receiver. The controls that hold them only show while no TV plays.
	const castSlot = activeChannel ? (
		<>
			{airplay.available && (
				<AirPlayButton
					onSend={(anchor, confirm) => sendToAirPlay(activeChannel, anchor, confirm)}
					warning={airplayConvertWarning(mac)}
				/>
			)}
			{showsCastButton(cast) && (
				<CastButton
					cast={cast}
					channel={activeChannel}
					onSend={(id) => sendToCast(id, activeChannel)}
				/>
			)}
		</>
	) : undefined;

	const castTv = cast.destination;
	const airplayTv = airplay.destination;
	/** Plays the item here again after a TV let it go, from `position`. */
	const playHereFrom = async (position: number, failed: (message: string) => void) => {
		// Stryker disable next-line ConditionalExpression: The view only shows after a send, which needs a channel, and nothing clears the channel while it shows.
		if (!activeChannel) return;
		await playback
			.load(
				{ kind: "local", channel: activeChannel },
				{ startAt: position > 0 ? position : undefined }
			)
			.catch(() => failed("Couldn't play it on this device."));
	};
	const shared = { touchLayout: touchDevice, skip, onFailed: reportFailure };
	const destinationView = airplayTv ? (
		<DestinationView
			{...shared}
			destination={airplayTv}
			name={airplayTv.name}
			label="AirPlay"
			icon={Airplay}
			{...episodes}
			onPlayHere={async (position, anchor) => {
				// AirPlay lets go of the stream before mpv opens it, since many
				// accounts allow one connection at a time.
				await airplay.returnHere(anchor);
				await playHereFrom(position, deviceNotice);
			}}
			// Play here opens the system picker on an iPhone. A Mac's sound never moves.
			playHereNote={
				mac
					? undefined
					: "Play here opens the AirPlay list. Choose this iPhone so the sound comes back too."
			}
			onStop={async () => {
				await airplay.stop();
				handleStop();
			}}
		/>
	) : castTv && cast.state ? (
		<DestinationView
			{...shared}
			destination={castTv}
			name={castTv.name}
			label="Google Cast"
			icon={Cast}
			failure={(message) => castFailureMessage(castTv.name, message)}
			{...episodes}
			onPlayHere={async (position) => {
				// The receiver lets go of the stream before mpv opens it, since
				// many accounts allow one connection at a time.
				await cast.stop().catch(() => {});
				await playHereFrom(position, castNotice);
			}}
			onStop={async () => {
				await cast.stop().catch(() => {});
				handleStop();
			}}
		/>
	) : remoteLink ? (
		<DestinationView
			{...shared}
			destination={remoteLink.destination}
			// The link's, which follows a rename.
			name={remoteLink.name}
			label="Cinette device"
			icon={MonitorSmartphone}
			{...episodes}
			// It stops there, and this page goes back to that device's catalog.
			onStop={() =>
				void remoteLink.destination.stop().then(
					() => navigate("/"),
					// Stryker disable next-line BooleanLiteral: Another Cinette device's failure reads the same for a seek.
					(error: unknown) => reportFailure(error, false)
				)
			}
		/>
	) : null;

	// Resumes where the stream broke, not from the start of the movie or episode.
	const retryStream = () => {
		mpv.reload().catch(() => {});
	};

	return (
		<div
			ref={containerRef}
			className={
				isFullscreen
					? "player-container fixed inset-0 z-9999 bg-transparent focus:outline-hidden"
					: "player-container relative h-full w-full bg-transparent focus:outline-hidden"
			}
			onMouseMove={touchDevice ? undefined : handleMouseMove}
			onPointerMove={touchDevice ? handlePointerMove : undefined}
			onClick={revealControls}
			onKeyDown={handleKeyDown}
			tabIndex={0}
		>
			{mpv.fallbackActive && (
				<div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-lg border border-yellow-500/40 bg-yellow-950/80 px-4 py-2 text-yellow-200 text-sm shadow-lg backdrop-blur-xs max-w-xl">
					<span>⚠</span>
					<span>
						The video can't show here, so it plays in a window of its own. Closing that
						window stops playback.
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
						<p className="text-destructive text-sm mb-2 wrap-break-word">{mpv.error}</p>
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

			{destinationView}

			{/* Over a TV's view too, which has no Back of its own. */}
			{(activeChannelName || showBack) && (showControls || tv) && (
				<div className="absolute top-0 left-0 right-0 z-40 flex items-center gap-1 bg-linear-to-b from-black/60 to-transparent p-4 pt-[calc(1rem+env(safe-area-inset-top))] pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))]">
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
					{activeChannelName && !tv && (
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

			{castConfirm && (
				<Dialog
					onClose={() => {
						castConfirm.answer(false);
						setCastConfirm(null);
					}}
					labelledBy="cast-confirm-title"
					// Above the Cast panel and the notes, inside the player.
					overlayClassName="z-50"
					className="bg-card border border-border rounded-lg p-4 w-[360px] max-w-[calc(100vw-2rem)] shadow-xl"
				>
					<h2 id="cast-confirm-title" className="text-sm font-semibold mb-3">
						Play on <bdi>{castConfirm.name}</bdi>?
					</h2>
					<p className="text-xs text-muted-foreground mb-4">
						{convertWarning(castConfirm.name, castConfirm.keep)}
					</p>
					<div className="flex justify-end gap-2">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								castConfirm.answer(false);
								setCastConfirm(null);
							}}
						>
							Cancel
						</Button>
						<Button
							size="sm"
							onClick={() => {
								castConfirm.answer(true);
								setCastConfirm(null);
							}}
						>
							Confirm
						</Button>
					</div>
				</Dialog>
			)}
			{notice && (
				<p
					role="alert"
					// Below the notch or the Dynamic Island in portrait, and no
					// wider than the screen.
					className="absolute top-[calc(1rem+env(safe-area-inset-top))] left-1/2 z-40 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded bg-black/90 px-4 py-2 text-sm text-white"
				>
					<span>{notice.text}</span>
					<button
						type="button"
						aria-label="Dismiss"
						className="text-white/70 hover:text-white"
						onClick={() => setNotice(null)}
					>
						<X className="h-4 w-4" aria-hidden />
					</button>
				</p>
			)}

			{!mpv.fallbackActive && !tv && (
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
					onPlay={playback.play}
					onPause={playback.pause}
					onStop={handleStop}
					onSeek={seekTo}
					skip={seekable ? skip : undefined}
					onSkip={(seconds) => flashOsd(formatSkip(skipBy(seconds)))}
					touchLayout={touchDevice}
					// Play, pause and skip do nothing useful while the stream opens
					// or after it fails, and the spinner or the error has the middle
					// to itself.
					hideCenterControls={mpv.opening || mpv.openFailed || mpv.loadFailed}
					// Stryker disable next-line OptionalChaining: the bar only calls this while it's on the page, inside the container, so the ref is never null.
					onHideWithFocus={remote ? () => containerRef.current?.focus() : undefined}
					onVolumeChange={playback.setVolume}
					onToggleMute={mpv.toggleMute}
					onFullscreen={fullscreenButton ? toggleFullscreen : undefined}
					onInfo={hasInfo ? () => setShowInfoDrawer(true) : undefined}
					{...episodes}
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
					castSlot={castSlot}
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
					startPick={() => followSubtitlePick(true)}
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
						mpvSetSubDelay(d).catch(() => {});
					}}
					onSettingsModeChange={(active) => setSubtitleEditMode(active)}
				/>
			)}

			{/* mpv's own window shows the subtitles itself. */}
			{!mpv.fallbackActive && (subtitleCues.length > 0 || subtitleEditMode) && (
				<SubtitleOverlay
					cues={subtitleCues}
					position={mpv.state.position}
					positionAt={mpv.state.positionAt}
					playing={videoPlaying && !mpv.buffering && !mpv.state.waiting}
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
					prefetchedOmdbData={prefetchedOmdbData}
					prefetchedWhatsonData={prefetchedWhatsonData}
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
					prefetchedOmdbData={prefetchedOmdbData}
					prefetchedWhatsonData={prefetchedWhatsonData}
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
