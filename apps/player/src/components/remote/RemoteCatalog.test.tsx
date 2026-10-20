// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";

vi.mock("@/lib/tauri", () => ({ remoteCatalog: vi.fn() }));

import { remoteCatalog, type CatalogQuery } from "@/lib/tauri";
import { RemoteCatalog, PAGE, SEARCH_DELAY_MS, episodeLabel, groupName } from "./RemoteCatalog";
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
	id: 9,
	deviceId: "tv1",
	name: "Living Room",
	phase: { phase: "connected" },
	code: null,
	destination: createCinetteDestination("tv1", "Living Room", send),
});

/** Answers each query from a table, by kind and its fields. */
const answer = (pages: Record<string, { items: CatalogItem[]; next: string | null }>) =>
	vi.mocked(remoteCatalog).mockImplementation(async (linkId: number, q: CatalogQuery) => {
		if (linkId !== 9) throw new Error(`asked link ${linkId}`);
		const key = JSON.stringify(q);
		const page = pages[key];
		if (!page) throw new Error(`unexpected ${key}`);
		return page;
	});

const groups = (contentType: string, cursor?: string) =>
	JSON.stringify({ kind: "groups", contentType, cursor, limit: PAGE });
const episodes = (seriesId: string, cursor?: string) =>
	JSON.stringify({ kind: "episodes", seriesId, cursor, limit: PAGE });
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

	it("keeps what it shows when the next page fails, and tries again", async () => {
		answer({
			[groups("live")]: { items: [item("UK", "UK")], next: null },
			[groupItems("UK")]: { items: [item("a", "One")], next: "b" },
		});
		render(<RemoteCatalog link={link()} />);
		fireEvent.click(await screen.findByRole("button", { name: "UK" }));
		fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Couldn't load more from Living Room."
		);
		expect(screen.getByRole("button", { name: /One/ })).toBeInTheDocument();
		answer({
			[groups("live")]: { items: [item("UK", "UK")], next: null },
			[groupItems("UK")]: { items: [item("a", "One")], next: "b" },
			[groupItems("UK", "b")]: { items: [item("b", "Two")], next: null },
		});
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByRole("button", { name: /Two/ })).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("asks for one more page at a time", async () => {
		let release: (page: { items: CatalogItem[]; next: string | null }) => void = () => {};
		vi.mocked(remoteCatalog).mockImplementation(async (_link: number, q: CatalogQuery) => {
			if (q.kind === "groups") return { items: [item("UK", "UK")], next: null };
			if (q.kind === "items" && q.cursor === undefined)
				return { items: [item("a", "One")], next: "b" };
			return new Promise((r) => (release = r));
		});
		render(<RemoteCatalog link={link()} />);
		fireEvent.click(await screen.findByRole("button", { name: "UK" }));
		const more = await screen.findByRole("button", { name: "Load more" });
		fireEvent.click(more);
		expect(more).toBeDisabled();
		fireEvent.click(more);
		expect(remoteCatalog).toHaveBeenCalledTimes(3);
		await act(async () => release({ items: [item("b", "Two")], next: null }));
		expect(screen.getAllByRole("listitem")).toHaveLength(2);
	});

	it("drops a page, or its failure, that comes after it moved on", async () => {
		const pages: {
			resolve: (page: { items: CatalogItem[]; next: string | null }) => void;
			reject: (e: unknown) => void;
		}[] = [];
		vi.mocked(remoteCatalog).mockImplementation(async (_link: number, q: CatalogQuery) => {
			if (q.kind === "groups")
				return { items: [item("UK", "UK"), item("US", "US")], next: null };
			if (q.kind === "items" && q.cursor === undefined)
				return { items: [item(`${q.group}-1`, `${q.group} one`)], next: "more" };
			return new Promise((resolve, reject) => pages.push({ resolve, reject }));
		});
		render(<RemoteCatalog link={link()} />);
		const moveOn = async (from: string, to: string) => {
			fireEvent.click(await screen.findByRole("button", { name: from }));
			fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
			fireEvent.click(screen.getByRole("button", { name: "Back" }));
			fireEvent.click(await screen.findByRole("button", { name: to }));
			await screen.findByRole("button", { name: `${to} one` });
		};
		await moveOn("UK", "US");
		await act(async () => pages[0].resolve({ items: [item("UK-2", "UK two")], next: null }));
		expect(screen.queryByRole("button", { name: "UK two" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Back" }));
		await moveOn("UK", "US");
		await act(async () => pages[1].reject("late"));
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
	});

	it("tries again as often as asked", async () => {
		vi.mocked(remoteCatalog).mockRejectedValue("notConnected");
		render(<RemoteCatalog link={link()} />);
		await screen.findByText("Couldn't load this from Living Room.");
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		await screen.findByText("Couldn't load this from Living Room.");
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		await screen.findByText("Couldn't load this from Living Room.");
		expect(remoteCatalog).toHaveBeenCalledTimes(3);
	});

	it("calls only a group with no name No group, not an item or a result", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		vi.mocked(remoteCatalog).mockImplementation(async (_link: number, q: CatalogQuery) => {
			if (q.kind === "groups") return { items: [item("UK", "UK")], next: null };
			return { items: [item("x", "")], next: null };
		});
		render(<RemoteCatalog link={link()} />);
		await act(async () => {});
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } });
		await act(async () => vi.advanceTimersByTime(SEARCH_DELAY_MS));
		await act(async () => {});
		expect(screen.getAllByRole("listitem")).toHaveLength(1);
		expect(screen.queryByText("No group"), "a search result").toBeNull();
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
		await act(async () => vi.advanceTimersByTime(SEARCH_DELAY_MS));
		await act(async () => {});
		fireEvent.click(screen.getByRole("button", { name: "UK" }));
		await act(async () => {});
		expect(screen.getAllByRole("listitem")).toHaveLength(1);
		expect(screen.queryByText("No group"), "an item in a group").toBeNull();
	});

	it("tries the first page again when asked", async () => {
		vi.mocked(remoteCatalog).mockRejectedValueOnce("notConnected");
		vi.mocked(remoteCatalog).mockResolvedValue({ items: [item("UK", "UK")], next: null });
		render(<RemoteCatalog link={link()} />);
		expect(await screen.findByText("Couldn't load this from Living Room.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(screen.getByText("Loading…")).toBeInTheDocument();
		expect(await screen.findByRole("button", { name: "UK" })).toBeInTheDocument();
	});

	it("waits while the link is down, and loads again once it's back", async () => {
		vi.mocked(remoteCatalog).mockResolvedValue({ items: [item("UK", "UK")], next: null });
		const down = { ...link(), phase: { phase: "reconnecting", attempt: 1 } as const };
		const view = render(<RemoteCatalog link={down} />);
		await act(async () => {});
		expect(remoteCatalog).not.toHaveBeenCalled();
		expect(screen.getByText("Loading…")).toBeInTheDocument();
		view.rerender(<RemoteCatalog link={{ ...down, phase: { phase: "connected" } }} />);
		expect(await screen.findByRole("button", { name: "UK" })).toBeInTheDocument();
		expect(remoteCatalog).toHaveBeenCalledTimes(1);
	});

	it("keeps the pages it loaded when the link drops and comes back", async () => {
		answer({
			[groups("live")]: { items: [item("UK", "UK")], next: null },
			[groupItems("UK")]: { items: [item("a", "One")], next: "b" },
			[groupItems("UK", "b")]: { items: [item("b", "Two")], next: null },
		});
		const up = link();
		const view = render(<RemoteCatalog link={up} />);
		fireEvent.click(await screen.findByRole("button", { name: "UK" }));
		await screen.findByRole("button", { name: /One/ });
		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		await screen.findByRole("button", { name: /Two/ });
		const asked = vi.mocked(remoteCatalog).mock.calls.length;
		view.rerender(
			<RemoteCatalog link={{ ...up, phase: { phase: "reconnecting", attempt: 1 } }} />
		);
		view.rerender(<RemoteCatalog link={{ ...up, phase: { phase: "connected" } }} />);
		await act(async () => {});
		expect(remoteCatalog).toHaveBeenCalledTimes(asked);
		expect(screen.getByRole("button", { name: /One/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Two/ })).toBeInTheDocument();
	});

	it("calls a group with no name No group", async () => {
		answer({
			[groups("live")]: { items: [item("", "")], next: null },
			[groupItems("")]: { items: [item("a", "One", { group: "" })], next: null },
		});
		render(<RemoteCatalog link={link()} />);
		fireEvent.click(await screen.findByRole("button", { name: "No group" }));
		expect(await screen.findByRole("heading")).toHaveTextContent("No group");
		expect(screen.getByRole("button", { name: "One" })).toBeInTheDocument();
		expect(groupName("Drama")).toBe("Drama");
	});

	it("opens a series' episodes and goes back to where it came from", async () => {
		const show = item("series-1", "The Show", { contentType: "series", group: "Drama" });
		vi.mocked(remoteCatalog).mockImplementation(async (_link: number, q: CatalogQuery) => {
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
		expect(remoteCatalog).toHaveBeenCalledWith(9, JSON.parse(episodes("series-1")));
		fireEvent.click(episode);
		await waitFor(() => expect(send).toHaveBeenCalledWith({ action: "load", itemId: "ep-1" }));
		fireEvent.click(screen.getByRole("button", { name: "Back" }));
		expect(await screen.findByRole("button", { name: "The Show" })).toBeInTheDocument();
		expect(remoteCatalog).toHaveBeenLastCalledWith(9, {
			kind: "items",
			contentType: "series",
			group: "Drama",
			limit: PAGE,
		});
	});

	it("searches what the other device has once typing pauses", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		vi.mocked(remoteCatalog).mockImplementation(async (_link: number, q: CatalogQuery) =>
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
		expect(remoteCatalog).toHaveBeenLastCalledWith(9, {
			kind: "search",
			query: "bbc",
			contentType: "live",
			limit: PAGE,
		});
		await act(async () => {});
		expect(screen.getByRole("heading"), "the results come from every group").toHaveTextContent(
			"Search results on Living Room"
		);
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
			expect(remoteCatalog).toHaveBeenLastCalledWith(9, {
				kind: "groups",
				contentType: "movie",
				limit: PAGE,
			})
		);
		fireEvent.click(screen.getByRole("button", { name: "Live" }));
		await waitFor(() =>
			expect(remoteCatalog).toHaveBeenLastCalledWith(9, {
				kind: "groups",
				contentType: "live",
				limit: PAGE,
			})
		);
		expect(vi.mocked(remoteCatalog).mock.calls[0]).toEqual([
			9,
			{ kind: "groups", contentType: "live", limit: PAGE },
		]);
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
		vi.mocked(remoteCatalog).mockImplementation(async (_link: number, q: CatalogQuery) => {
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
		vi.mocked(remoteCatalog).mockImplementation(async (_link: number, q: CatalogQuery) => {
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
		await act(async () => {});
		// The episodes show, and the search is gone.
		expect(screen.getByRole("button", { name: /Pilot/ })).toBeInTheDocument();
		expect(screen.getByRole("textbox")).toHaveValue("");
		expect(screen.getByRole("heading")).toHaveTextContent("The Show");
		await act(async () => vi.advanceTimersByTime(SEARCH_DELAY_MS));
		expect(
			screen.getByRole("button", { name: /Pilot/ }),
			"no search comes back"
		).toBeInTheDocument();
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
			9,
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

describe("RemoteCatalog while a page loads", () => {
	it("says it's loading a group and offers no more of the last one", async () => {
		let resolve: (page: { items: CatalogItem[]; next: string | null }) => void = () => {};
		vi.mocked(remoteCatalog)
			.mockResolvedValueOnce({ items: [item("UK", "UK")], next: "x" })
			.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
		render(<RemoteCatalog link={link()} />);
		fireEvent.click(await screen.findByRole("button", { name: "UK" }));
		expect(screen.getByText("Loading…")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
		await act(async () => resolve({ items: [item("a", "One")], next: null }));
		expect(screen.getByRole("button", { name: /One/ })).toBeInTheDocument();
	});

	it("says it's loading a search", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		vi.mocked(remoteCatalog)
			.mockResolvedValueOnce({ items: [item("UK", "UK")], next: null })
			.mockImplementationOnce(() => new Promise(() => {}));
		render(<RemoteCatalog link={link()} />);
		await act(async () => {});
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "bbc" } });
		await act(async () => vi.advanceTimersByTime(SEARCH_DELAY_MS));
		expect(screen.getByText("Loading…")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "UK" })).toBeNull();
	});

	it("keeps offering more while there is more", async () => {
		answer({
			[groups("live")]: { items: [item("UK", "UK")], next: null },
			[groupItems("UK")]: { items: [item("a", "One")], next: "b" },
			[groupItems("UK", "b")]: { items: [item("b", "Two")], next: "c" },
		});
		render(<RemoteCatalog link={link()} />);
		fireEvent.click(await screen.findByRole("button", { name: "UK" }));
		fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
		await screen.findByRole("button", { name: /Two/ });
		expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();
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
