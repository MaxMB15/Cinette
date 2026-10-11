// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import { deleteAt, deleteLabel, summarize } from "./retention";
import type { DownloadRecord } from "./types";

const DAY = 24 * 60 * 60;

const finished = (overrides: Partial<DownloadRecord> = {}): DownloadRecord => ({
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
	finishedAt: 1000,
	keep: false,
	lastPlayedAt: null,
	...overrides,
});

describe("deleteAt", () => {
	it("counts from when the download finished", () => {
		expect(deleteAt(finished(), 7)).toBe(1000 + 7 * DAY);
	});

	it("starts over when the download is played", () => {
		expect(deleteAt(finished({ lastPlayedAt: 5000 }), 7)).toBe(5000 + 7 * DAY);
	});

	it("never deletes when the setting is off, the download is kept, or unfinished", () => {
		expect(deleteAt(finished(), null)).toBeNull();
		expect(deleteAt(finished({ keep: true }), 7)).toBeNull();
		expect(deleteAt(finished({ status: "downloading" }), 7)).toBeNull();
	});
});

describe("deleteLabel", () => {
	it("rounds up to whole days", () => {
		expect(deleteLabel(3 * DAY, 0)).toBe("Deletes in 3 days");
		expect(deleteLabel(2 * DAY + 1, 0)).toBe("Deletes in 3 days");
		expect(deleteLabel(60, 0)).toBe("Deletes in 1 day");
	});

	it("says soon once the time has passed", () => {
		expect(deleteLabel(0, 0)).toBe("Deletes soon");
		expect(deleteLabel(0, 100)).toBe("Deletes soon");
	});
});

describe("summarize", () => {
	it("gives the soonest deletion among downloads that aren't kept", () => {
		const records = [
			finished({ id: "a", finishedAt: 5000 }),
			finished({ id: "b", finishedAt: 2000 }),
			finished({ id: "c", finishedAt: 100, keep: true }),
		];
		expect(summarize(records, 7)).toEqual({ state: "due", at: 2000 + 7 * DAY });
	});

	it("is kept when every finished download is kept", () => {
		const records = [finished({ keep: true }), finished({ id: "b", status: "failed" })];
		expect(summarize(records, 7)).toEqual({ state: "kept" });
	});

	it("is none with the setting off or nothing finished", () => {
		expect(summarize([finished()], null)).toEqual({ state: "none" });
		expect(summarize([finished({ status: "queued" })], 7)).toEqual({ state: "none" });
	});
});
