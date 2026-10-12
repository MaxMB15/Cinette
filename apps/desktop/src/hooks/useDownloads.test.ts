// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import { aggregateForSeries, groupDownloads, supersedes } from "./useDownloads";
import type { DownloadRecord } from "@/lib/types";

const rec = (over: Partial<DownloadRecord>): DownloadRecord => ({
	id: "x",
	channelId: "x",
	title: "t",
	kind: "episode",
	seriesChannelId: "S1",
	status: "completed",
	destPath: "/p",
	totalBytes: null,
	downloadedBytes: 0,
	avgRateBps: null,
	error: null,
	createdAt: 0,
	finishedAt: null,
	keep: false,
	lastPlayedAt: null,
	...over,
});

describe("aggregateForSeries", () => {
	it("returns none when no episodes downloaded", () => {
		expect(aggregateForSeries([], 24)).toBe("none");
	});
	it("returns downloading when any in progress", () => {
		const recs = [rec({ status: "downloading" }), rec({ status: "completed" })];
		expect(aggregateForSeries(recs, 24)).toBe("downloading");
	});
	it("returns partial when some but not all complete", () => {
		const recs = [rec({ status: "completed" }), rec({ status: "completed" })];
		expect(aggregateForSeries(recs, 24)).toBe("partial");
	});
	it("returns complete when all episodes downloaded", () => {
		const recs = Array.from({ length: 24 }, () => rec({ status: "completed" }));
		expect(aggregateForSeries(recs, 24)).toBe("complete");
	});
});

describe("supersedes", () => {
	it("a completed record always wins", () => {
		const completed = rec({ id: "a", status: "completed", createdAt: 1 });
		const failed = rec({ id: "b", status: "failed", createdAt: 100 });
		expect(supersedes(completed, failed)).toBe(true);
	});
	it("does not replace a completed record with a newer non-completed one", () => {
		const completed = rec({ id: "a", status: "completed", createdAt: 1 });
		const downloading = rec({ id: "b", status: "downloading", createdAt: 100 });
		expect(supersedes(downloading, completed)).toBe(false);
	});
	it("a newer attempt supersedes an older non-completed one", () => {
		const oldFailed = rec({ id: "a", status: "failed", createdAt: 10 });
		const retry = rec({ id: "b", status: "queued", createdAt: 20 });
		expect(supersedes(retry, oldFailed)).toBe(true);
	});
});

describe("groupDownloads", () => {
	it("keeps one record per channel, preferring completed over a stale failure", () => {
		const failed = rec({ id: "f", channelId: "c1", status: "failed", createdAt: 10 });
		const done = rec({ id: "d", channelId: "c1", status: "completed", createdAt: 20 });
		const { byChannel } = groupDownloads([failed, done]);
		expect(byChannel.size).toBe(1);
		expect(byChannel.get("c1")?.id).toBe("d");
	});

	it("counts episodes individually but never the series container", () => {
		// 12 episodes of one series — the series container has no record itself.
		const eps = Array.from({ length: 12 }, (_, i) =>
			rec({ id: `e${i}`, channelId: `ep-${i}`, status: "completed", seriesChannelId: "S1" })
		);
		const { byChannel, bySeries } = groupDownloads(eps);
		expect(byChannel.size).toBe(12); // tab badge count
		expect(bySeries.get("S1")?.length).toBe(12);
	});

	it("dedupes per episode within a series (retry replaces failed)", () => {
		const failed = rec({
			id: "f",
			channelId: "ep-1",
			status: "failed",
			seriesChannelId: "S1",
			createdAt: 1,
		});
		const done = rec({
			id: "d",
			channelId: "ep-1",
			status: "completed",
			seriesChannelId: "S1",
			createdAt: 2,
		});
		const { bySeries } = groupDownloads([failed, done]);
		expect(bySeries.get("S1")?.length).toBe(1);
		expect(bySeries.get("S1")?.[0].id).toBe("d");
	});

	it("treats movies as standalone channels", () => {
		const movie = rec({ id: "m", channelId: "mv-1", kind: "movie", seriesChannelId: null });
		const { byChannel, bySeries } = groupDownloads([movie]);
		expect(byChannel.size).toBe(1);
		expect(bySeries.size).toBe(0);
	});
});
