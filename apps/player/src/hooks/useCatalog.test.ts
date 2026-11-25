// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeChannel, makeHistoryEntry } from "@/test/channel-fixtures";
import { deferred } from "@/test/deferred";
import type { Channel } from "@/lib/types";

vi.mock("@/lib/tauri", () => ({ getXtreamSeriesEpisodes: vi.fn() }));

import { getXtreamSeriesEpisodes } from "@/lib/tauri";
import { useCatalog, type HistoryActions } from "./useCatalog";

const live = makeChannel({ id: "live", name: "News" });
const movie = makeChannel({ id: "movie", name: "Sintel", contentType: "movie" });
const recording = makeChannel({ id: "rec", name: "Taped", contentType: "recording" });

const series = (id: string, title: string, overrides: Partial<Channel> = {}): Channel =>
	makeChannel({
		id,
		name: title,
		seriesTitle: title,
		contentType: "series",
		url: `http://example.test/${id}`,
		...overrides,
	});

const xtream = (id: string, title: string) =>
	series(id, title, { url: `xtream://series/${id}`, seriesTitle: undefined });

const episode = (id: string, show: string, season: number, number: number): Channel =>
	series(id, show, {
		name: `${show} S${String(season).padStart(2, "0")}E${String(number).padStart(2, "0")}`,
		season,
		episode: number,
	});

/** The episode to play, which comes with its sources added. */
const sameEpisode = (ep: Channel) => expect.objectContaining({ id: ep.id, name: ep.name });

const catalog = (channels: Channel[]) => renderHook(() => useCatalog(channels)).result;

const makeActions = () => ({
	playEpisode: vi.fn<HistoryActions["playEpisode"]>(),
	pickEpisode: vi.fn<HistoryActions["pickEpisode"]>(),
	showMovie: vi.fn<HistoryActions["showMovie"]>(),
	playOther: vi.fn<HistoryActions["playOther"]>(),
	setLoading: vi.fn<HistoryActions["setLoading"]>(),
	onMissing: vi.fn<HistoryActions["onMissing"]>(),
});

beforeEach(() => {
	vi.mocked(getXtreamSeriesEpisodes).mockReset();
});

describe("useCatalog lists", () => {
	it("sorts the channels by what they are, with anything else among the live ones", () => {
		const show = series("show", "Show");
		const { byType } = catalog([live, movie, show, recording]).current;
		expect(byType).toEqual({ live: [live, recording], movie: [movie], series: [show] });
	});

	it("starts with empty lists and no channels", () => {
		const { byType, seriesShows, movieTitles } = catalog([]).current;
		expect(byType).toEqual({ live: [], movie: [], series: [] });
		expect(seriesShows).toEqual([]);
		expect(movieTitles).toEqual([]);
	});

	it("lists each show once by its title, from its first entry and with no sources", () => {
		const first = episode("e1", "Show", 1, 1);
		const { seriesShows } = catalog([
			{ ...first, sources: ["http://example.test/other"] },
			episode("e2", "Show", 1, 2),
			episode("o1", "Other", 1, 1),
		]).current;
		expect(seriesShows).toEqual([
			{ ...first, name: "Show" },
			{ ...episode("o1", "Other", 1, 1), name: "Other" },
		]);
	});

	it.each([
		["case", "the show", "The Show"],
		["spaces around it", " The Show ", "The Show"],
		["spaces inside it", "The  Show", "The Show"],
		["other space characters", "The\tShow", "The Show"],
	])("counts titles that differ only in %s as one show", (_, a, b) => {
		expect(catalog([series("a", a), series("b", b)]).current.seriesShows).toHaveLength(1);
	});

	it("tells apart titles that differ by a space", () => {
		const { seriesShows } = catalog([series("a", "The Show"), series("b", "Theshow")]).current;
		expect(seriesShows).toHaveLength(2);
	});

	it("tells apart titles that only look the same in capitals", () => {
		const { seriesShows } = catalog([series("a", "Straße"), series("b", "STRASSE")]).current;
		expect(seriesShows).toHaveLength(2);
	});

	it("merges movies with one title into one with both sources", () => {
		const copy = { ...movie, id: "copy", url: "http://example.test/copy" };
		const { movieTitles } = catalog([movie, copy, live]).current;
		expect(movieTitles).toEqual([{ ...movie, sources: [copy.url] }]);
	});

	it("follows the channels as they change", () => {
		const { result, rerender } = renderHook(({ channels }) => useCatalog(channels), {
			initialProps: { channels: [live] },
		});
		const show = series("show", "Show");

		rerender({ channels: [live, movie, show] });

		expect(result.current.byType.movie).toEqual([movie]);
		expect(result.current.seriesShows.map((s) => s.id)).toEqual(["show"]);
		expect(result.current.movieTitles.map((m) => m.id)).toEqual(["movie"]);
	});
});

describe("useCatalog Xtream episodes", () => {
	const a1 = episode("a1", "Show", 1, 1);
	const b1 = episode("b1", "Show", 1, 1);

	it("loads every entry of a show, the one picked first", async () => {
		const first = xtream("x1", "Show");
		const picked = xtream("x2", "show");
		const elsewhere = xtream("x3", "Other");
		vi.mocked(getXtreamSeriesEpisodes).mockImplementation(async (id) =>
			id === "x2" ? [a1] : [b1]
		);

		const episodes = await catalog([first, picked, elsewhere]).current.fetchXtreamShowEpisodes(
			"Show",
			picked
		);

		expect(vi.mocked(getXtreamSeriesEpisodes).mock.calls).toEqual([["x2"], ["x1"]]);
		expect(episodes).toEqual([a1, b1]);
	});

	it("leaves out entries of the show that aren't Xtream's", async () => {
		const picked = xtream("x1", "Show");
		vi.mocked(getXtreamSeriesEpisodes).mockResolvedValue([a1]);

		await catalog([picked, series("plain", "Show")]).current.fetchXtreamShowEpisodes(
			"Show",
			picked
		);

		expect(vi.mocked(getXtreamSeriesEpisodes).mock.calls).toEqual([["x1"]]);
	});

	it("loads the entry it was given when no entry has that title", async () => {
		const picked = xtream("x1", "Show");
		vi.mocked(getXtreamSeriesEpisodes).mockResolvedValue([a1]);

		const episodes = await catalog([]).current.fetchXtreamShowEpisodes("Show", picked);

		expect(vi.mocked(getXtreamSeriesEpisodes).mock.calls).toEqual([["x1"]]);
		expect(episodes).toEqual([a1]);
	});

	it("fails when the entry picked can't load", async () => {
		const picked = xtream("x1", "Show");
		vi.mocked(getXtreamSeriesEpisodes).mockImplementation(async (id) => {
			if (id === "x1") throw new Error("gone");
			return [b1];
		});

		await expect(
			catalog([picked, xtream("x2", "Show")]).current.fetchXtreamShowEpisodes("Show", picked)
		).rejects.toThrow("gone");
	});

	it("does without another entry that can't load", async () => {
		const picked = xtream("x1", "Show");
		vi.mocked(getXtreamSeriesEpisodes).mockImplementation(async (id) => {
			if (id === "x2") throw new Error("gone");
			return [a1];
		});

		await expect(
			catalog([picked, xtream("x2", "Show")]).current.fetchXtreamShowEpisodes("Show", picked)
		).resolves.toEqual([a1]);
	});

	it("uses the new channels' entries after the channels change", async () => {
		const picked = xtream("x1", "Show");
		vi.mocked(getXtreamSeriesEpisodes).mockResolvedValue([]);
		const { result, rerender } = renderHook(({ channels }) => useCatalog(channels), {
			initialProps: { channels: [picked] },
		});

		rerender({ channels: [picked, xtream("x2", "Show")] });
		await result.current.fetchXtreamShowEpisodes("Show", picked);
		expect(vi.mocked(getXtreamSeriesEpisodes).mock.calls).toEqual([["x1"], ["x2"]]);
	});
});

describe("useCatalog episodesOf", () => {
	it("asks the provider for an Xtream show's episodes", async () => {
		const show = xtream("x1", "Show");
		const ep = episode("e1", "Show", 1, 1);
		vi.mocked(getXtreamSeriesEpisodes).mockResolvedValue([ep]);

		await expect(catalog([show]).current.episodesOf(show)).resolves.toEqual([ep]);
		expect(getXtreamSeriesEpisodes).toHaveBeenCalledExactlyOnceWith("x1");
	});

	it("finds the rest of a show's episodes in the channels", async () => {
		const first = episode("e1", "Show", 1, 1);
		const second = episode("e2", "Show", 1, 2);
		const other = episode("o1", "Other", 1, 1);

		await expect(catalog([first, other, second]).current.episodesOf(first)).resolves.toEqual([
			first,
			second,
		]);
		expect(getXtreamSeriesEpisodes).not.toHaveBeenCalled();
	});

	it("uses the new channels after they change", async () => {
		const first = episode("e1", "Show", 1, 1);
		const second = episode("e2", "Show", 1, 2);
		const show = xtream("x1", "Other");
		vi.mocked(getXtreamSeriesEpisodes).mockResolvedValue([]);
		const { result, rerender } = renderHook(({ channels }) => useCatalog(channels), {
			initialProps: { channels: [first, show] },
		});

		rerender({ channels: [first, second, show, xtream("x2", "Other")] });

		await expect(result.current.episodesOf(first)).resolves.toEqual([first, second]);
		await result.current.episodesOf(show);
		expect(vi.mocked(getXtreamSeriesEpisodes).mock.calls).toEqual([["x1"], ["x2"]]);
	});
});

describe("useCatalog episodesOf, across spellings", () => {
	it("lists the episodes of every spelling that shares a show's card", async () => {
		const first = episode("e1", "The Show", 1, 1);
		const second = episode("e2", "the  SHOW", 1, 2);
		const other = episode("o1", "Other", 1, 1);
		const { episodesOf, seriesShows } = catalog([first, second, other]).current;

		expect(seriesShows.map((show) => show.name)).toEqual(["The Show", "Other"]);
		await expect(episodesOf(seriesShows[0])).resolves.toEqual([first, second]);
	});
});

describe("useCatalog openHistoryEntry", () => {
	const watched = (name: string, id = "e1", seriesTitle: string | null = "Show") =>
		makeHistoryEntry({ channelId: id, channelName: name, contentType: "series", seriesTitle });

	it("plays the watched episode of a show, with its list", () => {
		const first = episode("e1", "Show", 1, 1);
		const second = episode("e2", "Show", 1, 2);
		const actions = makeActions();

		catalog([first, second, episode("o1", "Other", 1, 1)]).current.openHistoryEntry(
			watched(first.name),
			actions
		);

		expect(actions.playEpisode).toHaveBeenCalledExactlyOnceWith(sameEpisode(first), [
			first,
			second,
		]);
		expect(actions.pickEpisode).not.toHaveBeenCalled();
		expect(actions.setLoading).not.toHaveBeenCalled();
		expect(actions.onMissing).not.toHaveBeenCalled();
		expect(getXtreamSeriesEpisodes).not.toHaveBeenCalled();
	});

	it("finds a watched episode under another spelling of its show", () => {
		const first = episode("e1", "The Show", 1, 1);
		const second = episode("e2", "the  show", 1, 2);
		const actions = makeActions();

		catalog([first, second]).current.openHistoryEntry(
			watched(second.name, "e2", "THE SHOW"),
			actions
		);

		expect(actions.playEpisode).toHaveBeenCalledExactlyOnceWith(sameEpisode(second), [
			first,
			second,
		]);
	});

	it("finds a show's Xtream entry under another spelling", async () => {
		const ep = episode("e1", "The Show", 1, 1);
		vi.mocked(getXtreamSeriesEpisodes).mockResolvedValue([ep]);
		const actions = makeActions();

		catalog([xtream("x1", "The Show")]).current.openHistoryEntry(
			watched(ep.name, "e1", "the show"),
			actions
		);

		await waitFor(() => expect(actions.playEpisode).toHaveBeenCalledOnce());
		expect(getXtreamSeriesEpisodes).toHaveBeenCalledExactlyOnceWith("x1");
	});

	it("says when a show has nothing left to open", () => {
		const actions = makeActions();

		catalog([episode("o1", "Other", 1, 1)]).current.openHistoryEntry(
			watched("Show S01E01"),
			actions
		);

		expect(actions.onMissing).toHaveBeenCalledOnce();
		expect(actions.playEpisode).not.toHaveBeenCalled();
		expect(actions.pickEpisode).not.toHaveBeenCalled();
	});

	it("names the show from the entry's name when the history doesn't say", () => {
		const first = episode("e1", "Show", 1, 1);
		const actions = makeActions();

		catalog([first]).current.openHistoryEntry(watched(first.name, "e1", null), actions);

		expect(actions.playEpisode).toHaveBeenCalledExactlyOnceWith(sameEpisode(first), [first]);
	});

	it("lets the viewer pick another episode when the watched one is gone", () => {
		const first = episode("e1", "Show", 1, 1);
		const actions = makeActions();

		catalog([first]).current.openHistoryEntry(watched("Show S09E09", "gone"), actions);

		expect(actions.pickEpisode).toHaveBeenCalledExactlyOnceWith("Show", [first], "e1");
		expect(actions.playEpisode).not.toHaveBeenCalled();
	});

	it("does nothing for a show that's no longer listed", () => {
		const actions = makeActions();

		catalog([live]).current.openHistoryEntry(watched("Show S01E01"), actions);

		expect(actions.playEpisode).not.toHaveBeenCalled();
		expect(actions.pickEpisode).not.toHaveBeenCalled();
		expect(actions.setLoading).not.toHaveBeenCalled();
	});

	it("loads an Xtream show's episodes first, and says so while it does", async () => {
		const show = xtream("x1", "Show");
		const ep = episode("e1", "Show", 1, 1);
		const load = deferred<Channel[]>();
		vi.mocked(getXtreamSeriesEpisodes).mockReturnValue(load.promise);
		const actions = makeActions();

		catalog([show]).current.openHistoryEntry(watched(ep.name), actions);
		expect(actions.setLoading).toHaveBeenCalledExactlyOnceWith(true);
		expect(getXtreamSeriesEpisodes).toHaveBeenCalledExactlyOnceWith("x1");
		expect(actions.playEpisode).not.toHaveBeenCalled();

		await act(async () => load.resolve([ep]));

		expect(actions.playEpisode).toHaveBeenCalledExactlyOnceWith(sameEpisode(ep), [ep]);
		expect(actions.setLoading).toHaveBeenLastCalledWith(false);
	});

	it("lets the viewer pick from an Xtream show, by its entry, when the episode is gone", async () => {
		const show = xtream("x1", "Show");
		const ep = episode("e1", "Show", 1, 1);
		vi.mocked(getXtreamSeriesEpisodes).mockResolvedValue([ep]);
		const actions = makeActions();

		catalog([show]).current.openHistoryEntry(watched("Show S09E09", "gone"), actions);

		await waitFor(() =>
			expect(actions.pickEpisode).toHaveBeenCalledExactlyOnceWith("Show", [ep], "x1")
		);
	});

	it("logs a failed Xtream load and stops saying it's loading", async () => {
		const show = xtream("x1", "Show");
		const failure = new Error("gone");
		vi.mocked(getXtreamSeriesEpisodes).mockRejectedValue(failure);
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const actions = makeActions();

		catalog([show]).current.openHistoryEntry(watched("Show S01E01"), actions);

		await waitFor(() => expect(actions.setLoading).toHaveBeenLastCalledWith(false));
		expect(logged).toHaveBeenCalledExactlyOnceWith(
			"[Xtream] failed to fetch series episodes:",
			failure
		);
		expect(actions.playEpisode).not.toHaveBeenCalled();
		expect(actions.onMissing).toHaveBeenCalledOnce();
		logged.mockRestore();
	});

	it("shows a movie that's still listed", () => {
		const actions = makeActions();
		catalog([movie, live]).current.openHistoryEntry(
			makeHistoryEntry({ channelName: "Sintel", contentType: "movie" }),
			actions
		);
		expect(actions.showMovie).toHaveBeenCalledExactlyOnceWith(movie);
		expect(actions.playOther).not.toHaveBeenCalled();
		expect(actions.onMissing).not.toHaveBeenCalled();
	});

	it("says when a movie has gone", () => {
		const actions = makeActions();
		catalog([movie]).current.openHistoryEntry(
			makeHistoryEntry({ channelName: "Elsewhere", contentType: "movie" }),
			actions
		);
		expect(actions.showMovie).not.toHaveBeenCalled();
		expect(actions.playOther).not.toHaveBeenCalled();
		expect(actions.onMissing).toHaveBeenCalledOnce();
	});

	it("plays anything else right away", () => {
		const actions = makeActions();
		const entry = makeHistoryEntry({ channelName: "News" });
		catalog([live]).current.openHistoryEntry(entry, actions);
		expect(actions.playOther).toHaveBeenCalledExactlyOnceWith(entry);
		expect(actions.showMovie).not.toHaveBeenCalled();
		expect(actions.playEpisode).not.toHaveBeenCalled();
	});

	it("uses the new channels after they change", async () => {
		const first = episode("e1", "Show", 1, 1);
		const { result, rerender } = renderHook(({ channels }) => useCatalog(channels), {
			initialProps: { channels: [live] },
		});

		rerender({ channels: [first, movie, xtream("x1", "Other"), xtream("x2", "Other")] });

		const actions = makeActions();
		result.current.openHistoryEntry(watched(first.name), actions);
		expect(actions.playEpisode).toHaveBeenCalledExactlyOnceWith(sameEpisode(first), [first]);

		result.current.openHistoryEntry(
			makeHistoryEntry({ channelName: "Sintel", contentType: "movie" }),
			actions
		);
		expect(actions.showMovie).toHaveBeenCalledExactlyOnceWith(movie);

		vi.mocked(getXtreamSeriesEpisodes).mockResolvedValue([]);
		result.current.openHistoryEntry(watched("Other S01E01", "o1", "Other"), actions);
		await waitFor(() => expect(actions.setLoading).toHaveBeenLastCalledWith(false));
		expect(vi.mocked(getXtreamSeriesEpisodes).mock.calls).toEqual([["x1"], ["x2"]]);
	});
});
