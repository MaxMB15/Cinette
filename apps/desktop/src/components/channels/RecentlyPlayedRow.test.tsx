// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WatchHistoryEntry } from "@/lib/types";
import { getWatchHistory, deleteHistoryEntry } from "@/lib/tauri";
import { RecentlyPlayedRow } from "./RecentlyPlayedRow";

vi.mock("@/lib/tauri", () => ({
	getWatchHistory: vi.fn(),
	deleteHistoryEntry: vi.fn(),
}));

const entry = (
	channelId: string,
	channelName: string,
	contentType: WatchHistoryEntry["contentType"] = "live"
): WatchHistoryEntry => ({
	channelId,
	channelName,
	contentType,
	firstWatchedAt: 0,
	lastWatchedAt: 0,
	totalDurationSeconds: 0,
	playCount: 1,
});

describe("RecentlyPlayedRow", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		cleanup();
		vi.mocked(getWatchHistory).mockReset();
		vi.mocked(deleteHistoryEntry).mockReset();
		vi.restoreAllMocks();
	});

	it("renders nothing when the history cannot be loaded", async () => {
		vi.mocked(getWatchHistory).mockRejectedValue(new Error("db locked"));
		const { container } = render(<RecentlyPlayedRow contentType="live" onPlay={() => {}} />);

		await waitFor(() => expect(console.error).toHaveBeenCalled());
		expect(container).toBeEmptyDOMElement();
	});

	it("logs a failed dismiss and keeps the entry", async () => {
		vi.mocked(getWatchHistory).mockResolvedValue([entry("a", "Alpha")]);
		vi.mocked(deleteHistoryEntry).mockRejectedValue(new Error("db locked"));
		render(<RecentlyPlayedRow contentType="live" onPlay={() => {}} />);

		fireEvent.click(await screen.findByRole("button", { name: "Dismiss Alpha" }));

		await waitFor(() => expect(console.error).toHaveBeenCalled());
		expect(screen.getByText("Alpha")).toBeInTheDocument();
	});

	it("clear all keeps only the entries whose delete failed", async () => {
		vi.mocked(getWatchHistory).mockResolvedValue([entry("a", "Alpha"), entry("b", "Beta")]);
		vi.mocked(deleteHistoryEntry).mockImplementation((id: string) =>
			id === "b" ? Promise.reject(new Error("db locked")) : Promise.resolve()
		);
		render(<RecentlyPlayedRow contentType="live" onPlay={() => {}} />);

		fireEvent.click(await screen.findByText("Clear all"));

		await waitFor(() => expect(screen.queryByText("Alpha")).not.toBeInTheDocument());
		expect(screen.getByText("Beta")).toBeInTheDocument();
	});

	it("dismisses every episode a series card stands for", async () => {
		vi.mocked(getWatchHistory).mockResolvedValue([
			entry("e2", "Harbour Lights S01E02", "series"),
			entry("e1", "Harbour Lights S01E01", "series"),
		]);
		vi.mocked(deleteHistoryEntry).mockResolvedValue(undefined);
		render(<RecentlyPlayedRow contentType="series" onPlay={() => {}} />);

		fireEvent.click(await screen.findByRole("button", { name: "Dismiss Harbour Lights" }));

		await waitFor(() => expect(screen.queryByText("Harbour Lights")).not.toBeInTheDocument());
		expect(vi.mocked(deleteHistoryEntry).mock.calls.map(([id]) => id)).toEqual(["e2", "e1"]);
	});
});
