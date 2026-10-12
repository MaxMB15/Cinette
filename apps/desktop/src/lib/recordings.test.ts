// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, beforeEach } from "vitest";
import {
	DEFAULT_MARGINS,
	NO_GUIDE_LENGTH,
	dayLabel,
	errorSummary,
	formatAt,
	formatWindow,
	isActiveRecording,
	isRecordingOf,
	isTooLong,
	overlapWarning,
	overlapping,
	parseLocalDateTime,
	programWindow,
	providerOf,
	rangeWindow,
	readMargins,
	recordNowWindow,
	recordingChannel,
	recordingLabel,
	recordingName,
	recordingOfProgram,
	recordingProgress,
	recordingStatus,
	recordingStatusColor,
	sortRecordings,
	toLocalInputValue,
	writeMargins,
} from "./recordings";
import { formatHHMM } from "./epg-window";
import type { DownloadRecord, EpgProgram } from "./types";

const MIN = 60;

const PROVIDERS = ["xt-1", "xt-10"];
const channel = { id: "xt-1-xt-0", name: "City News" };

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
			program: { title: "Evening News", start: now - 20 * MIN, end: now + 40 * MIN },
		});
	});

	it("record now runs an hour without a guide", () => {
		expect(recordNowWindow(now, null, DEFAULT_MARGINS)).toEqual({
			startAt: now,
			endAt: now + NO_GUIDE_LENGTH,
			program: null,
		});
		const over = prog(now - 60 * MIN, now - MIN);
		expect(recordNowWindow(now, over, DEFAULT_MARGINS).endAt).toBe(now + NO_GUIDE_LENGTH);
	});

	it("a program gets the margins on both sides", () => {
		const p = prog(now + 60 * MIN, now + 120 * MIN);
		expect(programWindow(p, { before: 2, after: 5 })).toEqual({
			startAt: now + 58 * MIN,
			endAt: now + 125 * MIN,
			program: { title: "Evening News", start: now + 60 * MIN, end: now + 120 * MIN },
		});
	});

	it("a window can be up to 12 hours long", () => {
		expect(isTooLong({ startAt: 0, endAt: 12 * 60 * MIN })).toBe(false);
		expect(isTooLong({ startAt: 0, endAt: 12 * 60 * MIN + 1 })).toBe(true);
	});

	it("a time range starts at the local time typed", () => {
		const start = local(2026, 10, 12, 20, 0);
		expect(rangeWindow("2026-10-12T20:00", 90)).toEqual({
			startAt: start,
			endAt: start + 90 * MIN,
			program: null,
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

	it("says recordings of one channel become one, even after the channel's id moved", () => {
		const message = "It overlaps a recording of this channel, so the two become one recording.";
		expect(overlapWarning(window, channel, [rec()], PROVIDERS)).toBe(message);
		const moved = rec({ sourceChannelId: "xt-1-xt-4" });
		expect(overlapWarning(window, channel, [moved], PROVIDERS)).toBe(message);
	});

	it("warns that another channel of the same provider may not get a stream", () => {
		const other = rec({ sourceChannelId: "xt-1-xt-7", title: "Sports One" });
		expect(overlapWarning(window, channel, [other], PROVIDERS)).toBe(
			"It overlaps a recording of Sports One from the same provider. Many providers allow one stream at a time, so one of them may fail."
		);
		expect(overlapWarning(window, channel, [other, { ...other, id: "x" }], PROVIDERS)).toMatch(
			/^It overlaps 2 other recordings from the same provider\./
		);
	});

	it("leaves out recordings from other providers", () => {
		const elsewhere = rec({ sourceChannelId: "xt-10-xt-7", title: "Sports One" });
		expect(overlapWarning(window, channel, [elsewhere], PROVIDERS)).toBeNull();
	});

	it("says nothing when the times don't meet", () => {
		expect(
			overlapWarning({ startAt: 2_000, endAt: 2_100 }, channel, [rec()], PROVIDERS)
		).toBeNull();
	});
});

describe("finding a channel's recordings", () => {
	it("works out a channel's provider from its id, the longest match first", () => {
		expect(providerOf("xt-1-xt-0", PROVIDERS)).toBe("xt-1");
		expect(providerOf("xt-10-xt-0", PROVIDERS)).toBe("xt-10");
		expect(providerOf("m3u-2-ch-0", PROVIDERS)).toBeUndefined();
	});

	it("matches a recording by its channel's name within one provider", () => {
		expect(isRecordingOf(rec(), channel, PROVIDERS)).toBe(true);
		// A refresh gave the channel another id.
		expect(isRecordingOf(rec({ sourceChannelId: "xt-1-xt-4" }), channel, PROVIDERS)).toBe(true);
		// The id now belongs to another channel.
		expect(isRecordingOf(rec({ title: "Sports One" }), channel, PROVIDERS)).toBe(false);
		// Same name on another provider.
		expect(isRecordingOf(rec({ sourceChannelId: "xt-10-xt-0" }), channel, PROVIDERS)).toBe(
			false
		);
		// Without a known provider the ids have to match.
		expect(isRecordingOf(rec({ sourceChannelId: "zz-xt-0" }), channel, PROVIDERS)).toBe(false);
		expect(isRecordingOf(rec({ kind: "movie" }), channel, PROVIDERS)).toBe(false);
	});

	it("a program is covered by a recording of its channel that spans it", () => {
		const scheduled = rec({ startAt: 880, endAt: 2_300 });
		expect(recordingOfProgram([scheduled], prog(1_000, 2_000), 0)).toBe(scheduled);
		expect(recordingOfProgram([scheduled], prog(2_000, 3_000), 0)).toBeUndefined();
		expect(
			recordingOfProgram([{ ...scheduled, status: "missed" }], prog(1_000, 2_000), 0)
		).toBeUndefined();
	});

	it("a recording started late still covers the program on air", () => {
		const late = rec({ status: "recording", startAt: 1_200, endAt: 2_300 });
		expect(recordingOfProgram([late], prog(1_000, 2_000), 1_250)).toBe(late);
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
	});

	it("names the end's day when a recording runs past midnight", () => {
		const now = local(2026, 10, 12, 9);
		const [eight, nine] = [local(2026, 10, 12, 20), local(2026, 10, 12, 21)];
		expect(formatWindow(eight, nine, now)).toBe(
			`Today, ${formatHHMM(eight)} to ${formatHHMM(nine)}`
		);
		const [late, early] = [local(2026, 10, 12, 23, 30), local(2026, 10, 13, 1)];
		expect(formatWindow(late, early, now)).toBe(
			`Today, ${formatHHMM(late)} to Tomorrow, ${formatHHMM(early)}`
		);
		expect(formatAt(nine, now)).toBe(formatHHMM(nine));
		expect(formatAt(early, now)).toBe(`Tomorrow, ${formatHHMM(early)}`);
	});

	it("gives each state a short status", () => {
		const now = 1_500;
		expect(recordingStatus(rec(), now)).toBe("Scheduled");
		expect(recordingStatus(rec({ error: "The stream stopped." }), now)).toBe("Trying again");
		expect(recordingStatus(rec({ status: "recording" }), now)).toBe(
			`Recording until ${formatHHMM(2_000)}`
		);
		expect(recordingStatus(rec({ status: "completed" }), now)).toBe("Recorded");
		expect(
			recordingStatus(
				rec({ status: "completed", error: "The stream stopped before the end." }),
				now
			)
		).toBe("Ended early");
		expect(recordingStatus(rec({ status: "missed" }), now)).toBe("Missed");
		expect(recordingStatus(rec({ status: "failed" }), now)).toBe("Failed");
	});

	it("colors a recording that ended early or is trying again amber", () => {
		expect(recordingStatusColor(rec())).toBe("text-blue-400");
		expect(recordingStatusColor(rec({ error: "x" }))).toBe("text-amber-500");
		expect(recordingStatusColor(rec({ status: "completed", error: "x" }))).toBe(
			"text-amber-500"
		);
		expect(recordingStatusColor(rec({ status: "completed" }))).toBe("text-muted-foreground");
	});

	it("keeps the plain words of an error and leaves ffmpeg's for the tooltip", () => {
		expect(errorSummary("The stream stopped.\nConnection reset by peer")).toBe(
			"The stream stopped."
		);
		expect(errorSummary("Missed")).toBe("Missed");
	});

	it("labels a recording by its program and channel", () => {
		expect(recordingLabel(rec())).toBe("City News");
		expect(recordingLabel(rec({ programTitle: "Late Show" }))).toBe("Late Show on City News");
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
			contentType: "recording",
			sources: [],
		});
	});
});
