// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";

vi.mock("@/lib/tauri", () => ({ remoteCatalog: vi.fn() }));

import { remoteCatalog, type CatalogQuery } from "@/lib/tauri";
import { RemoteCatalog, PAGE, SEARCH_DELAY_MS, episodeLabel } from "./RemoteCatalog";
import { createCinetteDestination, type CatalogItem } from "@/lib/cinette-destination";
import type { Link } from "@/lib/remote-control";

const item = (id: string, name: string, extra: Partial<CatalogItem> = {}): CatalogItem => ({
	id,
	name,
	contentType: "live",
	group: "UK",
	...extra,
});

const send = vi.fn<(command: unknown) => Promise<number>>(() => Promise.resolve(1));

const link = (): Link => ({
	deviceId: "tv1",
	name: "Living Room",
	phase: { phase: "connected" },
	code: null,
	destination: createCinetteDestination("tv1", "Living Room", send),
});

/** Answers each query from a table, by kind and its fields. */
const answer = (pages: Record<string, { items: CatalogItem[]; next: string | null }>) =>
	vi.mocked(remoteCatalog).mockImplementation(async (q: CatalogQuery) => {
		const key = JSON.stringify(q);
		const page = pages[key];
		if (!page) throw new Error(`unexpected ${key}`);
		return page;
	});

const groups = (contentType: string) => JSON.stringify({ kind: "groups", contentType });
const groupItems = (group: string, cursor?: string) =>
	JSON.stringify(
		cursor === undefined
			? { kind: "items", contentType: "live", group, limit: PAGE }
			: { kind: "items", contentType: "live", group, cursor, limit: PAGE }
	);

beforeEach(() => {
	vi.mocked(remoteCatalog).mockReset();
	send.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("RemoteCatalog", () => {
	it("lists the other device's groups, then a group's items, and plays one there", async () => {
		answer({
			[groups("live")]: { items: [item("UK", "UK"), item("News", "News")], next: null },
			[groupItems("UK")]: {
				items: [item("live-1", "BBC One", { nowPlaying: "Pointless" })],
				next: null,
			},
		});
		render(<RemoteCatalog link={link()} />);
		expect(screen.getByText("Loading…")).toBeInTheDocument();
		expect(screen.getByRole("heading")).toHaveTextContent("On Living Room");
		fireEvent.click(await screen.findByRole("button", { name: "UK" }));
		expect(screen.getByRole("heading")).toHaveTextContent("UK");
		const channel = await screen.findByRole("button", { name: /BBC One/ });
		expect(channel).toHaveTextContent("Pointless");
		fireEvent.click(channel);
		await waitFor(() =>
			expect(send).toHaveBeenCalledWith({ action: "load", itemId: "live-1" })
		);
		fireEvent.click(screen.getByRole("button", { name: "Back" }));
		expect(await screen.findByRole("button", { name: "News" })).toBeInTheDocument();
	});

	it("loads more of a long group", async () => {
		answer({
			[groups("live")]: { items: [item("UK", "UK")], next: null },
			[groupItems("UK")]: { items: [item("a", "One")], next: "b" },
			[groupItems("UK", "b")]: { items: [item("b", "Two")], next: null },
		});
		render(<RemoteCatalog link={link()} />);
		fireEvent.click(await screen.findByRole("button", { name: "UK" }));
		await screen.findByRole("button", { name: /One/ });
		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		expect(await screen.findByRole("button", { name: /Two/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /One/ })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
	});

	it("says when a page fails, and when another page fails", async () => {
		answer({
			[groups("live")]: { items: [item("UK", "UK")], next: null },
			[groupItems("UK")]: { items: [item("a", "One")], next: "b" },
		});
		render(<RemoteCatalog link={link()} />);
		fireEvent.click(await screen.findByRole("button", { name: "UK" }));
		fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
		expect(await screen.findByText("Couldn't load this from Living Room.")).toBeInTheDocument();
	});

	it("opens a series' episodes and goes back to where it came from", async () => {
		const show = item("series-1", "The Show", { contentType: "series", group: "Drama" });
		vi.mocked(remoteCatalog).mockImplementation(async (q: CatalogQuery) => {
			if (q.kind === "groups") return { items: [item("Drama", "Drama")], next: null };
			if (q.kind === "items") return { items: [show], next: null };
			if (q.kind === "episodes")
				return {
					items: [
						item("ep-1", "Pilot", { contentType: "series", season: 1, episode: 1 }),
					],
					next: null,
				};
			throw new Error("unexpected");
		});
		render(<RemoteCatalog link={link()} />);
		fireEvent.click(screen.getByRole("button", { name: "Series" }));
		fireEvent.click(await screen.findByRole("button", { name: "Drama" }));
		fireEvent.click(await screen.findByRole("button", { name: "The Show" }));
		const episode = await screen.findByRole("button", { name: /Pilot/ });
		expect(episode).toHaveTextContent("S1 E1");
		expect(remoteCatalog).toHaveBeenCalledWith({ kind: "episodes", seriesId: "series-1" });
		fireEvent.click(episode);
		await waitFor(() => expect(send).toHaveBeenCalledWith({ action: "load", itemId: "ep-1" }));
		fireEvent.click(screen.getByRole("button", { name: "Back" }));
		expect(await screen.findByRole("button", { name: "The Show" })).toBeInTheDocument();
		expect(remoteCatalog).toHaveBeenLastCalledWith({
			kind: "items",
			contentType: "series",
			group: "Drama",
			limit: PAGE,
		});
	});

	it("searches what the other device has once typing pauses", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		vi.mocked(remoteCatalog).mockImplementation(async (q: CatalogQuery) =>
			q.kind === "search"
				? { items: q.query === "bbc" ? [item("live-1", "BBC One")] : [], next: null }
				: { items: [item("UK", "UK")], next: null }
		);
		render(<RemoteCatalog link={link()} />);
		await act(async () => {});
		const box = screen.getByRole("textbox", { name: "Search Living Room" });
		fireEvent.change(box, { target: { value: "bb" } });
		fireEvent.change(box, { target: { value: " bbc " } });
		await act(async () => vi.advanceTimersByTime(SEARCH_DELAY_MS - 1));
		expect(remoteCatalog).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "search" }));
		await act(async () => vi.advanceTimersByTime(1));
		expect(remoteCatalog).toHaveBeenCalledTimes(2);
		expect(remoteCatalog).toHaveBeenLastCalledWith({
			kind: "search",
			query: "bbc",
			contentType: "live",
			limit: PAGE,
		});
		await act(async () => {});
		fireEvent.click(screen.getByRole("button", { name: /BBC One/ }));
		await act(async () => {});
		expect(send).toHaveBeenCalledWith({ action: "load", itemId: "live-1" });

		// Spaces alone change nothing, and leave no "Loading…" behind.
		fireEvent.change(box, { target: { value: "bbc  " } });
		await act(async () => vi.advanceTimersByTime(SEARCH_DELAY_MS));
		expect(remoteCatalog).toHaveBeenCalledTimes(2);
		expect(screen.queryByText("Loading…")).toBeNull();

		fireEvent.change(box, { target: { value: "zzz" } });
		await act(async () => vi.advanceTimersByTime(SEARCH_DELAY_MS));
		await act(async () => {});
		expect(screen.getByText("Nothing on Living Room matches.")).toBeInTheDocument();
	});

	it("says when a group is empty", async () => {
		answer({ [groups("live")]: { items: [], next: null } });
		render(<RemoteCatalog link={link()} />);
		expect(await screen.findByText("Nothing here.")).toBeInTheDocument();
	});

	it("says when the other device couldn't play something", async () => {
		send.mockRejectedValueOnce("not_found");
		answer({
			[groups("live")]: { items: [item("UK", "UK")], next: null },
			[groupItems("UK")]: { items: [item("live-1", "BBC One")], next: null },
		});
		render(<RemoteCatalog link={link()} />);
		fireEvent.click(await screen.findByRole("button", { name: "UK" }));
		fireEvent.click(await screen.findByRole("button", { name: /BBC One/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Living Room couldn't play BBC One."
		);
	});

	it("shows a logo where there is one", async () => {
		answer({
			[groups("live")]: { items: [item("UK", "UK")], next: null },
			[groupItems("UK")]: {
				items: [item("live-1", "BBC One", { logo: "https://logos.example/bbc.png" })],
				next: null,
			},
		});
		const { container } = render(<RemoteCatalog link={link()} />);
		fireEvent.click(await screen.findByRole("button", { name: "UK" }));
		await screen.findByRole("button", { name: /BBC One/ });
		expect(container.querySelector("img")).toHaveAttribute(
			"src",
			"https://logos.example/bbc.png"
		);
	});

	it("drops an answer that comes after it moved on", async () => {
		let late: (page: { items: CatalogItem[]; next: string | null }) => void = () => {};
		vi.mocked(remoteCatalog)
			.mockImplementationOnce(() => new Promise((r) => (late = r)))
			.mockResolvedValue({ items: [item("Film", "Film")], next: null });
		render(<RemoteCatalog link={link()} />);
		fireEvent.click(screen.getByRole("button", { name: "Movies" }));
		await screen.findByRole("button", { name: "Film" });
		await act(async () => late({ items: [item("UK", "UK")], next: null }));
		expect(screen.queryByRole("button", { name: "UK" })).toBeNull();
	});

	it("starts on the groups with an empty search box and no way back", async () => {
		answer({ [groups("live")]: { items: [item("UK", "UK")], next: null } });
		render(<RemoteCatalog link={link()} />);
		await screen.findByRole("button", { name: "UK" });
		const box = screen.getByRole("textbox", { name: "Search Living Room" });
		expect(box).toHaveValue("");
		expect(box).toHaveAttribute("placeholder", "Search Living Room");
		expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
		for (const label of ["Live", "Movies", "Series"]) {
			expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
		}
	});

	it("asks for each content type's groups", async () => {
		vi.mocked(remoteCatalog).mockResolvedValue({ items: [], next: null });
		render(<RemoteCatalog link={link()} />);
		await screen.findByText("Nothing here.");
		fireEvent.click(screen.getByRole("button", { name: "Movies" }));
		await waitFor(() =>
			expect(remoteCatalog).toHaveBeenLastCalledWith({ kind: "groups", contentType: "movie" })
		);
		fireEvent.click(screen.getByRole("button", { name: "Live" }));
		await waitFor(() =>
			expect(remoteCatalog).toHaveBeenLastCalledWith({ kind: "groups", contentType: "live" })
		);
		expect(remoteCatalog.mock.calls[0][0]).toEqual({ kind: "groups", contentType: "live" });
	});

	it("says when the first page fails", async () => {
		vi.mocked(remoteCatalog).mockRejectedValue("notConnected");
		render(<RemoteCatalog link={link()} />);
		expect(await screen.findByText("Couldn't load this from Living Room.")).toBeInTheDocument();
	});

	it("ignores a failure that comes after it moved on", async () => {
		let fail: (e: unknown) => void = () => {};
		vi.mocked(remoteCatalog)
			.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)))
			.mockResolvedValue({ items: [item("Film", "Film")], next: null });
		render(<RemoteCatalog link={link()} />);
		fireEvent.click(screen.getByRole("button", { name: "Movies" }));
		await screen.findByRole("button", { name: "Film" });
		await act(async () => fail("late"));
		expect(screen.queryByText("Couldn't load this from Living Room.")).toBeNull();
	});

	it("shows a series' name over its episodes, and no line for an item without one", async () => {
		const show = item("series-1", "The Show", { contentType: "series", group: "Drama" });
		vi.mocked(remoteCatalog).mockImplementation(async (q: CatalogQuery) => {
			if (q.kind === "groups") return { items: [item("Drama", "Drama")], next: null };
			if (q.kind === "items") return { items: [show], next: null };
			return { items: [item("ep-1", "Pilot", { contentType: "series" })], next: null };
		});
		render(<RemoteCatalog link={link()} />);
		fireEvent.click(screen.getByRole("button", { name: "Series" }));
		fireEvent.click(await screen.findByRole("button", { name: "Drama" }));
		const series = await screen.findByRole("button", { name: "The Show" });
		expect(series.querySelectorAll("span > span")).toHaveLength(1);
		fireEvent.click(series);
		await screen.findByRole("button", { name: /Pilot/ });
		expect(screen.getByRole("heading")).toHaveTextContent("The Show");
	});

	it("opens a series found by search, and goes back to the groups from it", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const show = item("series-1", "The Show", { contentType: "series" });
		vi.mocked(remoteCatalog).mockImplementation(async (q: CatalogQuery) => {
			if (q.kind === "groups") return { items: [item("UK", "UK")], next: null };
			if (q.kind === "items") return { items: [item("live-1", "One")], next: null };
			if (q.kind === "search") return { items: [show], next: null };
			return { items: [item("ep-1", "Pilot", { season: 1, episode: 1 })], next: null };
		});
		render(<RemoteCatalog link={link()} />);
		await act(async () => {});
		fireEvent.click(screen.getByRole("button", { name: "UK" }));
		await act(async () => {});
		expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "show" } });
		await act(async () => vi.advanceTimersByTime(SEARCH_DELAY_MS));
		await act(async () => {});
		expect(screen.queryByRole("button", { name: "Back" }), "not while searching").toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "The Show" }));
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
		await act(async () => vi.advanceTimersByTime(SEARCH_DELAY_MS));
		await act(async () => {});
		fireEvent.click(screen.getByRole("button", { name: "Back" }));
		await act(async () => {});
		expect(screen.getByRole("button", { name: "UK" })).toBeInTheDocument();
		expect(screen.getByRole("heading")).toHaveTextContent("On Living Room");
	});

	it("waits for typing to pause for the whole delay", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		vi.mocked(remoteCatalog).mockResolvedValue({ items: [], next: null });
		render(<RemoteCatalog link={link()} />);
		await act(async () => {});
		const box = screen.getByRole("textbox");
		fireEvent.change(box, { target: { value: "bb" } });
		await act(async () => vi.advanceTimersByTime(200));
		fireEvent.change(box, { target: { value: "bbc" } });
		await act(async () => vi.advanceTimersByTime(200));
		expect(remoteCatalog).toHaveBeenCalledTimes(1);
		await act(async () => vi.advanceTimersByTime(100));
		expect(remoteCatalog).toHaveBeenCalledTimes(2);
		expect(remoteCatalog).toHaveBeenLastCalledWith(
			expect.objectContaining({ kind: "search", query: "bbc" })
		);
	});

	it("clears a failed play's message when the next one works", async () => {
		send.mockRejectedValueOnce("not_found");
		answer({
			[groups("live")]: { items: [item("UK", "UK")], next: null },
			[groupItems("UK")]: { items: [item("live-1", "BBC One")], next: null },
		});
		render(<RemoteCatalog link={link()} />);
		fireEvent.click(await screen.findByRole("button", { name: "UK" }));
		const channel = await screen.findByRole("button", { name: /BBC One/ });
		fireEvent.click(channel);
		await screen.findByRole("alert");
		fireEvent.click(channel);
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
		expect(within(screen.getByRole("list")).getAllByRole("button")).toHaveLength(1);
	});
});

describe("episodeLabel", () => {
	it("needs both the season and the episode", () => {
		expect(episodeLabel(item("a", "A", { season: 2, episode: 5 }))).toBe("S2 E5");
		expect(episodeLabel(item("a", "A", { season: 2 }))).toBeNull();
		expect(episodeLabel(item("a", "A", { episode: 5 }))).toBeNull();
		expect(episodeLabel(item("a", "A", { season: 0, episode: 0 }))).toBe("S0 E0");
	});
});
