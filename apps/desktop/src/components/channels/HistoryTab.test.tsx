// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WatchHistoryEntry } from "@/lib/types";
import { deleteHistoryEntry, getWatchHistory } from "@/lib/tauri";
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
