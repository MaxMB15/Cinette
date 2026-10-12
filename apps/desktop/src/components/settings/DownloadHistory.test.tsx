// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { makeDownload } from "@/test/channel-fixtures";
import { makeRecording } from "@/test/detail-fixtures";
import type { DownloadRecord } from "@/lib/types";

const state = vi.hoisted(() => ({ downloads: [] as DownloadRecord[] }));

vi.mock("@/hooks/useDownloads", () => ({
	useDownloads: () => ({ downloads: state.downloads, retentionDays: null }),
}));

import { DownloadHistory, DownloadHistoryDialog } from "./DownloadHistory";

/** Renders the table with one download and returns its size and status cells. */
const renderRow = (overrides: Partial<DownloadRecord>) => {
	state.downloads = [makeDownload(overrides)];
	render(<DownloadHistory />);
	const cells = within(screen.getAllByRole("row")[1]).getAllByRole("cell");
	return { size: cells[2], status: cells[6] };
};

const now = Math.floor(Date.now() / 1000);

/** A recording of a live channel that ended an hour ago. */
const recording = (overrides: Partial<DownloadRecord> = {}) =>
	makeRecording({
		status: "completed",
		destPath: "/downloads/recordings/City News.ts",
		downloadedBytes: 1_250_000_000,
		createdAt: now - 3 * 86_400,
		finishedAt: now - 3_600,
		startAt: now - 7_200,
		endAt: now - 3_600,
		...overrides,
	});

describe("DownloadHistoryDialog", () => {
	afterEach(() => {
		cleanup();
		state.downloads = [];
	});

	it("renders nothing while closed", () => {
		render(<DownloadHistoryDialog open={false} onClose={vi.fn()} />);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("is a dialog named by its title that takes focus", () => {
		render(<DownloadHistoryDialog open onClose={vi.fn()} />);
		const dialog = screen.getByRole("dialog", { name: "Download history" });
		expect(dialog.contains(document.activeElement)).toBe(true);
	});

	it("closes on Escape", () => {
		const onClose = vi.fn();
		render(<DownloadHistoryDialog open onClose={onClose} />);
		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

describe("DownloadHistory", () => {
	afterEach(() => {
		cleanup();
		state.downloads = [];
	});

	it("says so when there are no downloads", () => {
		render(<DownloadHistory />);
		expect(screen.getByText("No downloads yet.")).toBeInTheDocument();
	});

	it("shows the saved size out of the total while a download runs", () => {
		const { size, status } = renderRow({
			status: "downloading",
			downloadedBytes: 25_000_000,
			totalBytes: 100_000_000,
		});
		expect(size).toHaveTextContent(/^25 MB \/ 100 MB$/);
		expect(status).toHaveTextContent(/^25%$/);
	});

	it("stops the percent at 100 when the file grows past the size the server gave", () => {
		const { status } = renderRow({
			status: "downloading",
			downloadedBytes: 101_200_000,
			totalBytes: 100_000_000,
		});
		expect(status).toHaveTextContent(/^100%$/);
	});

	it("shows only the saved size and no percent while the size is unknown", () => {
		const { size, status } = renderRow({
			status: "downloading",
			downloadedBytes: 50_000_000,
			totalBytes: null,
		});
		expect(size).toHaveTextContent(/^50 MB$/);
		expect(status).toHaveTextContent(/^…$/);
	});

	it("shows only the file's size once a download finishes", () => {
		// An older version saved an HLS playlist's 460 bytes as the size.
		const { size, status } = renderRow({
			status: "completed",
			downloadedBytes: 105_000_000,
			totalBytes: 460,
		});
		expect(size).toHaveTextContent(/^105 MB$/);
		expect(status).toHaveTextContent(/^Done$/);
	});

	it("shows only the saved size once a download has failed", () => {
		const { size } = renderRow({
			status: "failed",
			downloadedBytes: 52_000_000,
			totalBytes: 460,
		});
		expect(size).toHaveTextContent(/^52 MB$/);
	});

	it("shows the total while a download waits its turn", () => {
		const { size } = renderRow({
			status: "queued",
			downloadedBytes: 0,
			totalBytes: 100_000_000,
		});
		expect(size).toHaveTextContent(/^0 MB \/ 100 MB$/);
	});

	it("shows when a recording started, not when it was set up, and its size", () => {
		state.downloads = [recording()];
		render(<DownloadHistory />);
		expect(screen.getByText(new Date((now - 7_200) * 1000).toLocaleString())).toBeDefined();
		expect(screen.getByText("1.3 GB")).toBeDefined();
	});

	it("gives a recording's status in plain words, with what ffmpeg said in a tooltip", () => {
		const error = "The stream stopped before the end.\nConnection reset by peer";
		state.downloads = [recording({ error })];
		render(<DownloadHistory />);
		const status = screen.getByText("Ended early. The stream stopped before the end.");
		expect(status.getAttribute("title")).toBe(error);
	});
});
