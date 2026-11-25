// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { deleteHistoryEntry, getWatchHistory } from "@/lib/tauri";
import type { WatchHistoryEntry } from "@/lib/types";
import { formatRelativeDate } from "@/lib/watch-history";
import { makeHistoryEntry } from "@/test/channel-fixtures";
import { wrapperFor } from "@/test/query";
import { TV_START_ATTRIBUTE } from "@/lib/tv-focus";
import { TvHistory } from "./TvHistory";
import { TvNavContext } from "./tv-nav";

vi.mock("@/hooks/useNow", () => ({ useNow: () => 1_800_000_000 }));
vi.mock("@/lib/tauri", () => ({
	getWatchHistory: vi.fn(),
	deleteHistoryEntry: vi.fn(),
}));

const news = makeHistoryEntry({
	channelId: "n",
	channelName: "News",
	channelLogo: "http://logo.example.test/n.png",
	lastWatchedAt: 1_700_000_000,
});
const sport = makeHistoryEntry({
	channelId: "s",
	channelName: "Sport",
	lastWatchedAt: 1_600_000_000,
});

const renderHistory = (
	onOpen: (entry: WatchHistoryEntry) => void = () => {},
	memory = new Map<string, unknown>(),
	state: { opening?: boolean; missingId?: string | null } = {}
) =>
	render(
		<TvNavContext.Provider value={{ section: "history", openSection: () => {}, memory }}>
			<TvHistory onOpen={onOpen} {...state} />
		</TvNavContext.Provider>,
		{ wrapper: wrapperFor() }
	);

const list = () => screen.findByRole("listbox", { name: "History" });
const remove = () => screen.getByRole("button", { name: "Remove" });
const active = () => screen.getByRole("option", { selected: true });

describe("TvHistory", () => {
	beforeEach(() => {
		vi.mocked(getWatchHistory).mockResolvedValue([news, sport]);
		vi.mocked(deleteHistoryEntry).mockResolvedValue(undefined);
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		vi.mocked(getWatchHistory).mockReset();
		vi.mocked(deleteHistoryEntry).mockReset();
	});

	it("says nothing beside an entry that has opened", async () => {
		renderHistory();
		await list();
		expect(screen.getByRole("status")).toBeEmptyDOMElement();
	});

	it("says when the episodes are loading", async () => {
		renderHistory(undefined, undefined, { opening: true, missingId: "n" });
		await list();
		expect(screen.getByRole("status")).toHaveTextContent(/^Loading episodes$/);
	});

	it("says an entry couldn't open, only while the cursor is on it", async () => {
		renderHistory(undefined, undefined, { missingId: "n" });
		fireEvent.keyDown(await list(), { key: "ArrowDown" });
		expect(active()).toHaveTextContent("Sport");
		expect(screen.getByRole("status")).toBeEmptyDOMElement();

		fireEvent.keyDown(await list(), { key: "ArrowUp" });
		expect(active()).toHaveTextContent("News");
		expect(screen.getByRole("status")).toHaveTextContent(
			"Couldn't open this. It may have left your provider."
		);
	});

	it("loads the newest 200 entries of every kind", async () => {
		renderHistory();
		await list();
		expect(getWatchHistory).toHaveBeenCalledExactlyOnceWith(200, undefined);
	});

	it("shows nothing but the heading while the entries load", () => {
		vi.mocked(getWatchHistory).mockReturnValue(new Promise(() => {}));
		renderHistory();
		expect(screen.getByRole("heading", { name: "History" })).toBeInTheDocument();
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		expect(screen.queryByText("What you watch shows up here")).not.toBeInTheDocument();
	});

	it("says what will show up here when nothing was watched", async () => {
		vi.mocked(getWatchHistory).mockResolvedValue([]);
		renderHistory();
		expect(await screen.findByText("What you watch shows up here")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
	});

	it("logs entries that can't load", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const failure = new Error("no database");
		vi.mocked(getWatchHistory).mockRejectedValue(failure);
		renderHistory();
		await waitFor(() =>
			expect(error).toHaveBeenCalledWith("[TvHistory] failed to fetch history:", failure)
		);
	});

	it("shows each entry with its name, logo and when it was watched", async () => {
		renderHistory();
		const rows = within(await list()).getAllByRole("option");
		expect(rows.map((row) => row.textContent)).toEqual([
			`News${formatRelativeDate(news.lastWatchedAt)}`,
			`SSport${formatRelativeDate(sport.lastWatchedAt)}`,
		]);
		expect(rows[0].querySelector("img")).toHaveAttribute("src", news.channelLogo);
		expect(rows[0].style.height).toBe("3.4rem");
		expect(screen.queryByLabelText("Favorite")).not.toBeInTheDocument();
		expect((await list()).style.height).toBe("32rem");
	});

	it("starts on the newest entry, and OK picks up the one under the cursor", async () => {
		const onOpen = vi.fn();
		renderHistory(onOpen);
		await list();
		expect(document.activeElement).toBe(active());
		expect(active()).toHaveAttribute(TV_START_ATTRIBUTE);

		fireEvent.keyDown(active(), { key: "ArrowDown" });
		fireEvent.keyDown(active(), { key: "Enter" });
		expect(onOpen).toHaveBeenCalledExactlyOnceWith(sport, 1);
	});

	it("remembers its place for when the screen opens again", async () => {
		const memory = new Map<string, unknown>();
		renderHistory(() => {}, memory);
		await list();
		fireEvent.keyDown(active(), { key: "ArrowDown" });
		expect(memory.get("history")).toBe(1);
	});

	it("removes the entry under the cursor from the list and the backend", async () => {
		renderHistory();
		await list();
		fireEvent.keyDown(active(), { key: "ArrowDown" });
		fireEvent.click(remove());
		expect(deleteHistoryEntry).toHaveBeenCalledExactlyOnceWith("s");
		await waitFor(() =>
			expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual([
				`News${formatRelativeDate(news.lastWatchedAt)}`,
			])
		);
	});

	it("keeps the next entry's row when the one above it goes", async () => {
		renderHistory();
		await list();
		const next = screen.getByRole("option", { name: /Sport/ });
		fireEvent.click(remove());
		await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
		expect(screen.getByRole("option", { name: /Sport/ })).toBe(next);
	});

	it("keeps the Remove button on the last entry after the one under the cursor goes", async () => {
		renderHistory();
		await list();
		fireEvent.keyDown(active(), { key: "ArrowDown" });
		fireEvent.click(remove());
		await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
		fireEvent.click(remove());
		expect(deleteHistoryEntry).toHaveBeenLastCalledWith("n");
		expect(await screen.findByText("What you watch shows up here")).toBeInTheDocument();
	});

	it("keeps an entry the backend wouldn't delete, and logs why", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const failure = new Error("locked");
		vi.mocked(deleteHistoryEntry).mockRejectedValue(failure);
		renderHistory();
		await list();
		fireEvent.click(remove());
		await waitFor(() =>
			expect(error).toHaveBeenCalledWith("[TvHistory] failed to delete entry:", failure)
		);
		expect(screen.getAllByRole("option")).toHaveLength(2);
	});
});
