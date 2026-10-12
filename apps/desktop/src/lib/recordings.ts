// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// Recordings of live channels. The app records into a file from a start time
// to an end time, in Unix seconds. These helpers work out those times, check
// them against other recordings and describe a recording in the UI. The
// margins are a Settings choice kept in web storage, which can throw, so every
// access is guarded and falls back to the defaults.

import { formatClock } from "./format";
import type { Channel, DownloadRecord, EpgProgram, GuideProgram } from "./types";

const MINUTE = 60;

/** How long "Record now" runs on a channel with no guide, in seconds. */
export const NO_GUIDE_LENGTH = 60 * MINUTE;

/** The longest recording the app accepts, in minutes. The app checks it too. */
export const MAX_LENGTH_MINUTES = 12 * 60;

const BEFORE_KEY = "mvp_recording_start_early";
const AFTER_KEY = "mvp_recording_end_late";

/** Minutes a program's recording starts early and runs over. */
export interface RecordingMargins {
	before: number;
	after: number;
}

export const DEFAULT_MARGINS: RecordingMargins = { before: 2, after: 5 };

/** Choices for the margins in Settings, in minutes. */
export const MARGIN_OPTIONS = [0, 1, 2, 5, 10, 15, 30].map((value) => ({
	value,
	label: value === 0 ? "None" : value === 1 ? "1 minute" : `${value} minutes`,
}));

const MAX_MARGIN = 60;

const readMinutes = (key: string, fallback: number): number => {
	try {
		const raw = localStorage.getItem(key);
		const n = raw === null ? NaN : Number(raw);
		return Number.isInteger(n) && n >= 0 && n <= MAX_MARGIN ? n : fallback;
	} catch {
		return fallback;
	}
};

export const readMargins = (): RecordingMargins => ({
	before: readMinutes(BEFORE_KEY, DEFAULT_MARGINS.before),
	after: readMinutes(AFTER_KEY, DEFAULT_MARGINS.after),
});

export const writeMargins = (margins: RecordingMargins): void => {
	const clamp = (n: number) => Math.min(MAX_MARGIN, Math.max(0, Math.round(n)));
	try {
		localStorage.setItem(BEFORE_KEY, String(clamp(margins.before)));
		localStorage.setItem(AFTER_KEY, String(clamp(margins.after)));
	} catch {}
};

/** What to record, in Unix seconds, and the guide's program when there is one. */
export interface RecordingWindow {
	startAt: number;
	endAt: number;
	program: GuideProgram | null;
}

const guideProgram = (prog: EpgProgram): GuideProgram => ({
	title: prog.title,
	start: prog.startTime,
	end: prog.endTime,
});

/**
 * "Record now" from `now`. It runs until the program on air ends, plus the
 * margin after, or for an hour when the channel has no guide.
 */
export const recordNowWindow = (
	now: number,
	onAir: EpgProgram | null,
	margins: RecordingMargins
): RecordingWindow =>
	onAir && onAir.endTime > now
		? {
				startAt: now,
				endAt: onAir.endTime + margins.after * MINUTE,
				program: guideProgram(onAir),
			}
		: { startAt: now, endAt: now + NO_GUIDE_LENGTH, program: null };

/** A program from the guide, with the margins around it. */
export const programWindow = (prog: EpgProgram, margins: RecordingMargins): RecordingWindow => ({
	startAt: prog.startTime - margins.before * MINUTE,
	endAt: prog.endTime + margins.after * MINUTE,
	program: guideProgram(prog),
});

/** Whether `window` runs longer than a recording can, as a long guide entry might. */
export const isTooLong = (window: Pick<RecordingWindow, "startAt" | "endAt">): boolean =>
	window.endAt - window.startAt > MAX_LENGTH_MINUTES * MINUTE;

/**
 * A local date and time as a datetime-local input gives it, such as
 * "2026-10-12T20:00", in Unix seconds. Null when it isn't a real date.
 */
export const parseLocalDateTime = (value: string): number | null => {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
	if (!match) return null;
	const [year, month, day, hour, minute] = match.slice(1).map(Number);
	if (hour > 23 || minute > 59) return null;
	const date = new Date(year, month - 1, day, hour, minute);
	// The Date constructor turns October 32 into November 1.
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day)
		return null;
	return Math.floor(date.getTime() / 1000);
};

/** Unix seconds as the value of a datetime-local input, in local time. */
export const toLocalInputValue = (unix: number): string => {
	const d = new Date(unix * 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** A time range the user typed. Null when the start isn't a date or the length is out of range. */
export const rangeWindow = (start: string, minutes: number): RecordingWindow | null => {
	const startAt = parseLocalDateTime(start);
	if (startAt === null || !Number.isInteger(minutes)) return null;
	if (minutes <= 0 || minutes > MAX_LENGTH_MINUTES) return null;
	return { startAt, endAt: startAt + minutes * MINUTE, program: null };
};

/**
 * The provider of the channel `channelId`, as the app works it out. A
 * channel's id starts with its provider's id and a "-", and the longest
 * such provider id wins.
 */
export const providerOf = (channelId: string, providerIds: string[]): string | undefined =>
	providerIds
		.filter((p) => channelId.startsWith(`${p}-`))
		.reduce<
			string | undefined
		>((best, p) => (best !== undefined && best.length >= p.length ? best : p), undefined);

/** Whether the channels `a` and `b` come from one known provider. */
const sameProvider = (a: string, b: string, providerIds: string[]): boolean => {
	const provider = providerOf(a, providerIds);
	return provider !== undefined && provider === providerOf(b, providerIds);
};

/**
 * Whether `rec` records `channel`. Channel ids follow each channel's place in
 * the playlist, so a refresh can give an id to another channel. A
 * recording's title is its channel's name, and the name decides within one
 * provider, as in the app. Without a known provider the ids have to match.
 */
export const isRecordingOf = (
	rec: DownloadRecord,
	channel: Pick<Channel, "id" | "name">,
	providerIds: string[]
): boolean =>
	rec.kind === "recording" &&
	rec.title === channel.name &&
	rec.sourceChannelId != null &&
	(rec.sourceChannelId === channel.id ||
		sameProvider(rec.sourceChannelId, channel.id, providerIds));

/** A recording that's waiting to start or running. */
export const isActiveRecording = (rec: DownloadRecord): boolean =>
	rec.kind === "recording" && (rec.status === "scheduled" || rec.status === "recording");

/** The waiting or running recordings whose time overlaps `window`. */
export const overlapping = (
	window: Pick<RecordingWindow, "startAt" | "endAt">,
	records: DownloadRecord[]
): DownloadRecord[] =>
	records.filter(
		(r) =>
			isActiveRecording(r) &&
			r.startAt != null &&
			r.endAt != null &&
			r.startAt < window.endAt &&
			window.startAt < r.endAt
	);

/**
 * What the confirm step says about recordings at the same time, or null when
 * there are none. Two recordings of one channel become one. A recording from
 * another provider uses another connection, so it doesn't count.
 */
export const overlapWarning = (
	window: Pick<RecordingWindow, "startAt" | "endAt">,
	channel: Pick<Channel, "id" | "name">,
	records: DownloadRecord[],
	providerIds: string[]
): string | null => {
	const hits = overlapping(window, records);
	const same = hits.filter((r) => isRecordingOf(r, channel, providerIds));
	const others = hits.filter(
		(r) =>
			!same.includes(r) &&
			r.sourceChannelId != null &&
			sameProvider(r.sourceChannelId, channel.id, providerIds)
	);
	const notes: string[] = [];
	if (same.length > 0) {
		notes.push("It overlaps a recording of this channel, so the two become one recording.");
	}
	if (others.length > 0) {
		const what =
			others.length === 1
				? `a recording of ${others[0].title}`
				: `${others.length} other recordings`;
		notes.push(
			`It overlaps ${what} from the same provider. Many providers allow one stream at a time, so one of them may fail.`
		);
	}
	return notes.length > 0 ? notes.join(" ") : null;
};

/**
 * Of `records`, the recordings of one channel, the waiting or running one
 * that covers `prog`.
 */
export const recordingOfProgram = (
	records: DownloadRecord[],
	prog: EpgProgram,
	now: number
): DownloadRecord | undefined =>
	records.find(
		(r) =>
			isActiveRecording(r) &&
			r.startAt != null &&
			r.endAt != null &&
			r.startAt <= Math.max(prog.startTime, now) &&
			r.endAt >= prog.endTime
	);

/** How far a running recording is, from 0 to 1, going by the clock. */
export const recordingProgress = (rec: DownloadRecord, now: number): number => {
	if (rec.startAt == null || rec.endAt == null || rec.endAt <= rec.startAt) return 0;
	return Math.min(1, Math.max(0, (now - rec.startAt) / (rec.endAt - rec.startAt)));
};

const STATUS_ORDER: Partial<Record<DownloadRecord["status"], number>> = {
	recording: 0,
	scheduled: 1,
};

/**
 * Running recordings first, then the waiting ones by start time, then the
 * rest with the newest first.
 */
export const sortRecordings = (records: DownloadRecord[]): DownloadRecord[] =>
	[...records].sort((a, b) => {
		const rank = (STATUS_ORDER[a.status] ?? 2) - (STATUS_ORDER[b.status] ?? 2);
		if (rank !== 0) return rank;
		const diff = (a.startAt ?? a.createdAt) - (b.startAt ?? b.createdAt);
		return isActiveRecording(a) ? diff : -diff;
	});

const startOfDay = (unix: number): number => {
	const d = new Date(unix * 1000);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** "Today", "Tomorrow", "Yesterday" or a short date, in local time. */
export const dayLabel = (unix: number, now: number): string => {
	const days = Math.round((startOfDay(unix) - startOfDay(now)) / 86_400_000);
	if (days === 0) return "Today";
	if (days === 1) return "Tomorrow";
	if (days === -1) return "Yesterday";
	return new Date(unix * 1000).toLocaleDateString([], {
		weekday: "short",
		day: "numeric",
		month: "short",
	});
};

/** "20:00" for a time on the day of `now`, or "Tomorrow, 01:00" for one on another day. */
export const formatAt = (unix: number, now: number): string =>
	startOfDay(unix) === startOfDay(now)
		? formatClock(unix)
		: `${dayLabel(unix, now)}, ${formatClock(unix)}`;

/**
 * "Today, 20:00 to 21:05" for a recording's time, or "Today, 23:30 to
 * Tomorrow, 01:00" when it ends on another day.
 */
export const formatWindow = (startAt: number, endAt: number, now: number): string => {
	const end =
		startOfDay(endAt) === startOfDay(startAt)
			? formatClock(endAt)
			: `${dayLabel(endAt, now)}, ${formatClock(endAt)}`;
	return `${dayLabel(startAt, now)}, ${formatClock(startAt)} to ${end}`;
};

/** What a recording records, such as "Evening News on City News". */
export const recordingLabel = (rec: DownloadRecord): string =>
	rec.programTitle ? `${rec.programTitle} on ${rec.title}` : rec.title;

/** A short status for a recording in the list. */
export const recordingStatus = (rec: DownloadRecord, now: number): string => {
	switch (rec.status) {
		case "scheduled":
			// After a stream fails, the app tries again a little later.
			return rec.error ? "Trying again" : "Scheduled";
		case "recording":
			return rec.endAt != null ? `Recording until ${formatAt(rec.endAt, now)}` : "Recording";
		case "completed":
			return rec.error ? "Ended early" : "Recorded";
		case "missed":
			return "Missed";
		case "failed":
			return "Failed";
		default:
			return "";
	}
};

const STATUS_COLOR: Partial<Record<DownloadRecord["status"], string>> = {
	recording: "text-red-400",
	scheduled: "text-blue-400",
	missed: "text-amber-500",
	failed: "text-red-400",
};

/** The text color for a recording's status. Amber when it ended early or is trying again. */
export const recordingStatusColor = (rec: DownloadRecord): string =>
	(rec.status === "completed" || rec.status === "scheduled") && rec.error
		? "text-amber-500"
		: (STATUS_COLOR[rec.status] ?? "text-muted-foreground");

/**
 * A recording's error in plain words, which is its first line. The app puts
 * what ffmpeg said on the lines after it, for a tooltip.
 */
export const errorSummary = (error: string): string => error.split("\n", 1)[0];

/**
 * The name of a finished recording, from its file, such as
 * "City News 2026-10-12 20.00". Each recording has its own, so each keeps
 * its own place to resume from.
 */
export const recordingName = (rec: DownloadRecord): string => {
	const file = rec.destPath.split(/[\\/]/).pop() ?? "";
	const stem = file.replace(/\.ts$/i, "");
	return stem || rec.title;
};

/** A channel that plays a finished recording from its file. */
export const recordingChannel = (rec: DownloadRecord): Channel => ({
	id: rec.channelId,
	name: recordingName(rec),
	url: rec.destPath,
	groupTitle: "Recordings",
	isFavorite: false,
	contentType: "recording",
	sources: [],
});
