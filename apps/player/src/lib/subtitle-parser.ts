// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { SubtitleCue } from "./types";

/** Spaces or tabs, which C's sscanf skips before a number and around the arrow. */
const SPACES = /[ \t\v\f]*/.source;
/** A number as sscanf reads it with %d, after any spaces, with a sign or not. */
const NUMBER = `${SPACES}${/[-+]?\d+/.source}`;
/** An SRT time, "HH:MM:SS,mmm", with a comma or a period before the milliseconds. */
const SRT_TIME = `${NUMBER}:${NUMBER}:${NUMBER}[,.]${NUMBER}`;
/** A WebVTT time, which leaves out the hours when they're 0, as in "MM:SS.mmm". */
const VTT_TIME = `${NUMBER}:(?:${NUMBER}:)?${NUMBER}\\.${NUMBER}`;

/**
 * A timing line as FFmpeg reads it. Spaces can come before each number and
 * around the arrow, but not before a colon, a comma or a period. FFmpeg reads
 * the start and end time and ignores the rest of the line, which can hold
 * position values such as "X1:100", WebVTT settings such as "align:start", or
 * another arrow.
 */
const timingLine = (time: string): RegExp => new RegExp(`^(${time})${SPACES}-->(${time})`);
const SRT_TIMING = timingLine(SRT_TIME);
const VTT_TIMING = timingLine(VTT_TIME);

/**
 * Read a time into seconds. Like FFmpeg, it reads the milliseconds as a whole
 * number, so "00:00:01,5" is 1.005 seconds.
 */
const parseTimestamp = (time: string): number => {
	// Number ignores the spaces before each part.
	const parts = time.split(/[:,.]/).map(Number);
	const ms = parts[parts.length - 1];
	return parts.slice(0, -1).reduce((total, part) => total * 60 + part, 0) + ms / 1000;
};

/** The start and end of a timing line, or null when the line is text. */
const parseTiming = (line: string, webvtt: boolean): { start: number; end: number } | null => {
	const times = (webvtt ? VTT_TIMING : SRT_TIMING).exec(line);
	return times && { start: parseTimestamp(times[1]), end: parseTimestamp(times[2]) };
};

/**
 * Strip SRT/HTML tags (<i>, <b>, <font ...>, etc.) from subtitle text.
 *
 * React shows the result as plain text, never as HTML. With this pattern a
 * second pass never finds anything, but CodeQL's incomplete sanitization check
 * only accepts a replacement that repeats until nothing changes, so keep the loop.
 */
const stripTags = (text: string): string => {
	let stripped = text;
	let previous: string;
	do {
		previous = stripped;
		stripped = stripped.replace(/<[^>]+>/g, "");
	} while (stripped !== previous);
	return stripped.trim();
};

/**
 * Parse SRT or WebVTT file content into an array of SubtitleCue objects.
 *
 * Like FFmpeg's SRT reader, which mpv uses, a cue runs from its timing line to
 * the next one. A blank line inside a cue keeps the text after it, and two
 * cues with no blank line between them stay apart. A number right before the
 * next timing line, or before the blank lines in front of it, is that cue's
 * number. In SRT, FFmpeg keeps a number with a line of spaces after it in the
 * cue before, and here it's dropped. Any line that isn't a timing line FFmpeg
 * can read is text, even with an arrow in it. WebVTT doesn't allow an empty
 * line inside a cue, so there a cue also ends at one. That empty line comes
 * before the next cue's name, and the name sits right on its timing line, so a
 * WebVTT cue that's only a number keeps it.
 */
export const parseSrt = (content: string): SubtitleCue[] => {
	// FFmpeg skips a byte order mark at the start of the file.
	const file = content.replace(/^\uFEFF/, "");
	// A file with only carriage returns ends each line with one, so two in a
	// row make an empty line. Otherwise a run of carriage returns is one line
	// break, with a line feed after it or not. A file converted more than once
	// can end its lines in "\r\r\n".
	const lines = file.includes("\n") ? file.split(/\r+\n?|\n/) : file.split("\r");
	const webvtt = lines[0].startsWith("WEBVTT");
	const timings = lines.flatMap((line, at) => {
		const timing = parseTiming(line, webvtt);
		return timing ? [{ at, ...timing }] : [];
	});
	const cues: SubtitleCue[] = [];
	timings.forEach(({ at, start, end }, i) => {
		if (end <= start) return;
		const next = timings[i + 1]?.at ?? lines.length;
		const body = lines.slice(at + 1, next);
		// The next cue's number comes before its timing line, at times with
		// blank lines between them.
		let last = body.length - 1;
		while (body[last]?.trim() === "") last--;
		// In WebVTT, the next cue's name sits right on its timing line. A cue
		// that's only a number, like a countdown, has an empty line or a line
		// of spaces after it, so it keeps its number.
		const numbered =
			(!webvtt || last === body.length - 1) &&
			next < lines.length &&
			/^\s*\d+\s*$/.test(body[last]);
		const stop = numbered ? last : last + 1;
		const kept = body.slice(0, stop);
		// An empty line keeps a WebVTT note, or the name of the next cue, out
		// of the text.
		const shown = webvtt && kept.includes("") ? kept.slice(0, kept.indexOf("")) : kept;
		const text = shown.map(stripTags).filter(Boolean).join("\n");
		if (text) cues.push({ start, end, text });
	});
	return cues;
};
