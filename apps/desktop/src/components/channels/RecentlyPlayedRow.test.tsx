// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WatchHistoryEntry } from "@/lib/types";
import {
	clearWatchHistoryOfType,
	deleteHistoryEntry,
	deleteHistorySeries,
	getWatchHistory,
} from "@/lib/tauri";
import { RecentlyPlayedRow } from "./RecentlyPlayedRow";

vi.mock("@/lib/tauri", () => ({
	getWatchHistory: vi.fn(),
	deleteHistoryEntry: vi.fn(),
	deleteHistorySeries: vi.fn(),
	clearWatchHistoryOfType: vi.fn(),
}));

const entry = (
	channelId: string,
	channelName: string,
	contentType: WatchHistoryEntry["contentType"] = "live",
	// The backend sends null for entries that aren't series.
	seriesTitle: string | null = null
): WatchHistoryEntry => ({
	channelId,
	channelName,
	contentType,
	firstWatchedAt: 0,
	lastWatchedAt: 0,
	totalDurationSeconds: 0,
	playCount: 1,
	seriesTitle,
});

describe("RecentlyPlayedRow", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		cleanup();
		vi.mocked(getWatchHistory).mockReset();
		vi.mocked(deleteHistoryEntry).mockReset();
		vi.mocked(deleteHistorySeries).mockReset();
		vi.mocked(clearWatchHistoryOfType).mockReset();
		vi.restoreAllMocks();
	});

	it("renders nothing when the history cannot be loaded", async () => {
		vi.mocked(getWatchHistory).mockRejectedValue(new Error("db locked"));
		const { container } = render(<RecentlyPlayedRow contentType="live" onPlay={() => {}} />);

		await waitFor(() => expect(console.error).toHaveBeenCalled());
		expect(container).toBeEmptyDOMElement();
	});

	it("asks only for its own content type, so other types can't crowd it out", async () => {
		vi.mocked(getWatchHistory).mockResolvedValue([entry("m", "Moonfall", "movie")]);
		render(<RecentlyPlayedRow contentType="movie" onPlay={() => {}} />);

		expect(await screen.findByText("Moonfall")).toBeInTheDocument();
		expect(getWatchHistory).toHaveBeenCalledWith(50, "movie");
	});

	it("logs a failed dismiss and keeps the entry", async () => {
		vi.mocked(getWatchHistory).mockResolvedValue([entry("a", "Alpha")]);
		vi.mocked(deleteHistoryEntry).mockRejectedValue(new Error("db locked"));
		render(<RecentlyPlayedRow contentType="live" onPlay={() => {}} />);

		fireEvent.click(await screen.findByRole("button", { name: "Dismiss Alpha" }));

		await waitFor(() => expect(console.error).toHaveBeenCalled());
		expect(screen.getByText("Alpha")).toBeInTheDocument();
	});

	it("clear all clears the whole type in the backend", async () => {
		vi.mocked(getWatchHistory).mockResolvedValue([entry("a", "Alpha"), entry("b", "Beta")]);
		vi.mocked(clearWatchHistoryOfType).mockResolvedValue(undefined);
		const { container } = render(<RecentlyPlayedRow contentType="live" onPlay={() => {}} />);

		fireEvent.click(await screen.findByText("Clear all"));

		await waitFor(() => expect(container).toBeEmptyDOMElement());
		expect(clearWatchHistoryOfType).toHaveBeenCalledWith("live");
		expect(deleteHistoryEntry).not.toHaveBeenCalled();
	});

	it("keeps the row when clear all fails", async () => {
		vi.mocked(getWatchHistory).mockResolvedValue([entry("a", "Alpha")]);
		vi.mocked(clearWatchHistoryOfType).mockRejectedValue(new Error("db locked"));
		render(<RecentlyPlayedRow contentType="live" onPlay={() => {}} />);

		fireEvent.click(await screen.findByText("Clear all"));

		await waitFor(() => expect(console.error).toHaveBeenCalled());
		expect(screen.getByText("Alpha")).toBeInTheDocument();
	});

	it("shows one card per show, named by the show title from the history", async () => {
		vi.mocked(getWatchHistory).mockResolvedValue([
			entry("e2", "HL 1x02", "series", "Harbour Lights"),
			entry("e1", "Harbour Lights S01E01", "series", "Harbour Lights"),
			entry("d1", "Dune Road S02E04", "series", "Dune Road"),
		]);
		const onPlay = vi.fn();
		render(<RecentlyPlayedRow contentType="series" onPlay={onPlay} />);

		fireEvent.click(await screen.findByText("Harbour Lights"));

		expect(screen.getAllByRole("button", { name: /^Dismiss/ })).toHaveLength(2);
		expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ channelId: "e2" }));
	});

	it("dismisses a series card by show, so older episodes go too", async () => {
		vi.mocked(getWatchHistory).mockResolvedValue([
			entry("e2", "Harbour Lights S01E02", "series", "Harbour Lights"),
			entry("e1", "Harbour Lights S01E01", "series", "Harbour Lights"),
			entry("d1", "Dune Road S02E04", "series", "Dune Road"),
		]);
		vi.mocked(deleteHistorySeries).mockResolvedValue(undefined);
		render(<RecentlyPlayedRow contentType="series" onPlay={() => {}} />);

		fireEvent.click(await screen.findByRole("button", { name: "Dismiss Harbour Lights" }));

		await waitFor(() => expect(screen.queryByText("Harbour Lights")).not.toBeInTheDocument());
		expect(deleteHistorySeries).toHaveBeenCalledExactlyOnceWith("Harbour Lights");
		expect(deleteHistoryEntry).not.toHaveBeenCalled();
		expect(screen.getByText("Dune Road")).toBeInTheDocument();
	});
});
