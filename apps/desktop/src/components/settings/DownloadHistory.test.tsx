// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { DownloadHistory } from "./DownloadHistory";
import type { DownloadRecord } from "@/lib/types";

let downloads: DownloadRecord[] = [];
vi.mock("@/hooks/useDownloads", () => ({
	useDownloads: () => ({ downloads, retentionDays: null }),
}));

const now = Math.floor(Date.now() / 1000);

const recording = (overrides: Partial<DownloadRecord> = {}): DownloadRecord => ({
	id: "rec-1",
	channelId: "rec-1",
	title: "City News",
	kind: "recording",
	seriesChannelId: null,
	status: "completed",
	destPath: "/downloads/recordings/City News.ts",
	totalBytes: null,
	downloadedBytes: 1_250_000_000,
	avgRateBps: null,
	error: null,
	createdAt: now - 3 * 86_400,
	finishedAt: now - 3_600,
	keep: false,
	lastPlayedAt: null,
	sourceChannelId: "xt-1-xt-0",
	startAt: now - 7_200,
	endAt: now - 3_600,
	programTitle: null,
	...overrides,
});

describe("DownloadHistory", () => {
	afterEach(cleanup);

	it("shows when a recording started, not when it was set up, and its size", () => {
		downloads = [recording()];
		render(<DownloadHistory />);
		expect(screen.getByText(new Date((now - 7_200) * 1000).toLocaleString())).toBeDefined();
		expect(screen.getByText("1.3 GB")).toBeDefined();
	});

	it("gives a recording's status in plain words, with what ffmpeg said in a tooltip", () => {
		const error = "The stream stopped before the end.\nConnection reset by peer";
		downloads = [recording({ error })];
		render(<DownloadHistory />);
		const status = screen.getByText("Ended early. The stream stopped before the end.");
		expect(status.getAttribute("title")).toBe(error);
	});
});
