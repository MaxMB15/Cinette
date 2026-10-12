// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { RecordingsSection } from "./RecordingsSection";
import { removeDownload, stopRecording } from "@/lib/tauri";
import type { DownloadRecord } from "@/lib/types";
import { makeRecording } from "@/test/detail-fixtures";

vi.mock("@/hooks/useDownloads", () => ({
	useDownloads: () => ({ downloads: [], retentionDays: null }),
}));
vi.mock("@/lib/tauri", () => ({
	removeDownload: vi.fn(() => Promise.resolve()),
	stopRecording: vi.fn(() => Promise.resolve()),
	setDownloadKeep: vi.fn(() => Promise.resolve()),
}));

const MIN = 60;
const now = Math.floor(Date.now() / 1000);

const rec = (overrides: Partial<DownloadRecord> = {}) =>
	makeRecording({
		createdAt: now - 60 * MIN,
		startAt: now + 60 * MIN,
		endAt: now + 120 * MIN,
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
			downloadedBytes: 350_000_000,
		});
		render(<RecordingsSection recordings={[done, missed, rec(), running]} onPlay={vi.fn()} />);
		const statuses = rows().map((r) => r.textContent ?? "");
		expect(statuses[0]).toMatch(/Recording until .+, 350 MB/);
		expect(statuses[1]).toMatch(/Scheduled/);
		expect(statuses[2]).toMatch(/Missed/);
		expect(statuses[3]).toMatch(/Recorded/);
		expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
	});

	it("asks before it cancels a scheduled recording", async () => {
		render(<RecordingsSection recordings={[rec()]} onPlay={vi.fn()} />);
		fireEvent.click(screen.getByText("Cancel"));
		expect(stopRecording).not.toHaveBeenCalled();
		const dialog = within(screen.getByRole("dialog", { name: "Cancel this recording?" }));
		fireEvent.click(dialog.getByText("Cancel recording"));
		await waitFor(() => expect(stopRecording).toHaveBeenCalledWith("rec-1"));
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

	it("says why a recording ended early, with what ffmpeg said in a tooltip", () => {
		const error = "The stream stopped before the end.\nConnection reset by peer";
		render(<RecordingsSection recordings={[{ ...done, error }]} onPlay={vi.fn()} />);
		expect(screen.getByText("Ended early")).toBeDefined();
		const reason = screen.getByText("The stream stopped before the end.");
		expect(reason.getAttribute("title")).toBe(error);
	});

	it("says when it's trying a failed recording again", () => {
		const retrying = rec({ startAt: now + MIN, error: "The stream stopped before the end." });
		render(<RecordingsSection recordings={[retrying]} onPlay={vi.fn()} />);
		expect(screen.getByText("Trying again")).toBeDefined();
		expect(screen.getByText("The stream stopped before the end.")).toBeDefined();
	});

	it("removes a missed recording", () => {
		render(<RecordingsSection recordings={[rec({ status: "missed" })]} onPlay={vi.fn()} />);
		fireEvent.click(screen.getByText("Remove"));
		expect(removeDownload).toHaveBeenCalledWith("rec-1");
	});
});
