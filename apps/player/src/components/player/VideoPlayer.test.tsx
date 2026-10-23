// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useState,
	type ComponentProps,
	type ReactNode,
} from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
	MemoryRouter,
	Route,
	Routes,
	useLocation,
	useNavigate,
	type NavigateFunction,
} from "react-router";
import type * as Bridge from "@/lib/tauri";
import type { useMpv } from "@/hooks/useMpv";
import type { AirPlay } from "@/hooks/useAirPlay";
import type { Cast } from "@/hooks/useCast";
import type { Link } from "@/lib/remote-control";
import { createCinetteDestination, type LinkPhase } from "@/lib/cinette-destination";
import type { RemoteCommand } from "@/lib/remote-target";
import type { CastDestination } from "@/lib/cast-destination";
import type { PlaybackDestination, PlaybackState } from "@/lib/destination";
import type { MovieInfoDrawer } from "@/components/channels/MovieInfoDrawer";
import type { SeriesDetailModal } from "@/components/channels/SeriesDetailModal";
import type { LiveInfoDrawer } from "@/components/channels/LiveInfoDrawer";
import type { SubtitlePick, SubtitlePicker } from "./SubtitlePicker";
import type {
	Channel,
	DownloadRecord,
	LayoutMode,
	PlaybackPosition,
	PolledMpvState,
	Platform,
	SkipSegment,
	SubtitleSearchResult,
} from "@/lib/types";
import { FullscreenContext } from "@/lib/fullscreen-context";
import { consumeBrowseState, saveBrowseSearch } from "@/lib/browse-state";
import { writeSkipInterval, writeSkipSegmentMode } from "@/lib/player-prefs";
import { makeChannel, makeDownload } from "@/test/channel-fixtures";
import { makeEpisode, makeMovie, makeNewsChannel, makeOmdb } from "@/test/detail-fixtures";
import { deferred } from "@/test/deferred";
import { installPointerEvent } from "@/test/pointer-event";
import { makeSegment } from "@/test/segments";
import { fakeDestination, playbackCapabilities, playbackState } from "@/test/destination-fixtures";
import { getMountedPlayer } from "@/lib/remote-target";
import { saveProgressNow } from "@/lib/player-progress";
import { PlayerView } from "./VideoPlayer";

type Mpv = ReturnType<typeof useMpv>;

/** What mpv reports with nothing loaded. */
const idleState = vi.hoisted(() => (): PolledMpvState => ({
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
	positionAt: 0,
}));

const env = vi.hoisted(() => ({
	channels: [] as Channel[],
	downloads: [] as DownloadRecord[],
	layoutMode: "desktop" as LayoutMode,
	os: "macos" as Platform,
}));

/** The last subtitle pick the picker started for a download. */
const picker = vi.hoisted(() => ({ pick: undefined as SubtitlePick | undefined }));

const tauri = vi.hoisted(() => ({
	mpvSetBounds: vi.fn<typeof Bridge.mpvSetBounds>(async () => {}),
	warmStreamFormats: vi.fn<typeof Bridge.warmStreamFormats>(async () => {}),
	mpvSetMediaInfo: vi.fn<typeof Bridge.mpvSetMediaInfo>(async () => {}),
	mpvGetState: vi.fn<typeof Bridge.mpvGetState>(async () => idleState()),
	mpvSubAdd: vi.fn<typeof Bridge.mpvSubAdd>(async () => {}),
	mpvSubRemove: vi.fn<typeof Bridge.mpvSubRemove>(async () => {}),
	mpvSetSubDelay: vi.fn<typeof Bridge.mpvSetSubDelay>(async () => {}),
	recordPlayStart: vi.fn<typeof Bridge.recordPlayStart>(async () => {}),
	recordPlayEnd: vi.fn<typeof Bridge.recordPlayEnd>(async () => {}),
	fetchOmdbData: vi.fn<typeof Bridge.fetchOmdbData>(async () => null),
	fetchWhatsonData: vi.fn<typeof Bridge.fetchWhatsonData>(async () => null),
	searchSubtitles: vi.fn<typeof Bridge.searchSubtitles>(async () => null),
	downloadSubtitle: vi.fn<typeof Bridge.downloadSubtitle>(async () => "/subtitles/chosen.srt"),
	readSubtitleFile: vi.fn<typeof Bridge.readSubtitleFile>(async () => ""),
	getPlaybackPosition: vi.fn<typeof Bridge.getPlaybackPosition>(async () => null),
	savePlaybackPosition: vi.fn<typeof Bridge.savePlaybackPosition>(async () => {}),
	deletePlaybackPosition: vi.fn<typeof Bridge.deletePlaybackPosition>(async () => {}),
	markPositionFinished: vi.fn<typeof Bridge.markPositionFinished>(async () => {}),
	handOffProgress: vi.fn<typeof Bridge.handOffProgress>(async () => {}),
	resolveLocalDownload: vi.fn<typeof Bridge.resolveLocalDownload>(async () => null),
	enqueueMovieDownload: vi.fn<typeof Bridge.enqueueMovieDownload>(async () => "dl-new"),
	enqueueEpisodeDownload: vi.fn<typeof Bridge.enqueueEpisodeDownload>(async () => "dl-new"),
	stopDownload: vi.fn<typeof Bridge.stopDownload>(async () => {}),
	removeDownload: vi.fn<typeof Bridge.removeDownload>(async () => {}),
	getSkipSegments: vi.fn<typeof Bridge.getSkipSegments>(async () => []),
	// No device controls this one in these tests.
	remoteSessions: vi.fn<typeof Bridge.remoteSessions>(async () => []),
	remoteSetState: vi.fn<typeof Bridge.remoteSetState>(async () => {}),
}));

/**
 * A mock function handles the promises it returns, so a rejection the player
 * doesn't catch would go unnoticed. This sends each call through a promise of
 * its own, and Vitest fails the run on one that's left unhandled.
 */
const ownPromise = vi.hoisted(
	() =>
		<A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
		(...args: A): Promise<R> =>
			fn(...args).then((v) => v)
);

/**
 * Stands in for useMpv. Tests set what mpv reports, as its polls would, and
 * check what the player asked it to do.
 */
const fakeMpv = vi.hoisted(() => {
	const actions = {
		load: vi.fn<Mpv["load"]>(async () => {}),
		reload: vi.fn<Mpv["reload"]>(async () => true),
		getLastKnownPosition: vi.fn<Mpv["getLastKnownPosition"]>(() => 0),
		play: vi.fn<Mpv["play"]>(async () => {}),
		pause: vi.fn<Mpv["pause"]>(async () => {}),
		stop: vi.fn<Mpv["stop"]>(async () => {}),
		seek: vi.fn<Mpv["seek"]>(async () => {}),
		setVolume: vi.fn<Mpv["setVolume"]>(async () => {}),
		toggleMute: vi.fn<Mpv["toggleMute"]>(async () => {}),
		refresh: vi.fn<Mpv["refresh"]>(async () => {}),
	};
	const { getLastKnownPosition, ...asyncActions } = actions;
	const player = {
		getLastKnownPosition,
		...(Object.fromEntries(
			Object.entries(asyncActions).map(([name, fn]) => [
				name,
				ownPromise(fn as (...a: unknown[]) => Promise<unknown>),
			])
		) as typeof asyncActions),
	};
	const initial = (): Mpv => ({
		state: idleState(),
		error: null,
		fallbackActive: false,
		firstFrameReady: false,
		opening: false,
		loadId: 0,
		reconnecting: false,
		reconnectAttempt: 0,
		buffering: false,
		loadFailed: false,
		openFailed: false,
		recentlyRecovered: false,
		windowClosedId: 0,
		...player,
	});
	let current = initial();
	const listeners = new Set<() => void>();
	return {
		actions,
		get: () => current,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		reset: () => {
			current = initial();
		},
		set: (patch: Partial<Omit<Mpv, "state">> & { state?: Partial<PolledMpvState> }) => {
			current = {
				...current,
				...patch,
				// Each state is a new reading of mpv's position, as useMpv's poll is.
				state: patch.state
					? { ...current.state, positionAt: performance.now(), ...patch.state }
					: current.state,
			};
			listeners.forEach((listener) => listener());
		},
	};
});

vi.mock("@/lib/tauri", () =>
	Object.fromEntries(
		Object.entries(tauri).map(([name, fn]) => [
			name,
			ownPromise(fn as (...a: unknown[]) => Promise<unknown>),
		])
	)
);

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => env.os }));

vi.mock("@/hooks/usePlatform", () => ({
	usePlatform: () => ({ platform: env.os, layoutMode: env.layoutMode }),
}));

vi.mock("@/hooks/useChannels", () => ({ useChannels: () => ({ channels: env.channels }) }));

vi.mock("@/hooks/useDownloads", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/hooks/useDownloads")>();
	return {
		...actual,
		useDownloads: () => ({
			downloads: env.downloads,
			...actual.groupDownloads(env.downloads),
		}),
	};
});

/** The hooks' state is their destination's, so a test that sets one
 *  sets both. */
const mirror = vi.hoisted(
	() =>
		({ destination, state }: { destination: unknown; state: PlaybackState | null }) => {
			const getState = (destination as { getState?: unknown } | null)?.getState;
			if (state && vi.isMockFunction(getState)) getState.mockReturnValue(state);
		}
);

/** Stands in for useAirPlay, which has tests of its own. */
const fakeAirPlay = vi.hoisted(() => {
	const initial = (): AirPlay => ({
		available: false,
		destination: null,
		state: null,
		send: vi.fn<AirPlay["send"]>(async () => ({ sent: true })),
		stop: vi.fn<AirPlay["stop"]>(async () => {}),
		returnHere: vi.fn<AirPlay["returnHere"]>(async () => {}),
		notPicked: false,
	});
	let current = initial();
	const listeners = new Set<() => void>();
	return {
		enabled: [] as boolean[],
		macs: [] as boolean[],
		get: () => current,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		reset: () => {
			current = initial();
		},
		set: (patch: Partial<AirPlay>) => {
			current = { ...current, ...patch };
			mirror(current);
			listeners.forEach((listener) => listener());
		},
	};
});

vi.mock("@/hooks/useAirPlay", async () => {
	const { useSyncExternalStore } = await import("react");
	return {
		useAirPlay: (enabled: boolean, mac = false) => {
			fakeAirPlay.enabled.push(enabled);
			fakeAirPlay.macs.push(mac);
			return useSyncExternalStore(fakeAirPlay.subscribe, fakeAirPlay.get);
		},
	};
});

/** Stands in for useCast, which has tests of its own. */
const fakeCast = vi.hoisted(() => {
	const initial = (): Cast => ({
		receivers: [],
		localNetworkDenied: false,
		statuses: new Map(),
		check: vi.fn(),
		release: vi.fn(),
		destination: null,
		current: () => current.destination,
		state: null,
		send: vi.fn<Cast["send"]>(async () => null),
		// As the hook does, a stop ends the cast at once.
		stop: vi.fn<Cast["stop"]>(async () => {
			current = { ...current, destination: null, state: null };
			listeners.forEach((listener) => listener());
		}),
		vpnActive: false,
	});
	let current = initial();
	const listeners = new Set<() => void>();
	return {
		enabled: [] as boolean[],
		/** What the player gave the hook to say why a cast ended. */
		report: (() => {}) as (message: string) => void,
		get: () => current,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		reset: () => {
			current = initial();
		},
		set: (patch: Partial<Cast>) => {
			current = { ...current, ...patch };
			mirror(current);
			listeners.forEach((listener) => listener());
		},
	};
});

vi.mock("@/hooks/useCast", async () => {
	const { useSyncExternalStore } = await import("react");
	return {
		useCast: (enabled: boolean, report: (message: string) => void) => {
			fakeCast.enabled.push(enabled);
			fakeCast.report = report;
			return useSyncExternalStore(fakeCast.subscribe, fakeCast.get);
		},
	};
});

/** Stands in for useRemoteControl, which has tests of its own: the link
 *  to the other Cinette device this one controls, if any. */
const fakeRemote = vi.hoisted(() => {
	let link: Link | null = null;
	const listeners = new Set<() => void>();
	return {
		get: () => link,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		set: (next: Link | null) => {
			link = next;
			listeners.forEach((listener) => listener());
		},
	};
});

vi.mock("@/hooks/useRemoteControl", async () => {
	const { useSyncExternalStore } = await import("react");
	return {
		useRemoteControl: () => ({
			link: useSyncExternalStore(fakeRemote.subscribe, fakeRemote.get),
		}),
	};
});

vi.mock("@/hooks/useMpv", async () => {
	const { useSyncExternalStore } = await import("react");
	return { useMpv: () => useSyncExternalStore(fakeMpv.subscribe, fakeMpv.get) };
});

/** The destination the player last handed its controls. */
const local = vi.hoisted(() => ({ destination: null as PlaybackDestination | null }));

// The real hook, keeping the destination so a test can drive it the way
// another device's controls will.
vi.mock("@/hooks/useLocalPlayback", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/hooks/useLocalPlayback")>();
	const { useEffect } = await import("react");
	return {
		...actual,
		useLocalPlayback: (...args: Parameters<typeof actual.useLocalPlayback>) => {
			const destination = actual.useLocalPlayback(...args);
			useEffect(() => {
				local.destination = destination;
			}, [destination]);
			return destination;
		},
	};
});

// The picker and the drawers have tests of their own. These stand-ins show
// what the player passed them and call back the way they would.
vi.mock("./SubtitlePicker", () => ({
	SubtitlePicker: (props: ComponentProps<typeof SubtitlePicker>) => (
		<div role="dialog" aria-label="Subtitle picker">
			<p>
				Looking up {props.imdbId} season {props.season ?? "none"} episode{" "}
				{props.episode ?? "none"}
			</p>
			<input aria-label="Search subtitles" />
			<p>Current subtitle {props.currentSelectedEntry?.fileId ?? "none"}</p>
			<button
				type="button"
				onClick={() => {
					props.startPick();
					props.onSubtitleSelected?.(
						101,
						[{ start: 1, end: 4, text: "Mind the lantern" }],
						{ fileId: 101, languageCode: "en", format: "srt" },
						1
					);
				}}
			>
				Pick English
			</button>
			<button
				type="button"
				onClick={() => {
					props.startPick();
					props.onSubtitleSelected?.(null);
				}}
			>
				Pick none
			</button>
			<button
				type="button"
				onClick={() => {
					picker.pick = props.startPick();
				}}
			>
				Start a download
			</button>
			<button type="button" onClick={() => props.onDelayChange?.(1.5)}>
				Delay subtitles
			</button>
			<button type="button" onClick={() => props.onFontSizeChange?.(26)}>
				Bigger subtitles
			</button>
			<button type="button" onClick={() => props.onFontFamilyChange?.("Georgia, serif")}>
				Serif subtitles
			</button>
			<button type="button" onClick={() => props.onSettingsModeChange?.(true)}>
				Adjust subtitles
			</button>
			<button type="button" onClick={props.onClose}>
				Close subtitles
			</button>
		</div>
	),
}));

vi.mock("@/components/channels/MovieInfoDrawer", () => ({
	MovieInfoDrawer: (props: ComponentProps<typeof MovieInfoDrawer>) => (
		<div role="dialog" aria-label={`About ${props.movie.name}`}>
			<p>
				Details {props.prefetchedOmdbData?.imdbId ?? "none"}, guide{" "}
				{props.prefetchedWhatsonData ? "found" : "none"}
			</p>
			<button type="button" onClick={() => props.onPlay({ ...props.movie, url: MIRROR_URL })}>
				Play the second source
			</button>
			<button type="button" onClick={() => props.onPlay(harborLights())}>
				Play another movie
			</button>
			<button type="button" onClick={props.onClose}>
				Close details
			</button>
		</div>
	),
}));

vi.mock("@/components/channels/SeriesDetailModal", () => ({
	SeriesDetailModal: (props: ComponentProps<typeof SeriesDetailModal>) => (
		<div role="dialog" aria-label={`Episodes of ${props.showTitle}`}>
			<p>Series card {props.seriesChannelId}</p>
			{props.episodes.map((ep) => (
				<button key={ep.id} type="button" onClick={() => props.onPlay(ep)}>
					Play {ep.id}
				</button>
			))}
			<button type="button" onClick={props.onClose}>
				Close episodes
			</button>
		</div>
	),
}));

vi.mock("@/components/channels/LiveInfoDrawer", () => ({
	LiveInfoDrawer: (props: ComponentProps<typeof LiveInfoDrawer>) => (
		<div role="dialog" aria-label={`About ${props.channel.name}`}>
			<button type="button" onClick={props.onClose}>
				Close details
			</button>
		</div>
	),
}));

const MOVIE_URL = "https://cdn.example.test/movies/lantern-keeper.mkv";
const MIRROR_URL = "http://mirror.example.test/movies/lantern-keeper.mkv";
const MOVIE_KEY = "movie:the lantern keeper";
const DOWNLOADED_MOVIE = "/downloads/lantern-keeper.mkv";
const NEWS_URL = "http://live.example.test/news24.ts";

/** The movie most tests play. It has a second source on a mirror. */
const lanternKeeper = (overrides: Partial<Channel> = {}): Channel =>
	makeMovie({ name: "The Lantern Keeper", url: MOVIE_URL, sources: [MIRROR_URL], ...overrides });

/** Another movie, opened while the first one plays. */
const harborLights = (): Channel =>
	makeMovie({
		id: "mv2",
		name: "Harbor Lights",
		url: "https://cdn.example.test/movies/harbor-lights.mkv",
	});

/** OMDb details for The Lantern Keeper. */
const lanternOmdb = () =>
	makeOmdb({
		title: "The Lantern Keeper",
		director: "Ada Marsh",
		actors: "Tom Reed, Lena Vale",
		plot: "A keeper guards the last light on a stormy coast.",
		posterUrl: "https://img.example.test/lantern-keeper.jpg",
		imdbId: "tt9000001",
		runtime: "98 min",
	});

/** OMDb details for the series the episodes belong to. */
const showOmdb = () =>
	makeOmdb({
		title: "Show",
		director: "Ivy Stone",
		actors: "Sam Hale, Rita Moss",
		plot: "Neighbors share a lighthouse.",
		posterUrl: "https://img.example.test/show.jpg",
		imdbId: "tt9000002",
		runtime: "22 min",
	});

const ep1 = makeEpisode(1, 1, "Pilot");
const ep2 = makeEpisode(1, 2, "Second");
const ep3 = makeEpisode(1, 3, "Third");
/** The first episode again, from another provider. */
const ep1Mirror = makeEpisode(1, 1, "Pilot", {
	id: "s1e1-b",
	url: "http://mirror.example.test/show/s1e1.mkv",
});
/** The series card in the channel list. Its id groups the episodes' downloads. */
const seriesCard = makeChannel({
	id: "series-show",
	name: "Show",
	contentType: "series",
	seriesTitle: "Show",
});

/** A resume point as the backend returns it. */
const saved = (
	contentKey: string,
	positionSeconds: number,
	durationSeconds: number
): PlaybackPosition => ({ contentKey, positionSeconds, durationSeconds, updatedAt: 0 });

/** Makes the backend remember these resume points and no others. */
const remember = (...points: PlaybackPosition[]) =>
	tauri.getPlaybackPosition.mockImplementation(
		async (key) => points.find((p) => p.contentKey === key) ?? null
	);

/** What mpv reports while `url` plays. */
const playing = (currentUrl: string, position: number, duration: number) => ({
	currentUrl,
	position,
	duration,
	isPlaying: true,
	isPaused: false,
	reachedEnd: false,
});

/** What mpv reports once `url` is paused before its end. */
const paused = (currentUrl: string, position: number, duration: number) => ({
	currentUrl,
	position,
	duration,
	isPlaying: false,
	isPaused: true,
	reachedEnd: false,
});

/** What mpv reports once `url` plays to its end and holds the last frame. */
const ended = (currentUrl: string, duration: number) => ({
	...paused(currentUrl, duration, duration),
	reachedEnd: true,
});

/** The addresses mpv was asked to play, in order. */
const loadedUrls = () => fakeMpv.actions.load.mock.calls.map(([url]) => url);

/** Records each time the player turns full screen on or off. */
const fullscreenSpy = vi.fn<(on: boolean) => void>();

/** Full screen state the way the app holds it, with every change recorded. */
const FullscreenHarness = ({ initial, children }: { initial: boolean; children: ReactNode }) => {
	const [isFullscreen, setIsFullscreen] = useState(initial);
	const setFullscreen = useCallback((on: boolean) => {
		fullscreenSpy(on);
		setIsFullscreen(on);
	}, []);
	const value = useMemo(() => ({ isFullscreen, setFullscreen }), [isFullscreen, setFullscreen]);
	return <FullscreenContext.Provider value={value}>{children}</FullscreenContext.Provider>;
};

/** Lets a test move around the app the way its links do. */
const nav: { current: NavigateFunction | null } = { current: null };

/** Hands the router's navigate function to `nav`. */
const NavHandle = () => {
	const navigate = useNavigate();
	useEffect(() => {
		nav.current = navigate;
	}, [navigate]);
	return null;
};

/**
 * Runs in the commit that opens another page, after that page's layout
 * effects and before its passive ones.
 */
const pageOpens: { run: (() => void) | null } = { run: null };

/** Runs `pageOpens.run` each time another page opens. */
const PageOpens = () => {
	const { pathname } = useLocation();
	useLayoutEffect(() => pageOpens.run?.(), [pathname]);
	return null;
};

type NavState = {
	url?: string;
	channelName?: string;
	channel?: Channel;
	seriesEpisodes?: Channel[];
} | null;

interface RenderOptions {
	/** The page the player was opened from, or null when it was the first page. */
	from?: string | null;
	fullscreen?: boolean;
}

/** Opens the player page with `state`, as a link from another page would. */
const renderPlayer = (state: NavState, { from = "/", fullscreen = false }: RenderOptions = {}) => {
	const player = { pathname: "/player", state };
	const entries = from === null ? [player] : [from, player];
	return render(
		<FullscreenHarness initial={fullscreen}>
			<MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
				<NavHandle />
				<Routes>
					<Route path="/" element={<p>Channel list</p>} />
					<Route path="/playlists" element={<p>Playlists</p>} />
					<Route path="/player" element={<PlayerView />} />
				</Routes>
				<PageOpens />
			</MemoryRouter>
		</FullscreenHarness>
	);
};

/** Lets pending lookups and loads settle. */
const flush = () =>
	act(async () => {
		for (let i = 0; i < 30; i++) await Promise.resolve();
	});

/** Opens `channel` in the player from the channel list and waits for it to start. */
const openItem = async (
	channel: Channel,
	{ episodes, url, ...options }: RenderOptions & { episodes?: Channel[]; url?: string } = {}
) => {
	const view = renderPlayer(
		{ url: url ?? channel.url, channel, seriesEpisodes: episodes },
		options
	);
	await flush();
	return view;
};

/** Opens something else while the player is already showing. */
const goTo = async (state: NavState) => {
	act(() => {
		void nav.current?.("/player", { state });
	});
	await flush();
};

/** Leaves the player for another page of the app. */
const goToPage = async (path: string) => {
	act(() => {
		void nav.current?.(path);
	});
	await flush();
};

/** Presses a key wherever focus is. Returns false when the page claimed the key. */
const press = async (key: string, init: KeyboardEventInit = {}) => {
	const unclaimed = fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
	await flush();
	return unclaimed;
};

/** Reports a new mpv state, as the next poll would. */
const setMpv = (patch: Parameters<typeof fakeMpv.set>[0]) =>
	act(async () => {
		fakeMpv.set(patch);
	});

/** Sets how many touch points the screen reports. */
const setTouchPoints = (points: number) =>
	Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: points });

/** Sets up an iPad or a phone, which has a touch screen. */
const setUpTouchScreen = (layoutMode: LayoutMode = "tablet") => {
	env.os = "ios";
	env.layoutMode = layoutMode;
	setTouchPoints(5);
};

/** Hides or shows the page, as switching apps or locking the phone does. */
const setVisibility = (state: DocumentVisibilityState) =>
	act(() => {
		Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
		document.dispatchEvent(new Event("visibilitychange"));
	});

/** The player itself, which takes the keyboard and the mouse. */
const playerArea = () => document.querySelector(".player-container") as HTMLElement;

/** The layer over the video that takes taps on a touch screen. */
const tapLayer = () => document.querySelector(".touch-manipulation") as HTMLElement;

/** The bar along the bottom with the playback buttons. */
const controlBar = () =>
	screen.getByRole("button", { name: "Stop" }).closest(".transition-opacity");

/** The positioned box around a subtitle line. */
const subtitleBox = (text: string) =>
	screen.getByText(text).parentElement?.parentElement as HTMLElement;

/** A layout box `width` by `height` at the left edge, `top` down the window. */
const box = (width: number, height: number, top = 0): DOMRect => ({
	x: 0,
	y: top,
	width,
	height,
	top,
	left: 0,
	right: width,
	bottom: top + height,
	toJSON: () => ({}),
});

/** A finger tap on the video at `clientX`. */
const tap = (clientX = 0) => {
	fireEvent.pointerDown(tapLayer(), { clientX, clientY: 300, pointerType: "touch" });
	fireEvent.pointerUp(tapLayer(), { clientX, clientY: 300, pointerType: "touch" });
};

/** The resume prompt, if it shows. */
const resumePrompt = () => screen.queryByRole("dialog", { name: "Resume watching?" });

/** The keyboard shortcut list, if it shows. */
const shortcutList = () => screen.queryByRole("dialog", { name: "Keyboard shortcuts" });

/** Opens the source menu and plays source `n`, counting from 1. */
const pickSource = (n: number) => {
	fireEvent.click(screen.getByRole("button", { name: "Source" }));
	fireEvent.click(screen.getByRole("menuitemradio", { name: new RegExp(`^Source ${n}`) }));
};

/** Opens the subtitle picker and picks the English subtitles it offers. */
const pickEnglishSubtitles = () => {
	fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
	fireEvent.click(screen.getByRole("button", { name: "Pick English" }));
};

installPointerEvent();

beforeEach(() => {
	vi.resetAllMocks();
	localStorage.clear();
	sessionStorage.clear();
	fakeMpv.reset();
	fakeAirPlay.reset();
	fakeCast.reset();
	fakeRemote.set(null);
	fakeAirPlay.enabled = [];
	fakeAirPlay.macs = [];
	env.channels = [];
	env.downloads = [];
	env.layoutMode = "desktop";
	env.os = "macos";
	nav.current = null;
	pageOpens.run = null;
	local.destination = null;
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	Reflect.deleteProperty(navigator, "maxTouchPoints");
	Reflect.deleteProperty(document, "visibilityState");
});

describe("opening something to watch", () => {
	it("starts a live channel from the beginning without looking up a resume point or details", async () => {
		await openItem(makeNewsChannel());
		expect(fakeMpv.actions.load).toHaveBeenCalledWith(NEWS_URL, undefined);
		expect(tauri.getPlaybackPosition).not.toHaveBeenCalled();
		expect(tauri.fetchOmdbData).not.toHaveBeenCalled();
		expect(tauri.recordPlayStart).toHaveBeenCalledWith("ch1", "News 24", null, "live");
		expect(screen.getByText("News 24")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Download" })).not.toBeInTheDocument();
	});

	it("plays a finished download instead of the stream and saves progress under the movie", async () => {
		tauri.resolveLocalDownload.mockResolvedValue(DOWNLOADED_MOVIE);
		await openItem(lanternKeeper());
		expect(tauri.resolveLocalDownload).toHaveBeenCalledWith("mv1");
		expect(loadedUrls()).toEqual([DOWNLOADED_MOVIE]);
		await setMpv({ state: paused(DOWNLOADED_MOVIE, 700, 3600) });
		expect(tauri.savePlaybackPosition).toHaveBeenCalledWith(MOVIE_KEY, 700, 3600);
	});

	it("plays the stream when looking for a download fails", async () => {
		tauri.resolveLocalDownload.mockRejectedValue(new Error("database locked"));
		await openItem(lanternKeeper());
		expect(fakeMpv.actions.load).toHaveBeenCalledWith(MOVIE_URL, undefined);
	});

	it("plays the source picked in the channel list and marks it in the source menu", async () => {
		await openItem(lanternKeeper(), { url: MIRROR_URL });
		expect(loadedUrls()).toEqual([MIRROR_URL]);
		fireEvent.click(screen.getByRole("button", { name: "Source" }));
		expect(screen.getByRole("menuitemradio", { name: /^Source 2/ })).toHaveAttribute(
			"aria-checked",
			"true"
		);
		expect(screen.getByRole("menuitemradio", { name: /^Source 1/ })).toHaveAttribute(
			"aria-checked",
			"false"
		);
	});

	it("plays a bare stream address under the name it came with", async () => {
		const radio = "http://live.example.test/harbor-radio.ts";
		renderPlayer({ url: radio, channelName: "Harbor Radio" });
		await flush();
		expect(fakeMpv.actions.load.mock.calls).toEqual([[radio]]);
		expect(screen.getByText("Harbor Radio")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Channel info" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Download" })).not.toBeInTheDocument();
		expect(tauri.recordPlayStart).not.toHaveBeenCalled();
	});

	it("picks up the movie still playing when the player is opened again from the sidebar", async () => {
		sessionStorage.setItem("mvp_lastChannel", JSON.stringify(lanternKeeper()));
		sessionStorage.setItem("mvp_lastLoadedUrl", MOVIE_URL);
		renderPlayer(null);
		await flush();
		expect(screen.getByText("The Lantern Keeper")).toBeInTheDocument();
		expect(fakeMpv.actions.load).not.toHaveBeenCalled();
		await setMpv({ state: paused(MOVIE_URL, 1500, 3600) });
		expect(tauri.savePlaybackPosition).toHaveBeenCalledWith(MOVIE_KEY, 1500, 3600);
	});

	it("keeps the episode list when the player is opened again from the sidebar", async () => {
		sessionStorage.setItem("mvp_lastChannel", JSON.stringify(ep1));
		sessionStorage.setItem("mvp_lastSeriesEpisodes", JSON.stringify([ep1, ep2]));
		renderPlayer(null);
		await flush();
		fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
		await flush();
		expect(fakeMpv.actions.load).toHaveBeenCalledWith(ep2.url, undefined);
	});

	it("shows the empty player when what it remembers can't be read", async () => {
		sessionStorage.setItem("mvp_lastChannel", "{not json");
		sessionStorage.setItem("mvp_lastSeriesEpisodes", "[not json");
		renderPlayer(null);
		await flush();
		expect(screen.getByText("Select a channel to start watching")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Next episode" })).not.toBeInTheDocument();
	});

	it("saves how far the last movie got while it played in the background", async () => {
		sessionStorage.setItem("mvp_lastChannel", JSON.stringify(lanternKeeper()));
		sessionStorage.setItem("mvp_lastLoadedUrl", MOVIE_URL);
		tauri.mpvGetState.mockResolvedValue({
			...idleState(),
			...playing(MOVIE_URL, 1234, 3600),
		});
		await openItem(harborLights());
		expect(tauri.savePlaybackPosition).toHaveBeenCalledWith(MOVIE_KEY, 1234, 3600);
		expect(tauri.getPlaybackPosition).toHaveBeenCalledWith("movie:harbor lights");
		expect(loadedUrls()).toEqual([harborLights().url]);
	});

	it("doesn't save a background position that belongs to another stream", async () => {
		sessionStorage.setItem("mvp_lastChannel", JSON.stringify(lanternKeeper()));
		tauri.mpvGetState.mockResolvedValue({
			...idleState(),
			...playing("http://elsewhere.example.test/other.mkv", 1234, 3600),
		});
		await openItem(harborLights());
		expect(tauri.savePlaybackPosition).not.toHaveBeenCalled();
		expect(loadedUrls()).toEqual([harborLights().url]);
	});

	it("still opens the new movie when mpv can't say what it plays", async () => {
		sessionStorage.setItem("mvp_lastChannel", JSON.stringify(lanternKeeper()));
		tauri.mpvGetState.mockRejectedValue(new Error("mpv is not running"));
		await openItem(harborLights());
		expect(loadedUrls()).toEqual([harborLights().url]);
	});

	it("doesn't start a movie when the player page closed while its resume point was looked up", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 900, 3600) });
		await goToPage("/");
		const lookup = deferred<PlaybackPosition | null>();
		tauri.getPlaybackPosition.mockReturnValue(lookup.promise);
		await goTo({ url: harborLights().url, channel: harborLights() });
		await goToPage("/");
		await act(async () => lookup.resolve(null));
		await flush();
		expect(loadedUrls()).toEqual([MOVIE_URL]);
		expect(tauri.recordPlayStart).toHaveBeenCalledTimes(1);

		await goToPage("/player");
		expect(screen.getByText("The Lantern Keeper")).toBeInTheDocument();
	});

	it("doesn't start a channel when the player page closed while it checked what played", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 900, 3600) });
		await goToPage("/");
		const polled = deferred<PolledMpvState>();
		tauri.mpvGetState.mockReturnValue(polled.promise);
		await goTo({ url: NEWS_URL, channel: makeNewsChannel() });
		await goToPage("/");
		await act(async () => polled.resolve({ ...idleState(), ...playing(MOVIE_URL, 905, 3600) }));
		await flush();
		expect(loadedUrls()).toEqual([MOVIE_URL]);

		await goToPage("/player");
		expect(screen.getByText("The Lantern Keeper")).toBeInTheDocument();
	});

	it("has the app save what plays when the player page closed while it checked what played", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 900, 3600) });
		await goToPage("/");
		const polled = deferred<PolledMpvState>();
		tauri.mpvGetState.mockReturnValue(polled.promise);
		await goTo({ url: NEWS_URL, channel: makeNewsChannel() });
		await goToPage("/");
		expect(tauri.handOffProgress).toHaveBeenLastCalledWith(null);
		await act(async () => polled.resolve({ ...idleState(), ...playing(MOVIE_URL, 905, 3600) }));
		await flush();
		expect(tauri.handOffProgress).toHaveBeenLastCalledWith({
			key: MOVIE_KEY,
			url: MOVIE_URL,
			pendingStart: null,
		});
	});

	it("keeps the episode list of what plays when the page closed before another episode started", async () => {
		await openItem(ep1, { episodes: [ep1, ep2] });
		await setMpv({ state: playing(ep1.url, 300, 1300) });
		await goToPage("/");
		const lookup = deferred<PlaybackPosition | null>();
		tauri.getPlaybackPosition.mockReturnValue(lookup.promise);
		await goTo({ url: ep3.url, channel: ep3, seriesEpisodes: [ep3] });
		await goToPage("/");
		await act(async () => lookup.resolve(null));
		await flush();

		await goToPage("/player");
		expect(screen.getByText("Show S01E01 Pilot")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
		await flush();
		expect(loadedUrls()).toEqual([ep1.url, ep2.url]);
	});

	it("keeps a place exactly at the shortest one worth resuming", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: paused(MOVIE_URL, 30, 3600) });
		expect(tauri.savePlaybackPosition).toHaveBeenCalledWith(MOVIE_KEY, 30, 3600);
		expect(tauri.deletePlaybackPosition).not.toHaveBeenCalled();
	});

	it("saves its place for a history transfer and says what it has open", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 900, 3600) });
		tauri.savePlaybackPosition.mockClear();
		await expect(saveProgressNow()).resolves.toBe("mv1");
		expect(tauri.savePlaybackPosition).toHaveBeenCalledWith(MOVIE_KEY, 900, 3600);
	});

	it("opening another movie from inside the player saves the first and records its end", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 900, 3600) });
		await goTo({ url: harborLights().url, channel: harborLights() });
		expect(tauri.savePlaybackPosition).toHaveBeenCalledWith(MOVIE_KEY, 900, 3600);
		expect(tauri.recordPlayEnd).toHaveBeenCalledWith("mv1", expect.any(Number));
		expect(loadedUrls()).toEqual([MOVIE_URL, harborLights().url]);
		expect(screen.getByText("Harbor Lights")).toBeInTheDocument();
	});

	it("starts from the beginning when the resume point can't be read", async () => {
		tauri.getPlaybackPosition.mockRejectedValue(new Error("database locked"));
		await openItem(lanternKeeper());
		expect(resumePrompt()).not.toBeInTheDocument();
		expect(fakeMpv.actions.load).toHaveBeenCalledWith(MOVIE_URL, undefined);
	});

	it("shows a spinner while the stream opens and offers to try again when it takes too long", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await openItem(lanternKeeper());
		await setMpv({ opening: true, loadId: 1 });
		expect(screen.getByText("Opening stream")).toBeInTheDocument();
		expect(screen.queryByText("Select a channel to start watching")).not.toBeInTheDocument();
		act(() => vi.advanceTimersByTime(15_000));
		expect(screen.getByText("Some servers take a while to respond.")).toBeInTheDocument();
		act(() => vi.advanceTimersByTime(30_000));
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(fakeMpv.actions.reload).toHaveBeenCalledTimes(1);
	});

	it("asks for a channel while nothing plays", async () => {
		renderPlayer(null);
		await flush();
		expect(screen.getByText("Select a channel to start watching")).toBeInTheDocument();
		await setMpv({ state: playing(NEWS_URL, 5, 0) });
		expect(screen.queryByText("Select a channel to start watching")).not.toBeInTheDocument();
	});

	it("keeps the page black until the first frame shows, then lets the video through", async () => {
		const { unmount } = renderPlayer(null);
		expect(document.body.style.backgroundColor).toBe("black");
		expect(document.documentElement.style.backgroundColor).toBe("black");
		await setMpv({ firstFrameReady: true });
		expect(document.body.style.backgroundColor).toBe("transparent");
		unmount();
		expect(document.body.style.backgroundColor).toBe("");
		expect(document.documentElement.style.backgroundColor).toBe("");
	});

	it("tells the renderer where the video sits, and again when a stream loads", async () => {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(box(800, 450, 40));
		renderPlayer(null);
		await flush();
		expect(tauri.mpvSetBounds.mock.calls).toEqual([[0, 40, 800, 450]]);
		await setMpv({ state: playing(NEWS_URL, 5, 0) });
		expect(tauri.mpvSetBounds).toHaveBeenCalledTimes(2);
	});

	it("shows the movie without details when the details lookup fails", async () => {
		tauri.fetchOmdbData.mockRejectedValue(new Error("no OMDb key"));
		await openItem(lanternKeeper());
		expect(tauri.fetchOmdbData).toHaveBeenCalledWith("mv1", "The Lantern Keeper", "movie");
		fireEvent.click(screen.getByRole("button", { name: "Channel info" }));
		expect(screen.getByText("Details none, guide none")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Subtitles" })).not.toBeInTheDocument();
	});

	it("drops details that arrive after the viewer moved on to another movie", async () => {
		const late = deferred<ReturnType<typeof lanternOmdb> | null>();
		tauri.fetchOmdbData.mockImplementation((id) =>
			id === "mv1" ? late.promise : Promise.resolve(null)
		);
		await openItem(lanternKeeper());
		await goTo({ url: harborLights().url, channel: harborLights() });
		await act(async () => late.resolve(lanternOmdb()));
		expect(tauri.fetchWhatsonData).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: "Subtitles" })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Channel info" }));
		expect(screen.getByText("Details none, guide none")).toBeInTheDocument();
	});

	it("drops guide details that arrive after the viewer moved on to another movie", async () => {
		const late = deferred<{ imdbId: string; tagline: string } | null>();
		tauri.fetchOmdbData.mockImplementation(async (id) => (id === "mv1" ? lanternOmdb() : null));
		tauri.fetchWhatsonData.mockReturnValue(late.promise);
		await openItem(lanternKeeper());
		expect(tauri.fetchWhatsonData).toHaveBeenCalledWith("tt9000001", "movie");
		await goTo({ url: harborLights().url, channel: harborLights() });
		await act(async () =>
			late.resolve({ imdbId: "tt9000001", tagline: "Keep the light burning." })
		);
		fireEvent.click(screen.getByRole("button", { name: "Channel info" }));
		expect(screen.getByText("Details none, guide none")).toBeInTheDocument();
	});
});

describe("resuming", () => {
	it("offers to resume a movie stopped part way and resumes where it stopped", async () => {
		remember(saved(MOVIE_KEY, 1800, 3600));
		await openItem(lanternKeeper());
		expect(resumePrompt()).toBeInTheDocument();
		expect(fakeMpv.actions.load).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Resume from 30:00" }));
		await flush();
		expect(resumePrompt()).not.toBeInTheDocument();
		expect(fakeMpv.actions.load).toHaveBeenCalledWith(MOVIE_URL, 1800);
		// mpv reports the start of the file before the seek lands.
		await setMpv({ state: paused(MOVIE_URL, 2, 3600) });
		expect(tauri.savePlaybackPosition).not.toHaveBeenCalled();
		expect(tauri.deletePlaybackPosition).not.toHaveBeenCalled();
		await setMpv({ state: paused(MOVIE_URL, 1801, 3600) });
		expect(tauri.savePlaybackPosition).toHaveBeenCalledWith(MOVIE_KEY, 1801, 3600);
	});

	it("forgets the saved spot and plays from the beginning on start over", async () => {
		remember(saved(MOVIE_KEY, 1800, 3600));
		await openItem(lanternKeeper());
		fireEvent.click(screen.getByRole("button", { name: "Start from the beginning" }));
		await flush();
		expect(tauri.deletePlaybackPosition).toHaveBeenCalledWith(MOVIE_KEY);
		expect(fakeMpv.actions.load).toHaveBeenCalledWith(MOVIE_URL, undefined);
	});

	it("goes back to where the movie was opened from when the viewer cancels", async () => {
		remember(saved(MOVIE_KEY, 1800, 3600));
		await openItem(lanternKeeper(), { from: "/playlists" });
		await press("Escape");
		expect(screen.getByText("Playlists")).toBeInTheDocument();
		expect(fakeMpv.actions.load).not.toHaveBeenCalled();
		expect(fakeMpv.actions.play).not.toHaveBeenCalled();
	});

	it("cancels on Escape wherever focus is", async () => {
		remember(saved(MOVIE_KEY, 1800, 3600));
		await openItem(lanternKeeper(), { from: "/playlists" });
		act(() => playerArea().focus());
		await press("Escape");
		expect(screen.getByText("Playlists")).toBeInTheDocument();
	});

	it.each([
		["too little was watched", 20],
		["the movie was nearly over", 3500],
	])("doesn't offer to resume when %s", async (_, position) => {
		remember(saved(MOVIE_KEY, position, 3600));
		await openItem(lanternKeeper());
		expect(resumePrompt()).not.toBeInTheDocument();
		expect(fakeMpv.actions.load).toHaveBeenCalledWith(MOVIE_URL, undefined);
	});

	it("pauses the episode playing while it asks, and plays it again on cancel", async () => {
		remember(saved("series:show:s1e2", 600, 1300));
		await openItem(ep1, { episodes: [ep1, ep2] });
		await setMpv({ state: playing(ep1.url, 300, 1300) });
		fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
		await flush();
		expect(tauri.savePlaybackPosition).toHaveBeenCalledWith("series:show:s1e1", 300, 1300);
		expect(fakeMpv.actions.pause).toHaveBeenCalledTimes(1);
		expect(resumePrompt()).toBeInTheDocument();
		await press("Escape");
		expect(resumePrompt()).not.toBeInTheDocument();
		expect(fakeMpv.actions.play).toHaveBeenCalledTimes(1);
		expect(screen.getByText("Show S01E01 Pilot")).toBeInTheDocument();
		expect(loadedUrls()).toEqual([ep1.url]);
	});

	it("plays the episode again when the prompt for the next one is cancelled near its end", async () => {
		remember(saved("series:show:s1e2", 600, 1300));
		await openItem(ep1, { episodes: [ep1, ep2] });
		await setMpv({ state: playing(ep1.url, 1297, 1300) });
		await press("n");
		// The prompt pauses episode one in its last seconds.
		await setMpv({ state: paused(ep1.url, 1297, 1300) });
		expect(screen.getAllByRole("dialog")).toHaveLength(1);
		await press("Escape");
		expect(resumePrompt()).not.toBeInTheDocument();
		expect(fakeMpv.actions.play).toHaveBeenCalledTimes(1);
		expect(loadedUrls()).toEqual([ep1.url]);
	});

	it("resumes the next episode where it was stopped", async () => {
		remember(saved("series:show:s1e2", 600, 1300));
		await openItem(ep1, { episodes: [ep1, ep2] });
		await press("n");
		fireEvent.click(screen.getByRole("button", { name: "Resume from 10:00" }));
		await flush();
		expect(fakeMpv.actions.load).toHaveBeenLastCalledWith(ep2.url, 600);
		expect(screen.getByText("Show S01E02 Second")).toBeInTheDocument();
	});

	it("takes the episode list that came with an episode it resumes", async () => {
		remember(saved("series:show:s1e1", 600, 1300));
		await openItem(ep1, { episodes: [ep1, ep2] });
		fireEvent.click(screen.getByRole("button", { name: "Resume from 10:00" }));
		await flush();
		fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
		await flush();
		expect(loadedUrls()).toEqual([ep1.url, ep2.url]);
	});

	it("keeps the episode list of what plays when the prompt for another episode is cancelled", async () => {
		await openItem(ep1, { episodes: [ep1, ep2] });
		await setMpv({ state: playing(ep1.url, 300, 1300) });
		await goToPage("/");
		remember(saved("series:show:s1e3", 600, 1300));
		await goTo({ url: ep3.url, channel: ep3, seriesEpisodes: [ep3] });
		await press("Escape");
		expect(resumePrompt()).not.toBeInTheDocument();

		await goToPage("/player");
		expect(screen.getByText("Show S01E01 Pilot")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
		await flush();
		expect(loadedUrls()).toEqual([ep1.url, ep2.url]);
	});

	it("ignores the player's keys while the prompt is up", async () => {
		remember(saved(MOVIE_KEY, 1800, 3600));
		await openItem(lanternKeeper());
		await press("k");
		await press("f");
		expect(fakeMpv.actions.play).not.toHaveBeenCalled();
		expect(fullscreenSpy).not.toHaveBeenCalled();
		expect(resumePrompt()).toBeInTheDocument();
	});

	it("doesn't pause what plays when the page closed before the prompt could show", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 900, 3600) });
		await goToPage("/");
		const lookup = deferred<PlaybackPosition | null>();
		tauri.getPlaybackPosition.mockReturnValue(lookup.promise);
		await goTo({ url: harborLights().url, channel: harborLights() });
		await goToPage("/");
		await act(async () => lookup.resolve(saved("movie:harbor lights", 1800, 3600)));
		await flush();
		expect(fakeMpv.actions.pause).not.toHaveBeenCalled();
		expect(loadedUrls()).toEqual([MOVIE_URL]);
	});

	it("plays what was picked last when lookups finish out of order", async () => {
		const slow = deferred<PlaybackPosition | null>();
		tauri.getPlaybackPosition.mockImplementation(async (key) =>
			key === "series:show:s1e3" ? slow.promise : null
		);
		await openItem(ep2, { episodes: [ep1, ep2, ep3] });
		await press("n");
		await press("p");
		await act(async () => slow.resolve(null));
		await flush();
		expect(loadedUrls()).toEqual([ep2.url, ep1.url]);
		expect(screen.getByText("Show S01E01 Pilot")).toBeInTheDocument();
	});
});

/** The player's destination, once the player has rendered. */
const destination = () => {
	if (!local.destination) throw new Error("The player hasn't rendered");
	return local.destination;
};

/** Plays `channel` through the player's destination and lets it settle. */
const loadThrough = async (channel: Channel, startAt?: number) => {
	await act(() => destination().load({ kind: "local", channel }, { startAt }));
	await flush();
};

describe("loading through the destination", () => {
	it("starts where it's asked to, without offering to resume", async () => {
		remember(saved(MOVIE_KEY, 1800, 3600));
		await openItem(harborLights());
		await loadThrough(lanternKeeper(), 120);
		expect(resumePrompt()).not.toBeInTheDocument();
		expect(loadedUrls()).toEqual([harborLights().url, MOVIE_URL]);
		expect(fakeMpv.actions.load).toHaveBeenLastCalledWith(MOVIE_URL, 120);
		expect(tauri.recordPlayStart).toHaveBeenLastCalledWith(
			"mv1",
			"The Lantern Keeper",
			null,
			"movie"
		);
	});

	it("takes over from a resume prompt on screen", async () => {
		remember(saved(MOVIE_KEY, 1800, 3600));
		await openItem(lanternKeeper());
		expect(resumePrompt()).toBeInTheDocument();
		await loadThrough(harborLights(), 30);
		expect(resumePrompt()).not.toBeInTheDocument();
		expect(loadedUrls()).toEqual([harborLights().url]);
		expect(fakeMpv.actions.load).toHaveBeenCalledWith(harborLights().url, 30);
	});

	it("saves where the last item got to first", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 700, 3600) });
		expect(tauri.savePlaybackPosition).not.toHaveBeenCalled();
		await loadThrough(harborLights());
		expect(tauri.savePlaybackPosition).toHaveBeenCalledWith(MOVIE_KEY, 700, 3600);
	});

	it("wins over a start still looking up its resume point, and later starts still work", async () => {
		const slow = deferred<PlaybackPosition | null>();
		tauri.getPlaybackPosition.mockImplementation(async (key) =>
			key === MOVIE_KEY ? slow.promise : null
		);
		await openItem(harborLights());
		await goTo({ url: MOVIE_URL, channel: lanternKeeper() });
		await loadThrough(makeNewsChannel());
		await goTo({ url: harborLights().url, channel: harborLights() });
		await act(async () => slow.resolve(saved(MOVIE_KEY, 1800, 3600)));
		await flush();
		expect(resumePrompt()).not.toBeInTheDocument();
		expect(loadedUrls()).toEqual([harborLights().url, NEWS_URL, harborLights().url]);
	});

	it("waits for mpv to open the item, and passes on a failure", async () => {
		await openItem(harborLights());
		const opening = deferred();
		fakeMpv.actions.load.mockReturnValueOnce(opening.promise);
		let done = false;
		let loading: Promise<void> = Promise.resolve();
		act(() => {
			loading = destination()
				.load({ kind: "local", channel: lanternKeeper() })
				.then(() => {
					done = true;
				});
		});
		await flush();
		expect(fakeMpv.actions.load).toHaveBeenLastCalledWith(MOVIE_URL, undefined);
		expect(done).toBe(false);
		await act(async () => {
			opening.resolve();
			await loading;
		});
		expect(done).toBe(true);
		fakeMpv.actions.load.mockRejectedValueOnce(new Error("can't open it"));
		await act(() =>
			expect(destination().load({ kind: "local", channel: harborLights() })).rejects.toThrow(
				"can't open it"
			)
		);
	});
});

describe("saving progress", () => {
	it("saves every few seconds while playing", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const start = new Date("2026-03-01T20:00:00Z").getTime();
		vi.setSystemTime(start);
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 100, 3600) });
		vi.setSystemTime(start + 4000);
		await setMpv({ state: playing(MOVIE_URL, 104, 3600) });
		expect(tauri.savePlaybackPosition).not.toHaveBeenCalled();
		vi.setSystemTime(start + 5000);
		await setMpv({ state: playing(MOVIE_URL, 105, 3600) });
		expect(tauri.savePlaybackPosition).toHaveBeenCalledWith(MOVIE_KEY, 105, 3600);
		vi.setSystemTime(start + 6000);
		await setMpv({ state: playing(MOVIE_URL, 106, 3600) });
		expect(tauri.savePlaybackPosition).toHaveBeenCalledTimes(1);
	});

	it("saves as soon as the viewer pauses", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 100, 3600) });
		expect(tauri.savePlaybackPosition).not.toHaveBeenCalled();
		await setMpv({ state: paused(MOVIE_URL, 100, 3600) });
		expect(tauri.savePlaybackPosition).toHaveBeenCalledWith(MOVIE_KEY, 100, 3600);
	});

	it("forgets the spot of a movie stopped in the first seconds", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: paused(MOVIE_URL, 20, 3600) });
		expect(tauri.deletePlaybackPosition).toHaveBeenCalledWith(MOVIE_KEY);
		expect(tauri.savePlaybackPosition).not.toHaveBeenCalled();
		expect(tauri.markPositionFinished).not.toHaveBeenCalled();
	});

	it("keeps a movie stopped at the end as finished, so it isn't offered to resume", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: paused(MOVIE_URL, 3590, 3600) });
		expect(tauri.markPositionFinished).toHaveBeenCalledWith(MOVIE_KEY, 3600);
		expect(tauri.deletePlaybackPosition).not.toHaveBeenCalled();
		expect(tauri.savePlaybackPosition).not.toHaveBeenCalled();
	});

	it("ignores what mpv reports about another stream", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: paused("http://elsewhere.example.test/other.mkv", 700, 3600) });
		expect(tauri.savePlaybackPosition).not.toHaveBeenCalled();
	});

	it("saves once, records the end of play and goes to the channel list on stop", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 700, 3600) });
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		await flush();
		expect(fakeMpv.actions.stop).toHaveBeenCalledTimes(1);
		expect(screen.getByText("Channel list")).toBeInTheDocument();
		expect(tauri.savePlaybackPosition.mock.calls).toEqual([[MOVIE_KEY, 700, 3600]]);
		expect(tauri.recordPlayEnd).toHaveBeenCalledTimes(1);
		expect(tauri.recordPlayEnd).toHaveBeenCalledWith("mv1", expect.any(Number));
	});

	it("saves and records the end of play when the viewer leaves for another page", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 700, 3600) });
		await goToPage("/playlists");
		expect(screen.getByText("Playlists")).toBeInTheDocument();
		expect(tauri.savePlaybackPosition).toHaveBeenCalledWith(MOVIE_KEY, 700, 3600);
		expect(tauri.recordPlayEnd).toHaveBeenCalledWith("mv1", expect.any(Number));
		expect(tauri.handOffProgress).toHaveBeenLastCalledWith({
			key: MOVIE_KEY,
			url: MOVIE_URL,
			pendingStart: null,
		});
		expect(fakeMpv.actions.stop).not.toHaveBeenCalled();
	});

	it("hands saving to the app while the page is hidden and takes it back when shown", async () => {
		await openItem(lanternKeeper());
		expect(tauri.handOffProgress).toHaveBeenLastCalledWith(null);
		await setMpv({ state: playing(MOVIE_URL, 700, 3600) });
		await setVisibility("hidden");
		expect(tauri.handOffProgress).toHaveBeenLastCalledWith({
			key: MOVIE_KEY,
			url: MOVIE_URL,
			pendingStart: null,
		});
		await setVisibility("visible");
		expect(tauri.handOffProgress).toHaveBeenLastCalledWith(null);
		// The position held from before is stale, so leaving doesn't save it over the newer one.
		await goToPage("/playlists");
		expect(tauri.savePlaybackPosition).not.toHaveBeenCalled();
	});

	it("clears the channel list search after a minute of watching", async () => {
		saveBrowseSearch("lantern");
		await openItem(lanternKeeper());
		for (let position = 0; position <= 60; position += 4) {
			await setMpv({ state: playing(MOVIE_URL, position, 3600) });
		}
		expect(consumeBrowseState().search).toBe("");
	});

	it.each([
		["seeking", (position: number) => playing(MOVIE_URL, position * 8, 3600)],
		["paused", (position: number) => paused(MOVIE_URL, position, 3600)],
	])("keeps the channel list search when the time was spent %s", async (_, report) => {
		saveBrowseSearch("lantern");
		await openItem(lanternKeeper());
		for (let position = 0; position <= 80; position += 4) {
			await setMpv({ state: report(position) });
		}
		expect(consumeBrowseState().search).toBe("lantern");
	});
});

describe("episodes", () => {
	it("steps through the episodes in order with the keys and the buttons", async () => {
		await openItem(ep1, { episodes: [ep3, ep1, ep2] });
		expect(screen.queryByRole("button", { name: "Previous episode" })).not.toBeInTheDocument();
		await press("n");
		await press("n");
		expect(screen.queryByRole("button", { name: "Next episode" })).not.toBeInTheDocument();
		await press("n");
		await press("p");
		fireEvent.click(screen.getByRole("button", { name: "Previous episode" }));
		await flush();
		expect(loadedUrls()).toEqual([ep1.url, ep2.url, ep3.url, ep2.url, ep1.url]);
		expect(screen.getByText("Show S01E01 Pilot")).toBeInTheDocument();
	});

	it("skips another copy of the same episode and offers it as a second source", async () => {
		await openItem(ep1, { episodes: [ep1, ep1Mirror, ep2] });
		fireEvent.click(screen.getByRole("button", { name: "Source" }));
		expect(screen.getAllByRole("menuitemradio")).toHaveLength(2);
		fireEvent.click(screen.getByRole("menuitemradio", { name: /^Source 2/ }));
		expect(fakeMpv.actions.load).toHaveBeenLastCalledWith(ep1Mirror.url, undefined, true);
		await press("n");
		expect(fakeMpv.actions.load).toHaveBeenLastCalledWith(ep2.url, undefined);
	});

	it("finds the episodes in the channel list when none came with the episode", async () => {
		env.channels = [ep2, ep1];
		await openItem(ep1);
		fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
		await flush();
		expect(loadedUrls()).toEqual([ep1.url, ep2.url]);
	});

	it("knows which episode plays when it was opened from a list with other ids", async () => {
		const recent = makeEpisode(1, 2, "Second", { id: "recent-s1e2" });
		await openItem(recent, { episodes: [ep1, ep2, ep3] });
		expect(screen.getByRole("button", { name: "Previous episode" })).toBeInTheDocument();
		await press("n");
		expect(loadedUrls()).toEqual([ep2.url, ep3.url]);
	});

	it("plays the next episode when one ends", async () => {
		await openItem(ep1, { episodes: [ep1, ep2] });
		await setMpv({ state: playing(ep1.url, 1296, 1300) });
		await setMpv({ state: ended(ep1.url, 1300) });
		expect(loadedUrls()).toEqual([ep1.url, ep2.url]);
		expect(screen.getByText("Show S01E02 Second")).toBeInTheDocument();
	});

	it("stays on the last frame when autoplay is off", async () => {
		await openItem(ep1, { episodes: [ep1, ep2] });
		fireEvent.click(screen.getByRole("button", { name: "Autoplay on" }));
		expect(screen.getByRole("button", { name: "Autoplay off" })).toBeInTheDocument();
		await setMpv({ state: playing(ep1.url, 1296, 1300) });
		await setMpv({ state: ended(ep1.url, 1300) });
		expect(loadedUrls()).toEqual([ep1.url]);
	});

	it("doesn't go on to the next episode when the viewer pauses part way", async () => {
		await openItem(ep1, { episodes: [ep1, ep2] });
		await setMpv({ state: playing(ep1.url, 600, 1300) });
		await setMpv({ state: paused(ep1.url, 600, 1300) });
		expect(loadedUrls()).toEqual([ep1.url]);
	});

	it("doesn't go on to the next episode when the viewer pauses near the end", async () => {
		await openItem(ep1, { episodes: [ep1, ep2] });
		await setMpv({ state: playing(ep1.url, 1297, 1300) });
		await setMpv({ state: paused(ep1.url, 1297, 1300) });
		expect(loadedUrls()).toEqual([ep1.url]);
	});

	it("doesn't skip a second episode when next is pressed close to the end", async () => {
		await openItem(ep1, { episodes: [ep1, ep2, ep3] });
		await setMpv({ state: playing(ep1.url, 1299, 1300) });
		await press("n");
		// A poll sent before the load reports the end of episode one.
		await setMpv({ state: ended(ep1.url, 1300) });
		// Loading episode two stops episode one.
		await setMpv({
			state: {
				isPlaying: false,
				isPaused: false,
				currentUrl: ep2.url,
				position: 0,
				duration: 0,
				reachedEnd: false,
			},
		});
		expect(loadedUrls()).toEqual([ep1.url, ep2.url]);
	});

	it("doesn't go on to the next episode for an end reached while the viewer was on another page", async () => {
		await openItem(ep1, { episodes: [ep1, ep2] });
		await setMpv({ state: playing(ep1.url, 1290, 1300) });
		await goToPage("/playlists");
		// The episode ends while the viewer is away. Back on the player, the
		// state starts out empty and the first poll reports the end.
		await setMpv({ state: idleState() });
		await goToPage("/player");
		await setMpv({ state: ended(ep1.url, 1300) });
		expect(screen.getByText("Show S01E01 Pilot")).toBeInTheDocument();
		expect(loadedUrls()).toEqual([ep1.url]);
		// Seeking back and playing to the end again does go on.
		await setMpv({ state: playing(ep1.url, 1296, 1300) });
		await setMpv({ state: ended(ep1.url, 1300) });
		expect(loadedUrls()).toEqual([ep1.url, ep2.url]);
	});

	it("doesn't go on to the next episode for an end reached while the app was in the background", async () => {
		await openItem(ep1, { episodes: [ep1, ep2] });
		await setMpv({ state: playing(ep1.url, 600, 1300) });
		// iOS sends no polls while the app is in the background, though the
		// answer to one sent just before can land after the page is hidden.
		// The first poll after the app comes back reports the end.
		await setVisibility("hidden");
		await setMpv({ state: playing(ep1.url, 601, 1300) });
		await setVisibility("visible");
		await setMpv({ state: ended(ep1.url, 1300) });
		expect(loadedUrls()).toEqual([ep1.url]);
	});

	it("goes on to the next episode when the app comes back before the end", async () => {
		await openItem(ep1, { episodes: [ep1, ep2] });
		await setMpv({ state: playing(ep1.url, 600, 1300) });
		await setVisibility("hidden");
		await setVisibility("visible");
		await setMpv({ state: playing(ep1.url, 1296, 1300) });
		await setMpv({ state: ended(ep1.url, 1300) });
		expect(loadedUrls()).toEqual([ep1.url, ep2.url]);
	});

	it("goes on to the next episode for an end reached in a hidden window that still polls", async () => {
		await openItem(ep1, { episodes: [ep1, ep2] });
		await setMpv({ state: playing(ep1.url, 600, 1300) });
		await setVisibility("hidden");
		await setMpv({ state: playing(ep1.url, 1296, 1300) });
		await setMpv({ state: ended(ep1.url, 1300) });
		expect(loadedUrls()).toEqual([ep1.url, ep2.url]);
	});

	it.each([
		["10 seconds", 1290, [ep1.url, ep2.url]],
		["11 seconds", 1289, [ep1.url]],
	])("counts an end as seen coming from a poll %s before it", async (_, position, urls) => {
		await openItem(ep1, { episodes: [ep1, ep2] });
		await setMpv({ state: playing(ep1.url, position, 1300) });
		await setMpv({ state: ended(ep1.url, 1300) });
		expect(loadedUrls()).toEqual(urls);
	});

	it("doesn't go on to the next episode for an end seen coming before a seek back", async () => {
		await openItem(ep1, { episodes: [ep1, ep2] });
		await setMpv({ state: playing(ep1.url, 1296, 1300) });
		await setMpv({ state: playing(ep1.url, 600, 1300) });
		// It plays on to the end in the background, where iOS sends no polls.
		await setVisibility("hidden");
		await setVisibility("visible");
		await setMpv({ state: ended(ep1.url, 1300) });
		expect(loadedUrls()).toEqual([ep1.url]);
	});

	it("doesn't go on to the next episode when the length isn't known", async () => {
		await openItem(ep1, { episodes: [ep1, ep2] });
		await setMpv({ state: playing(ep1.url, 0, 0) });
		await setMpv({ state: ended(ep1.url, 0) });
		expect(loadedUrls()).toEqual([ep1.url]);
	});

	it.each([
		["goes on", 30_000, [ep1.url, ep2.url]],
		["doesn't go on", 30_001, [ep1.url]],
	])(
		"%s to the next episode when the app was in the background for %i ms of its last seconds",
		async (_, away, urls) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const start = new Date("2026-03-01T20:00:00Z").getTime();
			vi.setSystemTime(start);
			await openItem(ep1, { episodes: [ep1, ep2] });
			await setMpv({ state: playing(ep1.url, 1292, 1300) });
			await setVisibility("hidden");
			vi.setSystemTime(start + away);
			await setVisibility("visible");
			await setMpv({ state: ended(ep1.url, 1300) });
			expect(loadedUrls()).toEqual(urls);
		}
	);

	it("goes on to the next episode after a long pause in its last seconds", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const start = new Date("2026-03-01T20:00:00Z").getTime();
		vi.setSystemTime(start);
		await openItem(ep1, { episodes: [ep1, ep2] });
		await setMpv({ state: paused(ep1.url, 1295, 1300) });
		// Polls keep coming once a second while it's paused.
		vi.setSystemTime(start + 60_000);
		await setMpv({ state: paused(ep1.url, 1295, 1300) });
		vi.setSystemTime(start + 61_000);
		await setMpv({ state: playing(ep1.url, 1296, 1300) });
		vi.setSystemTime(start + 65_000);
		await setMpv({ state: ended(ep1.url, 1300) });
		expect(loadedUrls()).toEqual([ep1.url, ep2.url]);
	});

	it("asks about the next episode once when its resume prompt is cancelled", async () => {
		remember(saved("series:show:s1e2", 600, 1300));
		await openItem(ep1, { episodes: [ep1, ep2] });
		await setMpv({ state: playing(ep1.url, 1296, 1300) });
		await setMpv({ state: ended(ep1.url, 1300) });
		expect(resumePrompt()).toBeInTheDocument();
		await press("Escape");
		// Episode one still sits at its end, and each poll says so.
		await setMpv({ state: ended(ep1.url, 1300) });
		await setMpv({ state: ended(ep1.url, 1300) });
		expect(resumePrompt()).not.toBeInTheDocument();
		expect(
			tauri.getPlaybackPosition.mock.calls.filter(([key]) => key === "series:show:s1e2")
		).toHaveLength(1);
	});
});

describe("switching sources", () => {
	it("keeps the position and saves progress under the same movie", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 880, 3600) });
		fakeMpv.actions.getLastKnownPosition.mockReturnValue(900);
		pickSource(2);
		await flush();
		expect(fakeMpv.actions.load).toHaveBeenLastCalledWith(MIRROR_URL, 900, true);
		expect(tauri.savePlaybackPosition).toHaveBeenCalledWith(MOVIE_KEY, 880, 3600);
		expect(tauri.savePlaybackPosition.mock.invocationCallOrder[0]).toBeLessThan(
			fakeMpv.actions.load.mock.invocationCallOrder[1]
		);
		await setMpv({ state: paused(MIRROR_URL, 950, 3600) });
		expect(tauri.savePlaybackPosition).toHaveBeenLastCalledWith(MOVIE_KEY, 950, 3600);
		fireEvent.click(screen.getByRole("button", { name: "Source" }));
		expect(screen.getByRole("menuitemradio", { name: /^Source 2/ })).toHaveAttribute(
			"aria-checked",
			"true"
		);
	});

	it("does nothing when the source already playing is picked", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 880, 3600) });
		pickSource(1);
		await flush();
		expect(loadedUrls()).toEqual([MOVIE_URL]);
		expect(tauri.savePlaybackPosition).not.toHaveBeenCalled();
	});

	it("starts a live channel's backup stream from now", async () => {
		const backup = "http://backup.example.test/news24.ts";
		await openItem(makeNewsChannel({ sources: [backup] }));
		pickSource(2);
		expect(fakeMpv.actions.load).toHaveBeenLastCalledWith(backup, undefined, true);
		expect(fakeMpv.actions.getLastKnownPosition).not.toHaveBeenCalled();
	});

	it("isn't undone by a download lookup that finishes afterwards", async () => {
		const lookup = deferred<string | null>();
		tauri.resolveLocalDownload.mockReturnValue(lookup.promise);
		await openItem(lanternKeeper());
		pickSource(2);
		await act(async () => lookup.resolve(DOWNLOADED_MOVIE));
		await flush();
		// Nothing of this movie loaded before, so mpv drops what it kept.
		expect(fakeMpv.actions.load.mock.calls).toEqual([[MIRROR_URL, undefined, false]]);
	});
});

describe("skipping intros and credits", () => {
	/** Opens the movie with an intro from 60 to 120 seconds. */
	const openWithIntro = async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		tauri.getSkipSegments.mockResolvedValue([makeSegment()]);
		await openItem(lanternKeeper());
	};

	/** Plays the movie through these positions, one poll each. */
	const playThrough = async (positions: number[], url = MOVIE_URL, duration = 3600) => {
		for (const position of positions) await setMpv({ state: playing(url, position, duration) });
	};

	it("offers a Skip intro button during the intro", async () => {
		await openWithIntro();
		await playThrough([30]);
		expect(tauri.getSkipSegments).toHaveBeenCalledWith("tt9000001", null, null, 3600);
		expect(screen.queryByRole("button", { name: "Skip intro" })).not.toBeInTheDocument();
		await playThrough([61]);
		fireEvent.click(screen.getByRole("button", { name: "Skip intro" }));
		expect(fakeMpv.actions.seek).toHaveBeenCalledWith(120);
	});

	it("gives the keys back to the player when the focused skip button goes away", async () => {
		await openWithIntro();
		await playThrough([61]);
		act(() => screen.getByRole("button", { name: "Skip intro" }).focus());
		await playThrough([121]);
		expect(screen.queryByRole("button", { name: "Skip intro" })).not.toBeInTheDocument();
		expect(playerArea()).toHaveFocus();
		await press("k");
		expect(fakeMpv.actions.pause).toHaveBeenCalledTimes(1);
	});

	it("takes Enter for the skip only while the button shows", async () => {
		await openWithIntro();
		await playThrough([30]);
		expect(await press("Enter")).toBe(true);
		expect(fakeMpv.actions.seek).not.toHaveBeenCalled();
		await playThrough([61]);
		expect(await press("Enter")).toBe(false);
		expect(fakeMpv.actions.seek).toHaveBeenCalledWith(120);
	});

	it("skips the intro on its own when set to, and can undo it", async () => {
		writeSkipSegmentMode("opening", "auto");
		await openWithIntro();
		await playThrough([50, 53, 56, 59, 62]);
		expect(fakeMpv.actions.seek).toHaveBeenCalledWith(118);
		expect(screen.getByText("Skipped intro", { selector: "span" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Undo" }));
		expect(fakeMpv.actions.seek).toHaveBeenLastCalledWith(62);
	});

	it("doesn't look up skip times when skipping is off", async () => {
		writeSkipSegmentMode("opening", "off");
		writeSkipSegmentMode("ending", "off");
		await openWithIntro();
		await playThrough([30, 61]);
		expect(tauri.getSkipSegments).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: "Skip intro" })).not.toBeInTheDocument();
	});

	it("waits to skip on its own while the info drawer is open", async () => {
		writeSkipSegmentMode("opening", "auto");
		await openWithIntro();
		await playThrough([50, 53, 56, 59]);
		await press("i");
		await playThrough([62, 63]);
		expect(fakeMpv.actions.seek).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Close details" }));
		await flush();
		expect(fakeMpv.actions.seek).toHaveBeenCalledWith(118);
	});

	describe("at the credits", () => {
		/** Plays episode one into its credits, which run to the end. */
		const reachCredits = async () => {
			writeSkipSegmentMode("ending", "auto");
			tauri.fetchOmdbData.mockResolvedValue(showOmdb());
			const credits: SkipSegment = makeSegment({
				kind: "credits",
				start: 1240,
				end: 1300,
				autoFrom: 1242,
				autoTo: null,
			});
			tauri.getSkipSegments.mockResolvedValue([credits]);
			await openItem(ep1, { episodes: [ep1, ep2] });
			await playThrough([1230, 1233, 1236, 1239, 1242], ep1.url, 1300);
			expect(tauri.getSkipSegments).toHaveBeenCalledWith("tt9000002", 1, 1, 1300);
		};

		it("counts down to the next episode and plays it", async () => {
			await reachCredits();
			fireEvent.animationEnd(screen.getByTestId("countdown-fill"));
			await flush();
			expect(loadedUrls()).toEqual([ep1.url, ep2.url]);
		});

		it("stays on the credits when the viewer wants to watch them", async () => {
			await reachCredits();
			fireEvent.click(screen.getByRole("button", { name: "Watch credits" }));
			await flush();
			expect(screen.queryByTestId("countdown-fill")).not.toBeInTheDocument();
			expect(loadedUrls()).toEqual([ep1.url]);
		});

		it("goes to the next episode at once on Enter", async () => {
			await reachCredits();
			expect(await press("Enter")).toBe(false);
			expect(loadedUrls()).toEqual([ep1.url, ep2.url]);
		});
	});
});

describe("keyboard shortcuts", () => {
	it("plays with Space and pauses with K", async () => {
		await openItem(lanternKeeper());
		await press(" ");
		expect(fakeMpv.actions.play).toHaveBeenCalledTimes(1);
		await setMpv({ state: playing(MOVIE_URL, 10, 3600) });
		await press("k");
		expect(fakeMpv.actions.pause).toHaveBeenCalledTimes(1);
	});

	it("plays and pauses with the media keys", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 10, 3600) });
		expect(await press("MediaPlay")).toBe(false);
		expect(fakeMpv.actions.play).toHaveBeenCalledTimes(1);
		expect(await press("MediaPause")).toBe(false);
		expect(fakeMpv.actions.pause).toHaveBeenCalledTimes(1);
	});

	it("seeks with the arrows on a desktop even while a control has keyboard focus", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 100, 3600) });
		screen.getByRole("button", { name: "Skip forward 10 seconds" }).focus();
		expect(await press("ArrowRight")).toBe(false);
		expect(fakeMpv.actions.seek).toHaveBeenLastCalledWith(110);
	});

	describe("on a TV", () => {
		beforeEach(() => {
			env.os = "android";
			window.__CINETTE_TV__ = true;
		});

		afterEach(() => {
			delete window.__CINETTE_TV__;
		});

		it("plays and pauses with the center button when there's nothing to skip", async () => {
			await openItem(lanternKeeper());
			expect(await press("Enter")).toBe(false);
			expect(fakeMpv.actions.play).toHaveBeenCalledTimes(1);
			await setMpv({ state: playing(MOVIE_URL, 10, 3600) });
			expect(await press("Enter")).toBe(false);
			expect(fakeMpv.actions.pause).toHaveBeenCalledTimes(1);
			// Held down, it doesn't flip back and forth.
			expect(await press("Enter", { repeat: true })).toBe(true);
			expect(fakeMpv.actions.pause).toHaveBeenCalledTimes(1);
		});

		it("leaves Up and Down to move focus, since the TV has its own volume", async () => {
			await openItem(lanternKeeper());
			expect(await press("ArrowUp")).toBe(true);
			expect(await press("ArrowDown")).toBe(true);
			expect(fakeMpv.actions.setVolume).not.toHaveBeenCalled();
		});

		it("still seeks with Left and Right", async () => {
			await openItem(lanternKeeper());
			await setMpv({ state: playing(MOVIE_URL, 100, 3600) });
			expect(await press("ArrowRight")).toBe(false);
			expect(fakeMpv.actions.seek).toHaveBeenLastCalledWith(110);
		});

		it("leaves the arrows to move between the controls once one has focus", async () => {
			await openItem(lanternKeeper());
			await setMpv({ state: playing(MOVIE_URL, 100, 3600) });
			screen.getByRole("button", { name: "Skip forward 10 seconds" }).focus();
			expect(await press("ArrowRight")).toBe(true);
			expect(fakeMpv.actions.seek).not.toHaveBeenCalled();
		});

		describe("as the controls show and hide", () => {
			beforeEach(() => {
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			});

			it("shows them on any key, and keeps them up while focus moves between them", async () => {
				await openItem(lanternKeeper());
				await setMpv({ state: playing(MOVIE_URL, 100, 3600) });
				act(() => vi.advanceTimersByTime(4000));
				expect(controlBar()).toHaveClass("opacity-0");
				// Down moves focus into the controls, so they show.
				await press("ArrowDown");
				expect(controlBar()).toHaveClass("opacity-100");

				screen.getByRole("button", { name: "Skip forward 10 seconds" }).focus();
				act(() => vi.advanceTimersByTime(3000));
				await press("ArrowLeft");
				act(() => vi.advanceTimersByTime(3000));
				expect(controlBar()).toHaveClass("opacity-100");
				act(() => vi.advanceTimersByTime(1000));
				expect(controlBar()).toHaveClass("opacity-0");
			});

			it("gives the player focus back as they hide, so Left and Right seek again", async () => {
				await openItem(lanternKeeper());
				await setMpv({ state: playing(MOVIE_URL, 100, 3600) });
				screen.getByRole("button", { name: "Skip forward 10 seconds" }).focus();
				act(() => vi.advanceTimersByTime(4000));
				expect(controlBar()).toHaveClass("opacity-0");
				expect(document.activeElement).toBe(playerArea());
				expect(await press("ArrowRight")).toBe(false);
				expect(fakeMpv.actions.seek).toHaveBeenLastCalledWith(110);
			});
		});
	});

	it("goes full screen with F or a double click", async () => {
		renderPlayer(null);
		await flush();
		await press("f");
		expect(fullscreenSpy).toHaveBeenLastCalledWith(true);
		expect(playerArea()).toHaveClass("fixed");
		fireEvent.doubleClick(screen.getByText("Select a channel to start watching"));
		expect(fullscreenSpy).toHaveBeenLastCalledWith(false);
	});

	it("mutes and unmutes with M and says which", async () => {
		await openItem(lanternKeeper());
		await press("m");
		expect(fakeMpv.actions.toggleMute).toHaveBeenCalledTimes(1);
		expect(screen.getByText("Muted")).toBeInTheDocument();
		await setMpv({ state: { volume: 0 } });
		await press("m");
		expect(screen.getByText("Unmuted")).toBeInTheDocument();
	});

	it("seeks with the arrows and adds up presses in a row", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 100, 3600) });
		await press("ArrowRight");
		expect(fakeMpv.actions.seek).toHaveBeenLastCalledWith(110);
		expect(screen.getByText("+10s")).toBeInTheDocument();
		await press("ArrowRight");
		expect(fakeMpv.actions.seek).toHaveBeenLastCalledWith(120);
		expect(screen.getByText("+20s")).toBeInTheDocument();
		await press("ArrowLeft");
		expect(fakeMpv.actions.seek).toHaveBeenLastCalledWith(90);
		expect(screen.getByText("−10s")).toBeInTheDocument();
	});

	it("skips as far as Settings says, and follows a change", async () => {
		writeSkipInterval("back", 5);
		writeSkipInterval("forward", 30);
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 100, 3600) });
		expect(screen.getByRole("button", { name: "Skip forward 30 seconds" })).toBeInTheDocument();
		await press("j");
		expect(fakeMpv.actions.seek).toHaveBeenLastCalledWith(95);
		act(() => writeSkipInterval("forward", 15));
		expect(screen.getByRole("button", { name: "Skip forward 15 seconds" })).toBeInTheDocument();
		await press("L", { shiftKey: true });
		expect(fakeMpv.actions.seek).toHaveBeenLastCalledWith(130);
	});

	it("jumps to a tenth of the way with the digits and to the start with Home", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 100, 3600) });
		await press("5");
		expect(fakeMpv.actions.seek).toHaveBeenLastCalledWith(1800);
		expect(screen.getByText("30:00")).toBeInTheDocument();
		await press("Home");
		expect(fakeMpv.actions.seek).toHaveBeenLastCalledWith(0);
		expect(screen.getByText("0:00")).toBeInTheDocument();
	});

	it("doesn't jump in a live channel, which has no length", async () => {
		await openItem(makeNewsChannel());
		await setMpv({ state: playing(NEWS_URL, 100, 0) });
		await press("5");
		expect(fakeMpv.actions.seek).not.toHaveBeenCalled();
	});

	it("keeps the volume between silent and 150 percent", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: { volume: 148 } });
		await press("ArrowUp");
		expect(fakeMpv.actions.setVolume).toHaveBeenLastCalledWith(150);
		expect(screen.getByText("Volume 150%")).toBeInTheDocument();
		await setMpv({ state: { volume: 3 } });
		await press("ArrowDown");
		expect(fakeMpv.actions.setVolume).toHaveBeenLastCalledWith(0);
		expect(screen.getByText("Volume 0%")).toBeInTheDocument();
	});

	it("keeps seeking while an arrow is held but toggles only once for a held key", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 100, 3600) });
		await press("ArrowRight", { repeat: true });
		expect(fakeMpv.actions.seek).toHaveBeenCalledTimes(1);
		await press("k", { repeat: true });
		await press("f", { repeat: true });
		expect(fakeMpv.actions.pause).not.toHaveBeenCalled();
		expect(fullscreenSpy).not.toHaveBeenCalled();
	});

	it("leaves shortcuts with Cmd or Ctrl to the system", async () => {
		await openItem(lanternKeeper());
		expect(await press("f", { metaKey: true })).toBe(true);
		expect(await press("k", { ctrlKey: true })).toBe(true);
		expect(fullscreenSpy).not.toHaveBeenCalled();
		expect(fakeMpv.actions.play).not.toHaveBeenCalled();
	});

	it("lets the viewer type in a text field", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
		act(() => screen.getByRole("textbox", { name: "Search subtitles" }).focus());
		await press("k");
		await press("f");
		expect(fakeMpv.actions.play).not.toHaveBeenCalled();
		expect(fullscreenSpy).not.toHaveBeenCalled();
	});

	it("leaves Space to a button reached with Tab", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 100, 3600) });
		act(() => screen.getByRole("button", { name: "Stop" }).focus());
		expect(await press(" ")).toBe(true);
		expect(fakeMpv.actions.pause).not.toHaveBeenCalled();
	});

	it("moves the subtitles with the arrows while they're being adjusted, without seeking", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 100, 3600) });
		fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
		fireEvent.click(screen.getByRole("button", { name: "Adjust subtitles" }));
		expect(subtitleBox("Sample subtitle text").style.left).toBe("50%");
		await press("ArrowRight");
		expect(subtitleBox("Sample subtitle text").style.left).toBe("52%");
		expect(fakeMpv.actions.seek).not.toHaveBeenCalled();
	});

	it("opens and closes the shortcut list with the question mark and Escape", async () => {
		await openItem(lanternKeeper());
		await press("?");
		expect(shortcutList()).toBeInTheDocument();
		await press("k");
		expect(fakeMpv.actions.play).not.toHaveBeenCalled();
		await press("?");
		expect(shortcutList()).not.toBeInTheDocument();
		await press("?");
		await press("Escape");
		expect(shortcutList()).not.toBeInTheDocument();
		expect(screen.queryByText("Channel list")).not.toBeInTheDocument();
	});

	it("opens the shortcut list from its button and closes it with Close or a click outside", async () => {
		await openItem(lanternKeeper());
		fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
		const list = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
		fireEvent.click(within(list).getByRole("button", { name: "Close" }));
		expect(shortcutList()).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
		fireEvent.click(
			screen.getByRole("dialog", { name: "Keyboard shortcuts" }).parentElement as HTMLElement
		);
		expect(shortcutList()).not.toBeInTheDocument();
	});

	it("closes one thing at a time with Escape, then leaves the player", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		await press("f");
		await press("i");
		await press("s");
		await press("?");
		await press("Escape");
		expect(shortcutList()).not.toBeInTheDocument();
		expect(fullscreenSpy).toHaveBeenLastCalledWith(true);
		await press("Escape");
		expect(fullscreenSpy).toHaveBeenLastCalledWith(false);
		expect(
			screen.getByRole("dialog", { name: "About The Lantern Keeper" })
		).toBeInTheDocument();
		await press("Escape");
		expect(
			screen.queryByRole("dialog", { name: "About The Lantern Keeper" })
		).not.toBeInTheDocument();
		expect(screen.getByRole("dialog", { name: "Subtitle picker" })).toBeInTheDocument();
		await press("Escape");
		expect(screen.queryByRole("dialog", { name: "Subtitle picker" })).not.toBeInTheDocument();
		expect(fakeMpv.actions.stop).not.toHaveBeenCalled();
		await press("Escape");
		expect(fakeMpv.actions.stop).toHaveBeenCalledTimes(1);
		expect(screen.getByText("Channel list")).toBeInTheDocument();
	});

	it("leaves the keys to a download confirm opened from the controls", async () => {
		env.downloads = [makeDownload({ id: "dl-7", channelId: "mv1", status: "downloading" })];
		await openItem(lanternKeeper());
		fireEvent.click(screen.getByRole("button", { name: "Downloading" }));
		const confirm = screen.getByRole("dialog", { name: "Stop download?" });
		fireEvent.keyDown(confirm, { key: "k" });
		await press("k");
		expect(fakeMpv.actions.play).not.toHaveBeenCalled();
		await press("Escape");
		expect(screen.queryByRole("dialog", { name: "Stop download?" })).not.toBeInTheDocument();
		expect(fakeMpv.actions.stop).not.toHaveBeenCalled();
		expect(screen.getByText("The Lantern Keeper")).toBeInTheDocument();
		expect(tauri.stopDownload).not.toHaveBeenCalled();
	});
});

describe("showing and hiding the controls", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	});

	it("hides them after a few seconds and brings them back when the mouse moves", async () => {
		await openItem(lanternKeeper());
		act(() => vi.advanceTimersByTime(3999));
		expect(screen.getByText("The Lantern Keeper")).toBeInTheDocument();
		act(() => vi.advanceTimersByTime(1));
		expect(screen.queryByText("The Lantern Keeper")).not.toBeInTheDocument();
		expect(controlBar()).toHaveClass("opacity-0");
		fireEvent.mouseMove(playerArea());
		expect(screen.getByText("The Lantern Keeper")).toBeInTheDocument();
		expect(controlBar()).toHaveClass("opacity-100");
	});

	it("keeps them up for longer after a click", async () => {
		await openItem(lanternKeeper());
		act(() => vi.advanceTimersByTime(3000));
		fireEvent.click(playerArea());
		act(() => vi.advanceTimersByTime(3000));
		expect(screen.getByText("The Lantern Keeper")).toBeInTheDocument();
		act(() => vi.advanceTimersByTime(1000));
		expect(screen.queryByText("The Lantern Keeper")).not.toBeInTheDocument();
	});

	it("skips back with the button on the bar and says how far for a moment", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 100, 3600) });
		fireEvent.click(screen.getByRole("button", { name: "Skip back 10 seconds" }));
		expect(fakeMpv.actions.seek).toHaveBeenCalledWith(90);
		expect(screen.getByText("\u221210s")).toBeInTheDocument();
		act(() => vi.advanceTimersByTime(900));
		expect(screen.queryByText("\u221210s")).not.toBeInTheDocument();
	});

	it("brings them back on a shortcut", async () => {
		await openItem(lanternKeeper());
		act(() => vi.advanceTimersByTime(4000));
		await press("ArrowUp");
		expect(screen.getByText("The Lantern Keeper")).toBeInTheDocument();
	});

	it("stays hidden on a desktop for a key that isn't a shortcut", async () => {
		await openItem(lanternKeeper());
		act(() => vi.advanceTimersByTime(4000));
		await press("x");
		expect(controlBar()).toHaveClass("opacity-0");
	});

	it("leaves keyboard focus on a control as they hide on a desktop", async () => {
		await openItem(lanternKeeper());
		const stop = screen.getByRole("button", { name: "Stop" });
		stop.focus();
		act(() => vi.advanceTimersByTime(4000));
		expect(controlBar()).toHaveClass("opacity-0");
		expect(document.activeElement).toBe(stop);
	});

	describe("on a touch screen", () => {
		beforeEach(() => setUpTouchScreen());

		it("shows and hides them with a tap in the middle", async () => {
			await openItem(lanternKeeper());
			tap();
			expect(screen.queryByText("The Lantern Keeper")).not.toBeInTheDocument();
			tap();
			expect(screen.getByText("The Lantern Keeper")).toBeInTheDocument();
		});

		it("ignores the mouse moves a tap sends but shows them for a real mouse", async () => {
			await openItem(lanternKeeper());
			tap();
			fireEvent.mouseMove(playerArea());
			fireEvent.pointerMove(playerArea(), { pointerType: "touch" });
			expect(screen.queryByText("The Lantern Keeper")).not.toBeInTheDocument();
			fireEvent.pointerMove(playerArea(), { pointerType: "mouse" });
			expect(screen.getByText("The Lantern Keeper")).toBeInTheDocument();
		});

		it("skips forward on a double tap at the right side without hiding them", async () => {
			await openItem(lanternKeeper());
			await setMpv({ state: playing(MOVIE_URL, 100, 3600) });
			vi.spyOn(tapLayer(), "getBoundingClientRect").mockReturnValue(box(1000, 600));
			tap(900);
			tap(900);
			expect(fakeMpv.actions.seek).toHaveBeenCalledWith(110);
			expect(screen.getByText("+10s")).toBeInTheDocument();
			act(() => vi.advanceTimersByTime(300));
			expect(screen.getByText("The Lantern Keeper")).toBeInTheDocument();
		});
	});
});

describe("full screen and leaving", () => {
	it("goes in and out of full screen with the button", async () => {
		await openItem(lanternKeeper());
		fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }));
		expect(fullscreenSpy).toHaveBeenLastCalledWith(true);
		fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));
		expect(fullscreenSpy).toHaveBeenLastCalledWith(false);
	});

	it("leaves full screen begun in the player when the viewer stops", async () => {
		await openItem(lanternKeeper());
		fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }));
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		await flush();
		expect(screen.getByText("Channel list")).toBeInTheDocument();
		expect(fullscreenSpy.mock.calls).toEqual([[true], [false]]);
	});

	it("keeps a window that was full screen before the player opened", async () => {
		await openItem(lanternKeeper(), { fullscreen: true });
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		await flush();
		expect(screen.getByText("Channel list")).toBeInTheDocument();
		expect(fullscreenSpy).not.toHaveBeenCalled();
	});

	it("goes back to the page it came from with Back in the phone layout", async () => {
		env.layoutMode = "mobile";
		await openItem(lanternKeeper(), { from: "/playlists" });
		fireEvent.click(screen.getByRole("button", { name: "Back" }));
		await flush();
		expect(screen.getByText("Playlists")).toBeInTheDocument();
	});

	it("goes to the channel list with Back when the player was the first page", async () => {
		env.layoutMode = "mobile";
		await openItem(lanternKeeper(), { from: null });
		fireEvent.click(screen.getByRole("button", { name: "Back" }));
		await flush();
		expect(screen.getByText("Channel list")).toBeInTheDocument();
	});

	it("leaves full screen in a phone layout, which has no full screen button", async () => {
		setUpTouchScreen("mobile");
		await openItem(lanternKeeper(), { fullscreen: true });
		expect(fullscreenSpy).toHaveBeenCalledWith(false);
		expect(screen.queryByRole("button", { name: "Fullscreen" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Exit fullscreen" })).not.toBeInTheDocument();
	});
});

describe("subtitles", () => {
	it("offers subtitles once the movie's details arrive", async () => {
		const details = deferred<ReturnType<typeof lanternOmdb> | null>();
		tauri.fetchOmdbData.mockReturnValue(details.promise);
		await openItem(lanternKeeper());
		expect(screen.queryByRole("button", { name: "Subtitles" })).not.toBeInTheDocument();
		await act(async () => details.resolve(lanternOmdb()));
		expect(screen.getByRole("button", { name: "Subtitles" })).toBeInTheDocument();
		expect(tauri.fetchWhatsonData).toHaveBeenCalledWith("tt9000001", "movie");
	});

	it("shows the picked subtitles in time with the video", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
		expect(
			screen.getByText("Looking up tt9000001 season none episode none")
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Pick English" }));
		await setMpv({ state: playing(MOVIE_URL, 2, 3600) });
		expect(screen.getByText("Mind the lantern")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Subtitles" })).toHaveClass("text-blue-400");
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		expect(screen.queryByRole("dialog", { name: "Subtitle picker" })).not.toBeInTheDocument();
		await setMpv({ state: playing(MOVIE_URL, 5, 3600) });
		expect(screen.queryByText("Mind the lantern")).not.toBeInTheDocument();
	});

	it("shows the subtitles later for a delay and tells mpv", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 5, 3600) });
		pickEnglishSubtitles();
		expect(screen.queryByText("Mind the lantern")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Delay subtitles" }));
		// A cue from 1 s to 4 s now shows from 2.5 s to 5.5 s, as it does in mpv.
		expect(screen.getByText("Mind the lantern")).toBeInTheDocument();
		expect(tauri.mpvSetSubDelay).toHaveBeenCalledWith(1.5);
	});

	it("starts a cue on time between the positions mpv reports", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 0.5, 3600) });
		pickEnglishSubtitles();
		act(() => vi.advanceTimersByTime(498));
		expect(screen.queryByText("Mind the lantern")).not.toBeInTheDocument();
		act(() => vi.advanceTimersByTime(4));
		expect(screen.getByText("Mind the lantern")).toBeInTheDocument();
	});

	it("doesn't count on while the video is paused", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		await setMpv({ state: paused(MOVIE_URL, 0.5, 3600) });
		pickEnglishSubtitles();
		act(() => vi.advanceTimersByTime(1000));
		expect(screen.queryByText("Mind the lantern")).not.toBeInTheDocument();
	});

	it("doesn't count on while the stream stalls", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 0.5, 3600), buffering: true });
		pickEnglishSubtitles();
		act(() => vi.advanceTimersByTime(1000));
		expect(screen.queryByText("Mind the lantern")).not.toBeInTheDocument();
	});

	it("doesn't count on while mpv waits for more of the stream", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		await setMpv({ state: { ...playing(MOVIE_URL, 0.5, 3600), waiting: true } });
		pickEnglishSubtitles();
		act(() => vi.advanceTimersByTime(1000));
		expect(screen.queryByText("Mind the lantern")).not.toBeInTheDocument();
	});

	it("loads the same language for the next episode", async () => {
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		tauri.searchSubtitles.mockResolvedValue({
			languages: ["nl", "en"],
			entries: [
				{ fileId: 201, languageCode: "nl", format: "srt" },
				{ fileId: 202, languageCode: "en", format: "srt" },
				{ fileId: 203, languageCode: "en", format: "srt" },
				{ fileId: 204, languageCode: "en", format: "srt" },
			],
		});
		tauri.readSubtitleFile.mockResolvedValue(
			"1\n00:00:01,000 --> 00:00:04,000\nThe tide is turning\n"
		);
		await openItem(ep1, { episodes: [ep1, ep2] });
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await press("n");
		await flush();
		expect(tauri.searchSubtitles).toHaveBeenLastCalledWith("tt9000002", 1, 2);
		expect(tauri.downloadSubtitle).toHaveBeenCalledWith(203);
		expect(tauri.downloadSubtitle).not.toHaveBeenCalledWith(202);
		// The overlay draws the subtitles, so mpv doesn't. The new track takes
		// the place of the old one.
		expect(tauri.mpvSubAdd).toHaveBeenCalledExactlyOnceWith(
			"/subtitles/chosen.srt",
			true,
			ep2.url
		);
		expect(tauri.mpvSubRemove).not.toHaveBeenCalled();
		await setMpv({ state: playing(ep2.url, 2, 1300) });
		expect(screen.getByText("The tide is turning")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Subtitles" })).toHaveClass("text-blue-400");
	});

	it("lets mpv draw the next episode's subtitles when the overlay can't read them", async () => {
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		tauri.searchSubtitles.mockResolvedValue({
			languages: ["en"],
			entries: [{ fileId: 202, languageCode: "en", format: "ass" }],
		});
		tauri.readSubtitleFile.mockResolvedValue("[Script Info]\nTitle: The tide\n");
		await openItem(ep1, { episodes: [ep1, ep2] });
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await press("n");
		await flush();
		expect(tauri.downloadSubtitle).toHaveBeenCalledWith(202);
		expect(tauri.mpvSubAdd).toHaveBeenCalledExactlyOnceWith(
			"/subtitles/chosen.srt",
			false,
			ep2.url
		);
	});

	it("drops the next episode's subtitles when the viewer moves on before they arrive", async () => {
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		// Episode two has English subtitles and episode three only Dutch ones.
		tauri.searchSubtitles.mockImplementation(async (_imdbId, _season, episode) => ({
			languages: ["en", "nl"],
			entries: [
				episode === 2
					? { fileId: 302, languageCode: "en", format: "srt" }
					: { fileId: 303, languageCode: "nl", format: "srt" },
			],
		}));
		const file = deferred<string>();
		tauri.readSubtitleFile.mockReturnValue(file.promise);
		await openItem(ep1, { episodes: [ep1, ep2, ep3] });
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await press("n");
		expect(tauri.readSubtitleFile).toHaveBeenCalledTimes(1);
		await press("n");
		expect(tauri.searchSubtitles).toHaveBeenLastCalledWith("tt9000002", 1, 3);
		await act(async () =>
			file.resolve("1\n00:00:01,000 --> 00:00:04,000\nThe tide is turning\n")
		);
		await setMpv({ state: playing(ep3.url, 2, 1300) });
		expect(screen.queryByText("The tide is turning")).not.toBeInTheDocument();
		expect(tauri.downloadSubtitle.mock.calls).toEqual([[302]]);
		// mpv plays episode three now, so it doesn't get episode two's file,
		// and keeps its own subtitles.
		expect(tauri.mpvSubRemove).not.toHaveBeenCalled();
		expect(tauri.mpvSubAdd).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Subtitles" })).not.toHaveClass("text-blue-400");
	});

	it("drops the next episode's subtitles when mpv adds them after the viewer moves on", async () => {
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		// Episode two has English subtitles and episode three only Dutch ones.
		tauri.searchSubtitles.mockImplementation(async (_imdbId, _season, episode) => ({
			languages: ["en", "nl"],
			entries: [
				episode === 2
					? { fileId: 302, languageCode: "en", format: "ass" }
					: { fileId: 303, languageCode: "nl", format: "srt" },
			],
		}));
		// The overlay can't read the file, so only mpv can show it.
		tauri.readSubtitleFile.mockResolvedValue("[Script Info]\nTitle: The tide\n");
		const added = deferred<void>();
		tauri.mpvSubAdd.mockReturnValue(added.promise);
		await openItem(ep1, { episodes: [ep1, ep2, ep3] });
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await press("n");
		await flush();
		expect(tauri.mpvSubAdd).toHaveBeenCalledExactlyOnceWith(
			"/subtitles/chosen.srt",
			false,
			ep2.url
		);
		await press("n");
		expect(tauri.searchSubtitles).toHaveBeenLastCalledWith("tt9000002", 1, 3);
		expect(tauri.mpvSubRemove).not.toHaveBeenCalled();
		await act(async () => added.resolve());
		await flush();
		expect(screen.getByRole("button", { name: "Subtitles" })).not.toHaveClass("text-blue-400");
		// The viewer moved on, so the track mpv added comes out again.
		expect(tauri.mpvSubRemove).toHaveBeenCalledExactlyOnceWith(-1, ep2.url);
	});

	it("leaves the track in use when mpv can't add the next episode's subtitles after the viewer moves on", async () => {
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		// Episode two has English subtitles and episode three only Dutch ones.
		tauri.searchSubtitles.mockImplementation(async (_imdbId, _season, episode) => ({
			languages: ["en", "nl"],
			entries: [
				episode === 2
					? { fileId: 302, languageCode: "en", format: "ass" }
					: { fileId: 303, languageCode: "nl", format: "srt" },
			],
		}));
		// The overlay can't read the file, so only mpv can show it.
		tauri.readSubtitleFile.mockResolvedValue("[Script Info]\nTitle: The tide\n");
		const added = deferred<void>();
		tauri.mpvSubAdd.mockReturnValue(added.promise);
		await openItem(ep1, { episodes: [ep1, ep2, ep3] });
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await press("n");
		await flush();
		expect(tauri.mpvSubAdd).toHaveBeenCalledExactlyOnceWith(
			"/subtitles/chosen.srt",
			false,
			ep2.url
		);
		await press("n");
		expect(tauri.searchSubtitles).toHaveBeenLastCalledWith("tt9000002", 1, 3);
		await act(async () => added.reject(new Error("unsupported")));
		await flush();
		expect(screen.getByRole("button", { name: "Subtitles" })).not.toHaveClass("text-blue-400");
		// mpv added nothing, so a remove would only take out the track in use.
		expect(tauri.mpvSubRemove).not.toHaveBeenCalled();
	});

	it("keeps the viewer's pick when the next episode's subtitles arrive after it", async () => {
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		tauri.searchSubtitles.mockResolvedValue({
			languages: ["en"],
			entries: [{ fileId: 202, languageCode: "en", format: "srt" }],
		});
		const file = deferred<string>();
		tauri.readSubtitleFile.mockReturnValue(file.promise);
		await openItem(ep1, { episodes: [ep1, ep2] });
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await press("n");
		expect(tauri.readSubtitleFile).toHaveBeenCalledTimes(1);
		pickEnglishSubtitles();
		await act(async () =>
			file.resolve("1\n00:00:01,000 --> 00:00:04,000\nThe tide is turning\n")
		);
		await setMpv({ state: playing(ep2.url, 2, 1300) });
		expect(screen.getByText("Mind the lantern")).toBeInTheDocument();
		expect(screen.queryByText("The tide is turning")).not.toBeInTheDocument();
		expect(tauri.mpvSubAdd).not.toHaveBeenCalled();
	});

	it("keeps the viewer's pick when mpv adds the next episode's subtitles after it", async () => {
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		tauri.searchSubtitles.mockResolvedValue({
			languages: ["en"],
			entries: [{ fileId: 202, languageCode: "en", format: "ass" }],
		});
		// The overlay can't read the file, so only mpv can show it.
		tauri.readSubtitleFile.mockResolvedValue("[Script Info]\nTitle: The tide\n");
		const added = deferred<void>();
		tauri.mpvSubAdd.mockReturnValue(added.promise);
		await openItem(ep1, { episodes: [ep1, ep2] });
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await press("n");
		await flush();
		expect(tauri.mpvSubAdd).toHaveBeenCalledExactlyOnceWith(
			"/subtitles/chosen.srt",
			false,
			ep2.url
		);
		pickEnglishSubtitles();
		await act(async () => added.resolve());
		await flush();
		await setMpv({ state: playing(ep2.url, 2, 1300) });
		expect(screen.getByText("Mind the lantern")).toBeInTheDocument();
		// The track the viewer picked takes the place of mpv's, so nothing
		// takes that one out.
		expect(tauri.mpvSubRemove).not.toHaveBeenCalled();
	});

	it("drops the next episode's subtitles when another episode starts from elsewhere before they arrive", async () => {
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		// Episode two has English subtitles and episode three only Dutch ones.
		tauri.searchSubtitles.mockImplementation(async (_imdbId, _season, episode) => ({
			languages: ["en", "nl"],
			entries: [
				episode === 2
					? { fileId: 302, languageCode: "en", format: "srt" }
					: { fileId: 303, languageCode: "nl", format: "srt" },
			],
		}));
		const file = deferred<string>();
		tauri.readSubtitleFile.mockReturnValue(file.promise);
		await openItem(ep1, { episodes: [ep1, ep2, ep3] });
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await press("n");
		expect(tauri.readSubtitleFile).toHaveBeenCalledTimes(1);
		await goTo({ url: ep3.url, channel: ep3, seriesEpisodes: [ep1, ep2, ep3] });
		expect(loadedUrls()).toEqual([ep1.url, ep2.url, ep3.url]);
		await act(async () =>
			file.resolve("1\n00:00:01,000 --> 00:00:04,000\nThe tide is turning\n")
		);
		await setMpv({ state: playing(ep3.url, 2, 1300) });
		expect(screen.queryByText("The tide is turning")).not.toBeInTheDocument();
		expect(tauri.mpvSubAdd).not.toHaveBeenCalled();
	});

	it("adds the next episode's subtitles to its download once the player finds it", async () => {
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		tauri.searchSubtitles.mockResolvedValue({
			languages: ["en"],
			entries: [{ fileId: 202, languageCode: "en", format: "srt" }],
		});
		tauri.readSubtitleFile.mockResolvedValue(
			"1\n00:00:01,000 --> 00:00:04,000\nThe tide is turning\n"
		);
		await openItem(ep1, { episodes: [ep1, ep2] });
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		const local = deferred<string | null>();
		tauri.resolveLocalDownload.mockReturnValue(local.promise);
		await press("n");
		expect(tauri.searchSubtitles).not.toHaveBeenCalled();
		await act(async () => local.resolve("/downloads/second.mkv"));
		await flush();
		expect(loadedUrls()).toEqual([ep1.url, "/downloads/second.mkv"]);
		expect(tauri.mpvSubAdd).toHaveBeenCalledExactlyOnceWith(
			"/subtitles/chosen.srt",
			true,
			"/downloads/second.mkv"
		);
	});

	it("doesn't load the next episode's subtitles again when that episode restarts", async () => {
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		tauri.searchSubtitles.mockResolvedValue({
			languages: ["en"],
			entries: [{ fileId: 202, languageCode: "en", format: "srt" }],
		});
		tauri.readSubtitleFile.mockResolvedValue(
			"1\n00:00:01,000 --> 00:00:04,000\nThe tide is turning\n"
		);
		await openItem(ep1, { episodes: [ep1, ep2] });
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await press("n");
		await flush();
		expect(tauri.downloadSubtitle).toHaveBeenCalledOnce();
		// The player looks for a download of the episode before it loads it.
		const local = deferred<string | null>();
		tauri.resolveLocalDownload.mockReturnValue(local.promise);
		await goTo({ url: ep2.url, channel: ep2, seriesEpisodes: [ep1, ep2] });
		await act(async () => local.resolve(null));
		await flush();
		expect(loadedUrls()).toEqual([ep1.url, ep2.url, ep2.url]);
		expect(tauri.downloadSubtitle).toHaveBeenCalledOnce();
		expect(tauri.mpvSubAdd).toHaveBeenCalledOnce();
	});

	it("leaves the next episode's subtitles unpicked when mpv can't add a file the overlay can't read", async () => {
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		tauri.searchSubtitles.mockResolvedValue({
			languages: ["en"],
			entries: [{ fileId: 202, languageCode: "en", format: "ass" }],
		});
		tauri.readSubtitleFile.mockResolvedValue("[Script Info]\nTitle: The tide\n");
		tauri.mpvSubAdd.mockRejectedValue(new Error("unsupported"));
		await openItem(ep1, { episodes: [ep1, ep2] });
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await press("n");
		await flush();
		expect(tauri.mpvSubAdd).toHaveBeenCalledExactlyOnceWith(
			"/subtitles/chosen.srt",
			false,
			ep2.url
		);
		expect(screen.getByRole("button", { name: "Subtitles" })).not.toHaveClass("text-blue-400");
		expect(tauri.mpvSubRemove).not.toHaveBeenCalled();
	});

	it("lets mpv draw the next episode's subtitles when the file isn't UTF-8", async () => {
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		tauri.searchSubtitles.mockResolvedValue({
			languages: ["en"],
			entries: [{ fileId: 202, languageCode: "en", format: "srt" }],
		});
		tauri.readSubtitleFile.mockRejectedValue(new Error("stream did not contain valid UTF-8"));
		await openItem(ep1, { episodes: [ep1, ep2] });
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await press("n");
		await flush();
		expect(tauri.mpvSubAdd).toHaveBeenCalledExactlyOnceWith(
			"/subtitles/chosen.srt",
			false,
			ep2.url
		);
		expect(screen.getByRole("button", { name: "Subtitles" })).toHaveClass("text-blue-400");
		expect(tauri.mpvSubRemove).not.toHaveBeenCalled();
	});

	it("shows the subtitles as they were when the player is opened again from the sidebar", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Adjust subtitles" }));
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(box(1000, 500));
		fireEvent.mouseDown(subtitleBox("Sample subtitle text"), { clientX: 500, clientY: 440 });
		fireEvent.mouseMove(document, { clientX: 600, clientY: 390 });
		fireEvent.mouseUp(document);
		fireEvent.click(screen.getByRole("button", { name: "Delay subtitles" }));
		fireEvent.click(screen.getByRole("button", { name: "Bigger subtitles" }));
		fireEvent.click(screen.getByRole("button", { name: "Serif subtitles" }));
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await goToPage("/");
		expect(screen.getByText("Channel list")).toBeInTheDocument();

		await goToPage("/player");
		// The delay of 1.5 seconds shows the line from 1 to 4 seconds at 5.
		await setMpv({ state: playing(MOVIE_URL, 5, 3600) });
		expect(screen.getByText("Mind the lantern").parentElement).toHaveStyle({
			fontSize: "26px",
			fontFamily: "Georgia, serif",
		});
		expect(subtitleBox("Mind the lantern").style.left).toBe("60%");
		expect(subtitleBox("Mind the lantern").style.top).toBe("78%");
		expect(screen.getByRole("button", { name: "Subtitles" })).toHaveClass("text-blue-400");
	});

	it("keeps the language for the next episode when the player is opened again", async () => {
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		tauri.searchSubtitles.mockResolvedValue({
			languages: ["en"],
			entries: [{ fileId: 202, languageCode: "en", format: "srt" }],
		});
		await openItem(ep1, { episodes: [ep1, ep2] });
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await goToPage("/");
		await goToPage("/player");
		await press("n");
		await flush();
		expect(tauri.downloadSubtitle).toHaveBeenCalledExactlyOnceWith(202);
	});

	it.each([
		["the Stop button", () => fireEvent.click(screen.getByRole("button", { name: "Stop" }))],
		["Escape", () => press("Escape")],
	])("forgets the subtitles once %s stops playback", async (_how, stop) => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await stop();
		await flush();
		expect(screen.getByText("Channel list")).toBeInTheDocument();

		await goToPage("/player");
		await setMpv({ state: playing(MOVIE_URL, 2, 3600) });
		expect(screen.getByText("The Lantern Keeper")).toBeInTheDocument();
		expect(screen.queryByText("Mind the lantern")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Subtitles" })).not.toHaveClass("text-blue-400");
	});

	it("starts with no subtitles when the same movie is opened again from a list", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await goToPage("/");
		await goTo({ url: MOVIE_URL, channel: lanternKeeper() });
		await setMpv({ state: playing(MOVIE_URL, 2, 3600) });
		expect(screen.queryByText("Mind the lantern")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Subtitles" })).not.toHaveClass("text-blue-400");
	});

	it("keeps the subtitles when the resume prompt for another item is cancelled", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await goToPage("/");
		remember(saved("movie:harbor lights", 1800, 3600));
		await goTo({ url: harborLights().url, channel: harborLights() });
		expect(resumePrompt()).toBeInTheDocument();
		await press("Escape");
		expect(screen.getByText("Channel list")).toBeInTheDocument();

		await goToPage("/player");
		await setMpv({ state: playing(MOVIE_URL, 2, 3600) });
		expect(screen.getByText("Mind the lantern")).toBeInTheDocument();
		expect(loadedUrls()).toEqual([MOVIE_URL]);
	});

	it("keeps the subtitles when the page closed before another item could start", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await goToPage("/");
		const lookup = deferred<PlaybackPosition | null>();
		tauri.getPlaybackPosition.mockReturnValue(lookup.promise);
		await goTo({ url: harborLights().url, channel: harborLights() });
		await goToPage("/");
		await act(async () => lookup.resolve(null));
		await flush();
		expect(loadedUrls()).toEqual([MOVIE_URL]);

		await goToPage("/player");
		await setMpv({ state: playing(MOVIE_URL, 2, 3600) });
		expect(screen.getByText("Mind the lantern")).toBeInTheDocument();
	});

	it("loads the next episode's subtitles again when the page closed while they loaded", async () => {
		const srt = "1\n00:00:01,000 --> 00:00:04,000\nThe tide is turning\n";
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		tauri.searchSubtitles.mockResolvedValue({
			languages: ["en"],
			entries: [{ fileId: 202, languageCode: "en", format: "srt" }],
		});
		const file = deferred<string>();
		tauri.readSubtitleFile.mockReturnValueOnce(file.promise).mockResolvedValue(srt);
		await openItem(ep1, { episodes: [ep1, ep2] });
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await press("n");
		expect(tauri.readSubtitleFile).toHaveBeenCalledTimes(1);
		await goToPage("/");
		await act(async () => file.resolve(srt));
		expect(tauri.mpvSubAdd).not.toHaveBeenCalled();

		await goToPage("/player");
		await flush();
		await setMpv({ state: playing(ep2.url, 2, 1300) });
		expect(screen.getByText("The tide is turning")).toBeInTheDocument();
		expect(tauri.downloadSubtitle.mock.calls).toEqual([[202], [202]]);
		expect(tauri.mpvSubAdd).toHaveBeenCalledExactlyOnceWith(
			"/subtitles/chosen.srt",
			true,
			ep2.url
		);
	});

	it("loads the next episode's subtitles again when the page closed while it looked for a download", async () => {
		const srt = "1\n00:00:01,000 --> 00:00:04,000\nThe tide is turning\n";
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		tauri.searchSubtitles.mockResolvedValue({
			languages: ["en"],
			entries: [{ fileId: 202, languageCode: "en", format: "srt" }],
		});
		tauri.readSubtitleFile.mockResolvedValue(srt);
		await openItem(ep1, { episodes: [ep1, ep2] });
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		const local = deferred<string | null>();
		tauri.resolveLocalDownload.mockReturnValue(local.promise);
		await press("n");
		await goToPage("/");
		await act(async () => local.resolve("/downloads/second.mkv"));
		await flush();
		expect(loadedUrls()).toEqual([ep1.url, "/downloads/second.mkv"]);
		expect(tauri.downloadSubtitle).not.toHaveBeenCalled();

		await goToPage("/player");
		await flush();
		await setMpv({ state: playing("/downloads/second.mkv", 2, 1300) });
		expect(screen.getByText("The tide is turning")).toBeInTheDocument();
		expect(tauri.mpvSubAdd).toHaveBeenCalledExactlyOnceWith(
			"/subtitles/chosen.srt",
			true,
			"/downloads/second.mkv"
		);
	});

	it("keeps a subtitle mpv adds after the page closed for when it opens again", async () => {
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		tauri.searchSubtitles.mockResolvedValue({
			languages: ["nl"],
			entries: [
				{ fileId: 303, languageCode: "nl", format: "ass" },
				{ fileId: 304, languageCode: "nl", format: "ass" },
			],
		});
		tauri.readSubtitleFile.mockRejectedValue(new Error("stream did not contain valid UTF-8"));
		await openItem(ep1, { episodes: [ep1, ep2] });
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Start a download" }));
		await goToPage("/");
		// mpv draws the new track, which took the English one's place.
		const dutch = { fileId: 304, languageCode: "nl", format: "ass" };
		expect(picker.pick?.keep(ep1.url, dutch, 1)).toBe(true);

		await goToPage("/player");
		await setMpv({ state: playing(ep1.url, 2, 1300) });
		expect(screen.queryByText("Mind the lantern")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Subtitles" })).toHaveClass("text-blue-400");
		fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
		expect(screen.getByText("Current subtitle 304")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		// The next episode gets the second Dutch subtitle too.
		await press("n");
		await flush();
		expect(tauri.downloadSubtitle).toHaveBeenCalledExactlyOnceWith(304);
		expect(tauri.mpvSubAdd).toHaveBeenCalledExactlyOnceWith(
			"/subtitles/chosen.srt",
			false,
			ep2.url
		);
	});

	it("doesn't load the next episode's subtitles over a pick kept after the page closed", async () => {
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		const search = deferred<SubtitleSearchResult | null>();
		tauri.searchSubtitles.mockReturnValue(search.promise);
		await openItem(ep1, { episodes: [ep1, ep2] });
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await press("n");
		expect(tauri.searchSubtitles).toHaveBeenCalledOnce();
		fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
		fireEvent.click(screen.getByRole("button", { name: "Start a download" }));
		await goToPage("/");
		expect(
			picker.pick?.keep(ep2.url, { fileId: 304, languageCode: "nl", format: "ass" }, 0)
		).toBe(true);
		await act(async () =>
			search.resolve({
				languages: ["en", "nl"],
				entries: [
					{ fileId: 202, languageCode: "en", format: "srt" },
					{ fileId: 304, languageCode: "nl", format: "ass" },
				],
			})
		);

		await goToPage("/player");
		await flush();
		await setMpv({ state: playing(ep2.url, 2, 1300) });
		expect(screen.getByRole("button", { name: "Subtitles" })).toHaveClass("text-blue-400");
		expect(tauri.downloadSubtitle).not.toHaveBeenCalled();
	});

	it("keeps no subtitle mpv adds after the page closed once it has opened again", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Start a download" }));
		await goToPage("/");
		await goToPage("/player");
		await setMpv({ state: playing(MOVIE_URL, 2, 3600) });
		expect(screen.getByText("Mind the lantern")).toBeInTheDocument();
		// The page that opened again already shows the subtitles it read, so
		// the track goes.
		const dutch = { fileId: 304, languageCode: "nl", format: "ass" };
		expect(picker.pick?.keep(MOVIE_URL, dutch, 0)).toBe(false);
		// Nor once it has closed too, since it saved the subtitles it showed.
		await goToPage("/");
		expect(picker.pick?.keep(MOVIE_URL, dutch, 0)).toBe(false);
		await goToPage("/player");
		await setMpv({ state: playing(MOVIE_URL, 2, 3600) });
		expect(screen.getByText("Mind the lantern")).toBeInTheDocument();
	});

	it("keeps a subtitle mpv adds as the page closes", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Start a download" }));
		const dutch = { fileId: 304, languageCode: "nl", format: "ass" };
		let kept: boolean | undefined;
		pageOpens.run = () => {
			kept = picker.pick?.keep(MOVIE_URL, dutch, 0);
		};
		await goToPage("/");
		expect(kept).toBe(true);
	});

	it("keeps a subtitle mpv adds as the page opens again", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Start a download" }));
		await goToPage("/");
		const pick = picker.pick;
		const dutch = { fileId: 304, languageCode: "nl", format: "ass" };
		let kept: boolean | undefined;
		// The page that opens reads the saved subtitles after this.
		pageOpens.run = () => {
			kept = pick?.keep(MOVIE_URL, dutch, 0);
		};
		await goToPage("/player");
		expect(kept).toBe(true);
		await setMpv({ state: playing(MOVIE_URL, 2, 3600) });
		expect(screen.queryByText("Mind the lantern")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
		expect(screen.getByText("Current subtitle 304")).toBeInTheDocument();
	});

	it("keeps a subtitle mpv adds after a page that opened again closed", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await goToPage("/");
		await goToPage("/player");
		await setMpv({ state: playing(MOVIE_URL, 2, 3600) });
		fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
		fireEvent.click(screen.getByRole("button", { name: "Start a download" }));
		await goToPage("/");
		const dutch = { fileId: 304, languageCode: "nl", format: "ass" };
		expect(picker.pick?.keep(MOVIE_URL, dutch, 0)).toBe(true);

		await goToPage("/player");
		await setMpv({ state: playing(MOVIE_URL, 2, 3600) });
		expect(screen.queryByText("Mind the lantern")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
		expect(screen.getByText("Current subtitle 304")).toBeInTheDocument();
	});

	it("keeps a subtitle mpv adds after a page opened with a new item closed", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		await goToPage("/");
		// This page reads the subtitles the first one saved.
		await goToPage("/player");
		await goToPage("/");
		await goTo({ url: harborLights().url, channel: harborLights() });
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Start a download" }));
		await goToPage("/");
		const dutch = { fileId: 304, languageCode: "nl", format: "ass" };
		expect(picker.pick?.keep(harborLights().url, dutch, 0)).toBe(true);
	});

	it("keeps a subtitle mpv adds while a resume prompt for another item shows", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Start a download" }));
		await goToPage("/");
		const pick = picker.pick;
		remember(saved("movie:harbor lights", 1800, 3600));
		await goTo({ url: harborLights().url, channel: harborLights() });
		expect(resumePrompt()).toBeInTheDocument();
		// The page opened with another item, so it hasn't read the saved
		// subtitles yet.
		const dutch = { fileId: 304, languageCode: "nl", format: "ass" };
		expect(pick?.keep(MOVIE_URL, dutch, 0)).toBe(true);

		await goToPage("/player");
		await setMpv({ state: playing(MOVIE_URL, 2, 3600) });
		expect(screen.queryByText("Mind the lantern")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
		expect(screen.getByText("Current subtitle 304")).toBeInTheDocument();
	});

	it("keeps no subtitle for a page that's open or has moved on to another stream", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		const dutch = { fileId: 304, languageCode: "nl", format: "ass" };
		await openItem(lanternKeeper());
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await goToPage("/");
		await goToPage("/player");
		fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
		fireEvent.click(screen.getByRole("button", { name: "Start a download" }));
		expect(picker.pick?.keep(MOVIE_URL, dutch, 0)).toBe(false);
		await goToPage("/");
		expect(picker.pick?.keep(DOWNLOADED_MOVIE, dutch, 0)).toBe(false);

		await goToPage("/player");
		await setMpv({ state: playing(MOVIE_URL, 2, 3600) });
		expect(screen.getByText("Mind the lantern")).toBeInTheDocument();
	});

	it("tells the subtitle picker once the player moves on to another episode", async () => {
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		await openItem(ep1, { episodes: [ep1, ep2] });
		fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
		fireEvent.click(screen.getByRole("button", { name: "Start a download" }));
		expect(picker.pick?.stream()).toBe(ep1.url);
		fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
		await flush();
		expect(loadedUrls()).toEqual([ep1.url, ep2.url]);
		expect(picker.pick?.stream()).toBeNull();
		expect(picker.pick?.latest()).toBe(true);
	});

	it("tells the subtitle picker once the player page closes", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
		fireEvent.click(screen.getByRole("button", { name: "Start a download" }));
		expect(picker.pick?.stream()).toBe(MOVIE_URL);
		await goToPage("/");
		expect(picker.pick?.stream()).toBeNull();
	});

	it("tells the subtitle picker once the viewer picks again", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
		fireEvent.click(screen.getByRole("button", { name: "Start a download" }));
		fireEvent.click(screen.getByRole("button", { name: "Pick none" }));
		expect(picker.pick?.latest()).toBe(false);
		expect(picker.pick?.stream()).toBeNull();
	});

	it("gives the subtitle picker no stream before the item's stream is known", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		const local = deferred<string | null>();
		tauri.resolveLocalDownload.mockReturnValue(local.promise);
		await openItem(lanternKeeper());
		fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
		fireEvent.click(screen.getByRole("button", { name: "Start a download" }));
		expect(picker.pick?.stream()).toBeNull();
		await act(async () => local.resolve(null));
		await flush();
		expect(picker.pick?.stream()).toBe(MOVIE_URL);
	});

	it("keeps the subtitles when the sidebar's Player link is clicked over a resume prompt for another item", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await goToPage("/");
		remember(saved("movie:harbor lights", 1800, 3600));
		await goTo({ url: harborLights().url, channel: harborLights() });
		expect(resumePrompt()).toBeInTheDocument();

		await goToPage("/player");
		await setMpv({ state: playing(MOVIE_URL, 2, 3600) });
		expect(screen.getByText("The Lantern Keeper")).toBeInTheDocument();
		expect(screen.getByText("Mind the lantern")).toBeInTheDocument();
		expect(loadedUrls()).toEqual([MOVIE_URL]);
	});

	it("doesn't load the next episode's subtitles again over ones picked while they loaded", async () => {
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		tauri.searchSubtitles.mockResolvedValue({
			languages: ["en"],
			entries: [{ fileId: 202, languageCode: "en", format: "srt" }],
		});
		tauri.readSubtitleFile.mockReturnValue(new Promise(() => {}));
		await openItem(ep1, { episodes: [ep1, ep2] });
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await press("n");
		expect(tauri.readSubtitleFile).toHaveBeenCalledTimes(1);
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await goToPage("/");

		await goToPage("/player");
		await setMpv({ state: playing(ep2.url, 2, 1300) });
		expect(screen.getByText("Mind the lantern")).toBeInTheDocument();
		expect(tauri.downloadSubtitle).toHaveBeenCalledExactlyOnceWith(202);
	});

	it("doesn't look again for next-episode subtitles it didn't find", async () => {
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		tauri.searchSubtitles.mockResolvedValue({
			languages: ["fr"],
			entries: [{ fileId: 203, languageCode: "fr", format: "srt" }],
		});
		await openItem(ep1, { episodes: [ep1, ep2] });
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await press("n");
		await flush();
		expect(tauri.searchSubtitles).toHaveBeenCalledTimes(1);
		await goToPage("/");

		await goToPage("/player");
		await flush();
		await setMpv({ state: playing(ep2.url, 2, 1300) });
		expect(screen.getByText(ep2.name)).toBeInTheDocument();
		expect(tauri.searchSubtitles).toHaveBeenCalledTimes(1);
	});

	it("doesn't look again for subtitles it didn't find when an earlier search answers late", async () => {
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		const late = deferred<SubtitleSearchResult>();
		tauri.searchSubtitles.mockImplementation(async (_imdbId, _season, episode) =>
			episode === 2
				? late.promise
				: {
						languages: ["fr"],
						entries: [{ fileId: 303, languageCode: "fr", format: "srt" }],
					}
		);
		await openItem(ep1, { episodes: [ep1, ep2, ep3] });
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await press("n");
		await press("n");
		expect(tauri.searchSubtitles).toHaveBeenLastCalledWith("tt9000002", 1, 3);
		// Episode two's search answers after episode three's found nothing.
		await act(async () =>
			late.resolve({
				languages: ["en"],
				entries: [{ fileId: 302, languageCode: "en", format: "srt" }],
			})
		);
		await goToPage("/");

		await goToPage("/player");
		await flush();
		await setMpv({ state: playing(ep3.url, 2, 1300) });
		expect(screen.getByText(ep3.name)).toBeInTheDocument();
		expect(tauri.searchSubtitles).toHaveBeenCalledTimes(2);
		expect(tauri.downloadSubtitle).not.toHaveBeenCalled();
	});

	describe("kept from when the player page was last open", () => {
		/**
		 * Saves subtitles for `channelId` while mpv plays `url`, as the player
		 * does when its page closes.
		 */
		const keepSubtitles = (channelId: string, url: string) =>
			sessionStorage.setItem(
				"mvp_lastSubtitles",
				JSON.stringify({
					channelId,
					url,
					fileId: 301,
					entry: { fileId: 301, languageCode: "en", format: "srt" },
					cues: [{ start: 1, end: 4, text: "Kept from before" }],
					delay: 0,
					position: { x: 50, y: 88 },
					fontSize: 18,
					fontFamily: "system-ui, sans-serif",
					preference: null,
					autoLoad: false,
				})
			);

		/** Has the sidebar's Player link reopen `channel`, playing `url`. */
		const playedOn = (channel: Channel, url = channel.url) => {
			sessionStorage.setItem("mvp_lastChannel", JSON.stringify(channel));
			sessionStorage.setItem("mvp_lastLoadedUrl", url);
		};

		it("shows them over the item that played on", async () => {
			tauri.fetchOmdbData.mockResolvedValue(showOmdb());
			playedOn(ep1);
			sessionStorage.setItem("mvp_lastSeriesEpisodes", JSON.stringify([ep1, ep2]));
			keepSubtitles(ep1.id, ep1.url);
			renderPlayer(null);
			await flush();
			await setMpv({ state: playing(ep1.url, 2, 1300) });
			expect(screen.getByText("Kept from before")).toBeInTheDocument();
		});

		it("shows them only once, not when the viewer comes back to the episode", async () => {
			tauri.fetchOmdbData.mockResolvedValue(showOmdb());
			playedOn(ep1);
			sessionStorage.setItem("mvp_lastSeriesEpisodes", JSON.stringify([ep1, ep2]));
			keepSubtitles(ep1.id, ep1.url);
			renderPlayer(null);
			await flush();
			await press("n");
			await press("p");
			await setMpv({ state: playing(ep1.url, 2, 1300) });
			expect(loadedUrls()).toEqual([ep2.url, ep1.url]);
			expect(screen.queryByText("Kept from before")).not.toBeInTheDocument();
		});

		it("leaves them out over another item", async () => {
			tauri.fetchOmdbData.mockResolvedValue(showOmdb());
			playedOn(ep2);
			keepSubtitles(ep1.id, ep1.url);
			renderPlayer(null);
			await flush();
			await setMpv({ state: playing(ep2.url, 2, 1300) });
			expect(screen.getByText(ep2.name)).toBeInTheDocument();
			expect(screen.queryByText("Kept from before")).not.toBeInTheDocument();
		});

		it("leaves them out over another item that plays the same URL", async () => {
			tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
			// The same movie, listed again under another id.
			playedOn(lanternKeeper({ id: "mv-copy" }));
			keepSubtitles(lanternKeeper().id, MOVIE_URL);
			renderPlayer(null);
			await flush();
			await setMpv({ state: playing(MOVIE_URL, 2, 3600) });
			expect(screen.getByText("The Lantern Keeper")).toBeInTheDocument();
			expect(screen.queryByText("Kept from before")).not.toBeInTheDocument();
		});

		it("leaves them out once mpv plays something else for the item", async () => {
			tauri.fetchOmdbData.mockResolvedValue(showOmdb());
			playedOn(ep1, ep1Mirror.url);
			keepSubtitles(ep1.id, ep1.url);
			renderPlayer(null);
			await flush();
			await setMpv({ state: playing(ep1Mirror.url, 2, 1300) });
			expect(screen.getByText(ep1.name)).toBeInTheDocument();
			expect(screen.queryByText("Kept from before")).not.toBeInTheDocument();
		});
	});

	it("moves the subtitles where they're dragged while they're being adjusted", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
		fireEvent.click(screen.getByRole("button", { name: "Adjust subtitles" }));
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(box(1000, 500));
		fireEvent.mouseDown(subtitleBox("Sample subtitle text"), { clientX: 500, clientY: 440 });
		fireEvent.mouseMove(document, { clientX: 600, clientY: 390 });
		expect(subtitleBox("Sample subtitle text").style.left).toBe("60%");
		expect(subtitleBox("Sample subtitle text").style.top).toBe("78%");
		fireEvent.mouseUp(document);
		fireEvent.mouseMove(document, { clientX: 900, clientY: 390 });
		expect(subtitleBox("Sample subtitle text").style.left).toBe("60%");
	});

	it("loads none for the next episode after the viewer turned them off", async () => {
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		await openItem(ep1, { episodes: [ep1, ep2] });
		pickEnglishSubtitles();
		fireEvent.click(screen.getByRole("button", { name: "Pick none" }));
		fireEvent.click(screen.getByRole("button", { name: "Close subtitles" }));
		await press("n");
		await flush();
		expect(loadedUrls()).toEqual([ep1.url, ep2.url]);
		expect(tauri.searchSubtitles).not.toHaveBeenCalled();
	});

	it("reads the season and episode from the name when the provider leaves them out", async () => {
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		const episode = makeChannel({
			id: "ht-205",
			name: "Harbor Tales S02E05 Storm",
			url: "https://cdn.example.test/harbor-tales/s2e5.mkv",
			contentType: "series",
		});
		await openItem(episode);
		expect(tauri.fetchOmdbData).toHaveBeenCalledWith("ht-205", "Harbor Tales", "series");
		fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
		expect(screen.getByText("Looking up tt9000002 season 2 episode 5")).toBeInTheDocument();
	});

	it("clears the subtitles when something else is opened", async () => {
		tauri.fetchOmdbData.mockImplementation(async (id) => (id === "mv1" ? lanternOmdb() : null));
		await openItem(lanternKeeper());
		pickEnglishSubtitles();
		await setMpv({ state: playing(MOVIE_URL, 2, 3600) });
		expect(screen.getByText("Mind the lantern")).toBeInTheDocument();
		await goTo({ url: harborLights().url, channel: harborLights() });
		expect(screen.queryByText("Mind the lantern")).not.toBeInTheDocument();
		expect(screen.queryByRole("dialog", { name: "Subtitle picker" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Subtitles" })).not.toBeInTheDocument();
	});

	it("has none for a live channel, so S opens nothing for Escape to close", async () => {
		await openItem(makeNewsChannel());
		await press("s");
		expect(screen.queryByRole("dialog", { name: "Subtitle picker" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Subtitles" })).not.toBeInTheDocument();
		await press("Escape");
		expect(screen.getByText("Channel list")).toBeInTheDocument();
	});
});

describe("info drawers", () => {
	it("shows a live channel's info from the I key or the button", async () => {
		await openItem(makeNewsChannel());
		await press("i");
		expect(screen.getByRole("dialog", { name: "About News 24" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Close details" }));
		expect(screen.queryByRole("dialog", { name: "About News 24" })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Channel info" }));
		expect(screen.getByRole("dialog", { name: "About News 24" })).toBeInTheDocument();
		expect(tauri.fetchOmdbData).not.toHaveBeenCalled();
	});

	it("passes a movie's details to its drawer so it doesn't look them up again", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		tauri.fetchWhatsonData.mockResolvedValue({
			imdbId: "tt9000001",
			tagline: "Keep the light burning.",
		});
		await openItem(lanternKeeper());
		await press("i");
		expect(screen.getByText("Details tt9000001, guide found")).toBeInTheDocument();
	});

	it("switches to another source of the same movie from its drawer", async () => {
		await openItem(lanternKeeper());
		fakeMpv.actions.getLastKnownPosition.mockReturnValue(900);
		await press("i");
		fireEvent.click(screen.getByRole("button", { name: "Play the second source" }));
		await flush();
		expect(fakeMpv.actions.load).toHaveBeenLastCalledWith(MIRROR_URL, 900, true);
		expect(
			screen.queryByRole("dialog", { name: "About The Lantern Keeper" })
		).not.toBeInTheDocument();
	});

	it("opens another movie from the drawer", async () => {
		await openItem(lanternKeeper());
		await press("i");
		fireEvent.click(screen.getByRole("button", { name: "Play another movie" }));
		await flush();
		expect(tauri.getPlaybackPosition).toHaveBeenLastCalledWith("movie:harbor lights");
		expect(loadedUrls()).toEqual([MOVIE_URL, harborLights().url]);
	});

	it("lists a series' episodes and plays another source or another episode from it", async () => {
		tauri.fetchOmdbData.mockResolvedValue(showOmdb());
		env.channels = [seriesCard];
		await openItem(ep1, { episodes: [ep1, ep1Mirror, ep2] });
		expect(tauri.fetchWhatsonData).toHaveBeenCalledWith("tt9000002", "show");
		await press("i");
		expect(screen.getByRole("dialog", { name: "Episodes of Show" })).toBeInTheDocument();
		expect(screen.getByText("Series card series-show")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Close episodes" }));
		expect(screen.queryByRole("dialog", { name: "Episodes of Show" })).not.toBeInTheDocument();
		await press("i");
		fireEvent.click(screen.getByRole("button", { name: "Play s1e1-b" }));
		await flush();
		expect(fakeMpv.actions.load).toHaveBeenLastCalledWith(ep1Mirror.url, undefined, true);
		expect(screen.queryByRole("dialog", { name: "Episodes of Show" })).not.toBeInTheDocument();
		await press("i");
		fireEvent.click(screen.getByRole("button", { name: "Play s1e2" }));
		await flush();
		expect(fakeMpv.actions.load).toHaveBeenLastCalledWith(ep2.url, undefined);
		expect(screen.queryByRole("dialog", { name: "Episodes of Show" })).not.toBeInTheDocument();
	});

	it("keeps playing when the episode already playing is picked from the series drawer", async () => {
		await openItem(ep1, { episodes: [ep1, ep2] });
		await setMpv({ state: playing(ep1.url, 300, 1300) });
		await press("i");
		fireEvent.click(screen.getByRole("button", { name: "Play s1e1" }));
		await flush();
		expect(screen.queryByRole("dialog", { name: "Episodes of Show" })).not.toBeInTheDocument();
		expect(loadedUrls()).toEqual([ep1.url]);
		expect(tauri.savePlaybackPosition).not.toHaveBeenCalled();
	});

	it("has no info or download for a recording, so I opens nothing for Escape to close", async () => {
		const recording = makeChannel({
			id: "rec-1",
			name: "City News",
			url: "/recordings/city-news.ts",
			contentType: "recording",
		});
		await openItem(recording);
		await press("i");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Channel info" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Download" })).not.toBeInTheDocument();
		expect(tauri.fetchOmdbData).not.toHaveBeenCalled();
		await press("Escape");
		expect(screen.getByText("Channel list")).toBeInTheDocument();
	});
});

describe("downloading from the player", () => {
	it("downloads the movie playing", async () => {
		await openItem(lanternKeeper());
		fireEvent.click(screen.getByRole("button", { name: "Download" }));
		expect(tauri.enqueueMovieDownload).toHaveBeenCalledWith("mv1");
	});

	it("downloads the episode playing under its series", async () => {
		env.channels = [seriesCard];
		await openItem(ep1, { episodes: [ep1, ep2] });
		fireEvent.click(screen.getByRole("button", { name: "Download" }));
		expect(tauri.enqueueEpisodeDownload).toHaveBeenCalledWith(
			expect.objectContaining({ id: "s1e1" }),
			"series-show",
			"Show"
		);
	});

	it("stops a download in progress after asking", async () => {
		env.downloads = [makeDownload({ id: "dl-7", channelId: "mv1", status: "downloading" })];
		await openItem(lanternKeeper());
		fireEvent.click(screen.getByRole("button", { name: "Downloading" }));
		const confirm = screen.getByRole("dialog", { name: "Stop download?" });
		fireEvent.click(within(confirm).getByRole("button", { name: "Stop" }));
		expect(tauri.stopDownload).toHaveBeenCalledWith("dl-7");
		expect(fakeMpv.actions.stop).not.toHaveBeenCalled();
	});

	it("removes a finished download after asking", async () => {
		env.downloads = [makeDownload({ id: "dl-7", channelId: "mv1", status: "completed" })];
		await openItem(lanternKeeper());
		fireEvent.click(screen.getByRole("button", { name: "Downloaded" }));
		const confirm = screen.getByRole("dialog", { name: "Remove download?" });
		fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
		await flush();
		expect(tauri.removeDownload).toHaveBeenCalledWith("dl-7");
	});
});

describe("connection and errors", () => {
	it("says the player is reconnecting and which attempt it's on", async () => {
		await openItem(makeNewsChannel());
		await setMpv({ reconnecting: true, reconnectAttempt: 3 });
		expect(screen.getByText("Connection lost")).toBeInTheDocument();
		expect(screen.getByText("Reconnecting to stream (attempt #3)…")).toBeInTheDocument();
	});

	it("offers a retry when the stream can't be loaded, in place of the play button", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: paused(MOVIE_URL, 600, 3600), loadFailed: true });
		expect(screen.getByText("Stream unavailable")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Play" })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(fakeMpv.actions.reload).toHaveBeenCalledTimes(1);
	});

	it("doesn't call it a connection problem while the stream is still opening", async () => {
		await openItem(makeNewsChannel());
		await setMpv({ buffering: true, opening: true });
		expect(screen.queryByText("Connection issues")).not.toBeInTheDocument();
		await setMpv({ opening: false });
		expect(screen.getByText("Connection issues")).toBeInTheDocument();
	});

	it("says when the connection is back", async () => {
		await openItem(makeNewsChannel());
		await setMpv({ recentlyRecovered: true });
		expect(screen.getByText("Connection restored")).toBeInTheDocument();
	});

	it("shows an error with setup help on the desktop", async () => {
		renderPlayer(null);
		await setMpv({ error: "Could not start mpv" });
		expect(screen.getByText("Could not start mpv")).toBeInTheDocument();
		expect(screen.getByText(/Check that libmpv is installed/)).toBeInTheDocument();
		expect(screen.queryByText("Select a channel to start watching")).not.toBeInTheDocument();
	});

	it("shows the error without setup help on a phone", async () => {
		env.os = "android";
		renderPlayer(null);
		await setMpv({ error: "Could not start mpv" });
		expect(screen.getByText("Could not start mpv")).toBeInTheDocument();
		expect(screen.queryByText(/Check that libmpv is installed/)).not.toBeInTheDocument();
	});

	it("explains the separate window and leaves out its own controls and skipping", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		tauri.getSkipSegments.mockResolvedValue([makeSegment()]);
		await openItem(lanternKeeper());
		await setMpv({ fallbackActive: true, state: playing(MOVIE_URL, 61, 3600) });
		expect(screen.getByText(/plays in a window of its own/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
		expect(tauri.getSkipSegments).not.toHaveBeenCalled();
	});

	it("leaves the subtitles to mpv's window", async () => {
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 2, 3600) });
		pickEnglishSubtitles();
		expect(screen.getByText("Mind the lantern")).toBeInTheDocument();
		await setMpv({ fallbackActive: true });
		expect(screen.queryByText("Mind the lantern")).not.toBeInTheDocument();
	});

	it("stops and goes to the channel list when mpv's window closes", async () => {
		await openItem(lanternKeeper());
		await setMpv({ fallbackActive: true, state: playing(MOVIE_URL, 700, 3600) });
		await setMpv({ windowClosedId: 1 });
		await flush();
		expect(fakeMpv.actions.stop).toHaveBeenCalledTimes(1);
		expect(screen.getByText("Channel list")).toBeInTheDocument();
		expect(tauri.savePlaybackPosition.mock.calls).toEqual([[MOVIE_KEY, 700, 3600]]);
		expect(tauri.recordPlayEnd).toHaveBeenCalledWith("mv1", expect.any(Number));
	});
});

describe("when the app's backend fails", () => {
	it("keeps playing and leaves normally when saving and reporting fail", async () => {
		const down = new Error("backend unavailable");
		tauri.mpvSetBounds.mockRejectedValue(down);
		tauri.recordPlayStart.mockRejectedValue(down);
		tauri.recordPlayEnd.mockRejectedValue(down);
		tauri.savePlaybackPosition.mockRejectedValue(down);
		tauri.deletePlaybackPosition.mockRejectedValue(down);
		tauri.markPositionFinished.mockRejectedValue(down);
		tauri.handOffProgress.mockRejectedValue(down);
		tauri.fetchWhatsonData.mockRejectedValue(down);
		tauri.fetchOmdbData.mockResolvedValue(lanternOmdb());
		fakeMpv.actions.load.mockRejectedValue(down);
		const radio = "http://live.example.test/harbor-radio.ts";
		await openItem(lanternKeeper());
		await setMpv({ state: paused(MOVIE_URL, 700, 3600) });
		await setMpv({ state: paused(MOVIE_URL, 20, 3600) });
		await setMpv({ state: paused(MOVIE_URL, 3590, 3600) });
		await setVisibility("hidden");
		await setVisibility("visible");
		pickSource(2);
		await goTo({ url: harborLights().url, channel: harborLights() });
		expect(tauri.recordPlayEnd).toHaveBeenCalledWith("mv1", expect.any(Number));
		await goTo({ url: radio, channelName: "Harbor Radio" });
		expect(screen.getByText("Harbor Radio")).toBeInTheDocument();
		// Leaving with a channel open records the end of it on the way out.
		await goTo({ url: harborLights().url, channel: harborLights() });
		await goToPage("/playlists");
		expect(screen.getByText("Playlists")).toBeInTheDocument();
		expect(loadedUrls()).toEqual([
			MOVIE_URL,
			MIRROR_URL,
			harborLights().url,
			radio,
			harborLights().url,
		]);
		expect(tauri.recordPlayEnd).toHaveBeenLastCalledWith("mv2", expect.any(Number));
	});

	it("starts over, retries and stops normally when forgetting, reloading and reporting fail", async () => {
		const down = new Error("backend unavailable");
		tauri.deletePlaybackPosition.mockRejectedValue(down);
		tauri.recordPlayEnd.mockRejectedValue(down);
		fakeMpv.actions.reload.mockRejectedValue(down);
		remember(saved(MOVIE_KEY, 1800, 3600));
		await openItem(lanternKeeper());
		fireEvent.click(screen.getByRole("button", { name: "Start from the beginning" }));
		await flush();
		expect(tauri.deletePlaybackPosition).toHaveBeenCalledWith(MOVIE_KEY);
		await setMpv({ state: paused(MOVIE_URL, 600, 3600), loadFailed: true });
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await flush();
		expect(fakeMpv.actions.reload).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		await flush();
		expect(tauri.recordPlayEnd).toHaveBeenCalledWith("mv1", expect.any(Number));
		expect(screen.getByText("Channel list")).toBeInTheDocument();
	});
});

describe("phones, tablets and TV boxes", () => {
	it("tells the lock screen what plays on a phone", async () => {
		env.os = "ios";
		const logo = "https://img.example.test/news24.png";
		await openItem(makeNewsChannel({ logoUrl: logo }));
		expect(tauri.mpvSetMediaInfo).toHaveBeenLastCalledWith("News 24", true, logo);
	});

	it("leaves the lock screen alone on the desktop", async () => {
		await openItem(makeNewsChannel());
		expect(tauri.mpvSetMediaInfo).not.toHaveBeenCalled();
	});

	it("leaves out the volume slider and the shortcut list on an iPad", async () => {
		setUpTouchScreen();
		await openItem(lanternKeeper());
		expect(screen.queryByRole("slider", { name: "Volume" })).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Keyboard shortcuts" })
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Fullscreen" })).toBeInTheDocument();
	});

	it("keeps the volume slider and the shortcut list on a TV box, which has a remote", async () => {
		env.os = "android";
		env.layoutMode = "tv";
		setTouchPoints(0);
		await openItem(lanternKeeper());
		expect(screen.getByRole("slider", { name: "Volume" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Keyboard shortcuts" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Fullscreen" })).toBeInTheDocument();
	});
});

describe("remote control", () => {
	it("is the player other devices' commands go to while it's open", async () => {
		const view = await openItem(makeNewsChannel());
		expect(getMountedPlayer()?.getState().item?.ref).toBe("ch1");
		view.unmount();
		expect(getMountedPlayer()).toBeNull();
	});
});

describe("AirPlay", () => {
	const tvState = (patch: Partial<PlaybackState> = {}) =>
		playbackState({
			item: { title: "The Lantern Keeper", contentType: "movie", ref: "mv1" },
			volume: 100,
			subtitles: [{ id: "0", label: "English" }],
			audio: [
				{ id: "0", label: "Main" },
				{ id: "1", label: "Commentary" },
			],
			audioId: "0",
			...patch,
		});

	const tv = () => ({
		...fakeDestination(
			"airplay",
			"Living Room TV",
			tvState(),
			playbackCapabilities({ volume: "none", subtitles: "select", audioTracks: true })
		),
		notPicked: false,
		dispose: vi.fn(),
	});

	const airplayButton = () => screen.queryByRole("button", { name: "AirPlay" });

	it("is only on for iOS and macOS, and knows which", async () => {
		const last = (list: boolean[]) => list[list.length - 1];
		await openItem(lanternKeeper());
		expect(last(fakeAirPlay.enabled)).toBe(true);
		expect(last(fakeAirPlay.macs)).toBe(true);
		setUpTouchScreen();
		await goTo({ url: MOVIE_URL, channel: lanternKeeper() });
		expect(last(fakeAirPlay.enabled)).toBe(true);
		expect(last(fakeAirPlay.macs)).toBe(false);
		env.os = "linux";
		fakeAirPlay.enabled = [];
		await goTo({ url: MOVIE_URL, channel: lanternKeeper() });
		expect(fakeAirPlay.enabled.every((on) => !on)).toBe(true);
	});

	it("asks the panel ahead once a receiver is in reach", async () => {
		await openItem(lanternKeeper());
		expect(tauri.warmStreamFormats).not.toHaveBeenCalled();
		act(() => fakeAirPlay.set({ available: true }));
		await flush();
		expect(tauri.warmStreamFormats).toHaveBeenCalledWith(
			expect.objectContaining({ id: "mv1" })
		);
	});

	it("doesn't mind a panel that can't be asked ahead", async () => {
		tauri.warmStreamFormats.mockRejectedValueOnce(new Error("offline"));
		fakeAirPlay.set({ available: true });
		await openItem(lanternKeeper());
		await flush();
		expect(tauri.warmStreamFormats).toHaveBeenCalled();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("shows its button only while a receiver is in reach", async () => {
		await openItem(lanternKeeper());
		expect(airplayButton()).toBeNull();
		act(() => fakeAirPlay.set({ available: true }));
		expect(airplayButton()).not.toBeNull();
	});

	it("sends the movie from where it is, after stopping it here", async () => {
		fakeAirPlay.set({ available: true });
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 600, 5400) });
		fireEvent.click(airplayButton()!);
		await flush();
		const send = vi.mocked(fakeAirPlay.get().send);
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({ id: "mv1" }),
			expect.objectContaining({ startAt: 600 })
		);
		expect(send.mock.calls[0][1].anchor).toBeDefined();
		expect(fakeMpv.actions.stop).not.toHaveBeenCalled();
		await act(() => send.mock.calls[0][1].stopLocal());
		expect(fakeMpv.actions.stop).toHaveBeenCalled();
		expect(tauri.savePlaybackPosition).toHaveBeenCalled();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("asks before this device converts the stream", async () => {
		fakeAirPlay.set({ available: true });
		await openItem(lanternKeeper());
		const send = vi.mocked(fakeAirPlay.get().send);
		let answered: boolean | null = null;
		send.mockImplementationOnce(async (_, opts) => {
			answered = await opts.confirm();
			return { sent: true };
		});
		fireEvent.click(airplayButton()!);
		await flush();
		const dialog = screen.getByRole("dialog", { name: "Convert on this device?" });
		expect(dialog.textContent).toContain("This Mac converts the stream");
		fireEvent.click(within(dialog).getByRole("button", { name: "Send to TV" }));
		await flush();
		expect(answered).toBe(true);
	});

	it("says an iPhone converts on iOS", async () => {
		setUpTouchScreen();
		fakeAirPlay.set({ available: true });
		await openItem(lanternKeeper());
		vi.mocked(fakeAirPlay.get().send).mockImplementationOnce(async (_, opts) => {
			await opts.confirm();
			return { sent: true };
		});
		fireEvent.click(airplayButton()!);
		await flush();
		const dialog = screen.getByRole("dialog", { name: "Convert on this device?" });
		expect(dialog.textContent).toContain("This iPhone converts the stream");
	});

	it("says to pick this device to play here only where the sound moved", async () => {
		await openItem(lanternKeeper());
		act(() => fakeAirPlay.set({ destination: tv(), state: tvState() }));
		expect(screen.queryByText(/Choose this iPhone/)).toBeNull();
		setUpTouchScreen();
		await goTo({ url: MOVIE_URL, channel: lanternKeeper() });
		expect(screen.getByText(/Choose this iPhone/)).toBeInTheDocument();
	});

	it("sends live from now", async () => {
		fakeAirPlay.set({ available: true });
		await openItem(makeNewsChannel());
		await setMpv({ state: playing(NEWS_URL, 30, 0) });
		fireEvent.click(airplayButton()!);
		await flush();
		expect(vi.mocked(fakeAirPlay.get().send).mock.calls[0][1].startAt).toBeUndefined();
	});

	it("says why it can't send, and nothing when the picker is closed", async () => {
		fakeAirPlay.set({ available: true });
		await openItem(lanternKeeper());
		const send = vi.mocked(fakeAirPlay.get().send);
		send.mockResolvedValueOnce({ sent: false, why: "cancelled" });
		fireEvent.click(airplayButton()!);
		await flush();
		expect(screen.queryByRole("alert")).toBeNull();

		send.mockResolvedValueOnce({
			sent: false,
			why: "blocked",
			decision: { ok: false, reason: "container", detail: "mkv" },
		});
		fireEvent.click(airplayButton()!);
		await flush();
		expect(screen.getByRole("alert").textContent).toBe("AirPlay can't play MKV files.");

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const error = new Error("x");
		send.mockResolvedValueOnce({ sent: false, why: "failed", error, stopped: false });
		fireEvent.click(airplayButton()!);
		await flush();
		expect(screen.getByRole("alert").textContent).toBe("Couldn't start AirPlay.");
		expect(warn).toHaveBeenCalledWith("[VideoPlayer] AirPlay failed:", error);

		send.mockResolvedValueOnce({
			sent: false,
			why: "failed",
			error: "refused",
			stopped: false,
		});
		fireEvent.click(airplayButton()!);
		await flush();
		expect(screen.getByRole("alert").textContent).toMatch(/^The provider refused the stream/);

		send.mockResolvedValueOnce({
			sent: false,
			why: "failed",
			error: "Connect to Wi-Fi to send this to the TV.",
			stopped: false,
		});
		fireEvent.click(airplayButton()!);
		await flush();
		expect(screen.getByRole("alert").textContent).toBe(
			"Connect to Wi-Fi to send this to the TV."
		);
	});

	it("covers the player with its own controls while the TV plays", async () => {
		await openItem(lanternKeeper());
		const destination = tv();
		act(() => fakeAirPlay.set({ available: true, destination, state: tvState() }));
		const panel = screen.getByRole("region", { name: "AirPlay" });
		expect(panel).toHaveTextContent("Playing on Living Room TV");
		expect(airplayButton()).toBeNull();
		expect(screen.queryByRole("button", { name: "Download" })).toBeNull();

		fireEvent.click(within(panel).getByRole("button", { name: "Pause" }));
		expect(destination.pause).toHaveBeenCalled();
		act(() => fakeAirPlay.set({ state: tvState({ status: "paused" }) }));
		fireEvent.click(within(panel).getByRole("button", { name: "Play" }));
		expect(destination.play).toHaveBeenCalled();
		fireEvent.keyDown(within(panel).getByRole("slider", { name: "Seek" }), { key: "End" });
		expect(destination.seek).toHaveBeenCalledWith(5400);
		fireEvent.change(within(panel).getByRole("combobox", { name: "Subtitles" }), {
			target: { value: "0" },
		});
		expect(destination.selectSubtitle).toHaveBeenCalledWith("0");
		fireEvent.change(within(panel).getByRole("combobox", { name: "Audio" }), {
			target: { value: "1" },
		});
		expect(destination.selectAudio).toHaveBeenCalledWith("1");
	});

	it("plays here again from where the TV was", async () => {
		await openItem(lanternKeeper());
		fakeMpv.actions.load.mockClear();
		act(() => fakeAirPlay.set({ destination: tv(), state: tvState() }));
		// The last reading came too soon after the one before to be saved.
		act(() => fakeAirPlay.set({ state: tvState({ position: 605 }) }));
		await flush();
		vi.mocked(tauri.savePlaybackPosition).mockClear();
		act(() => fakeAirPlay.set({ state: tvState({ position: 606 }) }));
		await flush();
		expect(tauri.savePlaybackPosition).not.toHaveBeenCalled();
		const returnHere = vi.mocked(fakeAirPlay.get().returnHere);
		let letGo: () => void = () => {};
		returnHere.mockReturnValueOnce(new Promise((r) => (letGo = r)));
		fireEvent.click(screen.getByRole("button", { name: "Play here from 10:06" }));
		await flush();
		// It waits for AirPlay to let go of the stream and the sound.
		expect(returnHere).toHaveBeenCalledWith(expect.any(Object));
		expect(fakeMpv.actions.load).not.toHaveBeenCalled();
		// The position the TV had is saved as soon as Play here is pressed.
		expect(tauri.savePlaybackPosition).toHaveBeenCalledWith(MOVIE_KEY, 606, 5400);
		await act(async () => letGo());
		await flush();
		expect(fakeMpv.actions.load).toHaveBeenCalledWith(MOVIE_URL, 606);
	});

	it("plays here again from where it was when no TV took the video", async () => {
		fakeAirPlay.set({ available: true });
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 600, 5400) });
		fireEvent.click(airplayButton()!);
		await flush();
		const send = vi.mocked(fakeAirPlay.get().send);
		await act(() => send.mock.calls[0][1].stopLocal());
		act(() => fakeAirPlay.set({ destination: tv(), state: tvState({ status: "opening" }) }));
		await flush();
		fakeMpv.actions.load.mockClear();
		const stop = vi.mocked(fakeAirPlay.get().stop);
		expect(stop).not.toHaveBeenCalled();
		act(() => fakeAirPlay.set({ notPicked: true }));
		await flush();
		expect(stop).toHaveBeenCalledTimes(1);
		expect(fakeMpv.actions.load).toHaveBeenCalledWith(MOVIE_URL, 600);
		// AirPlay let go first.
		expect(stop.mock.invocationCallOrder[0]).toBeLessThan(
			fakeMpv.actions.load.mock.invocationCallOrder[0]
		);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("says so when it can't play here again after no TV took the video", async () => {
		await openItem(lanternKeeper());
		fakeMpv.actions.load.mockRejectedValueOnce(new Error("no"));
		act(() => fakeAirPlay.set({ destination: tv(), state: tvState() }));
		act(() => fakeAirPlay.set({ notPicked: true }));
		await flush();
		expect(screen.getByRole("alert").textContent).toBe("Couldn't play it on this device.");
	});

	it("keeps its notice below the notch and on the screen", async () => {
		setUpTouchScreen();
		await openItem(lanternKeeper());
		fakeMpv.actions.load.mockRejectedValueOnce(new Error("no"));
		act(() => fakeAirPlay.set({ destination: tv(), state: tvState() }));
		fireEvent.click(screen.getByRole("button", { name: "Play here from 10:00" }));
		await flush();
		const notice = screen.getByRole("alert");
		expect(notice.classList).toContain("top-[calc(1rem+env(safe-area-inset-top))]");
		expect(notice.classList).not.toContain("top-4");
		expect(notice.classList).toContain("max-w-[calc(100%-2rem)]");
	});

	it("says so when it can't play here again", async () => {
		await openItem(lanternKeeper());
		fakeMpv.actions.load.mockRejectedValueOnce(new Error("no"));
		act(() => fakeAirPlay.set({ destination: tv(), state: tvState() }));
		fireEvent.click(screen.getByRole("button", { name: "Play here from 10:00" }));
		await flush();
		expect(screen.getByRole("alert").textContent).toBe("Couldn't play it on this device.");
	});

	it("plays live here again from now", async () => {
		await openItem(makeNewsChannel());
		fakeMpv.actions.load.mockClear();
		const destination = { ...tv(), capabilities: { ...tv().capabilities, resumeAt: false } };
		act(() => fakeAirPlay.set({ destination, state: tvState({ duration: 0 }) }));
		fireEvent.click(screen.getByRole("button", { name: "Play here" }));
		await flush();
		expect(fakeMpv.actions.load).toHaveBeenCalledWith(NEWS_URL, undefined);
	});

	it("stops AirPlay and leaves the player", async () => {
		await openItem(lanternKeeper());
		act(() => fakeAirPlay.set({ destination: tv(), state: tvState() }));
		const panel = screen.getByRole("region", { name: "AirPlay" });
		act(() => fakeAirPlay.set({ state: tvState({ position: 700 }) }));
		await flush();
		vi.mocked(tauri.savePlaybackPosition).mockClear();
		act(() => fakeAirPlay.set({ state: tvState({ position: 701 }) }));
		await flush();
		const stop = vi.mocked(fakeAirPlay.get().stop);
		let stopped: () => void = () => {};
		stop.mockReturnValueOnce(new Promise((r) => (stopped = r)));
		fireEvent.click(within(panel).getByRole("button", { name: "Stop" }));
		await flush();
		// It saves where the TV was, and leaves once AirPlay has stopped.
		expect(tauri.savePlaybackPosition).toHaveBeenCalledWith(MOVIE_KEY, 701, 5400);
		expect(screen.queryByText("Channel list")).toBeNull();
		await act(async () => stopped());
		await flush();
		expect(screen.getByText("Channel list")).toBeTruthy();
	});

	it("drives the TV with the keyboard, and starts nothing here", async () => {
		await openItem(lanternKeeper(), { episodes: [] });
		fakeMpv.actions.load.mockClear();
		const destination = tv();
		// A reading from just now.
		destination.getState.mockReturnValue(tvState({ positionAt: performance.now() }));
		act(() => fakeAirPlay.set({ destination, state: tvState() }));
		await press(" ");
		expect(destination.pause).toHaveBeenCalledTimes(1);
		expect(destination.play).not.toHaveBeenCalled();
		expect(destination.seek).not.toHaveBeenCalled();
		expect(fakeMpv.actions.pause).not.toHaveBeenCalled();
		await press("ArrowRight");
		expect(destination.seek).toHaveBeenCalledWith(expect.closeTo(610, 0));
		expect(destination.play).not.toHaveBeenCalled();
		expect(destination.pause).toHaveBeenCalledTimes(1);
		await press("5");
		expect(destination.seek).toHaveBeenLastCalledWith(2700);
		// Volume, info and the rest do nothing.
		await press("ArrowUp");
		await press("i");
		expect(fakeMpv.actions.setVolume).not.toHaveBeenCalled();
		expect(fakeMpv.actions.load).not.toHaveBeenCalled();
		expect(fakeMpv.actions.play).not.toHaveBeenCalled();
	});

	it("says when a seek on the TV fails, from the keys or the panel", async () => {
		await openItem(lanternKeeper(), { episodes: [] });
		const destination = tv();
		destination.seek.mockRejectedValueOnce("refused");
		act(() => fakeAirPlay.set({ destination, state: tvState() }));
		await press("ArrowRight");
		await flush();
		expect(screen.getByText(/^The provider refused the stream/)).toBeTruthy();

		destination.seek.mockRejectedValueOnce(new Error("gone"));
		const panel = screen.getByRole("region", { name: "AirPlay" });
		fireEvent.keyDown(within(panel).getByRole("slider", { name: "Seek" }), { key: "End" });
		await flush();
		expect(screen.getByText("Couldn't move the stream on the TV.")).toBeTruthy();
	});

	it("says nothing when a control other than a seek fails, which the TV shows", async () => {
		await openItem(lanternKeeper());
		const destination = tv();
		destination.pause.mockRejectedValueOnce(new Error("gone"));
		act(() => fakeAirPlay.set({ destination, state: tvState() }));
		const panel = screen.getByRole("region", { name: "AirPlay" });
		fireEvent.click(within(panel).getByRole("button", { name: "Pause" }));
		await flush();
		expect(destination.pause).toHaveBeenCalled();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("keeps Back over the TV's view on a phone, and leaves the title to the view", async () => {
		setUpTouchScreen("mobile");
		await openItem(lanternKeeper());
		act(() => fakeAirPlay.set({ destination: tv(), state: tvState() }));
		const back = screen.getByRole("button", { name: "Back" });
		const bar = back.parentElement!;
		expect(bar).toHaveClass("z-40");
		expect(bar).not.toHaveTextContent("The Lantern Keeper");
		fireEvent.click(back);
		await flush();
		expect(screen.getByText("Channel list")).toBeTruthy();
	});

	it("gives the view the player's touch layout and skip lengths", async () => {
		writeSkipInterval("back", 5);
		await openItem(lanternKeeper());
		act(() => fakeAirPlay.set({ destination: tv(), state: tvState() }));
		const panel = screen.getByRole("region", { name: "AirPlay" });
		expect(within(panel).getByRole("button", { name: "Skip back 5 seconds" })).toBeTruthy();
		cleanup();
		setUpTouchScreen();
		await openItem(lanternKeeper());
		act(() => fakeAirPlay.set({ destination: tv(), state: tvState() }));
		// On touch, Play and Pause sit in the middle, with the skips beside them.
		const touch = screen.getByRole("region", { name: "AirPlay" });
		expect(
			within(touch).getByRole("button", { name: "Pause" }).closest(".pointer-events-none")
		).toBeTruthy();
	});

	it("plays a paused TV from the keyboard", async () => {
		await openItem(lanternKeeper());
		const destination = {
			...tv(),
			getState: vi.fn<() => PlaybackState>().mockReturnValue(tvState({ status: "paused" })),
		};
		act(() => fakeAirPlay.set({ destination, state: tvState({ status: "paused" }) }));
		await press(" ");
		expect(destination.play).toHaveBeenCalled();
		expect(destination.pause).not.toHaveBeenCalled();
		expect(destination.seek).not.toHaveBeenCalled();
	});

	it("still goes full screen from the keyboard", async () => {
		await openItem(lanternKeeper());
		act(() => fakeAirPlay.set({ destination: tv(), state: tvState() }));
		await press("f");
		expect(fullscreenSpy).toHaveBeenCalledWith(true);
	});

	it("saves the position on the TV as the resume point", async () => {
		await openItem(lanternKeeper());
		vi.mocked(tauri.savePlaybackPosition).mockClear();
		act(() => fakeAirPlay.set({ destination: tv(), state: tvState({ position: 900 }) }));
		await flush();
		// The first reading saves at once, then every few seconds.
		act(() => fakeAirPlay.set({ state: tvState({ position: 901 }) }));
		await flush();
		act(() => fakeAirPlay.set({ state: tvState({ position: 1200, status: "paused" }) }));
		await flush();
		expect(tauri.savePlaybackPosition).toHaveBeenLastCalledWith(MOVIE_KEY, 1200, 5400);
		// No length yet, or the very start, saves nothing.
		vi.mocked(tauri.savePlaybackPosition).mockClear();
		act(() =>
			fakeAirPlay.set({ state: tvState({ position: 1300, duration: 0, status: "paused" }) })
		);
		act(() => fakeAirPlay.set({ state: tvState({ position: 0.5, status: "paused" }) }));
		await flush();
		expect(tauri.savePlaybackPosition).not.toHaveBeenCalled();
	});

	it("says so in the player when AirPlay fails after this device stopped", async () => {
		fakeAirPlay.set({ available: true });
		await openItem(lanternKeeper());
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.mocked(fakeAirPlay.get().send).mockResolvedValueOnce({
			sent: false,
			why: "failed",
			error: new Error("nope"),
			stopped: true,
		});
		fireEvent.click(airplayButton()!);
		await act(async () => {
			for (let i = 0; i < 30; i++) await Promise.resolve();
		});
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toBe("Couldn't start AirPlay. Nothing is playing.");
		act(() => vi.advanceTimersByTime(5999));
		expect(screen.queryByRole("alert")).not.toBeNull();
		act(() => vi.advanceTimersByTime(1));
		expect(screen.queryByRole("alert")).toBeNull();

		// A second note gets its own six seconds, whatever the first one's
		// timer had left.
		vi.mocked(fakeAirPlay.get().send).mockResolvedValueOnce({
			sent: false,
			why: "failed",
			error: "nope",
			stopped: true,
		});
		fireEvent.click(airplayButton()!);
		await act(async () => {
			for (let i = 0; i < 30; i++) await Promise.resolve();
		});
		act(() => vi.advanceTimersByTime(3000));
		fakeMpv.actions.load.mockRejectedValueOnce(new Error("no"));
		act(() => fakeAirPlay.set({ destination: tv(), state: tvState() }));
		fireEvent.click(screen.getByRole("button", { name: "Play here from 10:00" }));
		await act(async () => {
			for (let i = 0; i < 30; i++) await Promise.resolve();
		});
		expect(screen.getByRole("alert").textContent).toBe("Couldn't play it on this device.");
		act(() => vi.advanceTimersByTime(3500));
		expect(screen.getByRole("alert").textContent).toBe("Couldn't play it on this device.");
	});
});

describe("Google Cast", () => {
	const castState = (patch: Partial<PlaybackState> = {}) =>
		playbackState({
			item: { title: "The Lantern Keeper", contentType: "movie", ref: "mv1" },
			...patch,
		});

	const receiver = (id: string, name: string, available = true) => ({
		id,
		name,
		model: "Chromecast",
		status: null,
		available,
	});

	const tv = () => ({
		...fakeDestination("cast", "Hotel TV", castState()),
		receive: vi.fn(),
		closedReason: vi.fn(() => null),
	});

	const castButton = () => screen.queryByRole("button", { name: "Cast" });

	it("is only on for macOS and Linux", async () => {
		await openItem(lanternKeeper());
		expect(fakeCast.enabled[fakeCast.enabled.length - 1]).toBe(true);
		env.os = "linux";
		fakeCast.enabled = [];
		await goTo({ url: MOVIE_URL, channel: lanternKeeper() });
		expect(fakeCast.enabled[fakeCast.enabled.length - 1]).toBe(true);
		env.os = "macos";
		setUpTouchScreen();
		fakeCast.enabled = [];
		await goTo({ url: MOVIE_URL, channel: lanternKeeper() });
		expect(fakeCast.enabled.every((on) => !on)).toBe(true);
	});

	it("shows its button once a receiver is found", async () => {
		await openItem(lanternKeeper());
		expect(castButton()).toBeNull();
		act(() => fakeCast.set({ receivers: [receiver("cast:tv", "Hotel TV")] }));
		expect(castButton()).not.toBeNull();
	});

	it("lists the receivers with how this item gets there, and casts from where it is", async () => {
		fakeCast.set({
			receivers: [receiver("cast:tv", "Hotel TV"), receiver("cast:den", "Den", false)],
			statuses: new Map([["cast:tv", { via: "direct" as const }]]),
		});
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 600, 5400) });
		fireEvent.click(castButton()!);
		await flush();
		expect(fakeCast.get().check).toHaveBeenCalledWith(expect.objectContaining({ id: "mv1" }));
		const picker = screen.getByRole("dialog", { name: "Play on" });
		const group = within(picker).getByRole("region", { name: "Google Cast" });
		expect(within(group).getByText("Plays directly")).toBeTruthy();
		expect(within(group).getByText("Can't be reached")).toBeTruthy();
		fireEvent.click(within(group).getByRole("button", { name: /Hotel TV/ }));
		await flush();
		expect(fakeCast.get().release).toHaveBeenCalled();
		const send = vi.mocked(fakeCast.get().send);
		expect(send).toHaveBeenCalledWith(
			"cast:tv",
			expect.objectContaining({ id: "mv1" }),
			expect.objectContaining({ startAt: 600 })
		);
		expect(fakeMpv.actions.stop).not.toHaveBeenCalled();
		await act(() => send.mock.calls[0][2].stopLocal());
		expect(fakeMpv.actions.stop).toHaveBeenCalled();
		expect(tauri.savePlaybackPosition).toHaveBeenCalled();
	});

	it("asks before this computer converts, and casts live from now", async () => {
		fakeCast.set({
			receivers: [receiver("cast:tv", "Hotel TV")],
			statuses: new Map([["cast:tv", { via: "converted" as const, keep: "on" as const }]]),
		});
		await openItem(makeNewsChannel());
		await setMpv({ state: playing(NEWS_URL, 30, 0) });
		fireEvent.click(castButton()!);
		await flush();
		fireEvent.click(screen.getByRole("button", { name: /Hotel TV/ }));
		const send = vi.mocked(fakeCast.get().send);
		expect(send).not.toHaveBeenCalled();
		expect(screen.getByText(/needs this computer to stay on/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
		await flush();
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0][2].startAt).toBeUndefined();
	});

	it("puts away a note about an earlier cast once one starts", async () => {
		fakeCast.set({
			receivers: [receiver("cast:tv", "Hotel TV")],
			statuses: new Map([["cast:tv", { via: "direct" as const }]]),
		});
		await openItem(lanternKeeper());
		const castTo = async () => {
			fireEvent.click(castButton()!);
			await flush();
			fireEvent.click(screen.getByRole("button", { name: /Hotel TV/ }));
			await flush();
		};
		act(() => fakeCast.report("Lost the connection to Hotel TV."));
		await castTo();
		expect(screen.queryByRole("alert")).toBeNull();
		// Nor a note that one didn't start.
		vi.mocked(fakeCast.get().send).mockResolvedValueOnce("Couldn't reach Hotel TV.");
		await castTo();
		expect(screen.getByRole("alert").textContent).toBe("Couldn't reach Hotel TV.");
		await castTo();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("keeps a note about AirPlay up when a cast starts", async () => {
		fakeAirPlay.set({ available: true });
		await openItem(lanternKeeper());
		vi.mocked(fakeAirPlay.get().send).mockResolvedValueOnce({
			sent: false,
			why: "blocked",
			decision: { ok: false, reason: "container", detail: "mkv" },
		});
		fireEvent.click(screen.getByRole("button", { name: "AirPlay" }));
		await flush();
		expect(screen.getByRole("alert").textContent).toBe("AirPlay can't play MKV files.");
		act(() => {
			fakeAirPlay.set({ available: false });
			fakeCast.set({
				receivers: [receiver("cast:tv", "Hotel TV")],
				statuses: new Map([["cast:tv", { via: "direct" as const }]]),
			});
		});
		fireEvent.click(castButton()!);
		await flush();
		fireEvent.click(screen.getByRole("button", { name: /Hotel TV/ }));
		await flush();
		expect(vi.mocked(fakeCast.get().send)).toHaveBeenCalled();
		expect(screen.getByRole("alert").textContent).toBe("AirPlay can't play MKV files.");
	});

	it("keeps a note about AirPlay's seek from the keys up when a cast starts", async () => {
		await openItem(lanternKeeper());
		const airplayTv = { ...tv(), id: "airplay:tv", kind: "airplay" as const };
		airplayTv.seek.mockRejectedValueOnce("");
		act(() =>
			fakeAirPlay.set({
				destination: airplayTv as unknown as AirPlay["destination"],
				state: castState(),
			})
		);
		await press("ArrowRight");
		expect(screen.getByRole("alert").textContent).toBe("Couldn't move the stream on the TV.");
		act(() => {
			fakeAirPlay.set({ destination: null, state: null });
			fakeCast.set({
				receivers: [receiver("cast:tv", "Hotel TV")],
				statuses: new Map([["cast:tv", { via: "direct" as const }]]),
			});
		});
		fireEvent.click(castButton()!);
		await flush();
		fireEvent.click(screen.getByRole("button", { name: /Hotel TV/ }));
		await flush();
		expect(screen.getByRole("alert").textContent).toBe("Couldn't move the stream on the TV.");
	});

	it("says why a cast didn't start", async () => {
		fakeCast.set({
			receivers: [receiver("cast:tv", "Hotel TV")],
			statuses: new Map([["cast:tv", { via: "direct" as const }]]),
		});
		vi.mocked(fakeCast.get().send).mockResolvedValueOnce("Couldn't reach Hotel TV.");
		await openItem(lanternKeeper());
		fireEvent.click(castButton()!);
		await flush();
		fireEvent.click(screen.getByRole("button", { name: /Hotel TV/ }));
		await flush();
		expect(screen.getByRole("alert").textContent).toBe("Couldn't reach Hotel TV.");
	});

	it("covers the player with the receiver's controls while it casts", async () => {
		await openItem(lanternKeeper());
		const destination = tv();
		act(() =>
			fakeCast.set({
				destination: destination as unknown as CastDestination,
				state: castState({ status: "paused" }),
			})
		);
		const panel = screen.getByRole("region", { name: "Google Cast" });
		expect(panel).toHaveTextContent("Playing on Hotel TV");
		expect(screen.queryByRole("button", { name: "Cast" })).toBeNull();
		fireEvent.click(within(panel).getByRole("button", { name: "Play" }));
		expect(destination.play).toHaveBeenCalled();
		fireEvent.keyDown(within(panel).getByRole("slider", { name: "Seek" }), { key: "End" });
		expect(destination.seek).toHaveBeenCalledWith(5400);
		const volume = within(panel).getByRole("slider", { name: "Volume" });
		expect(volume).toHaveAttribute("aria-valuemax", "100");
		fireEvent.keyDown(volume, { key: "End" });
		expect(destination.setVolume).toHaveBeenCalledWith(100);
	});

	it("says it stopped once the receiver let go and nothing else came", async () => {
		await openItem(lanternKeeper());
		act(() =>
			fakeCast.set({
				destination: tv() as unknown as CastDestination,
				state: castState({ status: "idle" }),
			})
		);
		const panel = screen.getByRole("region", { name: "Google Cast" });
		expect(panel).toHaveTextContent("Stopped on Hotel TV");
		expect(within(panel).queryByRole("button", { name: "Play" })).toBeNull();
		expect(within(panel).getByRole("button", { name: "Play here from 10:00" })).toBeTruthy();
		// Idle with nothing loaded yet is still casting, with nothing to drive.
		act(() => fakeCast.set({ state: castState({ status: "idle", item: null }) }));
		expect(panel).toHaveTextContent("Nothing playing on Hotel TV");
		expect(within(panel).queryByRole("button", { name: "Stop" })).toBeNull();
	});

	it("plays here again from where the receiver was", async () => {
		await openItem(lanternKeeper());
		fakeMpv.actions.load.mockClear();
		act(() =>
			fakeCast.set({
				destination: tv() as unknown as CastDestination,
				state: castState({ status: "paused" }),
			})
		);
		fireEvent.click(screen.getByRole("button", { name: "Play here from 10:00" }));
		await flush();
		expect(fakeCast.get().stop).toHaveBeenCalled();
		expect(fakeMpv.actions.load).toHaveBeenCalledWith(MOVIE_URL, 600);
	});

	it("stops the cast and leaves the player", async () => {
		await openItem(lanternKeeper());
		act(() =>
			fakeCast.set({
				destination: tv() as unknown as CastDestination,
				state: castState(),
			})
		);
		const panel = screen.getByRole("region", { name: "Google Cast" });
		fireEvent.click(within(panel).getByRole("button", { name: "Stop" }));
		await flush();
		expect(fakeCast.get().stop).toHaveBeenCalled();
		expect(screen.getByText("Channel list")).toBeTruthy();
	});

	it("says why a cast ended by itself, until it's dismissed", async () => {
		await openItem(lanternKeeper());
		act(() => fakeCast.report("Lost the connection to Hotel TV."));
		expect(screen.getByRole("alert").textContent).toBe("Lost the connection to Hotel TV.");
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("puts a note away after a while", async () => {
		vi.useFakeTimers();
		await openItem(lanternKeeper());
		act(() => fakeCast.report("Lost the connection to Hotel TV."));
		act(() => vi.advanceTimersByTime(5999));
		expect(screen.queryByRole("alert")).not.toBeNull();
		act(() => vi.advanceTimersByTime(1));
		expect(screen.queryByRole("alert")).toBeNull();
		vi.useRealTimers();
	});

	it("shows its button with no receivers when it knows why, and says why", async () => {
		await openItem(lanternKeeper());
		act(() => fakeCast.set({ vpnActive: true }));
		fireEvent.click(castButton()!);
		await flush();
		expect(screen.getByRole("dialog", { name: "Play on" }).textContent).toContain(
			"A VPN is on."
		);
		fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
		act(() => fakeCast.set({ vpnActive: false, localNetworkDenied: true }));
		expect(castButton()).not.toBeNull();
		act(() => fakeCast.set({ localNetworkDenied: false }));
		expect(castButton()).toBeNull();
	});

	it("says why a control failed while the cast is still connected", async () => {
		await openItem(lanternKeeper());
		const destination = tv();
		destination.play.mockRejectedValueOnce("refused");
		destination.pause.mockRejectedValueOnce("notConnected");
		act(() =>
			fakeCast.set({
				destination: destination as unknown as CastDestination,
				state: castState({ status: "paused" }),
			})
		);
		const panel = screen.getByRole("region", { name: "Google Cast" });
		fireEvent.click(within(panel).getByRole("button", { name: "Play" }));
		await flush();
		expect(screen.getByRole("alert").textContent).toBe(
			"The provider refused the stream. The login may have expired."
		);
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		act(() => fakeCast.set({ state: castState() }));
		fireEvent.click(within(panel).getByRole("button", { name: "Pause" }));
		await flush();
		expect(screen.getByRole("alert").textContent).toBe("Hotel TV didn't respond.");
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		// Once the connection is going, the cast says so itself.
		destination.getState.mockReturnValue(castState({ connection: "reconnecting" }));
		destination.seek.mockRejectedValueOnce("unreachable");
		fireEvent.keyDown(within(panel).getByRole("slider", { name: "Seek" }), { key: "End" });
		await flush();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("says in its own words why the receiver stopped", async () => {
		await openItem(lanternKeeper());
		act(() =>
			fakeCast.set({
				destination: tv() as unknown as CastDestination,
				state: castState({ error: { code: "failed", message: "unreachable" } }),
			})
		);
		const panel = screen.getByRole("region", { name: "Google Cast" });
		expect(within(panel).getByRole("status")).toHaveTextContent("Couldn't reach Hotel TV.");
	});

	it("shows no panel for a receiver whose state hasn't come yet", async () => {
		await openItem(lanternKeeper());
		act(() => fakeCast.set({ destination: tv() as unknown as CastDestination, state: null }));
		expect(screen.queryByRole("region", { name: "Google Cast" })).toBeNull();
	});

	it("saves where the receiver was before it plays here", async () => {
		await openItem(lanternKeeper());
		act(() =>
			fakeCast.set({
				destination: tv() as unknown as CastDestination,
				state: castState({ position: 700 }),
			})
		);
		await flush();
		vi.mocked(tauri.savePlaybackPosition).mockClear();
		act(() => fakeCast.set({ state: castState({ position: 701 }) }));
		await flush();
		expect(tauri.savePlaybackPosition).not.toHaveBeenCalled();
		const stop = vi.mocked(fakeCast.get().stop);
		stop.mockReturnValueOnce(new Promise(() => {}));
		fireEvent.click(screen.getByRole("button", { name: /^Play here from 11:4/ }));
		await flush();
		expect(tauri.savePlaybackPosition).toHaveBeenCalledWith(MOVIE_KEY, 701, 5400);
	});

	it("saves where the receiver was when it stops", async () => {
		await openItem(lanternKeeper());
		act(() =>
			fakeCast.set({
				destination: tv() as unknown as CastDestination,
				state: castState({ position: 700 }),
			})
		);
		await flush();
		vi.mocked(tauri.savePlaybackPosition).mockClear();
		act(() => fakeCast.set({ state: castState({ position: 701 }) }));
		await flush();
		expect(tauri.savePlaybackPosition).not.toHaveBeenCalled();
		fakeCast.get().stop = vi.fn(() => new Promise<void>(() => {}));
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		await flush();
		expect(tauri.savePlaybackPosition).toHaveBeenCalledWith(MOVIE_KEY, 701, 5400);
	});

	it("plays live here again from now, and says so when it can't", async () => {
		await openItem(makeNewsChannel());
		fakeMpv.actions.load.mockClear();
		act(() =>
			fakeCast.set({
				destination: tv() as unknown as CastDestination,
				state: castState({ duration: 0, status: "paused" }),
			})
		);
		fakeMpv.actions.load.mockRejectedValueOnce(new Error("no"));
		fireEvent.click(screen.getByRole("button", { name: "Play here" }));
		await flush();
		expect(fakeMpv.actions.load).toHaveBeenCalledWith(NEWS_URL, undefined);
		expect(screen.getByRole("alert").textContent).toBe("Couldn't play it on this device.");
	});

	describe("changing what plays while it casts", () => {
		const casting = (converted = false) => {
			const destination = { ...tv(), converted: vi.fn(() => converted) };
			act(() =>
				fakeCast.set({
					destination: destination as unknown as CastDestination,
					state: castState(),
				})
			);
			return destination;
		};

		it("sends the next episode to the receiver, from the panel or the keys", async () => {
			await openItem(ep1, { episodes: [ep1, ep2] });
			fakeMpv.actions.load.mockClear();
			casting();
			const send = vi.mocked(fakeCast.get().send);
			fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
			await flush();
			expect(send).toHaveBeenCalledWith(
				"cast:tv",
				expect.objectContaining({ id: ep2.id }),
				expect.objectContaining({ startAt: undefined })
			);
			// It asks before converting, since this cast doesn't yet.
			expect(send.mock.calls[0][2].confirm).toBeDefined();
			expect(fakeMpv.actions.load).not.toHaveBeenCalled();
			// The player moves to the episode once it's going to the receiver,
			// the last, so there's no next one.
			expect(screen.getByRole("button", { name: "Next episode" })).toBeInTheDocument();
			await act(() => send.mock.calls[0][2].stopLocal());
			expect(screen.queryByRole("button", { name: "Next episode" })).toBeNull();
			expect(fakeMpv.actions.stop).not.toHaveBeenCalled();
			await press("p");
			expect(send).toHaveBeenLastCalledWith(
				"cast:tv",
				expect.objectContaining({ id: ep1.id }),
				expect.anything()
			);
			expect(fakeMpv.actions.load).not.toHaveBeenCalled();
		});

		it("doesn't ask again while this computer already converts", async () => {
			await openItem(ep1, { episodes: [ep1, ep2] });
			casting(true);
			fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
			await flush();
			expect(vi.mocked(fakeCast.get().send).mock.calls[0][2].confirm).toBeUndefined();
		});

		it("asks before this computer starts converting, and a no keeps what plays", async () => {
			await openItem(ep1, { episodes: [ep1, ep2] });
			casting();
			const send = vi.mocked(fakeCast.get().send);
			const answers: boolean[] = [];
			send.mockImplementation(async (_, __, opts) => {
				answers.push(await opts.confirm!("on"));
				return null;
			});
			fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
			await flush();
			const dialog = screen.getByRole("dialog", { name: "Play on Hotel TV?" });
			expect(dialog.textContent).toContain("needs this computer to stay on");
			fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
			await flush();
			fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
			await flush();
			fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
			await flush();
			expect(answers).toEqual([false, true]);
			expect(screen.queryByRole("dialog")).toBeNull();
		});

		it("answers no to a question a newer one replaces, or that the page leaves open", async () => {
			await openItem(ep2, { episodes: [ep1, ep2, ep3] });
			casting();
			const answers: boolean[] = [];
			vi.mocked(fakeCast.get().send).mockImplementation(async (_, __, opts) => {
				answers.push(await opts.confirm!("on"));
				return null;
			});
			fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
			await flush();
			fireEvent.click(screen.getByRole("button", { name: "Previous episode" }));
			await flush();
			// The first question was answered no once the second came.
			expect(answers).toEqual([false]);
			expect(screen.getAllByRole("dialog", { name: "Play on Hotel TV?" })).toHaveLength(1);
			cleanup();
			await flush();
			expect(answers).toEqual([false, false]);
		});

		it("says why the new item can't go to the receiver", async () => {
			await openItem(ep1, { episodes: [ep1, ep2] });
			casting();
			vi.mocked(fakeCast.get().send).mockResolvedValueOnce("Can't play this format");
			fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
			await flush();
			expect(screen.getByRole("alert").textContent).toBe("Can't play this format");
		});

		it("resumes a movie where it was left, on the receiver", async () => {
			await openItem(ep1, { episodes: [ep1, ep2] });
			casting();
			vi.mocked(tauri.getPlaybackPosition).mockResolvedValue({
				positionSeconds: 1200,
				durationSeconds: 5400,
			} as Awaited<ReturnType<typeof Bridge.getPlaybackPosition>>);
			fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
			await flush();
			fireEvent.click(screen.getByRole("button", { name: /Resume/ }));
			await flush();
			expect(vi.mocked(fakeCast.get().send).mock.calls[0][2].startAt).toBe(1200);
		});

		it("records the item's play, from what it's going to", async () => {
			await openItem(ep1, { episodes: [ep1, ep2] });
			casting();
			vi.mocked(tauri.recordPlayEnd).mockClear();
			vi.mocked(tauri.recordPlayStart).mockClear();
			fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
			await flush();
			const send = vi.mocked(fakeCast.get().send);
			expect(tauri.recordPlayEnd).not.toHaveBeenCalled();
			await act(() => send.mock.calls[0][2].stopLocal());
			expect(tauri.recordPlayEnd).toHaveBeenCalledWith(ep1.id, expect.any(Number));
			expect(tauri.recordPlayStart).toHaveBeenCalledWith(
				ep2.id,
				ep2.name,
				null,
				ep2.contentType
			);
		});

		it("sends what another device asks for to the receiver", async () => {
			await openItem(lanternKeeper());
			casting();
			const send = vi.mocked(fakeCast.get().send);
			let loaded: Promise<void> = Promise.resolve();
			act(() => {
				loaded = destination().load({ kind: "local", channel: harborLights() });
			});
			await flush();
			expect(send).toHaveBeenCalledWith(
				"cast:tv",
				expect.objectContaining({ id: harborLights().id }),
				expect.anything()
			);
			// With nothing to do once it's under way, it moves the player on.
			await act(() => send.mock.calls[0][2].stopLocal());
			await act(() => loaded);
			expect(getMountedPlayer()?.getState().item?.ref).toBe(harborLights().id);
		});

		it("puts away a note about the cast once the next item goes to the receiver", async () => {
			await openItem(ep1, { episodes: [ep1, ep2] });
			const tvNow = casting();
			// A seek from the keys that failed, while the TV played.
			tvNow.seek.mockRejectedValueOnce("refused");
			await press("ArrowRight");
			expect(screen.getByRole("alert").textContent).toMatch(/^The provider refused/);
			fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
			await flush();
			expect(screen.queryByRole("alert")).toBeNull();
		});

		it("takes the episode keys to the receiver, and the rest as the TV's controls", async () => {
			await openItem(ep1, { episodes: [ep1, ep2] });
			fakeMpv.actions.load.mockClear();
			const tvNow = casting();
			await press("n");
			expect(vi.mocked(fakeCast.get().send)).toHaveBeenCalledWith(
				"cast:tv",
				expect.objectContaining({ id: ep2.id }),
				expect.anything()
			);
			await press(" ");
			expect(tvNow.pause).toHaveBeenCalled();
			expect(fakeMpv.actions.pause).not.toHaveBeenCalled();
			expect(fakeMpv.actions.load).not.toHaveBeenCalled();
		});

		it("leaves the episode keys alone while AirPlay plays", async () => {
			await openItem(ep1, { episodes: [ep1, ep2] });
			fakeMpv.actions.load.mockClear();
			const airplayTv = { ...tv(), id: "airplay:tv", kind: "airplay" as const };
			act(() =>
				fakeAirPlay.set({
					destination: airplayTv as unknown as AirPlay["destination"],
					state: castState(),
				})
			);
			await press("n");
			await press("p");
			expect(fakeMpv.actions.load).not.toHaveBeenCalled();
			expect(vi.mocked(fakeCast.get().send)).not.toHaveBeenCalled();
		});

		it("leaves the receiver alone while it asks", async () => {
			await openItem(ep1, { episodes: [ep1, ep2, ep3] });
			const tvNow = casting();
			vi.mocked(fakeCast.get().send).mockImplementation(async (_, __, opts) => {
				await opts.confirm!("on");
				return null;
			});
			fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
			await flush();
			expect(screen.getByRole("dialog", { name: "Play on Hotel TV?" })).toBeTruthy();
			for (const key of ["ArrowRight", " ", "n", "p"]) await press(key);
			expect(tvNow.seek).not.toHaveBeenCalled();
			expect(tvNow.pause).not.toHaveBeenCalled();
			expect(vi.mocked(fakeCast.get().send)).toHaveBeenCalledTimes(1);
		});

		it("says in the cast's words why a key's control failed", async () => {
			await openItem(lanternKeeper());
			const tvNow = casting();
			tvNow.pause.mockRejectedValueOnce("notConnected");
			await press(" ");
			expect(screen.getByRole("alert").textContent).toBe("Hotel TV didn't respond.");
			fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
			act(() => fakeCast.set({ state: castState({ status: "paused" }) }));
			tvNow.getState.mockReturnValue(castState({ status: "paused" }));
			tvNow.play.mockRejectedValueOnce("converterFailed");
			await press(" ");
			expect(screen.getByRole("alert").textContent).toBe("Couldn't play it on Hotel TV.");
			fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
			// Once the connection is going, the cast says so itself.
			tvNow.getState.mockReturnValue(castState({ connection: "reconnecting" }));
			tvNow.seek.mockRejectedValueOnce("unreachable");
			await press("ArrowRight");
			expect(screen.queryByRole("alert")).toBeNull();
		});

		it("says nothing when AirPlay's play or pause from the keys fails", async () => {
			await openItem(lanternKeeper());
			const airplayTv = { ...tv(), id: "airplay:tv", kind: "airplay" as const };
			airplayTv.pause.mockRejectedValueOnce("x");
			act(() =>
				fakeAirPlay.set({
					destination: airplayTv as unknown as AirPlay["destination"],
					state: castState(),
				})
			);
			await press(" ");
			expect(airplayTv.pause).toHaveBeenCalled();
			expect(screen.queryByRole("alert")).toBeNull();
			airplayTv.play.mockRejectedValueOnce("x");
			airplayTv.getState.mockReturnValue(castState({ status: "paused" }));
			act(() => fakeAirPlay.set({ state: castState({ status: "paused" }) }));
			await press(" ");
			expect(airplayTv.play).toHaveBeenCalled();
			expect(screen.queryByRole("alert")).toBeNull();
		});

		it("keeps a note up when a key's control fails with nothing to say", async () => {
			await openItem(lanternKeeper());
			const tvNow = casting();
			act(() => fakeCast.report("Lost the connection to Den."));
			tvNow.getState.mockReturnValue(castState({ connection: "reconnecting" }));
			tvNow.pause.mockRejectedValueOnce("notConnected");
			await press(" ");
			expect(screen.getByRole("alert").textContent).toBe("Lost the connection to Den.");
		});

		it("closes the question at once on Cancel or Escape, as a no", async () => {
			await openItem(ep1, { episodes: [ep1, ep2] });
			casting();
			const answers: boolean[] = [];
			vi.mocked(fakeCast.get().send).mockImplementation(async (_, __, opts) => {
				answers.push(await opts.confirm!("on"));
				return null;
			});
			fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
			await flush();
			fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
			expect(screen.queryByRole("dialog")).toBeNull();
			await flush();
			expect(answers).toEqual([false]);
			fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
			await flush();
			fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
			expect(screen.queryByRole("dialog")).toBeNull();
			await flush();
			expect(answers).toEqual([false, false]);
		});
	});
});

describe("another Cinette device", () => {
	/** A link to the Mac called `name`, playing a live channel. */
	const linkTo = (phase: LinkPhase = { phase: "connected" }, name = "Den Mac") => {
		const send = vi.fn<(command: RemoteCommand) => Promise<unknown>>(async () => undefined);
		const destination = createCinetteDestination("dev1", name, send);
		destination.setPhase(phase);
		destination.receive(
			{
				epoch: "e1",
				version: 1,
				state: {
					status: "playing",
					item: { id: "live-7", name: "News", contentType: "live", group: "UK" },
					position: 30,
					duration: 0,
					volume: 55,
					subtitles: [],
					subtitleId: null,
					audio: [],
					audioId: null,
					capabilities: {
						pause: true,
						seek: false,
						volume: true,
						subtitles: false,
						audioTracks: false,
						resumeAt: false,
					},
					error: null,
				},
			},
			performance.now()
		);
		const link: Link = {
			id: 1,
			deviceId: "dev1",
			name,
			phase,
			code: null,
			features: [],
			destination,
		};
		return { link, send };
	};

	const panel = () => screen.queryByRole("region", { name: "Cinette device" });

	afterEach(() => {
		delete window.__CINETTE_TV__;
	});

	it("drives what the other device plays with the player's own controls and keys", async () => {
		renderPlayer(null);
		await flush();
		const { link, send } = linkTo();
		act(() => fakeRemote.set(link));
		expect(panel()).toHaveTextContent("Playing on Den Mac");
		expect(panel()).toHaveTextContent("News");
		fireEvent.click(within(panel()!).getByRole("button", { name: "Pause" }));
		expect(send).toHaveBeenLastCalledWith({ action: "pause", itemId: "live-7" });
		await press(" ");
		expect(send).toHaveBeenCalledTimes(2);
		// A rename there shows here.
		act(() => fakeRemote.set(linkTo(undefined, "Study Mac").link));
		expect(panel()).toHaveTextContent("Playing on Study Mac");
	});

	it("stops what played here when it starts controlling another device", async () => {
		await openItem(lanternKeeper());
		await setMpv({ state: playing(MOVIE_URL, 900, 5400) });
		fakeMpv.actions.stop.mockClear();
		vi.mocked(tauri.savePlaybackPosition).mockClear();
		act(() => fakeRemote.set(linkTo().link));
		await flush();
		expect(fakeMpv.actions.stop).toHaveBeenCalledTimes(1);
		expect(tauri.savePlaybackPosition).toHaveBeenCalled();
		// Not again while the same link stays.
		act(() => fakeRemote.set({ ...fakeRemote.get()!, name: "Study Mac" }));
		await flush();
		expect(fakeMpv.actions.stop).toHaveBeenCalledTimes(1);
	});

	it("says it couldn't reach the device when a key's control fails", async () => {
		renderPlayer(null);
		await flush();
		const { link, send } = linkTo();
		send.mockRejectedValue("unreachable");
		act(() => fakeRemote.set(link));
		await press(" ");
		expect(screen.getByRole("alert").textContent).toBe("Couldn't reach Den Mac.");
	});

	it("shows while the link reconnects, and not before it connects", async () => {
		renderPlayer(null);
		await flush();
		act(() => fakeRemote.set(linkTo({ phase: "connecting" }).link));
		expect(panel()).toBeNull();
		act(() => fakeRemote.set(linkTo({ phase: "reconnecting", attempt: 1 }).link));
		expect(panel()).not.toBeNull();
	});

	it("isn't there on a TV, which controls no one", async () => {
		env.os = "android";
		window.__CINETTE_TV__ = true;
		renderPlayer(null);
		await flush();
		act(() => fakeRemote.set(linkTo().link));
		expect(panel()).toBeNull();
	});

	it("stops it there and goes back to its catalog", async () => {
		renderPlayer(null);
		await flush();
		const { link, send } = linkTo();
		act(() => fakeRemote.set(link));
		fireEvent.click(within(panel()!).getByRole("button", { name: "Stop" }));
		await flush();
		expect(send).toHaveBeenLastCalledWith({ action: "stop" });
		expect(screen.getByText("Channel list")).toBeTruthy();
	});

	it("says when the other device can't be reached, and stays", async () => {
		renderPlayer(null);
		await flush();
		const { link, send } = linkTo();
		send.mockRejectedValue("unreachable");
		act(() => fakeRemote.set(link));
		fireEvent.click(within(panel()!).getByRole("button", { name: "Pause" }));
		await flush();
		expect(screen.getByRole("alert").textContent).toBe("Couldn't reach Den Mac.");
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		fireEvent.click(within(panel()!).getByRole("button", { name: "Stop" }));
		await flush();
		expect(screen.getByRole("alert").textContent).toBe("Couldn't reach Den Mac.");
		expect(screen.queryByText("Channel list")).toBeNull();
	});
});
