// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Channel } from "@/lib/types";
import { makeMovie } from "@/test/detail-fixtures";
import { TV_START_ATTRIBUTE } from "@/lib/tv-focus";
import { TvPosters } from "./TvPosters";
import { TvNavContext } from "./tv-nav";

vi.mock("@/hooks/useNow", () => ({ useNow: () => 1_800_000_000 }));

const movie = (id: string, groupTitle: string, overrides: Partial<Channel> = {}): Channel =>
	makeMovie({ id, name: id, groupTitle, ...overrides });

const MIXED = [
	movie("a1", "Action"),
	movie("a2", "Action"),
	movie("a3", "Action"),
	movie("c1", "Comedy"),
];
const SINGLE = [movie("a1", "Action"), movie("a2", "Action")];

const posters = (
	memory: Map<string, unknown>,
	items: readonly Channel[],
	onOpen: (item: Channel) => void = () => {}
) => (
	<TvNavContext.Provider value={{ section: "movie", openSection: () => {}, memory }}>
		<TvPosters title="Movies" memoryKey="movie" items={items} onOpen={onOpen} />
	</TvNavContext.Provider>
);

const grid = () => screen.getByRole("listbox", { name: "Movies" });
const groups = () => screen.getByRole("listbox", { name: "Groups" });
const active = (list: HTMLElement) => within(list).getByRole("option", { selected: true });
const names = (list: HTMLElement) =>
	within(list)
		.getAllByRole("option")
		.map((row) => row.textContent);

describe("TvPosters", () => {
	afterEach(cleanup);

	it("shows the title as the screen's heading and uses it to name the grid", () => {
		render(posters(new Map(), SINGLE));
		expect(screen.getByRole("heading", { name: "Movies" })).toBeInTheDocument();
		expect(grid()).toBeInTheDocument();
	});

	it("skips the groups for a provider with only one, and gives the grid more columns", () => {
		render(posters(new Map(), SINGLE));
		expect(screen.queryByRole("listbox", { name: "Groups" })).not.toBeInTheDocument();
		// Eight columns, each 7.0625rem wide.
		const items = Array.from({ length: 9 }, (_, i) => movie(`m${i}`, "Action"));
		cleanup();
		render(posters(new Map(), items));
		expect(within(grid()).getByRole("option", { name: "M m7" }).style.left).toBe("49.4375rem");
		expect(within(grid()).getByRole("option", { name: "M m8" }).style.left).toBe("0rem");
		expect(within(grid()).getByRole("option", { name: "M m8" }).style.top).toBe("12.75rem");
		expect(within(grid()).getByRole("option", { name: "M m8" }).style.width).toBe("7.0625rem");
	});

	it("skips the groups with no items at all", () => {
		render(posters(new Map(), []));
		expect(screen.queryByRole("listbox", { name: "Groups" })).not.toBeInTheDocument();
		expect(screen.queryAllByRole("option")).toEqual([]);
	});

	it("shows six columns of posters beside the groups", () => {
		const items = Array.from({ length: 7 }, (_, i) => movie(`m${i}`, "Action"));
		items.push(movie("c1", "Comedy"));
		render(posters(new Map(), items));
		expect(names(groups())).toEqual(["All8", "Action7", "Comedy1"]);
		expect(within(grid()).getByRole("option", { name: "M m5" }).style.left).toBe("35.3125rem");
		expect(within(grid()).getByRole("option", { name: "M m6" }).style.left).toBe("0rem");
		expect(within(grid()).getByRole("option", { name: "M m6" }).style.height).toBe("12.75rem");
		expect(grid().style.height).toBe("32rem");
	});

	it("starts in the posters, and OK opens the one under the cursor", () => {
		const onOpen = vi.fn();
		render(posters(new Map(), MIXED, onOpen));
		expect(document.activeElement).toBe(active(grid()));
		expect(active(grid())).toHaveAttribute(TV_START_ATTRIBUTE);
		expect(active(groups())).not.toHaveAttribute(TV_START_ATTRIBUTE);

		fireEvent.keyDown(active(grid()), { key: "ArrowRight" });
		fireEvent.keyDown(active(grid()), { key: "Enter" });
		expect(onOpen).toHaveBeenCalledExactlyOnceWith(MIXED[1], 1);
	});

	it("shows what's in the group the cursor reaches, from its first poster", () => {
		render(posters(new Map(), MIXED));
		fireEvent.keyDown(active(grid()), { key: "ArrowRight" });
		expect(active(grid())).toHaveTextContent("a2");

		fireEvent.keyDown(active(groups()), { key: "ArrowDown" });
		expect(names(grid())).toEqual(["Aa1", "Aa2", "Aa3"]);
		expect(active(grid())).toHaveTextContent("a1");

		fireEvent.keyDown(active(groups()), { key: "ArrowDown" });
		expect(names(grid())).toEqual(["Cc1"]);
	});

	it("remembers its place for when the screen opens again", () => {
		const memory = new Map<string, unknown>();
		render(posters(memory, MIXED));
		fireEvent.keyDown(active(groups()), { key: "ArrowDown" });
		fireEvent.keyDown(active(grid()), { key: "ArrowRight" });
		expect(memory.get("movie")).toEqual({ group: 1, item: 1, inGroups: false });

		cleanup();
		render(posters(memory, MIXED));
		expect(active(groups())).toHaveTextContent("Action");
		expect(active(grid())).toHaveTextContent("a2");
		expect(document.activeElement).toBe(active(grid()));
	});

	it("comes back to the groups if that's where the focus was", () => {
		const memory = new Map<string, unknown>();
		render(posters(memory, MIXED));
		fireEvent.keyDown(active(groups()), { key: "ArrowDown" });
		expect(memory.get("movie")).toEqual({ group: 1, item: 0, inGroups: true });

		cleanup();
		render(posters(memory, MIXED));
		expect(document.activeElement).toBe(active(groups()));
		expect(active(groups())).toHaveAttribute(TV_START_ATTRIBUTE);
		expect(active(grid())).not.toHaveAttribute(TV_START_ATTRIBUTE);
	});

	it("falls back to the last group when the one it remembers has gone", () => {
		const memory = new Map<string, unknown>([
			["movie", { group: 9, item: 0, inGroups: false }],
		]);
		render(posters(memory, MIXED));
		expect(names(grid())).toEqual(["Cc1"]);
	});

	it("uses everything when a remembered group is gone and only one is left", () => {
		const memory = new Map<string, unknown>([
			["movie", { group: 2, item: 0, inGroups: false }],
		]);
		render(posters(memory, SINGLE));
		expect(names(grid())).toEqual(["Aa1", "Aa2"]);
	});

	it("keeps a poster's cell when the movies change order", () => {
		const memory = new Map<string, unknown>();
		const { rerender } = render(posters(memory, SINGLE));
		const cell = screen.getByRole("option", { name: "A a2" });
		rerender(posters(memory, [...SINGLE].reverse()));
		expect(screen.getByRole("option", { name: "A a2" })).toBe(cell);
	});

	it("shows a poster where there is one, and otherwise the name's capital first letter", () => {
		const { container } = render(
			posters(new Map(), [
				movie("with", "A", { name: "with", logoUrl: "http://logo.example.test/p.png" }),
				movie("without", "A", { name: "without" }),
			])
		);
		expect(container.querySelector("img")).toHaveAttribute(
			"src",
			"http://logo.example.test/p.png"
		);
		expect(screen.getByRole("option", { name: "W without" })).toBeInTheDocument();
	});
});
