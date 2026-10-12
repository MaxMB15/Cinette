// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { Channel, DownloadRecord, WatchHistoryEntry } from "@/lib/types";

/** A live channel with no logo, guide id or extra sources. Override what a test needs. */
export const makeChannel = (overrides: Partial<Channel> = {}): Channel => ({
	id: "ch-1",
	name: "Test Channel",
	url: "http://stream.example.test/1",
	groupTitle: "General",
	isFavorite: false,
	contentType: "live",
	sources: [],
	...overrides,
});

/** A finished movie download that the user hasn't marked to keep. */
export const makeDownload = (overrides: Partial<DownloadRecord> = {}): DownloadRecord => ({
	id: "dl-1",
	channelId: "ch-1",
	title: "Test Download",
	kind: "movie",
	seriesChannelId: null,
	status: "completed",
	destPath: "/downloads/test.mkv",
	totalBytes: 1000,
	downloadedBytes: 1000,
	avgRateBps: null,
	error: null,
	createdAt: 0,
	finishedAt: 0,
	keep: false,
	lastPlayedAt: null,
	...overrides,
});

/** A live channel watched once. The backend sends null for seriesTitle outside series. */
export const makeHistoryEntry = (
	overrides: Partial<WatchHistoryEntry> = {}
): WatchHistoryEntry => ({
	channelId: "ch-1",
	channelName: "Test Channel",
	contentType: "live",
	firstWatchedAt: 0,
	lastWatchedAt: 0,
	totalDurationSeconds: 0,
	playCount: 1,
	seriesTitle: null,
	...overrides,
});
