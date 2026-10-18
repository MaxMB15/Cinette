// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { wrapperFor } from "@/test/query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	Channel,
	DownloadRecord,
	EpgProgram,
	EpgSearchResult,
	GroupHierarchyEntry,
	LayoutMode,
	PinnedGroup,
} from "@/lib/types";
import { consumeBrowseState, saveBrowseSearch, saveBrowseTab } from "@/lib/browse-state";
import { formatHHMM } from "@/lib/epg-window";
import { makeChannel, makeDownload, makeHistoryEntry } from "@/test/channel-fixtures";
import { deferred } from "@/test/deferred";
import { answerFrom } from "@/test/guide-answers";
import { ChannelList } from "./ChannelList";
import { ROW_CARD_LEFT_WIDTH } from "./ChannelCard";

const state = vi.hoisted(() => ({
	channels: [] as Channel[],
	loading: false,
	downloads: [] as DownloadRecord[],
	layoutMode: "desktop" as LayoutMode,
	os: "macos",
	navigate: vi.fn(),
	toggleFavorite: vi.fn(),
	guideVersion: 0,
}));

/**
 * The backend calls the list and its children make. They live in one hoisted
 * object so the phone tests, which load ChannelList again, share them.
 */
const tauri = vi.hoisted(() => ({
	getXtreamSeriesEpisodes: vi.fn(),
	getCachedSeriesEpisodes: vi.fn(),
	getEpgForLiveChannels: vi.fn(),
	searchEpgProgrammes: vi.fn(),
	getGroupHierarchy: vi.fn(),
	getPinnedGroups: vi.fn(),
	pinGroup: vi.fn(),
	unpinGroup: vi.fn(),
	getWatchHistory: vi.fn(),
	deleteHistoryEntry: vi.fn(),
	deleteHistorySeries: vi.fn(),
	clearWatchHistory: vi.fn(),
	clearWatchHistoryOfType: vi.fn(),
	enqueueMovieDownload: vi.fn(),
	stopDownload: vi.fn(),
	removeDownload: vi.fn(),
	setDownloadKeep: vi.fn(),
}));

vi.mock("@/lib/tauri", () => tauri);

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => state.os }));

vi.mock("react-router", () => ({ useNavigate: () => state.navigate }));

vi.mock("@/hooks/useChannels", () => ({
	useChannels: () => ({
		channels: state.channels,
		loading: state.loading,
		toggleFavorite: state.toggleFavorite,
		guideVersion: state.guideVersion,
		providers: [
			{
				id: "p1",
				name: "Home",
				type: "m3u",
				url: "http://example.test/list.m3u",
				channelCount: 0,
			},
		],
	}),
}));

vi.mock("@/hooks/usePlatform", () => ({
	usePlatform: () => ({ platform: state.os, layoutMode: state.layoutMode }),
}));

vi.mock("@/hooks/useDownloads", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/hooks/useDownloads")>();
	return {
		...actual,
		useDownloads: () => ({
			downloads: state.downloads,
			...actual.groupDownloads(state.downloads),
			retentionDays: null,
		}),
	};
});

// The drawers and the category manager have their own tests. These stand-ins
// show what the list hands them and let a test press their buttons.
vi.mock("./SeriesDetailModal", () => ({
	SeriesDetailModal: (props: {
		showTitle: string;
		episodes: Channel[];
		seriesChannelId: string;
		onClose: () => void;
		onPlay: (ch: Channel) => void;
	}) => (
		<div role="dialog" aria-label={`Episodes of ${props.showTitle}`}>
			<p>{`Series card ${props.seriesChannelId}`}</p>
			{props.episodes.map((ep) => (
				<button key={ep.id} onClick={() => props.onPlay(ep)}>
					{`Episode ${ep.name}`}
				</button>
			))}
			<button onClick={props.onClose}>Close episodes</button>
		</div>
	),
}));

vi.mock("./MovieInfoDrawer", () => ({
	MovieInfoDrawer: (props: {
		movie: Channel;
		onClose: () => void;
		onPlay: (ch: Channel) => void;
	}) => (
		<div role="dialog" aria-label={`About ${props.movie.name}`}>
			<button onClick={() => props.onPlay(props.movie)}>Play from drawer</button>
			<button onClick={props.onClose}>Close drawer</button>
		</div>
	),
}));

// The manager stores a change and loads the shared hierarchy again, which the
// list reads too.
vi.mock("./CategoryManager", async () => {
	const { useQueryClient } = await import("@tanstack/react-query");
	const { groupHierarchyQuery } = await import("@/lib/queries");
	return {
		CategoryManager: (props: {
			providerId: string;
			contentType: string;
			channels: Channel[];
			onClose: () => void;
		}) => {
			const client = useQueryClient();
			const save = () =>
				client.invalidateQueries({
					queryKey: groupHierarchyQuery(props.providerId, props.contentType).queryKey,
				});
			return (
				<div role="dialog" aria-label="Category manager">
					<p>{`${props.providerId} ${props.contentType} ${props.channels.length} channels`}</p>
					<button onClick={save}>Save categories</button>
					<button onClick={props.onClose}>Close manager</button>
				</div>
			);
		},
	};
});

// ── Fixtures ─────────────────────────────────────────────────────────────

const news = makeChannel({
	id: "news",
	name: "News 24",
	url: "http://live.example.test/news",
	groupTitle: "News",
	tvgId: "news.tv",
});
const weather = makeChannel({
	id: "weather",
	name: "Weather Now",
	url: "http://live.example.test/weather",
	groupTitle: "News",
	isFavorite: true,
});
const sport = makeChannel({
	id: "sport",
	name: "Sport One",
	url: "http://live.example.test/sport",
	groupTitle: "Sports",
});
const dune = makeChannel({
	id: "dune-a",
	name: "Dune",
	url: "http://vod.example.test/dune-a.mkv",
	groupTitle: "Sci-Fi",
	contentType: "movie",
});
const duneAlt = makeChannel({
	id: "dune-b",
	name: "Dune",
	url: "http://vod.example.test/dune-b.mkv",
	groupTitle: "Sci-Fi",
	contentType: "movie",
});
const arrival = makeChannel({
	id: "arrival",
	name: "Arrival",
	url: "http://vod.example.test/arrival.mkv",
	groupTitle: "Drama",
	contentType: "movie",
	isFavorite: true,
});
const hl2 = makeChannel({
	id: "hl-2",
	name: "Harbor Lights S01E02",
	url: "http://vod.example.test/hl-2.mkv",
	groupTitle: "Drama",
	contentType: "series",
	season: 1,
	episode: 2,
	isFavorite: true,
});
const hl1 = makeChannel({
	id: "hl-1",
	name: "Harbor Lights S01E01",
	url: "http://vod.example.test/hl-1.mkv",
	groupTitle: "Drama",
	contentType: "series",
	season: 1,
	episode: 1,
});
const roadEp = makeChannel({
	id: "road-1",
	name: "Dune Road S02E04",
	url: "http://vod.example.test/road-1.mkv",
	groupTitle: "Drama",
	contentType: "series",
	season: 2,
	episode: 4,
});

/** Three live channels, two movie titles with Dune listed twice, and two shows. */
const library = [news, weather, sport, dune, duneAlt, arrival, hl2, hl1, roadEp];

/** Two Xtream entries of one show, named a little differently. */
const xtreamShow = makeChannel({
	id: "xs-1",
	name: "Harbor Lights",
	url: "xtream://series/1",
	groupTitle: "Drama",
	contentType: "series",
});
const xtreamShowFr = makeChannel({
	id: "xs-2",
	name: "harbor  lights",
	url: "xtream://series/2",
	groupTitle: "Drama FR",
	contentType: "series",
	isFavorite: true,
});
const episodeOf = (seriesId: string, n: number) =>
	makeChannel({
		id: `${seriesId}-e${n}`,
		name: `Harbor Lights S01E0${n}`,
		url: `http://vod.example.test/${seriesId}/${n}.mkv`,
		contentType: "series",
		season: 1,
		episode: n,
	});

const liveChannels = (count: number, name = "Channel") =>
	Array.from({ length: count }, (_, i) =>
		makeChannel({
			id: `live-${i + 1}`,
			name: `${name} ${i + 1}`,
			url: `http://live.example.test/${i + 1}`,
		})
	);

const hierarchyEntry = (
	groupName: string,
	superCategory: string | null,
	sortOrder = 0
): GroupHierarchyEntry => ({
	providerId: "p1",
	contentType: "live",
	groupName,
	superCategory,
	sortOrder,
	isUserOverride: false,
});

const pinned = (groupName: string): PinnedGroup => ({
	providerId: "p1",
	contentType: "live",
	groupName,
	sortOrder: 0,
});

/**
 * 10:00 local time on a Wednesday, far from any daylight saving change, moved
 * back to the start of its UTC hour. The guide's hours and half hours are UTC
 * ones, so in a timezone a half or quarter hour off it's 9:30 or 9:45 there.
 */
const NOW = Math.floor(new Date(2026, 5, 10, 10, 0, 0).getTime() / 3_600_000) * 3600;

const freezeClock = () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW * 1000);
};

/** Stops the clock at NOW, and lets the test move it on and tick useNow. */
const driveClock = () => {
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
	vi.setSystemTime(NOW * 1000);
};

// ── Helpers ──────────────────────────────────────────────────────────────

/** Lets pending backend answers reach the list. */
const flush = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

/** Waits out the list's search debounce and the program search after it. */
const waitForDebounce = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 350));
	});

const renderList = async (List = ChannelList) => {
	// Each list gets a new cache, as each app does.
	const view = render(<List />, { wrapper: wrapperFor() });
	await flush();
	return view;
};

/** The gridlines drawn behind the virtual rows, or null when there are none. */
const rowGrid = (container: HTMLElement) =>
	container.querySelector<HTMLElement>(".absolute.top-0.bottom-0.pointer-events-none.z-0");

const tab = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}`) });

const openTab = async (label: string) => {
	fireEvent.click(tab(label));
	await flush();
};

const searchBox = () => screen.getByPlaceholderText("Search channels...");

const typeSearch = (text: string) => fireEvent.change(searchBox(), { target: { value: text } });

const playedWith = () => state.navigate.mock.lastCall;

/**
 * Swaps in a ResizeObserver the test drives, since the one in src/test/setup.ts
 * never reports a size. Returns the elements being watched and a function that
 * gives one of them a new width.
 */
const watchResizes = () => {
	const watching = new Map<Element, ResizeObserverCallback>();
	vi.stubGlobal(
		"ResizeObserver",
		class {
			private targets: Element[] = [];
			constructor(private callback: ResizeObserverCallback) {}
			observe(target: Element) {
				this.targets.push(target);
				watching.set(target, this.callback);
			}
			unobserve(target: Element) {
				if (watching.get(target) === this.callback) watching.delete(target);
			}
			disconnect() {
				for (const target of this.targets) this.unobserve(target);
				this.targets = [];
			}
		}
	);
	const resize = (target: Element, width: number) =>
		act(() => {
			const callback = watching.get(target);
			expect(callback).toBeDefined();
			callback!(
				[{ target, contentRect: { width } } as ResizeObserverEntry],
				{} as ResizeObserver
			);
		});
	return { watching, resize };
};

/**
 * jsdom does no layout, so every element measures 0 by 0 and the virtualizer
 * would render no rows at all. A 600 px tall scroll area makes it render the
 * rows that fit, the way a real window would.
 */
const VIEWPORT_HEIGHT = 600;

beforeEach(() => {
	sessionStorage.clear();
	state.channels = library;
	state.loading = false;
	state.downloads = [];
	state.layoutMode = "desktop";
	state.os = "macos";
	state.guideVersion = 0;
	state.navigate.mockReset();
	state.toggleFavorite.mockReset();
	for (const fn of Object.values(tauri)) fn.mockReset();
	tauri.getGroupHierarchy.mockResolvedValue([]);
	tauri.getPinnedGroups.mockResolvedValue([]);
	tauri.getWatchHistory.mockResolvedValue([]);
	tauri.getEpgForLiveChannels.mockResolvedValue([]);
	tauri.searchEpgProgrammes.mockResolvedValue([]);
	tauri.pinGroup.mockResolvedValue(undefined);
	tauri.unpinGroup.mockResolvedValue(undefined);
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(VIEWPORT_HEIGHT);
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("ChannelList before there is anything to list", () => {
	it("shows only a spinner while the channels load", async () => {
		state.loading = true;
		const { container } = await renderList();
		expect(container.querySelector(".animate-spin")).not.toBeNull();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("asks for a playlist when there are no channels", async () => {
		state.channels = [];
		await renderList();
		expect(screen.getByText("No channels yet")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Add Playlist" }));
		expect(state.navigate).toHaveBeenCalledWith("/playlists");
	});
});

describe("ChannelList tabs", () => {
	it("counts live channels, movie titles, shows, favorites and downloads", async () => {
		state.downloads = [
			makeDownload({ id: "d1", channelId: "arrival" }),
			makeDownload({ id: "d2", channelId: "hl-1", kind: "episode", seriesChannelId: "hl-2" }),
		];
		await renderList();

		expect(tab("Live")).toHaveTextContent(/^Live3$/);
		// Dune is listed twice but is one title.
		expect(tab("Movies")).toHaveTextContent(/^Movies2$/);
		expect(tab("Series")).toHaveTextContent(/^Series2$/);
		expect(tab("Favorites")).toHaveTextContent(/^Favorites3$/);
		expect(tab("Downloads")).toHaveTextContent(/^Downloads2$/);
		expect(tab("History")).toHaveTextContent(/^History$/);
	});

	it("opens on the live tab with every live channel", async () => {
		await renderList();
		expect(screen.getByText("3 channels")).toBeInTheDocument();
		expect(screen.getByText("News 24")).toBeInTheDocument();
		expect(screen.getByText("Weather Now")).toBeInTheDocument();
		expect(screen.getByText("Sport One")).toBeInTheDocument();
		expect(screen.queryByText("Arrival")).toBeNull();
	});

	it("shows movie titles and one poster per show on their tabs", async () => {
		await renderList();

		await openTab("Movies");
		expect(screen.getByText("2 movies")).toBeInTheDocument();
		expect(screen.getAllByText("Dune")).toHaveLength(1);
		expect(screen.getByText("Arrival")).toBeInTheDocument();

		await openTab("Series");
		expect(screen.getByText("2 shows")).toBeInTheDocument();
		expect(screen.getByText("Harbor Lights")).toBeInTheDocument();
		expect(screen.getByText("Dune Road")).toBeInTheDocument();
		expect(screen.queryByText("Harbor Lights S01E01")).toBeNull();
	});

	it("remembers the tab, so the list opens on it again with the search", async () => {
		await renderList();
		await openTab("Series");
		expect(consumeBrowseState().tab).toBe("series");
		cleanup();

		saveBrowseTab("movie");
		saveBrowseSearch("dune");
		await renderList();

		expect(searchBox()).toHaveValue("dune");
		expect(screen.getByText("1 movie")).toBeInTheDocument();
		expect(screen.queryByText("Arrival")).toBeNull();
	});

	it("opens on the live tab when the remembered tab is unknown", async () => {
		saveBrowseTab("guide");
		await renderList();
		expect(screen.getByText("3 channels")).toBeInTheDocument();
	});

	it("opens on the downloads tab again after playing a download", async () => {
		state.downloads = [makeDownload({ id: "d1", channelId: "arrival" })];
		saveBrowseTab("downloads");
		await renderList();
		expect(screen.getByText("Arrival")).toBeInTheDocument();
		expect(screen.queryByText("3 channels")).toBeNull();
	});

	it("turns the filters off when switching tabs but keeps the search", async () => {
		await renderList();
		fireEvent.click(screen.getByRole("button", { name: "Show favorites only" }));
		typeSearch("a");

		await openTab("Movies");

		expect(screen.getByRole("button", { name: "Show favorites only" })).toHaveAttribute(
			"aria-pressed",
			"false"
		);
		expect(searchBox()).toHaveValue("a");
	});

	it("has no search or filters on the history and downloads tabs", async () => {
		await renderList();
		expect(searchBox()).toBeInTheDocument();

		for (const label of ["History", "Downloads"]) {
			await openTab(label);
			expect(screen.queryByRole("textbox")).toBeNull();
			expect(screen.queryByRole("button", { name: "Show favorites only" })).toBeNull();
			expect(screen.queryByRole("button", { name: "Show downloaded only" })).toBeNull();
		}
	});
});

describe("ChannelList live rows", () => {
	it("plays a channel when its row is clicked", async () => {
		await renderList();
		fireEvent.click(screen.getByText("News 24"));
		expect(state.navigate).toHaveBeenCalledExactlyOnceWith("/player", {
			state: { url: news.url, channelName: "News 24", channel: news },
		});
	});

	it("toggles a favorite from the heart without playing", async () => {
		await renderList();
		fireEvent.click(
			within(screen.getByText("Sport One").closest(".group") as HTMLElement).getByRole(
				"button",
				{ name: "Add to favorites" }
			)
		);
		expect(state.toggleFavorite).toHaveBeenCalledWith("sport");
		expect(state.navigate).not.toHaveBeenCalled();
	});

	it("loads the guide from two hours back to five ahead and shows it on matching rows", async () => {
		freezeClock();
		const programs: EpgProgram[] = [
			{
				channelId: "news.tv",
				title: "Morning Briefing",
				startTime: NOW - 1800,
				endTime: NOW + 1800,
			},
			{
				channelId: "news.tv",
				title: "Market Watch",
				startTime: NOW + 1800,
				endTime: NOW + 5400,
			},
			{ channelId: "other.tv", title: "Elsewhere", startTime: NOW, endTime: NOW + 3600 },
		];
		tauri.getEpgForLiveChannels.mockResolvedValue(programs);
		await renderList();

		// With no list of guide ids, it loads every channel's programs.
		expect(tauri.getEpgForLiveChannels).toHaveBeenCalledWith(NOW - 2 * 3600, NOW + 5 * 3600);
		const newsRow = screen.getByText("News 24").closest(".group") as HTMLElement;
		expect(within(newsRow).getByTitle("Morning Briefing")).toBeInTheDocument();
		expect(within(newsRow).getByTitle("Market Watch")).toBeInTheDocument();
		expect(screen.queryByTitle("Elsewhere")).toBeNull();
		// Weather Now has no guide id.
		const weatherRow = screen.getByText("Weather Now").closest(".group") as HTMLElement;
		expect(within(weatherRow).getByText("no epg")).toBeInTheDocument();
	});

	it("still lists the channels when the guide fails to load", async () => {
		tauri.getEpgForLiveChannels.mockRejectedValue(new Error("offline"));
		await renderList();
		expect(screen.getByText("3 channels")).toBeInTheDocument();
		expect(screen.getAllByText("no epg")).toHaveLength(3);
	});

	it("says a row has no guide only once the guide has loaded", async () => {
		const load = deferred<EpgProgram[]>();
		tauri.getEpgForLiveChannels.mockReturnValueOnce(load.promise);
		await renderList();
		const row = (name: string) =>
			within(screen.getByText(name).closest(".group") as HTMLElement);

		expect(row("News 24").queryByText("no epg")).toBeNull();
		// Weather Now has no guide id, so there's nothing to wait for.
		expect(row("Weather Now").getByText("no epg")).toBeInTheDocument();
		await act(async () => load.resolve([]));
		expect(row("News 24").getByText("no epg")).toBeInTheDocument();
	});

	it("loads no guide on the other tabs", async () => {
		saveBrowseTab("movie");
		await renderList();
		expect(tauri.getEpgForLiveChannels).not.toHaveBeenCalled();
	});

	it("shows a time axis of half hours with the edges left out and a now marker", async () => {
		freezeClock();
		await renderList();

		// A narrow list shows three hours, one before now and two after.
		for (const minutes of [30, 60, 90, 120, 150]) {
			expect(screen.getByText(formatHHMM(NOW - 3600 + minutes * 60))).toBeInTheDocument();
		}
		expect(screen.queryByText(formatHHMM(NOW - 3600))).toBeNull();
		expect(screen.getByText("▾")).toBeInTheDocument();
	});

	it("keeps each time on the axis on one line", async () => {
		freezeClock();
		await renderList();
		// Near the right edge, the last label has less room than its text, and a
		// 12-hour time like "06:30 AM" would wrap there.
		for (const minutes of [30, 60, 90, 120, 150]) {
			expect(screen.getByText(formatHHMM(NOW - 3600 + minutes * 60))).toHaveClass(
				"whitespace-nowrap"
			);
		}
	});

	it("has no time axis on the poster tabs", async () => {
		freezeClock();
		saveBrowseTab("movie");
		await renderList();
		expect(screen.queryByText("▾")).toBeNull();
		expect(screen.queryByText(formatHHMM(NOW))).toBeNull();
	});

	it("shows more of the guide when it gets wider", async () => {
		freezeClock();
		const { resize } = watchResizes();
		const { container } = await renderList();
		const earlier = formatHHMM(NOW - 5400);
		expect(screen.queryByText(earlier)).toBeNull();

		resize(container.firstElementChild!, 1200);

		// About six hours now fit, two of them before now.
		expect(screen.getByText(earlier)).toBeInTheDocument();
	});

	it("measures and follows its width once the channels arrive at startup", async () => {
		freezeClock();
		const { resize } = watchResizes();
		vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(1200);
		state.channels = [];
		const { container, rerender } = await renderList();

		state.channels = library;
		rerender(<ChannelList />);
		const earlier = formatHHMM(NOW - 5400);
		expect(screen.getByText(earlier)).toBeInTheDocument();

		resize(container.firstElementChild!, 400);
		expect(screen.queryByText(earlier)).toBeNull();
	});

	it("measures and follows its width once a playlist that was loading arrives", async () => {
		freezeClock();
		const { resize } = watchResizes();
		vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(1200);
		state.loading = true;
		const { container, rerender } = await renderList();

		state.loading = false;
		rerender(<ChannelList />);
		const earlier = formatHHMM(NOW - 5400);
		expect(screen.getByText(earlier)).toBeInTheDocument();

		resize(container.firstElementChild!, 400);
		expect(screen.queryByText(earlier)).toBeNull();
	});

	it("loads the guide for all of a wide window, once", async () => {
		freezeClock();
		vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(1200);
		await renderList();
		// About 6.1 hours fit, a little more than 2 back and 4 ahead, and the
		// guide loads one more hour ahead than that.
		expect(tauri.getEpgForLiveChannels).toHaveBeenCalledExactlyOnceWith(
			NOW - 3 * 3600,
			NOW + 6 * 3600
		);
	});

	it("moves the guide along with the clock", async () => {
		driveClock();
		await renderList();
		// A narrow list shows an hour before now and two after it.
		const halfHourBefore = formatHHMM(NOW - 1800);
		const twoHoursOn = formatHHMM(NOW + 7200);
		expect(screen.getByText(halfHourBefore)).toBeInTheDocument();
		expect(screen.queryByText(twoHoursOn)).toBeNull();

		act(() => vi.advanceTimersByTime(30 * 60_000));

		expect(screen.queryByText(halfHourBefore)).toBeNull();
		expect(screen.getByText(twoHoursOn)).toBeInTheDocument();
	});

	it("loads more of the guide once the clock carries the window past it", async () => {
		driveClock();
		await renderList();
		// The guide loaded up to 5 hours after NOW, and a narrow window ends 2
		// hours after now, so it reaches there 3 hours after NOW.
		const reachesEnd = NOW + 3 * 3600;
		vi.setSystemTime((reachesEnd - 30) * 1000);

		act(() => vi.advanceTimersByTime(30_000));
		expect(tauri.getEpgForLiveChannels).toHaveBeenCalledOnce();

		act(() => vi.advanceTimersByTime(30_000));
		expect(tauri.getEpgForLiveChannels).toHaveBeenCalledTimes(2);
		expect(tauri.getEpgForLiveChannels).toHaveBeenLastCalledWith(NOW + 3600, NOW + 9 * 3600);
	});

	it("doesn't load the guide again when it gets narrower", async () => {
		freezeClock();
		const { resize } = watchResizes();
		const { container } = await renderList();
		const root = container.firstElementChild!;
		resize(root, 1200);
		expect(tauri.getEpgForLiveChannels).toHaveBeenCalledTimes(2);

		resize(root, 400);
		resize(root, 1200);

		expect(tauri.getEpgForLiveChannels).toHaveBeenCalledTimes(2);
	});

	it("keeps the guide for the current width when a load for an older one finishes last", async () => {
		freezeClock();
		const { resize } = watchResizes();
		const guide = (title: string): EpgProgram[] => [
			{ channelId: "news.tv", title, startTime: NOW, endTime: NOW + 3600 },
		];
		const narrow = deferred<EpgProgram[]>();
		tauri.getEpgForLiveChannels
			.mockReturnValueOnce(narrow.promise)
			.mockResolvedValueOnce(guide("Market Watch"));
		const { container } = await renderList();

		resize(container.firstElementChild!, 1200);
		await flush();
		await act(async () => narrow.resolve(guide("Morning Briefing")));

		expect(screen.getByTitle("Market Watch")).toBeInTheDocument();
		expect(screen.queryByTitle("Morning Briefing")).toBeNull();
	});

	it("loads the guide again once a provider's guide finishes refreshing", async () => {
		freezeClock();
		tauri.getEpgForLiveChannels.mockResolvedValueOnce([]).mockResolvedValueOnce([
			{
				channelId: "news.tv",
				title: "Morning Briefing",
				startTime: NOW,
				endTime: NOW + 3600,
			},
		]);
		const { rerender } = await renderList();
		// Rendering again with no refresh finished loads nothing.
		rerender(<ChannelList />);
		await flush();
		expect(tauri.getEpgForLiveChannels).toHaveBeenCalledOnce();

		state.guideVersion = 1;
		rerender(<ChannelList />);
		await flush();

		expect(tauri.getEpgForLiveChannels).toHaveBeenCalledTimes(2);
		expect(tauri.getEpgForLiveChannels).toHaveBeenLastCalledWith(
			NOW - 2 * 3600,
			NOW + 5 * 3600
		);
		expect(screen.getByTitle("Morning Briefing")).toBeInTheDocument();
	});

	it("stops watching its size when it unmounts", async () => {
		const { watching } = watchResizes();
		const { container, unmount } = await renderList();
		const root = container.firstElementChild!;
		expect(watching.has(root)).toBe(true);

		unmount();

		expect(watching.has(root)).toBe(false);
	});
});

describe("ChannelList search", () => {
	it("ignores spaces around the search", async () => {
		saveBrowseTab("movie");
		saveBrowseSearch("  arr ");
		await renderList();
		expect(screen.getByText("1 movie")).toBeInTheDocument();
		expect(screen.getByText("Arrival")).toBeInTheDocument();
	});

	it("filters a moment after typing rather than on every keystroke", async () => {
		saveBrowseTab("movie");
		await renderList();

		typeSearch("arr");
		expect(screen.getByText("2 movies")).toBeInTheDocument();

		expect(await screen.findByText("1 movie")).toBeInTheDocument();
		expect(screen.getByText("Arrival")).toBeInTheDocument();
		expect(screen.queryByText("Dune")).toBeNull();
		expect(consumeBrowseState().search).toBe("arr");
	});

	it("says nothing matched and clears the search from there", async () => {
		saveBrowseTab("movie");
		saveBrowseSearch("zzz");
		await renderList();

		expect(screen.getByText("No movies matching “zzz”")).toBeInTheDocument();
		expect(screen.getByText("Check the spelling or try a shorter search.")).toBeInTheDocument();

		fireEvent.click(screen.getByText("Clear search"));
		expect(searchBox()).toHaveValue("");
		expect(await screen.findByText("2 movies")).toBeInTheDocument();
	});

	it("points at the active filter when a filtered search finds nothing", async () => {
		saveBrowseTab("movie");
		saveBrowseSearch("dune");
		await renderList();

		fireEvent.click(screen.getByRole("button", { name: "Show favorites only" }));

		expect(screen.getByText("No movies matching “dune”")).toBeInTheDocument();
		expect(
			screen.getByText("Try editing your search or removing the active filter.")
		).toBeInTheDocument();
	});

	it("searches programs for the live tab and lists them with when they start", async () => {
		freezeClock();
		const result = (title: string, startOffset: number): EpgSearchResult => ({
			channelId: "news.tv",
			channelName: "News 24",
			title,
			startTime: NOW + startOffset,
			endTime: NOW + startOffset + 1800,
		});
		tauri.searchEpgProgrammes.mockResolvedValue([
			result("Morning Briefing", -600),
			result("Market Watch", 1800),
			result("Late Edition", 5400),
			result("Evening Bulletin", 3 * 3600),
			result("Night Desk", 24 * 3600),
			result("Weekend Review", 3 * 24 * 3600),
		]);
		await renderList();

		typeSearch("news ");
		await waitForDebounce();

		expect(tauri.searchEpgProgrammes).toHaveBeenCalledExactlyOnceWith("news", NOW);
		expect(screen.getByText("Channels")).toBeInTheDocument();
		expect(screen.getByText("On Now / Upcoming")).toBeInTheDocument();
		const startOf = (title: string) =>
			screen.getByRole("button", { name: new RegExp(title) }).lastElementChild?.textContent;
		expect(startOf("Morning Briefing")).toBe("now");
		expect(startOf("Market Watch")).toBe("in 30m");
		expect(startOf("Late Edition")).toBe("in 1h");
		expect(startOf("Evening Bulletin")).toBe(`today ${formatHHMM(NOW + 3 * 3600)}`);
		expect(startOf("Night Desk")).toBe(`tomorrow ${formatHHMM(NOW + 24 * 3600)}`);
		const weekend = new Date((NOW + 3 * 24 * 3600) * 1000).toLocaleDateString([], {
			weekday: "short",
			month: "short",
			day: "numeric",
		});
		expect(startOf("Weekend Review")).toBe(`${weekend} ${formatHHMM(NOW + 3 * 24 * 3600)}`);
	});

	it("searches the guide once for a search typed quickly", async () => {
		tauri.searchEpgProgrammes.mockResolvedValue([]);
		await renderList();
		typeSearch("ma");
		typeSearch("mar");
		typeSearch("market");
		await waitFor(() => expect(tauri.searchEpgProgrammes).toHaveBeenCalled(), {
			timeout: 3000,
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 400));
		});
		expect(tauri.searchEpgProgrammes).toHaveBeenCalledOnce();
		expect(tauri.searchEpgProgrammes).toHaveBeenCalledWith("market", expect.any(Number));
	});

	it("plays the channel a program result is on", async () => {
		tauri.searchEpgProgrammes.mockResolvedValue([
			{
				channelId: "news.tv",
				channelName: "News 24",
				title: "Market Watch",
				startTime: 0,
				endTime: 0,
			},
			{
				channelId: "gone.tv",
				channelName: "Old Channel",
				title: "Lost Show",
				startTime: 0,
				endTime: 0,
			},
		]);
		await renderList();
		typeSearch("market");
		// The search waits 300 ms for the typing to stop, then asks the guide.
		fireEvent.click(
			await screen.findByRole("button", { name: /Lost Show/ }, { timeout: 3000 })
		);
		expect(state.navigate).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: /Market Watch/ }));
		expect(state.navigate).toHaveBeenCalledExactlyOnceWith("/player", {
			state: { url: news.url, channelName: "News 24", channel: news },
		});
	});

	it("lists matching channels as rows that play", async () => {
		await renderList();
		typeSearch("sport");
		await waitForDebounce();

		expect(screen.getByText("Channels")).toBeInTheDocument();
		expect(screen.queryByText("News 24")).toBeNull();
		fireEvent.click(screen.getByText("Sport One"));
		expect(playedWith()).toEqual([
			"/player",
			{ state: { url: sport.url, channelName: "Sport One", channel: sport } },
		]);
	});

	it("shows the first 80 matching channels and how many more there are", async () => {
		state.channels = liveChannels(85, "Newsroom");
		await renderList();
		typeSearch("newsroom");
		await waitForDebounce();

		expect(screen.getAllByText(/^Newsroom \d+$/)).toHaveLength(80);
		expect(screen.getByText("+5 more — narrow your search")).toBeInTheDocument();
	});

	it("says when neither channels nor programs match", async () => {
		await renderList();
		typeSearch("zzz");
		await waitForDebounce();
		expect(screen.getByText("No channels or programmes matching “zzz”")).toBeInTheDocument();
	});

	it("keeps the channel matches when the program search fails", async () => {
		tauri.searchEpgProgrammes.mockRejectedValue(new Error("offline"));
		await renderList();
		typeSearch("news");
		await waitForDebounce();
		expect(screen.getByText("News 24")).toBeInTheDocument();
		expect(screen.queryByText("On Now / Upcoming")).toBeNull();
	});

	it("drops the program results as soon as the search is cleared", async () => {
		tauri.searchEpgProgrammes.mockResolvedValue([
			{
				channelId: "news.tv",
				channelName: "News 24",
				title: "Market Watch",
				startTime: 0,
				endTime: 0,
			},
		]);
		await renderList();
		typeSearch("market");
		expect(await screen.findByText("Market Watch")).toBeInTheDocument();

		typeSearch("");
		expect(screen.queryByText("Market Watch")).toBeNull();
		expect(await screen.findByText("3 channels")).toBeInTheDocument();
	});

	it("drops a program search that answers after the search is cleared", async () => {
		let answer: (results: EpgSearchResult[]) => void = () => {};
		tauri.searchEpgProgrammes.mockReturnValue(
			new Promise<EpgSearchResult[]>((resolve) => {
				answer = resolve;
			})
		);
		await renderList();
		typeSearch("market");
		await waitForDebounce();
		expect(tauri.searchEpgProgrammes).toHaveBeenCalledOnce();

		typeSearch("");
		await act(async () =>
			answer([
				{
					channelId: "news.tv",
					channelName: "News 24",
					title: "Market Watch",
					startTime: 0,
					endTime: 0,
				},
			])
		);
		expect(screen.queryByText("Market Watch")).toBeNull();
		expect(await screen.findByText("3 channels")).toBeInTheDocument();
	});

	it("searches no programs outside the live tab", async () => {
		saveBrowseTab("movie");
		await renderList();
		typeSearch("dune");
		await waitForDebounce();
		expect(tauri.searchEpgProgrammes).not.toHaveBeenCalled();
	});
});

describe("ChannelList filters", () => {
	it("shows only favorites while the heart filter is on", async () => {
		await renderList();
		const filter = screen.getByRole("button", { name: "Show favorites only" });
		expect(filter).toHaveAttribute("aria-pressed", "false");

		fireEvent.click(filter);
		expect(screen.getByRole("button", { name: "Show all" })).toHaveAttribute(
			"aria-pressed",
			"true"
		);
		expect(screen.getByText("1 channel")).toBeInTheDocument();
		expect(screen.getByText("Weather Now")).toBeInTheDocument();
		expect(screen.queryByText("News 24")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Show all" }));
		expect(screen.getByText("3 channels")).toBeInTheDocument();
	});

	it("keeps a show whose first episode is a favorite under the heart filter", async () => {
		await renderList();
		await openTab("Series");
		fireEvent.click(screen.getByRole("button", { name: "Show favorites only" }));
		// The Harbor Lights card stands for its first listed episode, which is a favorite.
		expect(screen.getByText("Harbor Lights")).toBeInTheDocument();
		expect(screen.queryByText("Dune Road")).toBeNull();
	});

	it("says so when the heart filter leaves nothing", async () => {
		state.channels = library.map((ch) => ({ ...ch, isFavorite: false }));
		saveBrowseTab("movie");
		await renderList();
		fireEvent.click(screen.getByRole("button", { name: "Show favorites only" }));
		expect(screen.getByText("No favorites yet — tap ♡ on any channel")).toBeInTheDocument();
	});

	it("shows only downloaded movies and shows while the download filter is on", async () => {
		state.downloads = [
			makeDownload({ id: "d1", channelId: "arrival" }),
			makeDownload({ id: "d2", channelId: "hl-1", kind: "episode", seriesChannelId: "hl-2" }),
		];
		saveBrowseTab("movie");
		await renderList();

		const filter = screen.getByRole("button", { name: "Show downloaded only" });
		fireEvent.click(filter);
		expect(screen.getByRole("button", { name: "Show all" })).toHaveAttribute(
			"aria-pressed",
			"true"
		);
		expect(screen.getByText("1 movie")).toBeInTheDocument();
		expect(screen.getByText("Arrival")).toBeInTheDocument();

		await openTab("Series");
		fireEvent.click(screen.getByRole("button", { name: "Show downloaded only" }));
		expect(screen.getByText("1 show")).toBeInTheDocument();
		expect(screen.getByText("Harbor Lights")).toBeInTheDocument();
		expect(screen.queryByText("Dune Road")).toBeNull();
	});
});

describe("ChannelList categories without a hierarchy", () => {
	it("filters by a category chip, largest group first", async () => {
		await renderList();
		const chips = screen
			.getAllByRole("button")
			.map((b) => b.textContent)
			.filter((t) => t === "All" || /^(News|Sports)\d+$/.test(t ?? ""));
		expect(chips).toEqual(["All", "News2", "Sports1"]);

		fireEvent.click(screen.getByRole("button", { name: /^Sports\s?1$/ }));
		expect(screen.getByText("1 channel")).toBeInTheDocument();
		expect(screen.getByText("Sport One")).toBeInTheDocument();
		expect(screen.queryByText("News 24")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /^Sports\s?1$/ }));
		expect(screen.getByText("3 channels")).toBeInTheDocument();
	});

	it("tells a filtered search that finds nothing about the category", async () => {
		saveBrowseTab("movie");
		await renderList();
		fireEvent.click(screen.getByRole("button", { name: /^Drama\s?1$/ }));
		typeSearch("dune");
		expect(await screen.findByText("No movies matching “dune”")).toBeInTheDocument();
		expect(
			screen.getByText("Try editing your search or removing the active filter.")
		).toBeInTheDocument();
	});

	it("offers to organize the channels and opens the manager for this tab", async () => {
		await renderList();
		expect(screen.getByText("Channels not categorized yet.")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Use AI to organize channels?" }));
		const manager = screen.getByRole("dialog", { name: "Category manager" });
		expect(within(manager).getByText(`p1 live ${library.length} channels`)).toBeInTheDocument();

		fireEvent.click(within(manager).getByRole("button", { name: "Save categories" }));
		await flush();
		expect(tauri.getGroupHierarchy).toHaveBeenCalledTimes(2);

		fireEvent.click(within(manager).getByRole("button", { name: "Close manager" }));
		expect(screen.queryByRole("dialog", { name: "Category manager" })).toBeNull();
	});

	it("shows no chips or prompt when everything is in one group", async () => {
		state.channels = [news, weather];
		await renderList();
		expect(screen.queryByRole("button", { name: "All" })).toBeNull();
		expect(screen.queryByText("Channels not categorized yet.")).toBeNull();
	});
});

describe("ChannelList category hierarchy", () => {
	const goal = makeChannel({ id: "goal", name: "Goal TV", groupTitle: "Football" });
	const pitch = makeChannel({ id: "pitch", name: "Pitch Live", groupTitle: "Football" });
	const court = makeChannel({ id: "court", name: "Court One", groupTitle: "Tennis" });
	const odd = makeChannel({ id: "odd", name: "Odd Box", groupTitle: "Misc" });

	beforeEach(() => {
		state.channels = [goal, pitch, court, odd];
		tauri.getGroupHierarchy.mockResolvedValue([
			hierarchyEntry("Football", "Sports"),
			hierarchyEntry("Tennis", "Sports", 1),
			hierarchyEntry("Misc", null, 2),
		]);
	});

	it("shows category tiles with their counts instead of the channels", async () => {
		await renderList();
		expect(tauri.getGroupHierarchy).toHaveBeenCalledWith("p1", "live");
		expect(screen.getByText("2 groups · 3 ch")).toBeInTheDocument();
		expect(screen.getByText("1 channel")).toBeInTheDocument();
		expect(screen.queryByText("Goal TV")).toBeNull();
		expect(screen.queryByText("4 channels")).toBeNull();
		expect(screen.queryByText("Channels not categorized yet.")).toBeNull();
	});

	it("goes into a category and a group, and back out with the breadcrumb", async () => {
		await renderList();

		fireEvent.click(screen.getByText("Sports"));
		expect(screen.getByRole("button", { name: /^Football/ })).toHaveTextContent("Football2 ch");
		expect(screen.getByRole("button", { name: /^Tennis/ })).toHaveTextContent("Tennis1 ch");
		expect(screen.queryByText("Odd Box")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /^Football/ }));
		expect(screen.getByText("2 channels")).toBeInTheDocument();
		expect(screen.getByText("Goal TV")).toBeInTheDocument();
		expect(screen.getByText("Pitch Live")).toBeInTheDocument();
		expect(screen.queryByText("Court One")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Sports" }));
		expect(screen.getByRole("button", { name: /^Tennis/ })).toBeInTheDocument();
		expect(screen.queryByText("Goal TV")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "All Categories" }));
		expect(screen.getByText("2 groups · 3 ch")).toBeInTheDocument();
	});

	it("opens a group that has no category straight from its tile", async () => {
		await renderList();
		fireEvent.click(screen.getByText("Misc"));

		expect(screen.getByText("Odd Box")).toBeInTheDocument();
		expect(screen.getByText("1 channel")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "All Categories" }));
		expect(screen.queryByText("Odd Box")).toBeNull();
	});

	it("narrows a category's groups to the search", async () => {
		await renderList();
		fireEvent.click(screen.getByText("Sports"));
		typeSearch(" TEN ");
		await waitForDebounce();

		expect(screen.getByRole("button", { name: /^Tennis/ })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /^Football/ })).toBeNull();
	});

	it("pins and unpins a group from its category", async () => {
		await renderList();
		fireEvent.click(screen.getByText("Sports"));

		tauri.getPinnedGroups.mockResolvedValue([pinned("Football")]);
		fireEvent.click(screen.getByRole("button", { name: "Pin Football" }));
		await flush();
		expect(tauri.pinGroup).toHaveBeenCalledWith("p1", "live", "Football", 0);
		expect(screen.getByRole("button", { name: "Pin Football" })).toHaveAttribute(
			"aria-pressed",
			"true"
		);

		tauri.getPinnedGroups.mockResolvedValue([]);
		fireEvent.click(screen.getByRole("button", { name: "Pin Football" }));
		await flush();
		expect(tauri.unpinGroup).toHaveBeenCalledWith("p1", "live", "Football");
		expect(screen.getByRole("button", { name: "Pin Football" })).toHaveAttribute(
			"aria-pressed",
			"false"
		);
	});

	it("opens and unpins a pinned group from the pinned row", async () => {
		tauri.getPinnedGroups.mockResolvedValue([pinned("Football")]);
		await renderList();
		expect(screen.getByText("Pinned Groups")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Unpin Football" }));
		await flush();
		expect(tauri.unpinGroup).toHaveBeenCalledWith("p1", "live", "Football");

		fireEvent.click(screen.getByText("Football"));
		expect(screen.getByText("Goal TV")).toBeInTheDocument();
		// Opened from the home screen, so the way back skips the category.
		expect(screen.queryByRole("button", { name: "Sports" })).toBeNull();
		expect(screen.getByRole("button", { name: "All Categories" })).toBeInTheDocument();
	});

	it("opens the category manager from Manage", async () => {
		await renderList();
		fireEvent.click(screen.getByRole("button", { name: "Manage" }));
		expect(screen.getByText("p1 live 4 channels")).toBeInTheDocument();
	});
});

describe("ChannelList recently played", () => {
	it("plays a live channel by id under the name it was watched with", async () => {
		tauri.getWatchHistory.mockResolvedValue([
			makeHistoryEntry({ channelId: "news", channelName: "News 24 HD" }),
		]);
		await renderList();

		expect(tauri.getWatchHistory).toHaveBeenCalledWith(50, "live");
		fireEvent.click(screen.getByText("News 24 HD"));
		expect(state.navigate).toHaveBeenCalledExactlyOnceWith("/player", {
			state: { url: news.url, channelName: "News 24 HD", channel: news },
		});
	});

	it("does nothing for a channel that is no longer listed", async () => {
		tauri.getWatchHistory.mockResolvedValue([
			makeHistoryEntry({ channelId: "closed", channelName: "Closed Channel" }),
		]);
		await renderList();
		fireEvent.click(screen.getByText("Closed Channel"));
		expect(state.navigate).not.toHaveBeenCalled();
	});
});

describe("ChannelList movies", () => {
	it("opens the drawer for a movie with several sources and plays from it", async () => {
		saveBrowseTab("movie");
		await renderList();

		fireEvent.click(screen.getByText("Dune"));
		const drawer = screen.getByRole("dialog", { name: "About Dune" });
		expect(state.navigate).not.toHaveBeenCalled();

		fireEvent.click(within(drawer).getByRole("button", { name: "Play from drawer" }));
		const [path, { state: played }] = playedWith()!;
		expect(path).toBe("/player");
		expect(played.url).toBe(dune.url);
		expect(played.channel.sources).toEqual([duneAlt.url]);

		fireEvent.click(within(drawer).getByRole("button", { name: "Close drawer" }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("plays a movie with one source straight away", async () => {
		saveBrowseTab("movie");
		await renderList();
		fireEvent.click(screen.getByText("Arrival"));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(state.navigate).toHaveBeenCalledWith("/player", {
			state: { url: arrival.url, channelName: "Arrival", channel: arrival },
		});
	});

	it("opens the drawer for a movie picked from the recently played row", async () => {
		tauri.getWatchHistory.mockResolvedValue([
			makeHistoryEntry({
				channelId: "arrival",
				channelName: "Arrival",
				contentType: "movie",
			}),
		]);
		saveBrowseTab("movie");
		await renderList();

		expect(tauri.getWatchHistory).toHaveBeenCalledWith(50, "movie");
		fireEvent.click(screen.getAllByText("Arrival")[0]);
		expect(screen.getByRole("dialog", { name: "About Arrival" })).toBeInTheDocument();
	});
});

describe("ChannelList series", () => {
	it("opens a show's episodes and plays one with the season in order", async () => {
		saveBrowseTab("series");
		await renderList();

		fireEvent.click(screen.getByText("Harbor Lights"));
		const dialog = await screen.findByRole("dialog", { name: "Episodes of Harbor Lights" });
		expect(within(dialog).getByText("Series card hl-2")).toBeInTheDocument();
		expect(within(dialog).queryByText(/Dune Road/)).toBeNull();

		fireEvent.click(
			within(dialog).getByRole("button", { name: "Episode Harbor Lights S01E02" })
		);
		expect(state.navigate).toHaveBeenCalledWith("/player", {
			state: {
				url: hl2.url,
				channelName: hl2.name,
				channel: hl2,
				seriesEpisodes: [hl1, hl2],
			},
		});

		fireEvent.click(within(dialog).getByRole("button", { name: "Close episodes" }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("loads every Xtream entry of a show, the clicked one first", async () => {
		state.channels = [xtreamShow, xtreamShowFr];
		tauri.getXtreamSeriesEpisodes.mockImplementation(async (id: string) => [episodeOf(id, 1)]);
		saveBrowseTab("series");
		await renderList();

		expect(screen.getByText("1 show")).toBeInTheDocument();
		fireEvent.click(screen.getByText("Harbor Lights"));
		const dialog = await screen.findByRole("dialog", { name: "Episodes of Harbor Lights" });

		expect(tauri.getXtreamSeriesEpisodes.mock.calls).toEqual([["xs-1"], ["xs-2"]]);
		expect(
			within(dialog)
				.getAllByRole("button", { name: /^Episode/ })
				.map((b) => b.textContent)
		).toEqual(["Episode Harbor Lights S01E01", "Episode Harbor Lights S01E01"]);
	});

	it("still opens a show when one of its other entries fails to load", async () => {
		state.channels = [xtreamShow, xtreamShowFr];
		tauri.getXtreamSeriesEpisodes.mockImplementation(async (id: string) => {
			if (id === "xs-2") throw new Error("server down");
			return [episodeOf(id, 1), episodeOf(id, 2)];
		});
		saveBrowseTab("series");
		await renderList();

		fireEvent.click(screen.getByText("Harbor Lights"));
		const dialog = await screen.findByRole("dialog", { name: "Episodes of Harbor Lights" });
		expect(within(dialog).getAllByRole("button", { name: /^Episode/ })).toHaveLength(2);
	});

	it("logs and opens nothing when the clicked entry fails to load", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		state.channels = [xtreamShow, xtreamShowFr];
		tauri.getXtreamSeriesEpisodes.mockImplementation(async (id: string) => {
			if (id === "xs-1") throw new Error("server down");
			return [episodeOf(id, 1)];
		});
		saveBrowseTab("series");
		await renderList();

		fireEvent.click(screen.getByText("Harbor Lights"));
		await waitFor(() =>
			expect(error).toHaveBeenCalledWith(
				"[ChannelList] failed to load series episodes:",
				new Error("server down")
			)
		);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(tauri.getCachedSeriesEpisodes).not.toHaveBeenCalled();
	});

	it("shows a loading overlay only when the episodes take a while", async () => {
		state.channels = [xtreamShow];
		let resolve: (eps: Channel[]) => void = () => {};
		tauri.getXtreamSeriesEpisodes.mockReturnValue(new Promise((r) => (resolve = r)));
		saveBrowseTab("series");
		await renderList();

		fireEvent.click(screen.getByText("Harbor Lights"));
		expect(screen.queryByText("Loading episodes…")).toBeNull();
		expect(await screen.findByText("Loading episodes…")).toBeInTheDocument();

		await act(async () => resolve([episodeOf("xs-1", 1)]));
		expect(screen.queryByText("Loading episodes…")).toBeNull();
		expect(
			screen.getByRole("dialog", { name: "Episodes of Harbor Lights" })
		).toBeInTheDocument();
	});
});

describe("ChannelList favorites tab", () => {
	const sportGuide = { ...sport, tvgId: "sport.tv" };
	const arts = makeChannel({
		id: "arts",
		name: "Arts Channel",
		url: "http://live.example.test/arts",
		groupTitle: "Culture",
		tvgId: "arts.tv",
		isFavorite: true,
	});
	const guide: EpgProgram[] = [
		{ channelId: "arts.tv", title: "Gallery Hour", startTime: NOW, endTime: NOW + 3600 },
		{ channelId: "news.tv", title: "Morning Briefing", startTime: NOW, endTime: NOW + 3600 },
		{ channelId: "sport.tv", title: "Match Day", startTime: NOW, endTime: NOW + 3600 },
	];

	const row = (name: string) => within(screen.getByText(name).closest(".group") as HTMLElement);

	it("groups favorites by type", async () => {
		saveBrowseTab("favorites");
		await renderList();

		const section = (name: string) =>
			within(screen.getByRole("heading", { name }).closest("section") as HTMLElement);
		expect(section("Live").getByText("Weather Now")).toBeInTheDocument();
		expect(section("Movies").getByText("Arrival")).toBeInTheDocument();
		expect(section("Series").getByText("Harbor Lights S01E02")).toBeInTheDocument();
		expect(screen.queryByText("News 24")).toBeNull();
	});

	it("leaves out the sections that have no favorites", async () => {
		state.channels = [weather, news];
		saveBrowseTab("favorites");
		await renderList();
		expect(screen.getByRole("heading", { name: "Live" })).toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: "Movies" })).toBeNull();
		expect(screen.queryByRole("heading", { name: "Series" })).toBeNull();
	});

	it("plays each favorite the way its own type plays", async () => {
		const trailerCut = makeChannel({
			id: "cut",
			name: "Director's Cut",
			contentType: "movie",
			isFavorite: true,
			sources: ["http://mirror.example.test/cut.mkv"],
		});
		state.channels = [...library, trailerCut];
		saveBrowseTab("favorites");
		await renderList();

		fireEvent.click(screen.getByText("Weather Now"));
		expect(playedWith()?.[1].state.channel).toBe(weather);

		fireEvent.click(screen.getByText("Arrival"));
		expect(playedWith()?.[1].state.channel).toBe(arrival);

		fireEvent.click(screen.getByText("Director's Cut"));
		expect(screen.getByRole("dialog", { name: "About Director's Cut" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));

		fireEvent.click(screen.getByText("Harbor Lights S01E02"));
		expect(
			await screen.findByRole("dialog", { name: "Episodes of Harbor Lights" })
		).toBeInTheDocument();
	});

	it("loads a favorite Xtream entry's own episodes first", async () => {
		state.channels = [xtreamShow, xtreamShowFr];
		tauri.getXtreamSeriesEpisodes.mockImplementation(async (id: string) => [episodeOf(id, 1)]);
		saveBrowseTab("favorites");
		await renderList();

		fireEvent.click(screen.getByText("harbor lights"));
		await screen.findByRole("dialog");
		expect(tauri.getXtreamSeriesEpisodes.mock.calls).toEqual([["xs-2"], ["xs-1"]]);
	});

	it("shows the guide on its live favorites", async () => {
		freezeClock();
		state.channels = [{ ...news, isFavorite: true }, weather];
		tauri.getEpgForLiveChannels.mockResolvedValue([
			{
				channelId: "news.tv",
				title: "Morning Briefing",
				startTime: NOW,
				endTime: NOW + 3600,
			},
		]);
		saveBrowseTab("favorites");
		await renderList();

		expect(tauri.getEpgForLiveChannels).toHaveBeenCalledExactlyOnceWith(
			NOW - 2 * 3600,
			NOW + 5 * 3600,
			["news.tv"]
		);
		const newsRow = screen.getByText("News 24").closest(".group") as HTMLElement;
		expect(within(newsRow).getByTitle("Morning Briefing")).toBeInTheDocument();
	});

	it("loads the guide only for the live favorites that have a guide id", async () => {
		freezeClock();
		const newsHd = makeChannel({
			id: "news-hd",
			name: "News 24 HD",
			url: "http://live.example.test/news-hd",
			tvgId: "news.tv",
			isFavorite: true,
		});
		state.channels = [
			{ ...news, isFavorite: true },
			weather,
			sportGuide,
			arts,
			newsHd,
			{ ...arrival, tvgId: "film.tv" },
		];
		tauri.getEpgForLiveChannels.mockImplementation(answerFrom(guide));
		saveBrowseTab("favorites");
		await renderList();

		// Weather Now has no guide id, Sport One isn't a favorite, Arrival isn't
		// live, and News 24 HD has the same guide as News 24.
		expect(tauri.getEpgForLiveChannels).toHaveBeenCalledExactlyOnceWith(
			NOW - 2 * 3600,
			NOW + 5 * 3600,
			["arts.tv", "news.tv"]
		);
		expect(row("Arts Channel").getByTitle("Gallery Hour")).toBeInTheDocument();
		expect(row("News 24 HD").getByTitle("Morning Briefing")).toBeInTheDocument();
	});

	it("loads only a new favorite's guide while the tab is open", async () => {
		freezeClock();
		state.channels = [{ ...news, isFavorite: true }, weather, sportGuide];
		tauri.getEpgForLiveChannels.mockImplementation(answerFrom(guide));
		saveBrowseTab("favorites");
		const { rerender } = await renderList();

		state.channels = [
			{ ...news, isFavorite: true },
			weather,
			{ ...sportGuide, isFavorite: true },
		];
		rerender(<ChannelList />);
		await flush();

		expect(tauri.getEpgForLiveChannels).toHaveBeenCalledTimes(2);
		expect(tauri.getEpgForLiveChannels).toHaveBeenLastCalledWith(
			NOW - 2 * 3600,
			NOW + 5 * 3600,
			["sport.tv"]
		);
		expect(row("News 24").getByTitle("Morning Briefing")).toBeInTheDocument();
		expect(row("Sport One").getByTitle("Match Day")).toBeInTheDocument();
	});

	it("loads nothing when a favorite goes while the tab is open", async () => {
		freezeClock();
		state.channels = [
			{ ...news, isFavorite: true },
			weather,
			{ ...sportGuide, isFavorite: true },
		];
		tauri.getEpgForLiveChannels.mockImplementation(answerFrom(guide));
		saveBrowseTab("favorites");
		const { rerender } = await renderList();

		state.channels = [{ ...news, isFavorite: true }, weather, sportGuide];
		rerender(<ChannelList />);
		await flush();

		expect(tauri.getEpgForLiveChannels).toHaveBeenCalledExactlyOnceWith(
			NOW - 2 * 3600,
			NOW + 5 * 3600,
			["news.tv", "sport.tv"]
		);
		expect(screen.queryByText("Sport One")).toBeNull();
		expect(row("News 24").getByTitle("Morning Briefing")).toBeInTheDocument();
	});

	it("keeps the Live tab's guide for Favorites and back", async () => {
		freezeClock();
		state.channels = [news, weather, sportGuide];
		tauri.getEpgForLiveChannels.mockImplementation(answerFrom(guide));
		const { rerender } = await renderList();
		expect(tauri.getEpgForLiveChannels).toHaveBeenCalledExactlyOnceWith(
			NOW - 2 * 3600,
			NOW + 5 * 3600
		);

		// The Live tab loaded every channel's guide, so a new favorite already
		// has its own.
		state.channels = [news, weather, { ...sportGuide, isFavorite: true }];
		rerender(<ChannelList />);
		await openTab("Favorites");
		expect(row("Sport One").getByTitle("Match Day")).toBeInTheDocument();
		await openTab("Live");
		expect(row("News 24").getByTitle("Morning Briefing")).toBeInTheDocument();

		expect(tauri.getEpgForLiveChannels).toHaveBeenCalledOnce();
	});

	it("loads every channel's guide once when Live comes back before that load finishes", async () => {
		freezeClock();
		const all = deferred<EpgProgram[]>();
		tauri.getEpgForLiveChannels
			.mockReturnValueOnce(all.promise)
			.mockImplementation(answerFrom(guide));
		state.channels = [{ ...news, isFavorite: true }, weather, sportGuide];
		await renderList();
		await openTab("Favorites");
		expect(row("News 24").getByTitle("Morning Briefing")).toBeInTheDocument();
		await openTab("Live");

		// Sport One waits for the load Live started first.
		expect(row("News 24").getByTitle("Morning Briefing")).toBeInTheDocument();
		expect(row("Sport One").queryByText("no epg")).toBeNull();
		await act(async () => all.resolve(guide));
		expect(row("Sport One").getByTitle("Match Day")).toBeInTheDocument();

		expect(tauri.getEpgForLiveChannels.mock.calls).toStrictEqual([
			[NOW - 2 * 3600, NOW + 5 * 3600],
			[NOW - 2 * 3600, NOW + 5 * 3600, ["news.tv"]],
		]);
	});

	it("says a favorite has no guide only once its own guide has loaded", async () => {
		freezeClock();
		const load = deferred<EpgProgram[]>();
		tauri.getEpgForLiveChannels.mockReturnValueOnce(load.promise);
		state.channels = [
			{ ...news, isFavorite: true },
			{ ...sportGuide, isFavorite: true },
		];
		saveBrowseTab("favorites");
		await renderList();

		expect(row("News 24").queryByText("no epg")).toBeNull();
		expect(row("Sport One").queryByText("no epg")).toBeNull();
		await act(async () => load.resolve(guide.filter((p) => p.channelId === "news.tv")));
		expect(row("News 24").getByTitle("Morning Briefing")).toBeInTheDocument();
		expect(row("Sport One").getByText("no epg")).toBeInTheDocument();
	});

	it("keeps the favorites' programs and waits for the rest when Live opens after Favorites", async () => {
		freezeClock();
		tauri.getEpgForLiveChannels.mockImplementation(answerFrom(guide));
		state.channels = [{ ...news, isFavorite: true }, weather, sportGuide];
		saveBrowseTab("favorites");
		await renderList();
		const all = deferred<EpgProgram[]>();
		tauri.getEpgForLiveChannels.mockReturnValueOnce(all.promise);
		await openTab("Live");

		expect(row("News 24").getByTitle("Morning Briefing")).toBeInTheDocument();
		expect(row("Sport One").queryByText("no epg")).toBeNull();
		await act(async () => all.resolve(guide));
		expect(row("Sport One").getByTitle("Match Day")).toBeInTheDocument();
	});

	it("keeps showing every row's programs while Live loads a later window", async () => {
		driveClock();
		const allDay = (channelId: string, title: string): EpgProgram => ({
			channelId,
			title,
			startTime: NOW - 3600,
			endTime: NOW + 8 * 3600,
		});
		tauri.getEpgForLiveChannels.mockImplementation(
			answerFrom([allDay("news.tv", "Morning Briefing"), allDay("sport.tv", "Match Day")])
		);
		state.channels = [{ ...news, isFavorite: true }, weather, sportGuide];
		await renderList();
		await openTab("Favorites");

		// The clock carries the window past the guide, and Favorites loads only
		// its own channels for the new one.
		vi.setSystemTime((NOW + 3 * 3600) * 1000);
		act(() => vi.advanceTimersByTime(30_000));
		await flush();
		const later = deferred<EpgProgram[]>();
		tauri.getEpgForLiveChannels.mockReturnValueOnce(later.promise);
		await openTab("Live");

		expect(row("Sport One").getByTitle("Match Day")).toBeInTheDocument();
		await act(async () => later.resolve([allDay("sport.tv", "Late Match")]));
		expect(row("Sport One").getByTitle("Late Match")).toBeInTheDocument();
		// What every channel's load found replaces the whole guide.
		expect(row("News 24").getByText("no epg")).toBeInTheDocument();

		expect(tauri.getEpgForLiveChannels.mock.calls).toStrictEqual([
			[NOW - 2 * 3600, NOW + 5 * 3600],
			[NOW + 3600, NOW + 9 * 3600, ["news.tv"]],
			[NOW + 3600, NOW + 9 * 3600],
		]);
	});

	it("loads only the favorites' guide when the clock carries the window past it", async () => {
		driveClock();
		state.channels = [{ ...news, isFavorite: true }, weather, sportGuide];
		saveBrowseTab("favorites");
		await renderList();

		// The guide loaded up to 5 hours after NOW, and a narrow window gets there
		// 3 hours after NOW.
		vi.setSystemTime((NOW + 3 * 3600) * 1000);
		// The guide's call goes out a moment after the tick, so it can take
		// the other ids asked for with it.
		await act(async () => vi.advanceTimersByTime(30_000));

		expect(tauri.getEpgForLiveChannels).toHaveBeenCalledTimes(2);
		expect(tauri.getEpgForLiveChannels).toHaveBeenLastCalledWith(NOW + 3600, NOW + 9 * 3600, [
			"news.tv",
		]);
	});

	it("loads the favorites' guide again after the playlist reloads", async () => {
		freezeClock();
		state.channels = [{ ...news, isFavorite: true }, weather];
		saveBrowseTab("favorites");
		const { rerender } = await renderList();

		state.channels = [{ ...news, isFavorite: true }, weather, sportGuide];
		rerender(<ChannelList />);
		await flush();

		const favoritesGuide = [NOW - 2 * 3600, NOW + 5 * 3600, ["news.tv"]];
		expect(tauri.getEpgForLiveChannels.mock.calls).toStrictEqual([
			favoritesGuide,
			favoritesGuide,
		]);
	});

	it("waits for the guide on Live after a tab without one", async () => {
		freezeClock();
		tauri.getEpgForLiveChannels.mockImplementation(answerFrom(guide));
		state.channels = [{ ...news, isFavorite: true }, weather, sportGuide, arrival];
		saveBrowseTab("favorites");
		await renderList();
		await openTab("Movies");
		const all = deferred<EpgProgram[]>();
		tauri.getEpgForLiveChannels.mockReturnValueOnce(all.promise);
		await openTab("Live");

		expect(row("News 24").queryByText("no epg")).toBeNull();
		expect(row("Sport One").queryByText("no epg")).toBeNull();
		await act(async () => all.resolve(guide));
		expect(row("News 24").getByTitle("Morning Briefing")).toBeInTheDocument();
		expect(row("Sport One").getByTitle("Match Day")).toBeInTheDocument();

		expect(tauri.getEpgForLiveChannels.mock.calls).toStrictEqual([
			[NOW - 2 * 3600, NOW + 5 * 3600, ["news.tv"]],
			[NOW - 2 * 3600, NOW + 5 * 3600],
		]);
	});

	it("loads only a new favorite's guide while the others are still loading", async () => {
		freezeClock();
		const first = deferred<EpgProgram[]>();
		tauri.getEpgForLiveChannels
			.mockReturnValueOnce(first.promise)
			.mockImplementation(answerFrom(guide));
		state.channels = [{ ...news, isFavorite: true }, weather, sportGuide];
		saveBrowseTab("favorites");
		const { rerender } = await renderList();

		state.channels = [
			{ ...news, isFavorite: true },
			weather,
			{ ...sportGuide, isFavorite: true },
		];
		rerender(<ChannelList />);
		await flush();
		await act(async () => first.resolve(guide.filter((p) => p.channelId === "news.tv")));

		expect(row("News 24").getByTitle("Morning Briefing")).toBeInTheDocument();
		expect(row("Sport One").getByTitle("Match Day")).toBeInTheDocument();
		expect(tauri.getEpgForLiveChannels.mock.calls).toStrictEqual([
			[NOW - 2 * 3600, NOW + 5 * 3600, ["news.tv"]],
			[NOW - 2 * 3600, NOW + 5 * 3600, ["sport.tv"]],
		]);
	});

	it("loads no guide when no live favorite has one", async () => {
		saveBrowseTab("favorites");
		await renderList();
		expect(screen.getByText("Weather Now")).toBeInTheDocument();
		expect(tauri.getEpgForLiveChannels).not.toHaveBeenCalled();
	});

	it("suggests adding favorites when there are none", async () => {
		state.channels = [news, dune];
		saveBrowseTab("favorites");
		await renderList();
		expect(tab("Favorites")).toHaveTextContent(/^Favorites0$/);
		expect(screen.getByText("No favorites yet — tap ♡ on any channel")).toBeInTheDocument();
		expect(tauri.getEpgForLiveChannels).not.toHaveBeenCalled();
	});

	it("says when the search matches no favorite", async () => {
		saveBrowseTab("favorites");
		saveBrowseSearch("zzz");
		await renderList();
		expect(screen.getByText("No favorites matching “zzz”")).toBeInTheDocument();
		fireEvent.click(screen.getByText("Clear search"));
		expect(await screen.findByText("Weather Now")).toBeInTheDocument();
	});
});

describe("ChannelList downloads tab", () => {
	it("plays a downloaded movie and opens a downloaded show", async () => {
		state.downloads = [
			makeDownload({ id: "d1", channelId: "arrival" }),
			makeDownload({ id: "d2", channelId: "hl-1", kind: "episode", seriesChannelId: "hl-2" }),
		];
		await renderList();
		await openTab("Downloads");

		fireEvent.click(screen.getByText("Arrival"));
		expect(playedWith()?.[1].state.channel).toBe(arrival);

		fireEvent.click(screen.getByText("Harbor Lights S01E02"));
		const dialog = await screen.findByRole("dialog", { name: "Episodes of Harbor Lights" });
		expect(within(dialog).getAllByRole("button", { name: /^Episode/ })).toHaveLength(2);
		expect(tauri.getCachedSeriesEpisodes).not.toHaveBeenCalled();
	});

	it("toggles a download's favorite", async () => {
		state.downloads = [makeDownload({ id: "d1", channelId: "dune-a" })];
		await renderList();
		await openTab("Downloads");
		fireEvent.click(screen.getByRole("button", { name: "Add to favorites" }));
		expect(state.toggleFavorite).toHaveBeenCalledWith("dune-a");
	});

	it("uses the saved episode list when the show can't be loaded", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		state.channels = [xtreamShow];
		state.downloads = [
			makeDownload({
				id: "d1",
				channelId: "xs-1-e1",
				kind: "episode",
				seriesChannelId: "xs-1",
			}),
		];
		tauri.getXtreamSeriesEpisodes.mockRejectedValue(new Error("offline"));
		tauri.getCachedSeriesEpisodes.mockResolvedValue([episodeOf("xs-1", 1)]);
		await renderList();
		await openTab("Downloads");

		fireEvent.click(screen.getByText("Harbor Lights"));
		const dialog = await screen.findByRole("dialog", { name: "Episodes of Harbor Lights" });
		expect(warn).toHaveBeenCalled();
		expect(tauri.getCachedSeriesEpisodes).toHaveBeenCalledWith("xs-1");
		expect(within(dialog).getByText("Episode Harbor Lights S01E01")).toBeInTheDocument();
	});

	it("uses the saved episode list when the live one comes back empty", async () => {
		state.channels = [xtreamShow];
		state.downloads = [
			makeDownload({
				id: "d1",
				channelId: "xs-1-e2",
				kind: "episode",
				seriesChannelId: "xs-1",
			}),
		];
		tauri.getXtreamSeriesEpisodes.mockResolvedValue([]);
		tauri.getCachedSeriesEpisodes.mockResolvedValue([episodeOf("xs-1", 2)]);
		await renderList();
		await openTab("Downloads");

		fireEvent.click(screen.getByText("Harbor Lights"));
		const dialog = await screen.findByRole("dialog", { name: "Episodes of Harbor Lights" });
		expect(within(dialog).getByText("Episode Harbor Lights S01E02")).toBeInTheDocument();
	});
});

describe("ChannelList history tab", () => {
	const watched = (
		channelId: string,
		channelName: string,
		contentType: "live" | "movie" | "series",
		seriesTitle: string | null = null
	) => makeHistoryEntry({ channelId, channelName, contentType, seriesTitle });

	const playFromHistory = async (entry: ReturnType<typeof watched>) => {
		tauri.getWatchHistory.mockResolvedValue([entry]);
		saveBrowseTab("history");
		await renderList();
		expect(tauri.getWatchHistory).toHaveBeenCalledWith(200, undefined);
		fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${entry.channelName}`) }));
		await flush();
	};

	it("replays a watched episode with its season in order", async () => {
		await playFromHistory(watched("hl-1", "Harbor Lights S01E01", "series", "Harbor Lights"));

		const [path, { state: played }] = playedWith()!;
		expect(path).toBe("/player");
		expect(played.url).toBe(hl1.url);
		expect(played.channel.id).toBe("hl-1");
		expect(played.seriesEpisodes.map((ep: Channel) => ep.id)).toEqual(["hl-1", "hl-2"]);
	});

	it("finds the show from the episode name when the entry has no show title", async () => {
		await playFromHistory(watched("hl-2", "Harbor Lights S01E02", "series"));
		expect(playedWith()?.[1].state.channel.id).toBe("hl-2");
	});

	it("opens the show when the watched episode is no longer listed", async () => {
		await playFromHistory(watched("hl-9", "Harbor Lights S03E09", "series", "Harbor Lights"));

		expect(state.navigate).not.toHaveBeenCalled();
		const dialog = screen.getByRole("dialog", { name: "Episodes of Harbor Lights" });
		expect(within(dialog).getByText("Series card hl-2")).toBeInTheDocument();
	});

	it("does nothing for a show that is gone", async () => {
		await playFromHistory(watched("x-1", "Old Show S01E01", "series", "Old Show"));
		expect(state.navigate).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("loads an Xtream show before replaying the episode", async () => {
		state.channels = [xtreamShow];
		tauri.getXtreamSeriesEpisodes.mockResolvedValue([
			episodeOf("xs-1", 1),
			episodeOf("xs-1", 2),
		]);
		await playFromHistory(
			watched("xs-1-e2", "Harbor Lights S01E02", "series", "Harbor Lights")
		);

		expect(tauri.getXtreamSeriesEpisodes).toHaveBeenCalledWith("xs-1");
		expect(playedWith()?.[1].state.channel.id).toBe("xs-1-e2");
	});

	it("logs when an Xtream show can't be loaded for a replay", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		state.channels = [xtreamShow];
		tauri.getXtreamSeriesEpisodes.mockRejectedValue(new Error("offline"));
		await playFromHistory(
			watched("xs-1-e2", "Harbor Lights S01E02", "series", "Harbor Lights")
		);

		expect(error).toHaveBeenCalled();
		expect(state.navigate).not.toHaveBeenCalled();
	});

	it("opens the drawer for a watched movie", async () => {
		await playFromHistory(watched("dune-a", "Dune", "movie"));
		expect(screen.getByRole("dialog", { name: "About Dune" })).toBeInTheDocument();
	});

	it("ignores a watched movie that is no longer listed", async () => {
		await playFromHistory(watched("gone", "Solaris", "movie"));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("plays a watched live channel", async () => {
		await playFromHistory(watched("sport", "Sport One", "live"));
		expect(state.navigate).toHaveBeenCalledWith("/player", {
			state: { url: sport.url, channelName: "Sport One", channel: sport },
		});
	});
});

describe("ChannelList virtual list", () => {
	it("draws the guide's gridlines and the now line behind the live rows", async () => {
		freezeClock();
		state.channels = liveChannels(5);
		const { container } = await renderList();

		const grid = rowGrid(container)!;
		expect(grid.style.left).toBe(`${ROW_CARD_LEFT_WIDTH}px`);
		expect(grid.style.right).toBe("80px");
		const lines = [...grid.children] as HTMLElement[];
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) expect(line.style.left).toMatch(/^[\d.]+%$/);
		expect(lines[lines.length - 1]).toHaveClass("bg-red-400/20");
	});

	it("draws no gridlines behind posters", async () => {
		state.channels = [
			...liveChannels(3),
			makeChannel({ id: "m1", name: "Heat", contentType: "movie" }),
		];
		const { container } = await renderList();
		await openTab("Movies");
		expect(screen.getByText("Heat")).toBeInTheDocument();
		expect(rowGrid(container)).toBeNull();
	});

	it("renders only the rows in view and the next ones as the list scrolls", async () => {
		state.channels = liveChannels(300);
		await renderList();

		const rendered = () => screen.getAllByText(/^Channel \d+$/).map((el) => el.textContent);
		expect(rendered().length).toBeLessThan(30);
		expect(rendered()).toContain("Channel 1");
		expect(rendered()).not.toContain("Channel 201");

		// Keeps the height of all 300 rows, so the scrollbar fits the whole list.
		const scroller = screen.getByText("Channel 1").closest(".overflow-auto") as HTMLElement;
		expect((scroller.firstElementChild as HTMLElement).style.height).toBe(`${300 * 48}px`);

		scroller.scrollTop = 200 * 48;
		fireEvent.scroll(scroller);

		expect(rendered()).toContain("Channel 201");
		expect(rendered()).not.toContain("Channel 1");

		// The virtualizer ends the scroll 150 ms later. Waiting here keeps that
		// timer from firing after the test environment is gone.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 200));
		});
		expect(rendered()).toContain("Channel 201");
	});

	it("puts as many posters in a row as fit the width", async () => {
		const { resize } = watchResizes();
		state.channels = Array.from({ length: 9 }, (_, i) =>
			makeChannel({ id: `m${i + 1}`, name: `Movie ${i + 1}`, contentType: "movie" })
		);
		saveBrowseTab("movie");
		const { container } = await renderList();

		const rowOf = (name: string) => screen.getByText(name).closest(".grid") as HTMLElement;
		const titles = (row: HTMLElement) =>
			within(row)
				.getAllByText(/^Movie \d$/)
				.map((el) => el.textContent);
		expect(titles(rowOf("Movie 1"))).toEqual(["Movie 1", "Movie 2", "Movie 3", "Movie 4"]);
		expect(rowOf("Movie 1").style.gridTemplateColumns).toBe("repeat(4, minmax(0, 1fr))");
		expect(titles(rowOf("Movie 9"))).toEqual(["Movie 9"]);

		resize(container.firstElementChild!, 1200);

		expect(titles(rowOf("Movie 1"))).toEqual([
			"Movie 1",
			"Movie 2",
			"Movie 3",
			"Movie 4",
			"Movie 5",
			"Movie 6",
		]);
	});
});

describe("ChannelList on a phone", () => {
	/** The tab list is fixed when the module loads, so load it again as on a phone. */
	const loadPhoneList = async () => {
		state.os = "ios";
		state.layoutMode = "mobile";
		vi.resetModules();
		return (await import("./ChannelList")).ChannelList;
	};

	it("draws no guide gridlines, since its rows have no timeline", async () => {
		const PhoneList = await loadPhoneList();
		state.channels = liveChannels(3);
		const { container } = await renderList(PhoneList);
		expect(screen.getByText("Channel 1")).toBeInTheDocument();
		expect(rowGrid(container)).toBeNull();
	});

	it("has no downloads tab or download filter", async () => {
		const PhoneList = await loadPhoneList();
		await renderList(PhoneList);

		expect(screen.queryByRole("button", { name: /^Downloads/ })).toBeNull();
		expect(screen.queryByRole("button", { name: "Show downloaded only" })).toBeNull();
		expect(screen.getByRole("button", { name: "Show favorites only" })).toBeInTheDocument();
	});

	it("opens on the live tab when the downloads tab was remembered", async () => {
		saveBrowseTab("downloads");
		const PhoneList = await loadPhoneList();
		await renderList(PhoneList);
		expect(screen.getByText("3 channels")).toBeInTheDocument();
		expect(screen.getByText("News 24")).toBeInTheDocument();
	});

	it("shows what's on now in each row instead of a timeline", async () => {
		freezeClock();
		tauri.getEpgForLiveChannels.mockResolvedValue([
			{
				channelId: "news.tv",
				title: "Morning Briefing",
				startTime: NOW - 1800,
				endTime: NOW + 1800,
			},
			{
				channelId: "news.tv",
				title: "Market Watch",
				startTime: NOW + 1800,
				endTime: NOW + 5400,
			},
		]);
		const PhoneList = await loadPhoneList();
		await renderList(PhoneList);

		const row = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });
		expect(row("News 24")).toHaveTextContent(/^News 24Morning Briefing$/);
		expect(screen.queryByText("Market Watch")).toBeNull();
		expect(screen.queryByText("▾")).toBeNull();
		// Weather Now has no guide, so its row shows the group.
		expect(row("Weather Now")).toHaveTextContent(/^Weather NowNews$/);
	});
});
