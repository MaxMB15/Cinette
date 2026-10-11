// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { RetentionNote } from "./RetentionNote";
import { setDownloadKeep } from "@/lib/tauri";
import type { DownloadRecord } from "@/lib/types";

let retentionDays: number | null = 7;
vi.mock("@/hooks/useDownloads", () => ({ useDownloads: () => ({ retentionDays }) }));
vi.mock("@/lib/tauri", () => ({ setDownloadKeep: vi.fn(() => Promise.resolve()) }));

const DAY = 24 * 60 * 60;
const now = Math.floor(Date.now() / 1000);

const rec = (overrides: Partial<DownloadRecord> = {}): DownloadRecord => ({
	id: "d1",
	channelId: "c1",
	title: "A Movie",
	kind: "movie",
	seriesChannelId: null,
	status: "completed",
	destPath: "/downloads/a.mkv",
	totalBytes: null,
	downloadedBytes: 0,
	avgRateBps: null,
	error: null,
	createdAt: 0,
	finishedAt: now - 2 * DAY,
	keep: false,
	lastPlayedAt: null,
	...overrides,
});

describe("RetentionNote", () => {
	beforeEach(() => {
		retentionDays = 7;
		vi.mocked(setDownloadKeep).mockClear();
	});
	afterEach(cleanup);

	it("renders nothing while the setting is off", () => {
		retentionDays = null;
		const { container } = render(<RetentionNote records={[rec()]} />);
		expect(container.innerHTML).toBe("");
	});

	it("says when the download is deleted and keeps it on request", () => {
		render(<RetentionNote records={[rec()]} />);
		expect(screen.getByText("Deletes in 5 days")).toBeDefined();
		fireEvent.click(screen.getByText("Keep"));
		expect(setDownloadKeep).toHaveBeenCalledWith("d1", true);
	});

	it("keeps only the finished downloads of a series that aren't kept yet", () => {
		const records = [
			rec({ id: "a" }),
			rec({ id: "b", keep: true }),
			rec({ id: "c", status: "downloading" }),
		];
		render(<RetentionNote records={records} />);
		fireEvent.click(screen.getByText("Keep"));
		expect(setDownloadKeep).toHaveBeenCalledTimes(1);
		expect(setDownloadKeep).toHaveBeenCalledWith("a", true);
	});

	it("lets a kept download be deleted again", () => {
		render(<RetentionNote records={[rec({ keep: true })]} />);
		expect(screen.getByText("Kept")).toBeDefined();
		fireEvent.click(screen.getByText("Don't keep"));
		expect(setDownloadKeep).toHaveBeenCalledWith("d1", false);
	});

	it("shows the day count with the full text as a tooltip when compact", () => {
		render(<RetentionNote records={[rec()]} compact />);
		const button = screen.getByRole("button");
		expect(button.textContent).toBe("5d");
		expect(button.getAttribute("title")).toBe("Deletes in 5 days. Click to keep.");
	});
});
