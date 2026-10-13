// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { SubtitleCue } from "./types";

/**
 * Parse "HH:MM:SS,mmm" or "HH:MM:SS.mmm" into seconds. WebVTT leaves out the
 * hours when they're 0, as in "MM:SS.mmm". Gives NaN for any other number of
 * parts, or for a part that's empty.
 */
const parseTimestamp = (ts: string): number => {
	const parts = ts.replace(",", ".").split(":");
	if (parts.length < 2 || parts.length > 3 || parts.some((p) => !p.trim())) return NaN;
	// Number ignores the spaces around each part.
	return parts.map(Number).reduce((total, part) => total * 60 + part, 0);
};

/** The start and end of a timing line, or null when they can't be read. */
const parseTiming = (line: string): { start: number; end: number } | null => {
	const sides = line.split("-->");
	if (sides.length !== 2) return null;
	const start = parseTimestamp(sides[0]);
	// Position values such as "X1:100", or WebVTT settings such as
	// "align:start", can follow the end time.
	const end = parseTimestamp(sides[1].trim().split(/\s/)[0]);
	return isNaN(start) || isNaN(end) ? null : { start, end };
};

/**
 * Whether a line starts like a time and has an arrow. Like a time, it starts
 * with a number and a colon, then digits or spaces up to another colon, a
 * comma or a period. Other lines with an arrow, such as "3, 2, 1 --> go!" or
 * "10:00 --> 11:00", are text.
 */
const isTimingLine = (line: string): boolean =>
	/^\s*-?\d+:[\d\s]*[:.,]/.test(line) && line.includes("-->");

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
 * number. FFmpeg only ends a cue at a timing line it can read. Here one that
 * can't be read ends it too, and its own cue is skipped. WebVTT doesn't allow
 * an empty line inside a cue, so there a cue also ends at one. That empty line
 * comes before the next cue's name, so a WebVTT cue that's only a number keeps
 * it.
 */
export const parseSrt = (content: string): SubtitleCue[] => {
	// A file with only carriage returns ends each line with one, so two in a
	// row make an empty line. Otherwise a run of carriage returns is one line
	// break, with a line feed after it or not. A file converted more than once
	// can end its lines in "\r\r\n".
	const lines = content.includes("\n") ? content.split(/\r+\n?|\n/) : content.split("\r");
	const webvtt = lines[0].trim().startsWith("WEBVTT");
	const timings = lines.flatMap((line, at) => (isTimingLine(line) ? [at] : []));
	const cues: SubtitleCue[] = [];
	timings.forEach((at, i) => {
		const timing = parseTiming(lines[at]);
		if (!timing || timing.end <= timing.start) return;
		const next = timings[i + 1] ?? lines.length;
		const body = lines.slice(at + 1, next);
		// The next cue's number comes before its timing line, at times with
		// blank lines between them.
		let last = body.length - 1;
		while (body[last]?.trim() === "") last--;
		const numbered = !webvtt && next < lines.length && /^\s*\d+\s*$/.test(body[last]);
		const stop = numbered ? last : last + 1;
		const kept = body.slice(0, stop);
		// An empty line keeps a WebVTT note, or the name of the next cue, out
		// of the text.
		const shown = webvtt && kept.includes("") ? kept.slice(0, kept.indexOf("")) : kept;
		const text = shown.map(stripTags).filter(Boolean).join("\n");
		if (text) cues.push({ ...timing, text });
	});
	return cues;
};
