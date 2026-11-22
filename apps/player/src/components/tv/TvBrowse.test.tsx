// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCatalog, type HistoryActions } from "@/hooks/useCatalog";
import { useChannels } from "@/hooks/useChannels";
import { useHistoryStaleOnLeave } from "@/hooks/useWatchHistory";
import { getXtreamSeriesEpisodes } from "@/lib/tauri";
import { getZapList, setZapList } from "@/lib/tv-zap";
import type { Channel, WatchHistoryEntry } from "@/lib/types";
import { makeChannel, makeHistoryEntry } from "@/test/channel-fixtures";
import { makeEpisode } from "@/test/detail-fixtures";
import { TvBrowse } from "./TvBrowse";
import { TvDetails } from "./TvDetails";
import { TvFavorites } from "./TvFavorites";
import { TvHistory } from "./TvHistory";
import { TvLive } from "./TvLive";
import { TvPosters } from "./TvPosters";
import { TvSearch } from "./TvSearch";
import { TvNavContext, type TvNav, type TvSection } from "./tv-nav";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("react-router")>()),
	useNavigate: () => navigate,
}));
vi.mock("@/hooks/useChannels", () => ({ useChannels: vi.fn() }));
vi.mock("@/hooks/useWatchHistory", () => ({ useHistoryStaleOnLeave: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ getXtreamSeriesEpisodes: vi.fn() }));
vi.mock("@/hooks/useCatalog", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/hooks/useCatalog")>();
	return { ...actual, useCatalog: vi.fn(actual.useCatalog) };
});
vi.mock("./TvSearch", () => ({ TvSearch: vi.fn(() => <p>Search screen</p>) }));
vi.mock("./TvLive", () => ({ TvLive: vi.fn(() => <p>Live screen</p>) }));
vi.mock("./TvPosters", () => ({
	TvPosters: vi.fn(({ title }: { title: string }) => <p>{title} screen</p>),
}));
vi.mock("./TvFavorites", () => ({ TvFavorites: vi.fn(() => <p>Favorites screen</p>) }));
vi.mock("./TvHistory", () => ({ TvHistory: vi.fn(() => <p>History screen</p>) }));
vi.mock("./TvDetails", () => ({
	TvDetails: vi.fn(({ item }: { item: Channel }) => <p>Details of {item.name}</p>),
}));

/** The props a stubbed screen last rendered with. */
const propsOf = <P,>(screenStub: (props: P) => unknown): P => {
	const call = (screenStub as unknown as Mock).mock.lastCall;
	if (!call) throw new Error("That screen didn't render");
	return call[0] as P;
};

const NEWS = makeChannel({ id: "news", name: "News", isFavorite: true });
const SPORT = makeChannel({ id: "sport", name: "Sport" });
const DUNE = makeChannel({ id: "dune", name: "Dune", contentType: "movie", isFavorite: true });
const ALIEN = makeChannel({ id: "alien", name: "Alien", contentType: "movie" });
const PILOT = makeEpisode(1, 1, "Pilot");
const FINALE = makeEpisode(1, 2, "Finale", { isFavorite: true });
const OTHER_SHOW = makeEpisode(1, 1, "Start", { id: "other", seriesTitle: "Other" });
const CHANNELS = [NEWS, SPORT, DUNE, ALIEN, FINALE, PILOT, OTHER_SHOW];

const openSection = vi.fn();

const channelsAre = (channels: Channel[], loading = false) =>
	vi
		.mocked(useChannels)
		.mockReturnValue({ channels, loading } as unknown as ReturnType<typeof useChannels>);

const browse = (section: TvSection, memory: TvNav["memory"]) => (
	<TvNavContext.Provider value={{ section, openSection, memory }}>
		<TvBrowse />
	</TvNavContext.Provider>
);

const show = (section: TvSection, memory: TvNav["memory"] = new Map()) =>
	render(browse(section, memory));

const lastPlayed = () => navigate.mock.lastCall?.[1].state as Record<string, unknown>;

describe("TvBrowse", () => {
	beforeEach(() => {
		channelsAre(CHANNELS);
		setZapList([]);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		vi.mocked(useCatalog).mockReset();
	});

	it("marks the history stale when it's left", () => {
		show("live");
		expect(useHistoryStaleOnLeave).toHaveBeenCalled();
	});

	describe("without channels", () => {
		it("says it's loading them while they load", () => {
			channelsAre([], true);
			show("live");
			expect(screen.getByText("Loading channels")).toBeInTheDocument();
			expect(screen.queryByRole("button")).not.toBeInTheDocument();
			expect(screen.queryByText("Live screen")).not.toBeInTheDocument();
		});

		it("offers to load them again when they failed to load", async () => {
			const refreshProviders = vi.fn().mockResolvedValue(null);
			const refreshChannels = vi.fn().mockResolvedValue(undefined);
			vi.mocked(useChannels).mockReturnValue({
				channels: [],
				loading: false,
				loadFailed: true,
				refreshProviders,
				refreshChannels,
			} as unknown as ReturnType<typeof useChannels>);
			show("live");

			expect(screen.getByText("Couldn't load your channels")).toBeInTheDocument();
			expect(
				screen.queryByText("Add a provider to see channels here")
			).not.toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "Try again" }));
			expect(refreshProviders).toHaveBeenCalledOnce();
			expect(refreshChannels).toHaveBeenCalledOnce();
		});

		it("says it's loading them while a list that failed loads again", () => {
			vi.mocked(useChannels).mockReturnValue({
				channels: [],
				loading: true,
				loadFailed: true,
			} as unknown as ReturnType<typeof useChannels>);
			show("live");

			expect(screen.getByText("Loading channels")).toBeInTheDocument();
			expect(screen.queryByRole("button")).not.toBeInTheDocument();
		});

		it("shows the channels it still has when a later load fails", () => {
			vi.mocked(useChannels).mockReturnValue({
				channels: CHANNELS,
				loading: false,
				loadFailed: true,
			} as unknown as ReturnType<typeof useChannels>);
			show("live");

			expect(screen.getByText("Live screen")).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
		});

		it("sends the viewer to Settings, where providers are, when there are none", () => {
			channelsAre([]);
			show("live");
			expect(screen.getByText("Add a provider to see channels here")).toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "Go to Settings" }));
			expect(openSection).toHaveBeenCalledExactlyOnceWith("settings");
			expect(screen.queryByText("Live screen")).not.toBeInTheDocument();
		});

		it("shows channels that are there while more load", () => {
			channelsAre(CHANNELS, true);
			show("live");
			expect(screen.getByText("Live screen")).toBeInTheDocument();
		});
	});

	describe("the sections", () => {
		it.each<[TvSection, string]>([
			["search", "Search screen"],
			["live", "Live screen"],
			["movie", "Movies screen"],
			["series", "Series screen"],
			["favorites", "Favorites screen"],
			["history", "History screen"],
		])("shows only the %s screen when it's open", (section, text) => {
			const { container } = show(section);
			expect(container.textContent).toBe(text);
		});

		it("searches the channels, movies and shows, each kind on its own", () => {
			show("search");
			expect(
				propsOf(TvSearch).kinds.map((kind) => [kind.name, kind.items.map((i) => i.name)])
			).toEqual([
				["Live TV", ["News", "Sport"]],
				["Movies", ["Dune", "Alien"]],
				["Series", ["Show", "Other"]],
			]);
		});

		it("searches the new channels when they change", () => {
			const memory = new Map();
			const { rerender } = show("search", memory);
			channelsAre([SPORT]);
			rerender(browse("search", memory));
			expect(propsOf(TvSearch).kinds.map((kind) => kind.items)).toEqual([[SPORT], [], []]);
		});

		it("gives Live TV the live channels", () => {
			show("live");
			expect(propsOf(TvLive).live).toEqual([NEWS, SPORT]);
		});

		it("gives Movies one of each title, remembered on its own", () => {
			show("movie");
			const props = propsOf(TvPosters);
			expect(props.title).toBe("Movies");
			expect(props.memoryKey).toBe("movie");
			expect(props.items.map((item) => item.name)).toEqual(["Dune", "Alien"]);
		});

		it("gives Series one card per show, remembered on its own", () => {
			show("series");
			const props = propsOf(TvPosters);
			expect(props.title).toBe("Series");
			expect(props.memoryKey).toBe("series");
			expect(props.items.map((item) => item.name)).toEqual(["Show", "Other"]);
		});

		it("sorts the favorites by kind, a show counting if any episode is a favorite", () => {
			show("favorites");
			const groups = propsOf(TvFavorites).groups;
			expect(groups.map((g) => g.name)).toEqual(["Live TV", "Movies", "Series"]);
			expect(groups[0].items).toEqual([NEWS]);
			expect(groups[1].items.map((item) => item.name)).toEqual(["Dune"]);
			expect(groups[2].items.map((item) => item.name)).toEqual(["Show"]);
		});

		it("counts a favorite episode under another spelling of its show", () => {
			channelsAre([
				makeEpisode(1, 1, "Start", { id: "a", seriesTitle: "The Show" }),
				makeEpisode(1, 2, "Next", { id: "b", seriesTitle: "the show", isFavorite: true }),
			]);
			show("favorites");
			expect(propsOf(TvFavorites).groups[2].items.map((item) => item.name)).toEqual([
				"The Show",
			]);
		});

		it("leaves things that aren't favorites out of the favorites", () => {
			channelsAre([SPORT, ALIEN, PILOT]);
			show("favorites");
			expect(propsOf(TvFavorites).groups.flatMap((g) => g.items)).toEqual([]);
		});

		it("follows the favorites as they change", () => {
			const memory = new Map();
			const { rerender } = show("favorites", memory);
			channelsAre([{ ...SPORT, isFavorite: true }]);
			rerender(browse("favorites", memory));
			expect(propsOf(TvFavorites).groups[0].items.map((item) => item.id)).toEqual(["sport"]);
		});
	});

	describe("opening something", () => {
		const opened = (name: string) => screen.getByText(`Details of ${name}`);

		it.each<[TvSection, () => (item: Channel) => void]>([
			["search", () => propsOf(TvSearch).onOpen],
			["movie", () => propsOf(TvPosters).onOpen],
			["series", () => propsOf(TvPosters).onOpen],
		])("plays a channel from %s with every live channel to zap through", (section, onOpen) => {
			show(section);
			act(() => onOpen()(SPORT));
			expect(getZapList()).toEqual([NEWS, SPORT]);
			expect(navigate).toHaveBeenCalledExactlyOnceWith("/player", {
				state: { url: SPORT.url, channelName: "Sport", channel: SPORT },
			});
			expect(lastPlayed()).not.toHaveProperty("seriesEpisodes");
		});

		it("plays a favorite with its own list to zap through", () => {
			show("favorites");
			act(() => propsOf(TvFavorites).onOpen(SPORT, [SPORT]));
			expect(getZapList()).toEqual([SPORT]);
			expect(lastPlayed().channel).toBe(SPORT);
		});

		it("plays a channel from Live TV with the list it came from", () => {
			show("live");
			act(() => propsOf(TvLive).onPlay(NEWS, [NEWS]));
			expect(getZapList()).toEqual([NEWS]);
			expect(lastPlayed().channel).toBe(NEWS);
		});

		it.each<[string, Channel]>([
			["movie", DUNE],
			["show", PILOT],
		])("opens the details of a %s instead of playing it", (_kind, item) => {
			show("search");
			act(() => propsOf(TvSearch).onOpen(item));
			expect(opened(item.name)).toBeInTheDocument();
			expect(navigate).not.toHaveBeenCalled();
			expect(getZapList()).toEqual([]);
		});

		it("shows the details over the section, and closes them", () => {
			const memory = new Map();
			show("movie", memory);
			act(() => propsOf(TvPosters).onOpen(DUNE));
			expect(screen.getByText("Movies screen")).toBeInTheDocument();
			expect(memory.get("details")).toBe(DUNE);

			act(() => propsOf(TvDetails).onClose());
			expect(screen.queryByText(/Details of/)).not.toBeInTheDocument();
			expect(memory.get("details")).toBeNull();
		});

		it("brings back the details that were open before the player", () => {
			show("movie", new Map([["details", DUNE]]));
			expect(opened("Dune")).toBeInTheDocument();
		});

		it("plays a movie from its details without a list of episodes", () => {
			show("movie");
			act(() => propsOf(TvPosters).onOpen(DUNE));
			act(() => propsOf(TvDetails).onPlay(DUNE));
			expect(navigate).toHaveBeenCalledExactlyOnceWith("/player", {
				state: { url: DUNE.url, channelName: "Dune", channel: DUNE },
			});
			expect(lastPlayed()).not.toHaveProperty("seriesEpisodes");
		});

		it("plays an episode from its details with the show's episodes in order", () => {
			show("series");
			act(() => propsOf(TvPosters).onOpen(PILOT));
			act(() => propsOf(TvDetails).onPlay(FINALE, [FINALE, PILOT]));
			expect(lastPlayed()).toEqual({
				url: FINALE.url,
				channelName: FINALE.name,
				channel: FINALE,
				seriesEpisodes: [PILOT, FINALE],
			});
		});

		it("gives the details a way to load a show's episodes", async () => {
			show("series");
			act(() => propsOf(TvPosters).onOpen(PILOT));
			await expect(propsOf(TvDetails).episodesOf(PILOT)).resolves.toEqual([FINALE, PILOT]);
		});
	});

	describe("opening a history entry", () => {
		const open = (entry: WatchHistoryEntry, memory: TvNav["memory"] = new Map()) => {
			show("history", memory);
			act(() => propsOf(TvHistory).onOpen(entry));
		};

		it("plays an episode that's still there, with the show's episodes in order", () => {
			open(
				makeHistoryEntry({
					channelId: FINALE.id,
					channelName: FINALE.name,
					contentType: "series",
					seriesTitle: "Show",
				})
			);
			expect(lastPlayed()).toEqual({
				url: FINALE.url,
				channelName: FINALE.name,
				channel: expect.objectContaining({ id: FINALE.id }),
				seriesEpisodes: [PILOT, FINALE],
			});
			expect(getZapList()).toEqual([]);
		});

		it("loads an Xtream show's episodes before playing one", async () => {
			const container = makeEpisode(0, 0, "", {
				id: "xt",
				name: "Show",
				url: "xtream://series/1",
				season: undefined,
				episode: undefined,
			});
			channelsAre([NEWS, container]);
			vi.mocked(getXtreamSeriesEpisodes).mockResolvedValue([PILOT]);
			open(
				makeHistoryEntry({
					channelId: PILOT.id,
					channelName: PILOT.name,
					contentType: "series",
					seriesTitle: "Show",
				})
			);
			await waitFor(() =>
				expect(lastPlayed()?.channel).toEqual(expect.objectContaining({ id: PILOT.id }))
			);
		});

		it("opens the show's details when the episode has gone", () => {
			open(
				makeHistoryEntry({
					channelId: "gone",
					channelName: "Show S09E09 Gone",
					contentType: "series",
					seriesTitle: "Show",
				})
			);
			expect(screen.getByText("Details of Show")).toBeInTheDocument();
			expect(navigate).not.toHaveBeenCalled();
		});

		describe("when it picks a show for an episode that's gone", () => {
			const pickWith = (
				showTitle: string,
				seriesChannelId: string,
				memory: TvNav["memory"] = new Map()
			) => {
				const real = vi.mocked(useCatalog).getMockImplementation();
				vi.mocked(useCatalog).mockImplementation((channels) => ({
					...real!(channels),
					openHistoryEntry: (_entry: unknown, actions: HistoryActions) =>
						actions.pickEpisode(showTitle, [], seriesChannelId),
				}));
				open(makeHistoryEntry(), memory);
			};

			it("finds the show by its id", () => {
				pickWith("Another name", FINALE.id);
				expect(screen.getByText("Details of Show")).toBeInTheDocument();
			});

			it("finds the show by its name", () => {
				pickWith("Other", "another-id");
				expect(screen.getByText("Details of Other")).toBeInTheDocument();
			});

			it("leaves what's open alone when no show has that id or name", () => {
				const memory = new Map([["details", DUNE]]);
				pickWith("Another name", "another-id", memory);
				expect(memory.get("details")).toBe(DUNE);
				expect(screen.getByText("Details of Dune")).toBeInTheDocument();
				expect(navigate).not.toHaveBeenCalled();
			});
		});

		it("opens a movie's details", () => {
			open(makeHistoryEntry({ channelName: "Dune", contentType: "movie" }));
			expect(screen.getByText("Details of Dune")).toBeInTheDocument();
			expect(navigate).not.toHaveBeenCalled();
		});

		it("plays a live channel with every live channel to zap through", () => {
			open(makeHistoryEntry({ channelId: "sport", channelName: "Sport" }));
			expect(getZapList()).toEqual([NEWS, SPORT]);
			expect(lastPlayed().channel).toBe(SPORT);
			expect(lastPlayed()).not.toHaveProperty("seriesEpisodes");
		});

		it("says when a live channel has gone, and plays nothing", () => {
			open(makeHistoryEntry({ channelId: "gone", channelName: "Sport" }));
			expect(navigate).not.toHaveBeenCalled();
			expect(getZapList()).toEqual([]);
			expect(propsOf(TvHistory).missingId).toBe("gone");
		});

		it("says when a movie has gone", () => {
			open(
				makeHistoryEntry({ channelId: "m", channelName: "Elsewhere", contentType: "movie" })
			);
			expect(propsOf(TvHistory).missingId).toBe("m");
		});

		it("drops what it said when the next entry opens", () => {
			open(makeHistoryEntry({ channelId: "gone", channelName: "Sport" }));
			act(() =>
				propsOf(TvHistory).onOpen(
					makeHistoryEntry({ channelId: "sport", channelName: "Sport" })
				)
			);
			expect(propsOf(TvHistory).missingId).toBeNull();
		});

		it("says it's loading, and takes no other press until it's done", () => {
			const openHistoryEntry = vi.fn();
			const real = vi.mocked(useCatalog).getMockImplementation();
			vi.mocked(useCatalog).mockImplementation((channels) => ({
				...real!(channels),
				openHistoryEntry,
			}));
			open(makeHistoryEntry());
			const actions = openHistoryEntry.mock.lastCall![1] as HistoryActions;
			expect(propsOf(TvHistory).opening).toBe(false);

			act(() => actions.setLoading(true));
			expect(propsOf(TvHistory).opening).toBe(true);
			act(() => propsOf(TvHistory).onOpen(makeHistoryEntry()));
			expect(openHistoryEntry).toHaveBeenCalledOnce();

			act(() => actions.setLoading(false));
			expect(propsOf(TvHistory).opening).toBe(false);
			act(() => propsOf(TvHistory).onOpen(makeHistoryEntry()));
			expect(openHistoryEntry).toHaveBeenCalledTimes(2);
		});
	});
});
