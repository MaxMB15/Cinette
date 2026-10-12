// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask } from "@tauri-apps/plugin-dialog";
import type { WatchHistoryEntry } from "@/lib/types";
import { clearWatchHistory, deleteHistoryEntry, getWatchHistory } from "@/lib/tauri";
import { makeHistoryEntry } from "@/test/channel-fixtures";
import { HistoryTab } from "./HistoryTab";

vi.mock("@/lib/tauri", () => ({
	getWatchHistory: vi.fn(),
	deleteHistoryEntry: vi.fn(),
	clearWatchHistory: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
	ask: vi.fn(),
}));

const entry: WatchHistoryEntry = {
	channelId: "ch1",
	channelName: "News 24",
	contentType: "live",
	firstWatchedAt: 0,
	lastWatchedAt: 0,
	totalDurationSeconds: 300,
	playCount: 2,
};

describe("HistoryTab rows", () => {
	afterEach(() => {
		cleanup();
		vi.mocked(getWatchHistory).mockReset();
		vi.mocked(deleteHistoryEntry).mockReset();
	});

	it("plays an entry from a real, focusable button", async () => {
		vi.mocked(getWatchHistory).mockResolvedValue([entry]);
		const onPlay = vi.fn();
		render(<HistoryTab onPlay={onPlay} />);

		const play = await screen.findByRole("button", { name: /^News 24/ });
		expect(play.tagName).toBe("BUTTON");
		play.focus();
		expect(play).toHaveFocus();

		fireEvent.click(play);
		expect(onPlay).toHaveBeenCalledWith(entry);
	});

	it("keeps the delete button out of the play button", async () => {
		vi.mocked(getWatchHistory).mockResolvedValue([entry]);
		vi.mocked(deleteHistoryEntry).mockResolvedValue(undefined);
		const onPlay = vi.fn();
		render(<HistoryTab onPlay={onPlay} />);

		const play = await screen.findByRole("button", { name: /^News 24/ });
		const remove = screen.getByRole("button", { name: "Remove News 24 from history" });
		expect(play.contains(remove)).toBe(false);

		fireEvent.click(remove);
		await waitFor(() => expect(deleteHistoryEntry).toHaveBeenCalledWith("ch1"));
		expect(onPlay).not.toHaveBeenCalled();
	});
});

describe("HistoryTab list", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		cleanup();
		vi.mocked(getWatchHistory).mockReset();
		vi.mocked(deleteHistoryEntry).mockReset();
		vi.mocked(clearWatchHistory).mockReset();
		vi.mocked(ask).mockReset();
		vi.restoreAllMocks();
	});

	const movie = makeHistoryEntry({
		channelId: "m1",
		channelName: "Dune",
		contentType: "movie",
		playCount: 1,
		totalDurationSeconds: 7500,
	});
	const show = makeHistoryEntry({
		channelId: "e1",
		channelName: "Harbor Lights S01E01",
		contentType: "series",
		seriesTitle: "Harbor Lights",
		playCount: 3,
		totalDurationSeconds: 45,
	});

	it("asks for up to 200 entries and shows a spinner until they arrive", async () => {
		let resolve: (entries: WatchHistoryEntry[]) => void = () => {};
		vi.mocked(getWatchHistory).mockReturnValue(new Promise((r) => (resolve = r)));
		const { container } = render(<HistoryTab onPlay={vi.fn()} />);

		expect(getWatchHistory).toHaveBeenCalledWith(200);
		expect(container.querySelector(".animate-spin")).not.toBeNull();

		resolve([entry]);
		expect(await screen.findByText("News 24")).toBeInTheDocument();
		expect(container.querySelector(".animate-spin")).toBeNull();
	});

	it("says there is no history yet when nothing was watched", async () => {
		vi.mocked(getWatchHistory).mockResolvedValue([]);
		render(<HistoryTab onPlay={vi.fn()} />);
		expect(await screen.findByText(/No watch history yet/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Clear All/ })).toBeNull();
	});

	it("logs a failed load and shows the empty history", async () => {
		vi.mocked(getWatchHistory).mockRejectedValue(new Error("db locked"));
		render(<HistoryTab onPlay={vi.fn()} />);
		expect(await screen.findByText(/No watch history yet/)).toBeInTheDocument();
		expect(console.error).toHaveBeenCalled();
	});

	it("labels each entry with its type, plays and total time", async () => {
		vi.mocked(getWatchHistory).mockResolvedValue([entry, movie, show]);
		render(<HistoryTab onPlay={vi.fn()} />);

		const row = (name: RegExp) => screen.getByRole("button", { name });
		expect(await screen.findByRole("button", { name: /^News 24/ })).toHaveTextContent("LIVE");
		expect(row(/^News 24/)).toHaveTextContent("2 plays · 5m total");
		expect(row(/^Dune/)).toHaveTextContent("MOVIE");
		expect(row(/^Dune/)).toHaveTextContent("1 play · 2h 5m total");
		expect(row(/^Harbor Lights/)).toHaveTextContent("SERIES");
		expect(row(/^Harbor Lights/)).toHaveTextContent("3 plays · 45s total");
	});

	it("shows the first letter of the name when an entry has no logo", async () => {
		vi.mocked(getWatchHistory).mockResolvedValue([movie]);
		render(<HistoryTab onPlay={vi.fn()} />);
		const row = await screen.findByRole("button", { name: /^Dune/ });
		expect(row.querySelector("[aria-hidden='true']")).toHaveTextContent(/^D$/);
	});

	it("reloads the history after removing an entry", async () => {
		vi.mocked(getWatchHistory).mockResolvedValueOnce([entry, movie]).mockResolvedValue([movie]);
		vi.mocked(deleteHistoryEntry).mockResolvedValue(undefined);
		render(<HistoryTab onPlay={vi.fn()} />);

		fireEvent.click(await screen.findByRole("button", { name: "Remove News 24 from history" }));

		await waitFor(() => expect(screen.queryByText("News 24")).toBeNull());
		expect(screen.getByText("Dune")).toBeInTheDocument();
		expect(getWatchHistory).toHaveBeenCalledTimes(2);
	});

	it("logs a failed removal and keeps the entry", async () => {
		vi.mocked(getWatchHistory).mockResolvedValue([entry]);
		vi.mocked(deleteHistoryEntry).mockRejectedValue(new Error("db locked"));
		render(<HistoryTab onPlay={vi.fn()} />);

		fireEvent.click(await screen.findByRole("button", { name: "Remove News 24 from history" }));

		await waitFor(() => expect(console.error).toHaveBeenCalled());
		expect(screen.getByText("News 24")).toBeInTheDocument();
		expect(getWatchHistory).toHaveBeenCalledTimes(1);
	});

	it("clears the whole history once the user confirms", async () => {
		vi.mocked(getWatchHistory).mockResolvedValue([entry, movie]);
		vi.mocked(ask).mockResolvedValue(true);
		vi.mocked(clearWatchHistory).mockResolvedValue(undefined);
		render(<HistoryTab onPlay={vi.fn()} />);

		fireEvent.click(await screen.findByRole("button", { name: /Clear All/ }));

		expect(await screen.findByText(/No watch history yet/)).toBeInTheDocument();
		expect(ask).toHaveBeenCalledWith("Clear all watch history?", {
			title: "Clear History",
			kind: "warning",
		});
		expect(clearWatchHistory).toHaveBeenCalledOnce();
	});

	it("keeps the history when the user cancels clearing it", async () => {
		vi.mocked(getWatchHistory).mockResolvedValue([entry]);
		vi.mocked(ask).mockResolvedValue(false);
		render(<HistoryTab onPlay={vi.fn()} />);

		fireEvent.click(await screen.findByRole("button", { name: /Clear All/ }));

		await waitFor(() => expect(ask).toHaveBeenCalled());
		expect(clearWatchHistory).not.toHaveBeenCalled();
		expect(screen.getByText("News 24")).toBeInTheDocument();
	});

	it("logs a failed clear and keeps the history", async () => {
		vi.mocked(getWatchHistory).mockResolvedValue([entry]);
		vi.mocked(ask).mockResolvedValue(true);
		vi.mocked(clearWatchHistory).mockRejectedValue(new Error("db locked"));
		render(<HistoryTab onPlay={vi.fn()} />);

		fireEvent.click(await screen.findByRole("button", { name: /Clear All/ }));

		await waitFor(() => expect(console.error).toHaveBeenCalled());
		expect(screen.getByText("News 24")).toBeInTheDocument();
	});
});
