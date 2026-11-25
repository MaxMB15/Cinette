// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TV_START_ATTRIBUTE, moveFocus } from "@/lib/tv-focus";
import type { Channel } from "@/lib/types";
import { makeChannel } from "@/test/channel-fixtures";
import { TvFavorites } from "./TvFavorites";
import type { TvKind } from "./TvKinds";
import { TvNavContext } from "./tv-nav";

vi.mock("@/hooks/useNow", () => ({ useNow: () => 1_800_000_000 }));
vi.mock("@/lib/tv-focus", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/tv-focus")>()),
	moveFocus: vi.fn(() => true),
}));

const news = makeChannel({ id: "n", name: "News" });
const sport = makeChannel({ id: "s", name: "Sport" });
const dune = makeChannel({ id: "d", name: "Dune", contentType: "movie" });

const GROUPS: readonly TvKind[] = [
	{ name: "Live TV", items: [news, sport] },
	{ name: "Movies", items: [] },
	{ name: "Series", items: [dune] },
];

const favorites = (
	memory: Map<string, unknown>,
	groups: readonly TvKind[] = GROUPS,
	onOpen: (item: Channel, list: readonly Channel[]) => void = () => {}
) => (
	<TvNavContext.Provider value={{ section: "favorites", openSection: () => {}, memory }}>
		<TvFavorites groups={groups} onOpen={onOpen} />
	</TvNavContext.Provider>
);

const kinds = () => screen.getByRole("listbox", { name: "Kinds" });
const active = (list: HTMLElement) => within(list).getByRole("option", { selected: true });
const names = (list: HTMLElement) =>
	within(list)
		.getAllByRole("option")
		.map((row) => row.textContent);

describe("TvFavorites", () => {
	afterEach(() => {
		cleanup();
		vi.mocked(moveFocus).mockClear();
	});

	it("says how favorites get here when there are none", () => {
		render(favorites(new Map(), [{ name: "Live TV", items: [] }]));
		expect(screen.getByRole("heading", { name: "Favorites" })).toBeInTheDocument();
		expect(
			screen.getByText("Channels and movies you add to your favorites show up here")
		).toBeInTheDocument();
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});

	it("lists the kinds that have favorites, with how many each has", () => {
		render(favorites(new Map()));
		expect(names(kinds())).toEqual(["Live TV2", "Series1"]);
		expect(kinds().style.height).toBe("32rem");
		expect(active(kinds()).style.height).toBe("2.75rem");
	});

	it("starts in the favorites of the first kind, and OK opens one with its list", () => {
		const onOpen = vi.fn();
		render(favorites(new Map(), GROUPS, onOpen));
		const items = screen.getByRole("listbox", { name: "Live TV" });
		expect(names(items)).toEqual(["NNews", "SSport"]);
		expect(items.style.height).toBe("32rem");
		expect(active(items).style.height).toBe("3.4rem");
		expect(document.activeElement).toBe(active(items));
		expect(active(items)).toHaveAttribute(TV_START_ATTRIBUTE);
		expect(active(kinds())).not.toHaveAttribute(TV_START_ATTRIBUTE);

		fireEvent.keyDown(active(items), { key: "ArrowDown" });
		fireEvent.keyDown(active(items), { key: "Enter" });
		expect(onOpen).toHaveBeenCalledExactlyOnceWith(sport, GROUPS[0].items);
	});

	it("shows the favorites of the kind the cursor reaches, from the first of them", () => {
		const memory = new Map<string, unknown>();
		render(favorites(memory));
		const live = screen.getByRole("listbox", { name: "Live TV" });
		fireEvent.keyDown(active(live), { key: "ArrowDown" });
		expect(memory.get("favorites")).toEqual({ kind: 0, item: 1, inKinds: false });

		fireEvent.keyDown(active(kinds()), { key: "ArrowDown" });
		expect(names(screen.getByRole("listbox", { name: "Series" }))).toEqual(["DDune"]);
		expect(memory.get("favorites")).toEqual({ kind: 1, item: 0, inKinds: true });
	});

	it("keeps a kind's row and a favorite's row when the one above them goes", () => {
		const memory = new Map<string, unknown>();
		const { rerender } = render(favorites(memory));
		const series = within(kinds()).getByRole("option", { name: "Series1" });
		const sportRow = screen.getByRole("option", { name: "S Sport" });
		rerender(favorites(memory, [{ name: "Live TV", items: [sport] }, GROUPS[2]]));
		expect(screen.getByRole("option", { name: "S Sport" })).toBe(sportRow);
		rerender(favorites(memory, [GROUPS[2]]));
		expect(within(kinds()).getByRole("option", { name: "Series1" })).toBe(series);
	});

	it("sends OK on a kind to the favorites to its right", () => {
		render(favorites(new Map()));
		fireEvent.keyDown(active(kinds()), { key: "Enter" });
		expect(moveFocus).toHaveBeenCalledExactlyOnceWith("right");
	});

	it("comes back to the kinds if that's where the focus was", () => {
		const memory = new Map<string, unknown>([
			["favorites", { kind: 1, item: 0, inKinds: true }],
		]);
		render(favorites(memory));
		expect(document.activeElement).toBe(active(kinds()));
		expect(active(kinds())).toHaveAttribute(TV_START_ATTRIBUTE);
		expect(active(screen.getByRole("listbox", { name: "Series" }))).not.toHaveAttribute(
			TV_START_ATTRIBUTE
		);
	});

	it("falls back to the last kind when the one it remembers has gone", () => {
		const memory = new Map<string, unknown>([
			["favorites", { kind: 5, item: 0, inKinds: false }],
		]);
		render(favorites(memory));
		expect(screen.getByRole("listbox", { name: "Series" })).toBeInTheDocument();
		expect(screen.queryByRole("listbox", { name: "Live TV" })).not.toBeInTheDocument();
	});
});
