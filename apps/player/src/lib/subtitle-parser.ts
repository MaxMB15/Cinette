// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { SubtitleCue } from "./types";

/** Spaces, tabs, vertical tabs or form feeds, which C's sscanf skips before a number. */
const SPACES = /[ \t\v\f]*/.source;
/** A number as sscanf reads it with %d, after any spaces, with a sign or not. */
const NUMBER = `${SPACES}${/[-+]?\d+/.source}`;
/** An SRT time, "HH:MM:SS,mmm", with a comma or a period before the milliseconds. */
const SRT_TIME = `${NUMBER}:${NUMBER}:${NUMBER}[,.]${NUMBER}`;
/** A WebVTT time, which leaves out the hours when they're 0, as in "MM:SS.mmm". */
const VTT_TIME = `${NUMBER}:(?:${NUMBER}:)?${NUMBER}\\.${NUMBER}`;

/**
 * An SRT timing line as FFmpeg reads it. Spaces can come before each number
 * and around the arrow, but not before a colon, a comma or a period. FFmpeg
 * reads the start and end time and ignores the rest of the line, which can
 * hold position values such as "X1:100", or another arrow.
 */
const SRT_TIMING = new RegExp(`^(${SRT_TIME})${SPACES}-->(${SRT_TIME})`);
/** A WebVTT time at the start of a string. */
const VTT_TIME_FIRST = new RegExp(`^${VTT_TIME}`);
/** Only the spaces sscanf skips, or nothing. */
const ONLY_SPACES = new RegExp(`^${SPACES}$`);

/** A cue number as FFmpeg reads it with C's strtol, which takes a sign. */
const CUE_NUMBER = new RegExp(`^${SPACES}([-+]?\\d+)\\s*$`);

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

/**
 * Whether a WebVTT line is where FFmpeg looks for a timing line, first in its
 * block or right after the cue's name.
 */
const startsBlock = (lines: string[], at: number): boolean =>
	lines[at - 1] === "" || (lines[at - 2] === "" && !lines[at - 1].includes("-->"));

/**
 * The start and end of a timing line, or null when the line is text. `loose`
 * is true where FFmpeg reads a WebVTT timing line.
 */
const parseTiming = (
	line: string,
	webvtt: boolean,
	loose: boolean
): { start: number; end: number } | null => {
	if (!webvtt) {
		const times = SRT_TIMING.exec(line);
		return times && { start: parseTimestamp(times[1]), end: parseTimestamp(times[2]) };
	}
	// FFmpeg reads the end time right after the first arrow, which can come
	// anywhere after the start time. It ignores the rest of the line, which can
	// hold settings such as "align:start".
	const start = VTT_TIME_FIRST.exec(line);
	const arrow = line.indexOf("-->");
	if (!start || arrow < 0) return null;
	// FFmpeg reads the rest of a cue as text. Here a timing line in it starts
	// a new cue, as in SRT, so only spaces can come before its arrow, and a
	// text line like "1:30.5 in --> 2:00.0 out" stays text.
	if (!loose && !ONLY_SPACES.test(line.slice(start[0].length, arrow))) return null;
	const end = VTT_TIME_FIRST.exec(line.slice(arrow + 3));
	return end && { start: parseTimestamp(start[0]), end: parseTimestamp(end[0]) };
};

/**
 * Strip SRT/HTML tags (<i>, <b>, <font ...>, etc.) from a line of subtitle
 * text. A tag runs from a "<" to the first ">" after it, with something
 * between them. A "<" with no ">" after it stays, as in "I <3 you", and so
 * does "<>".
 *
 * React shows the result as plain text, never as HTML. This reads the line
 * once. The pattern /<[^>]+>/g it replaces backtracked over a long run of "<"
 * with no ">", and took seconds on a line of 100,000.
 */
const stripTags = (text: string): string => {
	let stripped = "";
	let from = 0;
	let open = text.indexOf("<");
	while (open !== -1) {
		const close = text.indexOf(">", open + 1);
		// With no ">" left, no later "<" starts a tag either.
		if (close === -1) break;
		if (close > open + 1) {
			stripped += text.slice(from, open);
			from = close + 1;
		}
		open = text.indexOf("<", close + 1);
	}
	return (stripped + text.slice(from)).trim();
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
 * WebVTT cue that's only a number keeps it. FFmpeg stops reading a WebVTT file
 * at a block it can't read, and here the cues after it still show.
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
		const timing = parseTiming(line, webvtt, startsBlock(lines, at));
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
		// FFmpeg reads a cue number of 0 or more. One below 0 is text.
		const numbered =
			(!webvtt || last === body.length - 1) &&
			next < lines.length &&
			Number(CUE_NUMBER.exec(body[last])?.[1]) >= 0;
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

/** `seconds` as a WebVTT time, "HH:MM:SS.mmm". */
const vttTime = (seconds: number): string => {
	const ms = Math.round(seconds * 1000);
	const pad = (n: number, width = 2) => String(n).padStart(width, "0");
	const hours = Math.floor(ms / 3_600_000);
	const minutes = Math.floor(ms / 60_000) % 60;
	const secs = Math.floor(ms / 1000) % 60;
	return `${pad(hours)}:${pad(minutes)}:${pad(secs)}.${pad(ms % 1000, 3)}`;
};

/** Cue text as WebVTT reads it, with no markup and no "-->". */
const vttText = (text: string): string =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * `cues` as a WebVTT file for a receiver that plays from `offset` seconds
 * into the item and counts from 0 there, as a converted cast does. A
 * positive `delay` shows each cue later, as mpv's `sub-delay` does. A cue
 * that ends by 0 is left out, and one that starts before 0 starts there.
 */
export const toWebVtt = (cues: SubtitleCue[], delay: number, offset: number): string => {
	const shift = delay - offset;
	const blocks = cues.flatMap(({ start, end, text }) =>
		end + shift > 0
			? [
					`${vttTime(Math.max(0, start + shift))} --> ${vttTime(end + shift)}\n${vttText(text)}`,
				]
			: []
	);
	return ["WEBVTT", ...blocks].join("\n\n") + "\n";
};
