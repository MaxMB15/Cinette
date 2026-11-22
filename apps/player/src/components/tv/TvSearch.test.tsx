// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TV_START_ATTRIBUTE } from "@/lib/tv-focus";
import type { Channel } from "@/lib/types";
import { makeChannel } from "@/test/channel-fixtures";
import { KINDS_START, type TvKind, type TvKindsPlace } from "./TvKinds";
import { TvSearch, searchItems } from "./TvSearch";
import { TvNavContext } from "./tv-nav";

vi.mock("@/hooks/useNow", () => ({ useNow: () => 1_800_000_000 }));

const named = (name: string, overrides: Partial<Channel> = {}): Channel =>
	makeChannel({ id: name, name, ...overrides });

describe("searchItems", () => {
	const ITEMS = [named("Sky News"), named("News 24"), named("Weather"), named("Newsround")];

	it("finds nothing for no text, or only spaces", () => {
		expect(searchItems(ITEMS, "")).toEqual([]);
		expect(searchItems(ITEMS, "   ")).toEqual([]);
	});

	it("puts the names that start with the text first, each kind in its own order", () => {
		expect(searchItems(ITEMS, "news").map((item) => item.name)).toEqual([
			"News 24",
			"Newsround",
			"Sky News",
		]);
	});

	it("ignores case and the spaces around the text", () => {
		expect(searchItems(ITEMS, "  WEATH ").map((item) => item.name)).toEqual(["Weather"]);
		expect(searchItems([named("WEATHER")], "weath")).toHaveLength(1);
	});

	it("leaves out names without the text", () => {
		expect(searchItems(ITEMS, "sport")).toEqual([]);
	});

	it("stops at 200 results", () => {
		const many = Array.from({ length: 201 }, (_, i) => named(`Item ${i}`));
		const results = searchItems(many, "item");
		expect(results).toHaveLength(200);
		expect(results[199].name).toBe("Item 199");
	});
});

describe("TvSearch", () => {
	const NEWS = named("News", { contentType: "live" });
	const NEWSREEL = named("Newsreel", { contentType: "movie" });
	const NEWSDESK = named("Newsdesk", { contentType: "movie" });
	const NEWSROOM = named("Newsroom", { contentType: "series" });
	const KINDS: readonly TvKind[] = [
		{ name: "Live TV", items: [NEWS] },
		{ name: "Movies", items: [NEWSREEL, NEWSDESK] },
		{ name: "Series", items: [NEWSROOM] },
	];

	const search = (
		memory = new Map<string, unknown>(),
		onOpen: (item: Channel) => void = () => {},
		kinds: readonly TvKind[] = KINDS
	) => (
		<TvNavContext.Provider value={{ section: "search", openSection: () => {}, memory }}>
			<TvSearch kinds={kinds} onOpen={onOpen} />
		</TvNavContext.Provider>
	);

	const startingAt = (place: { key?: number; text?: string; results?: TvKindsPlace }) =>
		new Map<string, unknown>([
			["search", { key: 0, text: "", results: KINDS_START, ...place }],
		]);

	const field = () =>
		screen.getByRole<HTMLInputElement>("searchbox", {
			name: "Search for a channel, movie or show",
		});
	const letters = () => screen.getByRole("listbox", { name: "Letters" });
	const kinds = () => screen.getByRole("listbox", { name: "Kinds" });
	const results = (kind: string) => screen.getByRole("listbox", { name: kind });
	const active = (list: HTMLElement) => within(list).getByRole("option", { selected: true });
	const names = (list: HTMLElement) =>
		within(list)
			.getAllByRole("option")
			.map((row) => row.textContent);
	const type = (text: string) => fireEvent.change(field(), { target: { value: text } });

	afterEach(cleanup);

	it("opens on the letters with an empty field and no results", () => {
		render(search());
		expect(screen.getByRole("heading", { name: "Search" })).toBeInTheDocument();
		expect(field()).toHaveValue("");
		expect(field().placeholder).toBe("Channel, movie or show");
		expect(field().style.height).toBe("2.75rem");
		expect(document.activeElement).toBe(active(letters()));
		expect(active(letters())).toHaveAttribute(TV_START_ATTRIBUTE);
		expect(active(letters())).toHaveTextContent("A");
		expect(screen.queryByRole("listbox", { name: "Kinds" })).not.toBeInTheDocument();
	});

	it("offers capital letters, digits, space, backspace and clear, six to a row", () => {
		render(search());
		const keys = within(letters()).getAllByRole("option");
		expect(keys.map((key) => key.textContent).join("")).toBe(
			"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
		);
		expect(keys).toHaveLength(39);
		expect(screen.getByLabelText("space")).toBeInTheDocument();
		expect(screen.getByLabelText("backspace")).toBeInTheDocument();
		expect(screen.getByLabelText("clear")).toBeInTheDocument();
		expect(keys[6].style.top).toBe("2.75rem");
		expect(keys[6].style.left).toBe("0rem");
	});

	it("types a letter on OK and shows what has it, by kind", () => {
		const memory = startingAt({ key: 13 });
		render(search(memory));
		fireEvent.keyDown(active(letters()), { key: "Enter" });
		expect(field()).toHaveValue("n");
		expect(names(kinds())).toEqual(["Live TV1", "Movies2", "Series1"]);
		expect(names(results("Live TV"))).toEqual(["NNews"]);
		expect(document.activeElement).toBe(active(letters()));
	});

	it.each([
		["space", 36, "ab", "ab "],
		["backspace", 37, "ab", "a"],
		["clear", 38, "ab", ""],
	])("applies the %s key to the text", (_name, key, text, after) => {
		render(search(startingAt({ key, text })));
		fireEvent.keyDown(active(letters()), { key: "Enter" });
		expect(field()).toHaveValue(after);
	});

	it("takes text typed into the field, and leaves out the kinds with nothing", () => {
		render(search());
		type("newsr");
		expect(field()).toHaveValue("newsr");
		expect(names(kinds())).toEqual(["Movies1", "Series1"]);
		expect(names(results("Movies"))).toEqual(["NNewsreel"]);
	});

	it("shows the results of the kind the cursor reaches", () => {
		render(search(startingAt({ text: "news" })));
		fireEvent.keyDown(active(kinds()), { key: "ArrowDown" });
		expect(names(results("Movies"))).toEqual(["NNewsreel", "NNewsdesk"]);
	});

	it("sizes the results for the screen", () => {
		render(search(startingAt({ text: "news" })));
		expect(results("Live TV").style.height).toBe("32rem");
		expect(active(results("Live TV")).style.height).toBe("3.4rem");
	});

	it("leaves the screen's start on the letters", () => {
		render(search(startingAt({ text: "news" })));
		expect(active(kinds())).not.toHaveAttribute(TV_START_ATTRIBUTE);
		expect(active(results("Live TV"))).not.toHaveAttribute(TV_START_ATTRIBUTE);
	});

	it("opens the result under the cursor on OK", () => {
		const onOpen = vi.fn();
		const at = { kind: 1, item: 0, inKinds: false };
		render(search(startingAt({ text: "news", results: at }), onOpen));
		fireEvent.keyDown(active(results("Movies")), { key: "ArrowDown" });
		fireEvent.keyDown(active(results("Movies")), { key: "Enter" });
		expect(onOpen).toHaveBeenCalledExactlyOnceWith(NEWSDESK, KINDS[1].items);
	});

	it("says nothing matched, with the text trimmed", () => {
		render(search(startingAt({ text: " sport " })));
		expect(screen.getByText('Nothing called "sport"')).toBeInTheDocument();
		expect(screen.queryByRole("listbox", { name: "Kinds" })).not.toBeInTheDocument();
	});

	it("shows neither results nor a message for spaces alone", () => {
		render(search(startingAt({ text: "   " })));
		expect(screen.queryByRole("listbox", { name: "Kinds" })).not.toBeInTheDocument();
		expect(screen.queryByText(/Nothing called/)).not.toBeInTheDocument();
	});

	it("remembers its place as the cursor moves", () => {
		const memory = startingAt({ text: "news" });
		render(search(memory));
		fireEvent.keyDown(active(kinds()), { key: "ArrowDown" });
		expect(memory.get("search")).toEqual({
			key: 0,
			text: "news",
			results: { kind: 1, item: 0, inKinds: true },
		});
		fireEvent.keyDown(active(results("Movies")), { key: "ArrowDown" });
		fireEvent.keyDown(active(letters()), { key: "ArrowRight" });
		expect(memory.get("search")).toEqual({
			key: 1,
			text: "news",
			results: { kind: 1, item: 1, inKinds: false },
		});
	});

	it("comes back as it was", () => {
		const at = { kind: 1, item: 1, inKinds: false };
		render(search(startingAt({ key: 2, text: "news", results: at })));
		expect(field()).toHaveValue("news");
		expect(active(letters())).toHaveTextContent("C");
		expect(active(kinds())).toHaveTextContent("Movies");
		expect(active(results("Movies"))).toHaveTextContent("Newsdesk");
	});

	it("goes back to the first result when the text changes from the letters", () => {
		const at = { kind: 1, item: 1, inKinds: false };
		const memory = startingAt({ key: 13, text: "news", results: at });
		render(search(memory));
		fireEvent.keyDown(active(letters()), { key: "Enter" });
		expect(memory.get("search")).toEqual({ key: 13, text: "newsn", results: KINDS_START });
	});

	it("goes back to the first result when the text changes in the field", () => {
		const at = { kind: 1, item: 1, inKinds: false };
		const memory = startingAt({ key: 2, text: "news", results: at });
		render(search(memory));
		type("new");
		expect(memory.get("search")).toEqual({ key: 2, text: "new", results: KINDS_START });
	});

	it("follows a new list of items", () => {
		const memory = startingAt({ text: "news" });
		const { rerender } = render(search(memory));
		rerender(search(memory, () => {}, [KINDS[0]]));
		expect(names(kinds())).toEqual(["Live TV1"]);
	});

	it("keeps a result's row when the ones above it drop out", () => {
		render(search(startingAt({ text: "news" }), () => {}, [KINDS[1]]));
		const row = screen.getByRole("option", { name: /Newsdesk/ });
		type("newsd");
		expect(screen.getByRole("option", { name: /Newsdesk/ })).toBe(row);
	});
});
