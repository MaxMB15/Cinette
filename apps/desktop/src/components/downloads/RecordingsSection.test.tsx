// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { RecordingsSection } from "./RecordingsSection";
import { removeDownload, stopRecording } from "@/lib/tauri";
import type { DownloadRecord } from "@/lib/types";

vi.mock("@/hooks/useDownloads", () => ({ useDownloads: () => ({ retentionDays: null }) }));
vi.mock("@/lib/tauri", () => ({
	removeDownload: vi.fn(() => Promise.resolve()),
	stopRecording: vi.fn(() => Promise.resolve()),
	setDownloadKeep: vi.fn(() => Promise.resolve()),
}));

const MIN = 60;
const now = Math.floor(Date.now() / 1000);

const rec = (overrides: Partial<DownloadRecord> = {}): DownloadRecord => ({
	id: "rec-1",
	channelId: "rec-1",
	title: "City News",
	kind: "recording",
	seriesChannelId: null,
	status: "scheduled",
	destPath: "",
	totalBytes: null,
	downloadedBytes: 0,
	avgRateBps: null,
	error: null,
	createdAt: now - 60 * MIN,
	finishedAt: null,
	keep: false,
	lastPlayedAt: null,
	sourceChannelId: "xt-1-xt-0",
	startAt: now + 60 * MIN,
	endAt: now + 120 * MIN,
	programTitle: null,
	...overrides,
});

const done = rec({
	id: "rec-done",
	channelId: "rec-done",
	status: "completed",
	destPath: "/downloads/recordings/City News 2026-10-11 20.00.ts",
	downloadedBytes: 1_500_000_000,
	startAt: now - 24 * 60 * MIN,
	endAt: now - 23 * 60 * MIN,
	finishedAt: now - 23 * 60 * MIN,
	programTitle: "Evening News",
});

const rows = () => screen.getAllByRole("listitem");

describe("RecordingsSection", () => {
	beforeEach(() => {
		vi.mocked(removeDownload).mockClear();
		vi.mocked(stopRecording).mockClear();
	});
	afterEach(cleanup);

	it("lists the running recording first, then the waiting ones, then the rest", () => {
		const missed = rec({ id: "m", status: "missed", startAt: now - 5 * 60 * MIN });
		const running = rec({
			id: "r",
			status: "recording",
			startAt: now - 30 * MIN,
			endAt: now + 30 * MIN,
		});
		render(<RecordingsSection recordings={[done, missed, rec(), running]} onPlay={vi.fn()} />);
		const statuses = rows().map((r) => r.textContent ?? "");
		expect(statuses[0]).toMatch(/Recording until/);
		expect(statuses[1]).toMatch(/Scheduled/);
		expect(statuses[2]).toMatch(/Missed/);
		expect(statuses[3]).toMatch(/Recorded/);
		expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
	});

	it("cancels a scheduled recording", () => {
		render(<RecordingsSection recordings={[rec()]} onPlay={vi.fn()} />);
		fireEvent.click(screen.getByText("Cancel"));
		expect(stopRecording).toHaveBeenCalledWith("rec-1");
	});

	it("asks before it stops a running recording", async () => {
		const running = rec({ status: "recording", startAt: now - MIN });
		render(<RecordingsSection recordings={[running]} onPlay={vi.fn()} />);
		fireEvent.click(within(rows()[0]).getByText("Stop"));
		expect(stopRecording).not.toHaveBeenCalled();
		fireEvent.click(within(screen.getByRole("dialog")).getByText("Stop"));
		await waitFor(() => expect(stopRecording).toHaveBeenCalledWith("rec-1"));
	});

	it("plays a finished recording from its file and deletes it after asking", async () => {
		const onPlay = vi.fn();
		render(<RecordingsSection recordings={[done]} onPlay={onPlay} />);
		expect(rows()[0].textContent).toMatch(/Evening News on City News/);
		expect(rows()[0].textContent).toMatch(/1\.5 GB/);

		fireEvent.click(screen.getByLabelText("Play Evening News"));
		expect(onPlay).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "rec-done",
				name: "City News 2026-10-11 20.00",
				url: "/downloads/recordings/City News 2026-10-11 20.00.ts",
			})
		);

		fireEvent.click(screen.getByLabelText("Delete Evening News"));
		fireEvent.click(within(screen.getByRole("dialog")).getByText("Delete"));
		await waitFor(() => expect(removeDownload).toHaveBeenCalledWith("rec-done"));
	});

	it("says why a recording ended early", () => {
		const early = { ...done, error: "The stream stopped before the end." };
		render(<RecordingsSection recordings={[early]} onPlay={vi.fn()} />);
		expect(screen.getByText("Ended early")).toBeDefined();
		expect(screen.getByText("The stream stopped before the end.")).toBeDefined();
	});

	it("removes a missed recording", () => {
		render(<RecordingsSection recordings={[rec({ status: "missed" })]} onPlay={vi.fn()} />);
		fireEvent.click(screen.getByText("Remove"));
		expect(removeDownload).toHaveBeenCalledWith("rec-1");
	});
});
