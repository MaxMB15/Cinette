// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, beforeEach } from "vitest";
import {
	DEFAULT_MARGINS,
	NO_GUIDE_LENGTH,
	dayLabel,
	formatWindow,
	isActiveRecording,
	overlapWarning,
	overlapping,
	parseLocalDateTime,
	programWindow,
	rangeWindow,
	readMargins,
	recordNowWindow,
	recordingChannel,
	recordingName,
	recordingOfProgram,
	recordingProgress,
	recordingStatus,
	runningRecordingOf,
	sortRecordings,
	toLocalInputValue,
	writeMargins,
} from "./recordings";
import type { DownloadRecord, EpgProgram } from "./types";

const MIN = 60;

/** Unix seconds for a local date and time. */
const local = (y: number, mo: number, d: number, h: number, mi = 0) =>
	Math.floor(new Date(y, mo - 1, d, h, mi).getTime() / 1000);

const prog = (startTime: number, endTime: number, title = "Evening News"): EpgProgram => ({
	channelId: "city.news",
	title,
	startTime,
	endTime,
});

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
	createdAt: 0,
	finishedAt: null,
	keep: false,
	lastPlayedAt: null,
	sourceChannelId: "xt-1-xt-0",
	startAt: 1_000,
	endAt: 2_000,
	programTitle: null,
	...overrides,
});

describe("margins", () => {
	beforeEach(() => localStorage.clear());

	it("start 2 minutes early and run 5 over by default", () => {
		expect(readMargins()).toEqual({ before: 2, after: 5 });
	});

	it("round-trip a saved choice", () => {
		writeMargins({ before: 0, after: 15 });
		expect(readMargins()).toEqual({ before: 0, after: 15 });
	});

	it("ignore a saved value that isn't a whole number of minutes", () => {
		localStorage.setItem("mvp_recording_start_early", "soon");
		localStorage.setItem("mvp_recording_end_late", "-3");
		expect(readMargins()).toEqual(DEFAULT_MARGINS);
	});
});

describe("recording windows", () => {
	const now = 10_000;

	it("record now runs until the program on air ends, plus the margin", () => {
		const onAir = prog(now - 20 * MIN, now + 40 * MIN);
		expect(recordNowWindow(now, onAir, DEFAULT_MARGINS)).toEqual({
			startAt: now,
			endAt: now + 45 * MIN,
			programTitle: "Evening News",
		});
	});

	it("record now runs an hour without a guide", () => {
		expect(recordNowWindow(now, null, DEFAULT_MARGINS)).toEqual({
			startAt: now,
			endAt: now + NO_GUIDE_LENGTH,
			programTitle: null,
		});
		const over = prog(now - 60 * MIN, now - MIN);
		expect(recordNowWindow(now, over, DEFAULT_MARGINS).endAt).toBe(now + NO_GUIDE_LENGTH);
	});

	it("a program gets the margins on both sides", () => {
		const p = prog(now + 60 * MIN, now + 120 * MIN);
		expect(programWindow(p, { before: 2, after: 5 })).toEqual({
			startAt: now + 58 * MIN,
			endAt: now + 125 * MIN,
			programTitle: "Evening News",
		});
	});

	it("a time range starts at the local time typed", () => {
		const start = local(2026, 10, 12, 20, 0);
		expect(rangeWindow("2026-10-12T20:00", 90)).toEqual({
			startAt: start,
			endAt: start + 90 * MIN,
			programTitle: null,
		});
	});

	it("a time range needs a real date and a length up to 12 hours", () => {
		expect(rangeWindow("", 60)).toBeNull();
		expect(rangeWindow("2026-02-30T20:00", 60)).toBeNull();
		expect(rangeWindow("2026-10-12T20:00", 0)).toBeNull();
		expect(rangeWindow("2026-10-12T20:00", 12.5)).toBeNull();
		expect(rangeWindow("2026-10-12T20:00", 12 * 60 + 1)).toBeNull();
		expect(rangeWindow("2026-10-12T20:00", 12 * 60)).not.toBeNull();
	});

	it("reads and writes the datetime input's format", () => {
		const at = local(2026, 1, 5, 7, 9);
		expect(toLocalInputValue(at)).toBe("2026-01-05T07:09");
		expect(parseLocalDateTime("2026-01-05T07:09")).toBe(at);
		expect(parseLocalDateTime("2026-01-05T24:00")).toBeNull();
		expect(parseLocalDateTime("2026-1-5T7:09")).toBeNull();
	});
});

describe("overlaps", () => {
	const window = { startAt: 1_500, endAt: 2_500 };

	it("finds waiting and running recordings at the same time", () => {
		const running = rec({ id: "a", status: "recording" });
		const later = rec({ id: "b", startAt: 2_500, endAt: 3_000 });
		const done = rec({ id: "c", status: "completed" });
		const movie = rec({ id: "d", kind: "movie" });
		expect(overlapping(window, [running, later, done, movie])).toEqual([running]);
	});

	it("says recordings of one channel become one", () => {
		expect(overlapWarning(window, "xt-1-xt-0", [rec()])).toBe(
			"It overlaps a recording of this channel, so the two become one recording."
		);
	});

	it("warns that another channel may not get a stream", () => {
		const other = rec({ sourceChannelId: "xt-1-xt-7", title: "Sports One" });
		expect(overlapWarning(window, "xt-1-xt-0", [other])).toBe(
			"It overlaps a recording of Sports One. Many providers allow one stream at a time, so one of them may fail."
		);
		expect(overlapWarning(window, "xt-1-xt-0", [other, { ...other, id: "x" }])).toMatch(
			/^It overlaps 2 other recordings\./
		);
	});

	it("says nothing when the times don't meet", () => {
		expect(overlapWarning({ startAt: 2_000, endAt: 2_100 }, "xt-1-xt-0", [rec()])).toBeNull();
	});
});

describe("finding a channel's recordings", () => {
	it("a program is covered by a recording of its channel that spans it", () => {
		const scheduled = rec({ startAt: 880, endAt: 2_300 });
		expect(recordingOfProgram([scheduled], "xt-1-xt-0", prog(1_000, 2_000), 0)).toBe(scheduled);
		expect(recordingOfProgram([scheduled], "xt-1-xt-9", prog(1_000, 2_000), 0)).toBeUndefined();
		expect(recordingOfProgram([scheduled], "xt-1-xt-0", prog(2_000, 3_000), 0)).toBeUndefined();
	});

	it("a recording started late still covers the program on air", () => {
		const late = rec({ status: "recording", startAt: 1_200, endAt: 2_300 });
		expect(recordingOfProgram([late], "xt-1-xt-0", prog(1_000, 2_000), 1_250)).toBe(late);
	});

	it("finds the recording that's running on a channel", () => {
		const waiting = rec({ id: "a" });
		const running = rec({ id: "b", status: "recording" });
		expect(runningRecordingOf([waiting, running], "xt-1-xt-0")).toBe(running);
		expect(runningRecordingOf([waiting], "xt-1-xt-0")).toBeUndefined();
	});

	it("only waiting and running recordings are active", () => {
		expect(isActiveRecording(rec())).toBe(true);
		expect(isActiveRecording(rec({ status: "recording" }))).toBe(true);
		expect(isActiveRecording(rec({ status: "missed" }))).toBe(false);
		expect(isActiveRecording(rec({ kind: "movie", status: "queued" }))).toBe(false);
	});
});

describe("describing recordings", () => {
	it("progress follows the clock", () => {
		const r = rec({ status: "recording", startAt: 1_000, endAt: 2_000 });
		expect(recordingProgress(r, 1_250)).toBe(0.25);
		expect(recordingProgress(r, 500)).toBe(0);
		expect(recordingProgress(r, 9_000)).toBe(1);
		expect(recordingProgress(rec({ startAt: null }), 1_500)).toBe(0);
	});

	it("sorts running, then waiting by start, then the rest newest first", () => {
		const records = [
			rec({ id: "old", status: "completed", startAt: 100 }),
			rec({ id: "later", startAt: 5_000 }),
			rec({ id: "new", status: "missed", startAt: 900 }),
			rec({ id: "soon", startAt: 3_000 }),
			rec({ id: "now", status: "recording", startAt: 50 }),
		];
		expect(sortRecordings(records).map((r) => r.id)).toEqual([
			"now",
			"soon",
			"later",
			"new",
			"old",
		]);
	});

	it("names days near today", () => {
		const now = local(2026, 10, 12, 9);
		expect(dayLabel(local(2026, 10, 12, 23, 59), now)).toBe("Today");
		expect(dayLabel(local(2026, 10, 13, 0, 30), now)).toBe("Tomorrow");
		expect(dayLabel(local(2026, 10, 11, 20), now)).toBe("Yesterday");
		expect(dayLabel(local(2026, 10, 20, 20), now)).not.toMatch(/Today|Tomorrow|Yesterday/);
		expect(formatWindow(local(2026, 10, 12, 20), local(2026, 10, 12, 21), now)).toMatch(
			/^Today, .+ to .+$/
		);
	});

	it("gives each state a short status", () => {
		expect(recordingStatus(rec())).toBe("Scheduled");
		expect(recordingStatus(rec({ status: "recording" }))).toMatch(/^Recording until /);
		expect(recordingStatus(rec({ status: "completed" }))).toBe("Recorded");
		expect(
			recordingStatus(
				rec({ status: "completed", error: "The stream stopped before the end." })
			)
		).toBe("Ended early");
		expect(recordingStatus(rec({ status: "missed" }))).toBe("Missed");
		expect(recordingStatus(rec({ status: "failed" }))).toBe("Failed");
	});

	it("plays a finished recording from its file, under the file's name", () => {
		const done = rec({
			status: "completed",
			destPath: "/downloads/recordings/City News 2026-10-12 20.00.ts",
		});
		expect(recordingName(done)).toBe("City News 2026-10-12 20.00");
		expect(recordingName(rec())).toBe("City News");
		expect(recordingChannel(done)).toMatchObject({
			id: "rec-1",
			name: "City News 2026-10-12 20.00",
			url: "/downloads/recordings/City News 2026-10-12 20.00.ts",
			contentType: "movie",
			sources: [],
		});
	});
});
