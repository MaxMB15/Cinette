// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { moveFocus } from "@/lib/tv-focus";
import { makeChannel } from "@/test/channel-fixtures";
import { TV_START_ATTRIBUTE } from "@/lib/tv-focus";
import { TvGroupList, useTvGroups, type TvGroup } from "./TvGroups";

vi.mock("@/lib/tv-focus", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/tv-focus")>()),
	moveFocus: vi.fn(() => true),
}));

const news1 = makeChannel({ id: "n1", groupTitle: "News" });
const news2 = makeChannel({ id: "n2", groupTitle: "News" });
const sport = makeChannel({ id: "s1", groupTitle: "Sport" });
const plain = makeChannel({ id: "p1", groupTitle: "" });

describe("useTvGroups", () => {
	it("puts one group with everything first, then the groups, largest first", () => {
		const items = [sport, news1, news2];
		const { result } = renderHook(() => useTvGroups(items, "Everything"));
		expect(result.current.groups.map((g) => [g.name, g.channelCount])).toEqual([
			["Everything", 3],
			["News", 2],
			["Sport", 1],
		]);
	});

	it("calls a group with no name No group, and lists only its own channels", () => {
		const items = [news1, plain, news2];
		const { result } = renderHook(() => useTvGroups(items, "All"));
		const { groups, itemsOf } = result.current;
		expect(groups.map((g) => g.name)).toEqual(["All", "News", "No group"]);
		expect(itemsOf(groups[0])).toBe(items);
		expect(itemsOf(groups[2])).toEqual([plain]);
		expect(new Set(groups.map((g) => g.id)).size).toBe(3);
	});

	it("lists what's in each group, in the order they came", () => {
		const items = [news1, sport, news2];
		const { result } = renderHook(() => useTvGroups(items, "All"));
		const { groups, itemsOf } = result.current;
		expect(itemsOf(groups[0])).toBe(items);
		expect(itemsOf(groups[1])).toEqual([news1, news2]);
		expect(itemsOf(groups[2])).toEqual([sport]);
	});

	it("gives a group that isn't there no items", () => {
		const items = [news1];
		const { result } = renderHook(() => useTvGroups(items, "All"));
		expect(result.current.itemsOf({ id: "Gone", name: "Gone", channelCount: 1 })).toEqual([]);
	});

	it("gives the same answer until the items or the label change", () => {
		const items = [news1];
		const { result, rerender } = renderHook(({ list, label }) => useTvGroups(list, label), {
			initialProps: { list: items, label: "All" },
		});
		const first = result.current;
		rerender({ list: items, label: "All" });
		expect(result.current).toBe(first);
		rerender({ list: items, label: "Every one" });
		expect(result.current.groups[0].name).toBe("Every one");
		rerender({ list: [news1, sport], label: "Every one" });
		expect(result.current.groups).toHaveLength(3);
	});
});

const GROUPS: readonly TvGroup[] = [
	{ id: "", name: "All", channelCount: 12345 },
	{ id: "News", name: "News", channelCount: 2 },
];

describe("TvGroupList", () => {
	afterEach(() => {
		cleanup();
		vi.mocked(moveFocus).mockClear();
	});

	it("shows each group's name and how many it holds, under its name", () => {
		render(<TvGroupList groups={GROUPS} active={0} onActiveChange={() => {}} start={false} />);
		expect(screen.getByRole("listbox", { name: "Groups" })).toBeInTheDocument();
		const [all, news] = screen.getAllByRole("option");
		expect(all).toHaveTextContent("All");
		expect(all).toHaveTextContent((12345).toLocaleString());
		expect(news).toHaveTextContent("News2");
	});

	it("marks the row at the given place active and reports moves", () => {
		const onActiveChange = vi.fn();
		render(
			<TvGroupList groups={GROUPS} active={1} onActiveChange={onActiveChange} start={false} />
		);
		const active = screen.getByRole("option", { selected: true });
		expect(active).toHaveTextContent("News");
		fireEvent.keyDown(active, { key: "ArrowUp" });
		expect(onActiveChange).toHaveBeenCalledExactlyOnceWith(0);
	});

	it("sends OK on to what's in the group, to its right", () => {
		render(<TvGroupList groups={GROUPS} active={0} onActiveChange={() => {}} start={false} />);
		fireEvent.keyDown(screen.getByRole("option", { selected: true }), { key: "Enter" });
		expect(moveFocus).toHaveBeenCalledExactlyOnceWith("right");
	});

	it("keeps a group's row when the groups change order", () => {
		const { rerender } = render(
			<TvGroupList groups={GROUPS} active={0} onActiveChange={() => {}} start={false} />
		);
		const news = screen.getByRole("option", { name: "News2" });
		rerender(
			<TvGroupList
				groups={[...GROUPS].reverse()}
				active={0}
				onActiveChange={() => {}}
				start={false}
			/>
		);
		expect(screen.getByRole("option", { name: "News2" })).toBe(news);
	});

	it("sizes its rows and its height for the screen", () => {
		render(<TvGroupList groups={GROUPS} active={0} onActiveChange={() => {}} start={false} />);
		expect(screen.getByRole("listbox").style.height).toBe("32rem");
		expect(screen.getByRole("option", { selected: true }).style.height).toBe("2.75rem");
	});

	it("takes the focus only when it's the start", () => {
		const { rerender } = render(
			<TvGroupList groups={GROUPS} active={0} onActiveChange={() => {}} start={false} />
		);
		expect(screen.getByRole("option", { selected: true })).not.toHaveAttribute(
			TV_START_ATTRIBUTE
		);
		rerender(<TvGroupList groups={GROUPS} active={0} onActiveChange={() => {}} start />);
		expect(screen.getByRole("option", { selected: true })).toHaveAttribute(TV_START_ATTRIBUTE);
	});
});
