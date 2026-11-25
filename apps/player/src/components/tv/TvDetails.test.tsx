// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useChannels } from "@/hooks/useChannels";
import { useSheetDetails } from "@/hooks/useMediaDetails";
import { TV_START_ATTRIBUTE } from "@/lib/tv-focus";
import type { Channel, OmdbData, WhatsonData } from "@/lib/types";
import { makeEpisode, makeMovie, makeOmdb } from "@/test/detail-fixtures";
import { TvDetails, type TvDetailsProps } from "./TvDetails";
import { TvNavContext } from "./tv-nav";

vi.mock("@/hooks/useChannels", () => ({ useChannels: vi.fn() }));
vi.mock("@/hooks/useMediaDetails", () => ({ useSheetDetails: vi.fn() }));

const toggleFavorite = vi.fn();

const channelsAre = (channels: Channel[]) =>
	vi
		.mocked(useChannels)
		.mockReturnValue({ channels, toggleFavorite } as unknown as ReturnType<typeof useChannels>);

const detailsAre = (omdbData: OmdbData | null, whatsonData: WhatsonData | null = null) =>
	vi
		.mocked(useSheetDetails)
		.mockReturnValue({ omdbData, whatsonData } as ReturnType<typeof useSheetDetails>);

const SINTEL = makeMovie();
const SHOW = makeEpisode(1, 1, "Pilot", { id: "show", name: "Show" });
const S1E1 = makeEpisode(1, 1, "Pilot");
const S1E2 = makeEpisode(1, 2, "Finale");
const S2E1 = makeEpisode(2, 1, "Return");
const SPECIAL = makeEpisode(0, 1, "Special", { season: undefined });

const noEpisodes = () => Promise.resolve([]);

const details = (overrides: Partial<TvDetailsProps> = {}, memory = new Map<string, unknown>()) => (
	<TvNavContext.Provider value={{ section: "movie", openSection: () => {}, memory }}>
		<TvDetails
			item={SINTEL}
			onClose={() => {}}
			onPlay={() => {}}
			episodesOf={noEpisodes}
			{...overrides}
		/>
	</TvNavContext.Provider>
);

/** Renders and lets a promise of episodes settle. */
const show = async (overrides: Partial<TvDetailsProps> = {}, memory?: Map<string, unknown>) => {
	const view = render(details({ item: SHOW, ...overrides }, memory));
	await act(async () => {});
	return view;
};

const button = (name: string | RegExp) => screen.getByRole("button", { name });
const active = (list: HTMLElement) => within(list).getByRole("option", { selected: true });
const list = (name: string) => screen.getByRole("listbox", { name });
const names = (el: HTMLElement) =>
	within(el)
		.getAllByRole("option")
		.map((row) => row.textContent);

describe("TvDetails", () => {
	beforeEach(() => {
		channelsAre([]);
		detailsAre(null);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	describe("for anything", () => {
		it("asks for a movie's details by its id and name, passing on what's already loaded", () => {
			const omdb = makeOmdb();
			const whatson = {} as WhatsonData;
			render(details({ omdbData: omdb, whatsonData: whatson }));
			expect(useSheetDetails).toHaveBeenCalledWith(
				{ id: SINTEL.id, title: "Sintel", kind: "movie" },
				omdb,
				whatson
			);
		});

		it("asks for a show's details as a series", async () => {
			await show();
			expect(useSheetDetails).toHaveBeenCalledWith(
				{ id: "show", title: "Show", kind: "series" },
				undefined,
				undefined
			);
		});

		it("names the dialog and the heading after the item", () => {
			render(details());
			expect(screen.getByRole("dialog", { name: "Sintel" })).toBeInTheDocument();
			expect(screen.getByRole("heading", { name: "Sintel" })).toBeInTheDocument();
		});

		it("closes on Back", () => {
			const onClose = vi.fn();
			render(details({ onClose }));
			fireEvent.keyDown(button("Play"), { key: "Escape" });
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it("shows the facts it has, and leaves out the rest", () => {
			detailsAre(
				makeOmdb({
					year: "2010",
					rated: undefined,
					genre: "Fantasy",
					runtime: "15 min",
					plot: "A girl and a dragon",
				})
			);
			render(details());
			expect(screen.getByText("2010")).toBeInTheDocument();
			expect(screen.getByText("Fantasy")).toBeInTheDocument();
			expect(screen.getByText("15 min")).toBeInTheDocument();
			expect(screen.getByText("A girl and a dragon")).toBeInTheDocument();
			expect(screen.getByText("2010").parentElement?.children).toHaveLength(3);
		});

		it("leaves the plot out when there's none", () => {
			detailsAre(makeOmdb({ plot: undefined }));
			render(details());
			// The facts and the two credits.
			expect(screen.getByRole("dialog").querySelectorAll("p")).toHaveLength(3);
		});

		it("shows the poster it found", () => {
			detailsAre(makeOmdb({ posterUrl: "http://poster.example.test/a.jpg" }));
			render(details());
			expect(screen.getByRole("dialog").querySelector("img")).toHaveAttribute(
				"src",
				"http://poster.example.test/a.jpg"
			);
			expect(screen.queryByText("S")).not.toBeInTheDocument();
		});

		it("shows the name's capital first letter without a poster", () => {
			render(details({ item: makeMovie({ name: "sintel" }) }));
			expect(screen.getByRole("dialog").querySelector("img")).toBeNull();
			expect(screen.getByText("S")).toBeInTheDocument();
		});

		it("goes by the channel list for whether it's a favorite", () => {
			channelsAre([
				{ ...SINTEL, id: "other" },
				{ ...SINTEL, isFavorite: true },
			]);
			render(details());
			expect(button("Remove from favorites")).toBeInTheDocument();
		});

		it("goes by the item when the channel list doesn't have it", () => {
			channelsAre([{ ...SINTEL, id: "other", isFavorite: false }]);
			render(details({ item: { ...SINTEL, isFavorite: true } }));
			expect(button("Remove from favorites")).toBeInTheDocument();
		});

		it("favorites the item", () => {
			render(details());
			fireEvent.click(button("Add to favorites"));
			expect(toggleFavorite).toHaveBeenCalledExactlyOnceWith(SINTEL.id);
		});
	});

	describe("for a movie", () => {
		it("opens on Play, so OK starts it", () => {
			const onPlay = vi.fn();
			render(details({ onPlay }));
			expect(document.activeElement).toBe(button("Play"));
			fireEvent.click(button("Play"));
			expect(onPlay).toHaveBeenCalledExactlyOnceWith(SINTEL);
		});

		it("says what the caller wants on its first button", () => {
			render(details({ playLabel: "Resume" }));
			expect(button("Resume")).toBeInTheDocument();
		});

		it("names the director and the cast", () => {
			detailsAre(makeOmdb({ director: "Colin Levy", actors: "Halina Reijn" }));
			render(details());
			expect(screen.getByText("Directed by").parentElement).toHaveTextContent(
				"Directed by Colin Levy"
			);
			expect(screen.getByText("With").parentElement).toHaveTextContent("With Halina Reijn");
		});

		it("leaves out credits it doesn't have", () => {
			detailsAre(makeOmdb({ director: undefined, actors: undefined }));
			render(details());
			expect(screen.queryByText("Directed by")).not.toBeInTheDocument();
			expect(screen.queryByText("With")).not.toBeInTheDocument();
		});

		it("loads no episodes", () => {
			const episodesOf = vi.fn(noEpisodes);
			render(details({ episodesOf }));
			expect(episodesOf).not.toHaveBeenCalled();
			expect(screen.queryByText("Loading episodes")).not.toBeInTheDocument();
		});

		describe("with one source", () => {
			it("doesn't offer another", () => {
				render(details());
				expect(screen.queryByRole("button", { name: /^Source/ })).not.toBeInTheDocument();
			});
		});

		describe("with several sources", () => {
			const url2 = "https://other.example.test/movies/sintel-1080p.mkv";
			const MANY = makeMovie({ sourceList: [SINTEL.url, url2] });

			it("steps through them on OK and comes back round", () => {
				render(details({ item: MANY }));
				fireEvent.click(button(/^Source 1 of 2/));
				expect(button(/^Source 2 of 2/)).toBeInTheDocument();
				fireEvent.click(button(/^Source 2 of 2/));
				expect(button(/^Source 1 of 2/)).toBeInTheDocument();
			});

			it("plays the movie itself on its own source", () => {
				const onPlay = vi.fn();
				render(details({ item: MANY, onPlay }));
				fireEvent.click(button("Play"));
				expect(onPlay).toHaveBeenCalledExactlyOnceWith(MANY);
			});

			it("plays the source that's picked", () => {
				const onPlay = vi.fn();
				render(details({ item: MANY, onPlay }));
				fireEvent.click(button(/^Source 1 of 2/));
				fireEvent.click(button("Play"));
				expect(onPlay).toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining({ id: MANY.id, url: url2 })
				);
			});

			it("says what's different about each source", () => {
				render(details({ item: MANY }));
				fireEvent.click(button(/^Source 1 of 2/));
				expect(button(/^Source 2 of 2/)).toHaveTextContent("other.example.test · MKV");
				// It's on its own, so a long name can shorten without the count.
				expect(screen.getByText("other.example.test · MKV")).toBeInTheDocument();
			});

			it("remembers the source for each movie", () => {
				const memory = new Map<string, unknown>();
				render(details({ item: MANY }, memory));
				fireEvent.click(button(/^Source 1 of 2/));
				expect(memory.get(`source:${MANY.id}`)).toBe(1);
				cleanup();
				render(details({ item: MANY }, memory));
				expect(button(/^Source 2 of 2/)).toBeInTheDocument();
			});

			it("falls back to the movie's own url when the remembered source has gone", () => {
				const onPlay = vi.fn();
				const memory = new Map<string, unknown>([[`source:${MANY.id}`, 5]]);
				render(details({ item: MANY, onPlay }, memory));
				fireEvent.click(button("Play"));
				expect(onPlay).toHaveBeenCalledExactlyOnceWith(MANY);
			});
		});
	});

	describe("for a show", () => {
		it("has its favorite button beside the poster, and no Play", async () => {
			await show();
			expect(button("Add to favorites")).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Play" })).not.toBeInTheDocument();
		});

		it("says it's loading the episodes until they come", async () => {
			let finish: (episodes: Channel[]) => void = () => {};
			const episodesOf = vi.fn(
				() =>
					new Promise<Channel[]>((resolve) => {
						finish = resolve;
					})
			);
			render(details({ item: SHOW, episodesOf }));
			expect(episodesOf).toHaveBeenCalledExactlyOnceWith(SHOW);
			expect(screen.getByText("Loading episodes")).toBeInTheDocument();
			expect(document.activeElement).toBe(button("Add to favorites"));

			await act(async () => finish([S1E1]));
			expect(screen.queryByText("Loading episodes")).not.toBeInTheDocument();
			expect(document.activeElement).toBe(active(list("Season 1")));
		});

		it("says so when a show has no episodes", async () => {
			await show();
			expect(screen.getByText("This show has no episodes yet.")).toBeInTheDocument();
			expect(document.activeElement).toBe(button("Add to favorites"));
		});

		it("says so when the provider sends no episodes", async () => {
			await show({ episodesOf: () => Promise.reject(new Error("offline")) });
			expect(
				screen.getByText(
					"This provider didn't send the episodes. Press Back and try again."
				)
			).toBeInTheDocument();
		});

		it("ignores episodes that arrive after it closes", async () => {
			let finish: (episodes: Channel[]) => void = () => {};
			const memory = new Map<string, unknown>();
			const { unmount } = render(
				details(
					{
						item: SHOW,
						currentEpisode: S1E2,
						episodesOf: () =>
							new Promise<Channel[]>((resolve) => {
								finish = resolve;
							}),
					},
					memory
				)
			);
			unmount();
			await act(async () => finish([S1E1, S1E2]));
			expect(memory.has("episodes:show")).toBe(false);
		});

		it("ignores a failure that comes after another show opened", async () => {
			let fail: (reason: Error) => void = () => {};
			const memory = new Map<string, unknown>();
			const { rerender } = render(
				details(
					{
						item: SHOW,
						episodesOf: () =>
							new Promise<Channel[]>((_resolve, reject) => {
								fail = reject;
							}),
					},
					memory
				)
			);
			rerender(
				details(
					{ item: { ...SHOW, id: "other" }, episodesOf: () => new Promise(() => {}) },
					memory
				)
			);
			await act(async () => fail(new Error("offline")));
			expect(screen.getByText("Loading episodes")).toBeInTheDocument();
		});

		it("ignores the old show's episodes after another show opened", async () => {
			let finish: (episodes: Channel[]) => void = () => {};
			const memory = new Map<string, unknown>();
			const { rerender } = render(
				details(
					{
						item: SHOW,
						episodesOf: () =>
							new Promise<Channel[]>((resolve) => {
								finish = resolve;
							}),
					},
					memory
				)
			);
			const other = { ...SHOW, id: "other" };
			rerender(details({ item: other, episodesOf: () => Promise.resolve([S2E1]) }, memory));
			await act(async () => {});
			await act(async () => finish([S1E1]));
			expect(names(list("Season 2"))).toHaveLength(1);
		});

		it("loads again only for another show", async () => {
			const episodesOf = vi.fn(() => Promise.resolve([S1E1]));
			const memory = new Map<string, unknown>();
			const { rerender } = await show({ episodesOf }, memory);
			rerender(
				details({ item: { ...SHOW }, episodesOf: vi.fn(() => Promise.resolve([])) }, memory)
			);
			await act(async () => {});
			expect(episodesOf).toHaveBeenCalledTimes(1);
			expect(names(list("Season 1"))).toHaveLength(1);
		});

		it("skips the seasons when there's only one, and starts on its first episode", async () => {
			const onPlay = vi.fn();
			await show({ onPlay, episodesOf: () => Promise.resolve([S1E2, S1E1]) });
			expect(screen.queryByRole("listbox", { name: "Seasons" })).not.toBeInTheDocument();
			const episodes = list("Season 1");
			expect(names(episodes)).toEqual(["1 Pilot", "2 Finale"]);
			expect(document.activeElement).toBe(active(episodes));
			expect(active(episodes)).toHaveAttribute(TV_START_ATTRIBUTE);
			expect(episodes.style.height).toBe("19.25rem");
			expect(active(episodes).style.height).toBe("2.75rem");

			fireEvent.keyDown(active(episodes), { key: "ArrowDown" });
			fireEvent.keyDown(active(episodes), { key: "Enter" });
			expect(onPlay).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ id: S1E2.id }),
				[expect.objectContaining({ id: S1E1.id }), expect.objectContaining({ id: S1E2.id })]
			);
		});

		it("merges an episode that came from two sources", async () => {
			await show({
				episodesOf: () => Promise.resolve([S1E1, { ...S1E1, id: "copy", url: "http://x" }]),
			});
			expect(names(list("Season 1"))).toEqual(["1 Pilot"]);
		});

		it("lists the seasons, in order, with episodes without a season as their own", async () => {
			await show({ episodesOf: () => Promise.resolve([S2E1, S1E1, SPECIAL]) });
			const seasons = list("Seasons");
			expect(names(seasons)).toEqual(["Other episodes", "Season 1", "Season 2"]);
			expect(seasons.style.height).toBe("19.25rem");
			expect(active(seasons).style.height).toBe("2.75rem");
			expect(names(list("Other episodes"))).toEqual(["1 Special"]);
		});

		it("shows the season the cursor reaches, from its first episode", async () => {
			const memory = new Map<string, unknown>();
			await show({ episodesOf: () => Promise.resolve([S1E1, S1E2, S2E1]) }, memory);
			fireEvent.keyDown(active(list("Season 1")), { key: "ArrowDown" });
			expect(memory.get("episodes:show")).toEqual({
				season: 0,
				episode: 1,
				inSeasons: false,
			});

			fireEvent.keyDown(active(list("Seasons")), { key: "ArrowDown" });
			expect(names(list("Season 2"))).toEqual(["1 Return"]);
			expect(memory.get("episodes:show")).toEqual({
				season: 1,
				episode: 0,
				inSeasons: true,
			});
		});

		it("comes back to the seasons if that's where the focus was", async () => {
			const memory = new Map<string, unknown>([
				["episodes:show", { season: 1, episode: 0, inSeasons: true }],
			]);
			await show({ episodesOf: () => Promise.resolve([S1E1, S2E1]) }, memory);
			expect(document.activeElement).toBe(active(list("Seasons")));
			expect(active(list("Seasons"))).toHaveAttribute(TV_START_ATTRIBUTE);
			expect(active(list("Season 2"))).not.toHaveAttribute(TV_START_ATTRIBUTE);
		});

		it("falls back to the last season when the remembered one has gone", async () => {
			const memory = new Map<string, unknown>([
				["episodes:show", { season: 9, episode: 0, inSeasons: false }],
			]);
			await show({ episodesOf: () => Promise.resolve([S1E1, S2E1]) }, memory);
			expect(list("Season 2")).toBeInTheDocument();
		});

		it("opens on the episode the caller says, over where the viewer last was", async () => {
			const memory = new Map<string, unknown>([
				["episodes:show", { season: 0, episode: 0, inSeasons: true }],
			]);
			await show(
				{
					currentEpisode: S2E1,
					episodesOf: () => Promise.resolve([S1E1, S1E2, S2E1, makeEpisode(2, 2, "Two")]),
				},
				memory
			);
			expect(memory.get("episodes:show")).toEqual({
				season: 1,
				episode: 0,
				inSeasons: false,
			});
			expect(active(list("Season 2"))).toHaveTextContent("1 Return");
		});

		it("finds the current episode's place inside its season", async () => {
			const two = makeEpisode(2, 2, "Two");
			await show({
				currentEpisode: two,
				// Another season's episode 2 comes first, and isn't where it opens.
				episodesOf: () => Promise.resolve([S1E2, S2E1, two]),
			});
			expect(active(list("Season 2"))).toHaveTextContent("2 Two");
		});

		it("opens episodes without a season on the current one", async () => {
			const first = makeEpisode(0, 1, "First", { season: undefined });
			const second = makeEpisode(0, 2, "Second", { season: undefined });
			await show({
				currentEpisode: second,
				episodesOf: () => Promise.resolve([S1E1, first, second]),
			});
			expect(active(list("Other episodes"))).toHaveTextContent("2 Second");
			expect(active(list("Seasons"))).toHaveTextContent("Other episodes");
		});

		it("starts at the top when the current episode isn't listed", async () => {
			await show({
				currentEpisode: makeEpisode(7, 7, "Gone"),
				episodesOf: () => Promise.resolve([S1E1, S2E1]),
			});
			expect(active(list("Seasons"))).toHaveTextContent("Season 1");
			expect(active(list("Season 1"))).toHaveTextContent("1 Pilot");
		});

		it("keeps a season's row when an earlier season appears", async () => {
			const memory = new Map<string, unknown>();
			const { rerender } = await show(
				{ episodesOf: () => Promise.resolve([S1E1, S2E1]) },
				memory
			);
			const row = screen.getByRole("option", { name: "Season 2" });
			rerender(
				details(
					{
						item: { ...SHOW, id: "other" },
						episodesOf: () => Promise.resolve([SPECIAL, S1E1, S2E1]),
					},
					memory
				)
			);
			await act(async () => {});
			expect(screen.getByRole("option", { name: "Season 2" })).toBe(row);
		});

		it("keeps an episode's row when an earlier episode appears", async () => {
			const memory = new Map<string, unknown>();
			const { rerender } = await show({ episodesOf: () => Promise.resolve([S1E2]) }, memory);
			const row = screen.getByRole("option", { name: "2 Finale" });
			rerender(
				details(
					{
						item: { ...SHOW, id: "other" },
						episodesOf: () => Promise.resolve([S1E1, S1E2]),
					},
					memory
				)
			);
			await act(async () => {});
			expect(screen.getByRole("option", { name: "2 Finale" })).toBe(row);
		});

		it("moves the focus to the lists when a show with episodes follows one without", async () => {
			const memory = new Map<string, unknown>();
			const { rerender } = await show({ episodesOf: noEpisodes }, memory);
			expect(screen.getByText("This show has no episodes yet.")).toBeInTheDocument();
			rerender(
				details(
					{
						item: { ...SHOW, id: "other" },
						episodesOf: () => Promise.resolve([S1E1]),
					},
					memory
				)
			);
			await act(async () => {});
			expect(document.activeElement).toBe(screen.getByRole("option", { name: "1 Pilot" }));
		});

		it("labels an episode without a title of its own by its number", async () => {
			await show({
				episodesOf: () => Promise.resolve([makeEpisode(1, 3, "", { name: "Show S01E03" })]),
			});
			expect(names(list("Season 1"))).toEqual(["Episode 3"]);
		});
	});
});
