// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import { parseSrt } from "./subtitle-parser";

describe("parseSrt", () => {
	it("parses a basic SRT block", () => {
		const srt = `1\n00:00:01,000 --> 00:00:03,000\nHello world\n\n`;
		const cues = parseSrt(srt);
		expect(cues).toHaveLength(1);
		expect(cues[0].start).toBeCloseTo(1.0);
		expect(cues[0].end).toBeCloseTo(3.0);
		expect(cues[0].text).toBe("Hello world");
	});

	it("strips HTML tags", () => {
		const srt = `1\n00:00:01,000 --> 00:00:02,000\n<i>Italic text</i>\n\n`;
		const cues = parseSrt(srt);
		expect(cues[0].text).toBe("Italic text");
	});

	it("strips tags that have attributes", () => {
		const srt = `1\n00:00:01,000 --> 00:00:02,000\n<font color="#ffff00">Yellow</font>\n\n`;
		expect(parseSrt(srt)[0].text).toBe("Yellow");
	});

	it("keeps a < that has no closing >", () => {
		const srt = `1\n00:00:01,000 --> 00:00:02,000\nI <3 you\n\n`;
		expect(parseSrt(srt)[0].text).toBe("I <3 you");
	});

	it("keeps the rest of a line after a < with no > after it", () => {
		const srt = `1\n00:00:01,000 --> 00:00:02,000\n<i>Hi</i> <3 <3\n\n`;
		expect(parseSrt(srt)[0].text).toBe("Hi <3 <3");
	});

	it("keeps a <> with nothing in it", () => {
		const srt = `1\n00:00:01,000 --> 00:00:02,000\nLeft <> right\n<><i>Hi</i>\n\n`;
		expect(parseSrt(srt)[0].text).toBe("Left <> right\n<>Hi");
	});

	it("strips tags that sit next to each other", () => {
		const srt = `1\n00:00:01,000 --> 00:00:02,000\n<b><i>Both</i></b>\n\n`;
		expect(parseSrt(srt)[0].text).toBe("Both");
	});

	it("strips a tag with a < inside it", () => {
		const srt = `1\n00:00:01,000 --> 00:00:02,000\nx <<i>y\n\n`;
		expect(parseSrt(srt)[0].text).toBe("x y");
	});

	// A diff of a wrong cue would print the whole line, so these two compare
	// the text without one.
	it("keeps a long run of < with no > quickly", () => {
		// A pattern that backtracks over the run would take seconds here.
		const line = "<".repeat(200_000) + "Hi";
		const started = performance.now();
		const cues = parseSrt(`00:00:01,000 --> 00:00:02,000\n${line}\n`);
		expect(performance.now() - started).toBeLessThan(1000);
		expect(cues.map((cue) => [cue.start, cue.end])).toEqual([[1, 2]]);
		expect(cues[0].text === line).toBe(true);
	});

	it("keeps many < after a tag quickly", () => {
		// A walk that looks for a > from every < would take seconds here, and
		// a pattern that backtracks over them far longer. Each < is on its
		// own, so a walk that skips over a run of them is slow too.
		const rest = " <".repeat(500_000);
		const started = performance.now();
		const cues = parseSrt(`00:00:01,000 --> 00:00:02,000\n<i>Hi</i>${rest}\n`);
		expect(performance.now() - started).toBeLessThan(1000);
		expect(cues.map((cue) => [cue.start, cue.end])).toEqual([[1, 2]]);
		expect(cues[0].text === `Hi${rest}`).toBe(true);
	});

	it("joins multi-line text with newline", () => {
		const srt = `1\n00:00:01,000 --> 00:00:04,000\nLine one\nLine two\n\n`;
		const cues = parseSrt(srt);
		expect(cues[0].text).toBe("Line one\nLine two");
	});

	it("handles multiple blocks", () => {
		const srt = `1\n00:00:01,000 --> 00:00:02,000\nFirst\n\n2\n00:00:05,000 --> 00:00:07,500\nSecond\n\n`;
		const cues = parseSrt(srt);
		expect(cues).toHaveLength(2);
		expect(cues[1].start).toBeCloseTo(5.0);
		expect(cues[1].end).toBeCloseTo(7.5);
		expect(cues[1].text).toBe("Second");
	});

	it("skips blocks without timestamps", () => {
		const srt = `1\nJust some text without arrow\n\n2\n00:00:01,000 --> 00:00:02,000\nValid\n\n`;
		const cues = parseSrt(srt);
		expect(cues).toHaveLength(1);
		expect(cues[0].text).toBe("Valid");
	});

	it("handles dot as millisecond separator", () => {
		const srt = `1\n00:00:01.500 --> 00:00:03.750\nHello\n\n`;
		const cues = parseSrt(srt);
		expect(cues[0].start).toBeCloseTo(1.5);
		expect(cues[0].end).toBeCloseTo(3.75);
	});

	it("returns empty array for empty input", () => {
		expect(parseSrt("")).toHaveLength(0);
	});

	it("skips blocks where end <= start", () => {
		const srt = `1\n00:00:03,000 --> 00:00:01,000\nBackwards\n\n`;
		expect(parseSrt(srt)).toHaveLength(0);
	});

	it("skips a cue that ends when it starts", () => {
		const srt = `1\n00:00:02,000 --> 00:00:02,000\nNo time on screen\n\n`;
		expect(parseSrt(srt)).toHaveLength(0);
	});

	it("reads the hours and minutes of a timestamp", () => {
		const srt = `1\n01:02:03,450 --> 01:02:05,000\nLate in the film\n\n`;
		const [cue] = parseSrt(srt);
		expect(cue.start).toBeCloseTo(3723.45);
		expect(cue.end).toBeCloseTo(3725);
	});

	it("keeps a timing line whose start or end can't be read as text, as FFmpeg does", () => {
		const srt =
			`1\n00:00:01,000 --> 00:00:02,000\nFirst\n\n` +
			`2\n00:00:xx,000 --> 00:00:04,000\nBad start\n\n` +
			`3\n00:00:05,000 --> 00:00:yy,000\nBad end\n\n` +
			`4\n00:00:07,000 --> 00:00:08,000\nGood\n`;
		expect(parseSrt(srt)).toEqual([
			{
				start: 1,
				end: 2,
				text:
					"First\n2\n00:00:xx,000 --> 00:00:04,000\nBad start\n" +
					"3\n00:00:05,000 --> 00:00:yy,000\nBad end",
			},
			{ start: 7, end: 8, text: "Good" },
		]);
	});

	it("reads a time without hours in WebVTT only", () => {
		const srt = `1\n00:00:00,500 --> 00:00:00,900\nA\n\n2\n00:01,000 --> 01:02,500\nB\n`;
		expect(parseSrt(srt)).toEqual([
			{ start: 0.5, end: 0.9, text: "A\n2\n00:01,000 --> 01:02,500\nB" },
		]);
		const vtt = `WEBVTT\n\n00:01.000 --> 01:02.500\nNo hours\n`;
		expect(parseSrt(vtt)).toEqual([{ start: 1, end: 62.5, text: "No hours" }]);
	});

	it("reads a WebVTT time only with a period before the milliseconds", () => {
		const vtt =
			`WEBVTT\n\n00:01.000 --> 00:02.000\nA\n` +
			`00:03,000 --> 00:04.000\n00:00:05.000 --> 00:00:06,000\n\n` +
			`00:07,000 --> 00:08.000\nB\n\n00:09.000 --> 00:10.000\nC\n`;
		expect(parseSrt(vtt)).toEqual([
			{ start: 1, end: 2, text: "A\n00:03,000 --> 00:04.000\n00:00:05.000 --> 00:00:06,000" },
			{ start: 9, end: 10, text: "C" },
		]);
	});

	it("reads the milliseconds as a whole number, as FFmpeg does", () => {
		const srt =
			`1\n00:00:01,5 --> 00:00:02,25\nShort\n\n` +
			`2\n00:00:03,0005 --> 00:00:04,1500\nLong\n`;
		const cues = parseSrt(srt);
		expect(cues.map((c) => c.text)).toEqual(["Short", "Long"]);
		expect(cues[0].start).toBeCloseTo(1.005, 6);
		expect(cues[0].end).toBeCloseTo(2.025, 6);
		expect(cues[1].start).toBeCloseTo(3.005, 6);
		expect(cues[1].end).toBeCloseTo(5.5, 6);
	});

	it("keeps a timing line with no milliseconds as text", () => {
		const srt =
			`1\n00:00:01,000 --> 00:00:02,000\nA\n` +
			`00:00:03 --> 00:00:04\n00:00:05,000 --> 00:00:06\n00:00:07 --> 00:00:08,000\n`;
		expect(parseSrt(srt)).toEqual([
			{
				start: 1,
				end: 2,
				text: "A\n00:00:03 --> 00:00:04\n00:00:05,000 --> 00:00:06\n00:00:07 --> 00:00:08,000",
			},
		]);
	});

	it("reads a WebVTT file", () => {
		const vtt =
			`WEBVTT\n\n00:01.000 --> 00:04.000 align:start\nHello\n\n` +
			`00:01:05.000 --> 00:01:06.000\nThere\n`;
		expect(parseSrt(vtt)).toEqual([
			{ start: 1, end: 4, text: "Hello" },
			{ start: 65, end: 66, text: "There" },
		]);
	});

	it("keeps a timing line with a time of one part or four as text", () => {
		const srt =
			`1\n00:00:01,000 --> 00:00:02,000\nA\n` +
			`02,000 --> 00:00:03,000\n00:00:03,000 --> 04,000\n` +
			`00:00:00:05,000 --> 00:00:06,000\n00:00:07,000 --> 00:00:00:08,000\n\n` +
			`2\n00:00:09,000 --> 00:00:10,000\nB\n`;
		expect(parseSrt(srt)).toEqual([
			{
				start: 1,
				end: 2,
				text:
					"A\n02,000 --> 00:00:03,000\n00:00:03,000 --> 04,000\n" +
					"00:00:00:05,000 --> 00:00:06,000\n00:00:07,000 --> 00:00:00:08,000",
			},
			{ start: 9, end: 10, text: "B" },
		]);
	});

	it("keeps two cues apart across lines of spaces and tabs", () => {
		const srt =
			`1\n00:00:01,000 --> 00:00:02,000\nFirst\n \t \n\t\n  \n` +
			`2\n00:00:03,000 --> 00:00:04,000\nSecond\n`;
		expect(parseSrt(srt)).toEqual([
			{ start: 1, end: 2, text: "First" },
			{ start: 3, end: 4, text: "Second" },
		]);
	});

	it("keeps two cues apart across a run of blank lines and lines of spaces", () => {
		const srt =
			`1\r\n00:00:01,000 --> 00:00:02,000\r\nFirst\r\n \r\n\r\n\t\r\n` +
			`2\r\n00:00:03,000 --> 00:00:04,000\r\nSecond\r\n`;
		expect(parseSrt(srt)).toEqual([
			{ start: 1, end: 2, text: "First" },
			{ start: 3, end: 4, text: "Second" },
		]);
	});

	it.each([
		{ name: "an empty line", line: "" },
		{ name: "a line of spaces and tabs", line: " \t " },
		{ name: "a line with a no-break space", line: "\u00a0" },
	])("keeps the text after $name inside a cue", ({ line }) => {
		const srt =
			`1\n00:00:01,000 --> 00:00:02,000\nLine one\n${line}\nLine two\n\n` +
			`2\n00:00:03,000 --> 00:00:04,000\nNext\n`;
		expect(parseSrt(srt)).toEqual([
			{ start: 1, end: 2, text: "Line one\nLine two" },
			{ start: 3, end: 4, text: "Next" },
		]);
	});

	it("keeps two cues apart with no blank line between them", () => {
		const srt =
			`1\n00:00:01,000 --> 00:00:02,000\nFirst\n` +
			`2\n00:00:03,000 --> 00:00:04,000\nSecond`;
		expect(parseSrt(srt)).toEqual([
			{ start: 1, end: 2, text: "First" },
			{ start: 3, end: 4, text: "Second" },
		]);
	});

	it("drops a cue number with spaces around it or more than one digit", () => {
		const srt =
			`9\n00:00:01,000 --> 00:00:02,000\nFirst\n\n` +
			`  10  \n00:00:03,000 --> 00:00:04,000\nSecond\n`;
		expect(parseSrt(srt).map((c) => c.text)).toEqual(["First", "Second"]);
	});

	it("drops a cue number that has blank lines after it", () => {
		const srt =
			`1\n00:00:01,000 --> 00:00:02,000\nFirst\n\n` +
			`2\n\n \n00:00:03,000 --> 00:00:04,000\nSecond\n`;
		expect(parseSrt(srt).map((c) => c.text)).toEqual(["First", "Second"]);
	});

	it("drops a cue number with a sign before it, as FFmpeg does", () => {
		const srt =
			`1\n00:00:01,000 --> 00:00:02,000\nA\n+2\n00:00:03,000 --> 00:00:04,000\nB\n` +
			`-0\n00:00:05,000 --> 00:00:06,000\nC\n\v\f+4\f\n00:00:07,000 --> 00:00:08,000\n+5\n` +
			`00:00:09,000 --> 00:00:10,000\nE\n0\n00:00:11,000 --> 00:00:12,000\nF\n`;
		expect(parseSrt(srt)).toEqual([
			{ start: 1, end: 2, text: "A" },
			{ start: 3, end: 4, text: "B" },
			{ start: 5, end: 6, text: "C" },
			{ start: 9, end: 10, text: "E" },
			{ start: 11, end: 12, text: "F" },
		]);
	});

	it("keeps a number below 0, or after a no-break space, as text", () => {
		const srt =
			`1\n00:00:01,000 --> 00:00:02,000\nA\n-2\n00:00:03,000 --> 00:00:04,000\nB\n` +
			`\u00a03\n00:00:05,000 --> 00:00:06,000\nC\n+ 4\n00:00:07,000 --> 00:00:08,000\nD\n`;
		expect(parseSrt(srt)).toEqual([
			{ start: 1, end: 2, text: "A\n-2" },
			{ start: 3, end: 4, text: "B\n3" },
			{ start: 5, end: 6, text: "C\n+ 4" },
			{ start: 7, end: 8, text: "D" },
		]);
	});

	it("keeps a line of text with an arrow in it", () => {
		const srt =
			`1\n00:00:01,000 --> 00:00:02,000\nGo --> there\n3 cats --> home\n` +
			`Meet at 10:30 --> the station\nMoved from 10:30, now --> 11:15, sorry\n10:30 is too late\n\n` +
			`2\n  00:00:03,000 --> 00:00:04,000\n<!-- note -->Hi\n`;
		expect(parseSrt(srt)).toEqual([
			{
				start: 1,
				end: 2,
				text:
					"Go --> there\n3 cats --> home\nMeet at 10:30 --> the station\n" +
					"Moved from 10:30, now --> 11:15, sorry\n10:30 is too late",
			},
			{ start: 3, end: 4, text: "Hi" },
		]);
	});

	it("keeps a line that starts with numbers and has an arrow as text", () => {
		const srt =
			`2\n00:00:03,000 --> 00:00:04,000\n3, 2, 1 --> go!\n1. Left --> right\n` +
			`10:00 --> 11:00\nnow\n`;
		expect(parseSrt(srt)).toEqual([
			{ start: 3, end: 4, text: "3, 2, 1 --> go!\n1. Left --> right\n10:00 --> 11:00\nnow" },
		]);
	});

	it("keeps a line that starts like a time and has no time after its arrow", () => {
		const srt =
			`1\n00:00:01,000 --> 00:00:02,000\nA\n10:30, go --> left\n` +
			`10:30: Arrival --> platform 3\n16:9, 4:3 --> crop\n-10:30, then --> go\n` +
			`12:00, lunch --> 1 hour\n12:00, then --> 3, 2, 1\n4:3, 16:9 --> 2.39:1\n` +
			`12:00. Meeting --> 13:00 lunch\n9:30, 10:15 --> 11:00, 11:45\n` +
			`00:00:03,000 --> 02,000\nB\n\n2\n00:00:03,000 --> 00:00:04,000\nC\n`;
		expect(parseSrt(srt)).toEqual([
			{
				start: 1,
				end: 2,
				text:
					"A\n10:30, go --> left\n10:30: Arrival --> platform 3\n16:9, 4:3 --> crop\n" +
					"-10:30, then --> go\n12:00, lunch --> 1 hour\n12:00, then --> 3, 2, 1\n" +
					"4:3, 16:9 --> 2.39:1\n12:00. Meeting --> 13:00 lunch\n" +
					"9:30, 10:15 --> 11:00, 11:45\n00:00:03,000 --> 02,000\nB",
			},
			{ start: 3, end: 4, text: "C" },
		]);
	});

	it("keeps a line that starts like a time but has no arrow", () => {
		const srt = `1\n00:00:01,000 --> 00:00:02,000\n12:30, not yet\n00:00:03 is late\n`;
		expect(parseSrt(srt)).toEqual([
			{ start: 1, end: 2, text: "12:30, not yet\n00:00:03 is late" },
		]);
	});

	it("reads a timing line with a minus or plus sign before a time", () => {
		const srt =
			`1\n00:00:01,000 --> 00:00:02,000\nA\n\n` +
			`2\n-00:00:03,000 --> 00:00:04,000\nB\n\n` +
			`3\n00:00:05,000 --> -00:00:06,000\nC\n\n` +
			`4\n+00:00:07,000 --> 00:00:08,000\nD\n\n` +
			`5\n00:00:09,000 --> +00:00:10,000\nE\n\n`;
		expect(parseSrt(srt)).toEqual([
			{ start: 1, end: 2, text: "A" },
			{ start: 3, end: 4, text: "B" },
			{ start: 5, end: 6, text: "C" },
			{ start: 7, end: 8, text: "D" },
			{ start: 9, end: 10, text: "E" },
		]);
	});

	it("reads a timing line with no spaces or extra spaces around its arrow", () => {
		const srt =
			`1\n00:00:01,000-->00:00:02,000\nA\n\n` + `2\n00:00:03,000  -->   00:00:04,000\nB\n`;
		expect(parseSrt(srt)).toEqual([
			{ start: 1, end: 2, text: "A" },
			{ start: 3, end: 4, text: "B" },
		]);
	});

	it("shows text after the last cue with that cue, as mpv does", () => {
		const srt = `1\n00:00:01,000 --> 00:00:02,000\nLast\n\n\nSubs by X\n`;
		expect(parseSrt(srt)).toEqual([{ start: 1, end: 2, text: "Last\nSubs by X" }]);
	});

	it("skips a cue with no text after its timing line", () => {
		expect(parseSrt(`1\n00:00:01,000 --> 00:00:02,000\n`)).toEqual([]);
	});

	it("keeps a line with a number and words before the next timing line", () => {
		const srt =
			`00:00:01,000 --> 00:00:02,000\nCount to 3\n` +
			`00:00:03,000 --> 00:00:04,000\n3 cats\n` +
			`00:00:05,000 --> 00:00:06,000\nHello\n3 cats\n` +
			`00:00:07,000 --> 00:00:08,000\nLast\n`;
		expect(parseSrt(srt).map((c) => c.text)).toEqual([
			"Count to 3",
			"3 cats",
			"Hello\n3 cats",
			"Last",
		]);
	});

	it("keeps a number that isn't right before a timing line", () => {
		const srt =
			`1\n00:00:01,000 --> 00:00:02,000\nThe answer is\n42\n\n` +
			`2\n00:00:03,000 --> 00:00:04,000\nCount down from\n10`;
		expect(parseSrt(srt).map((c) => c.text)).toEqual([
			"The answer is\n42",
			"Count down from\n10",
		]);
	});

	it("reads a timing line with spaces after a colon, a comma or a period", () => {
		const srt =
			`1\n00:00:05,000 --> 00:01: 06,000\nA\n\n` +
			`2\n00:02:07,000 --> 00: 02:08,000\nB\n\n` +
			`3\n00:02:09, 000 --> 00:02:10. 500\nC\n\n` +
			`4\n00: 02: 11,000 --> \t00:\t02:\t12,000\nD\n`;
		expect(parseSrt(srt)).toEqual([
			{ start: 5, end: 66, text: "A" },
			{ start: 127, end: 128, text: "B" },
			{ start: 129, end: 130.5, text: "C" },
			{ start: 131, end: 132, text: "D" },
		]);
	});

	it("reads a timing line with a vertical tab or a form feed before a number", () => {
		const srt =
			`1\n\v00:00:01,000 -->\f00:\v00:02,\f000\nA\n\n` +
			`2\n00:00:03,000\v-->\f00:00:04,000\nB\n`;
		expect(parseSrt(srt)).toEqual([
			{ start: 1, end: 2, text: "A" },
			{ start: 3, end: 4, text: "B" },
		]);
	});

	it("keeps a timing line with a space before a colon, a comma or a period as text", () => {
		const srt =
			`1\n00:00:01,000 --> 00:00:02,000\nA\n` +
			`00 :00:03,000 --> 00:00:04,000\n00:00:05 ,000 --> 00:00:06,000\n` +
			`00:00:07,000 --> 00:00 :08,000\n00:00:09,000 --> 00:00:10 .000\n` +
			`00: :11,000 --> 00:00:12,000\n\n` +
			`2\n00:00:13,000 --> 00:00:14,000\nB\n`;
		expect(parseSrt(srt)).toEqual([
			{
				start: 1,
				end: 2,
				text:
					"A\n00 :00:03,000 --> 00:00:04,000\n00:00:05 ,000 --> 00:00:06,000\n" +
					"00:00:07,000 --> 00:00 :08,000\n00:00:09,000 --> 00:00:10 .000\n" +
					"00: :11,000 --> 00:00:12,000",
			},
			{ start: 13, end: 14, text: "B" },
		]);
	});

	it("keeps a timing line with a no-break space or a byte order mark in it as text", () => {
		const srt =
			`1\n00:00:01,000 --> 00:00:02,000\nA\n` +
			`\u00a000:00:03,000 --> 00:00:04,000\n00:00:05,000\u00a0--> 00:00:06,000\n` +
			`00:00:07,000 -->\u00a000:00:08,000\n\uFEFF00:00:09,000 --> 00:00:10,000\n`;
		expect(parseSrt(srt)).toEqual([
			{
				start: 1,
				end: 2,
				text:
					"A\n00:00:03,000 --> 00:00:04,000\n00:00:05,000\u00a0--> 00:00:06,000\n" +
					"00:00:07,000 -->\u00a000:00:08,000\n00:00:09,000 --> 00:00:10,000",
			},
		]);
	});

	it("reads a WebVTT setting after a tab", () => {
		const vtt = `WEBVTT\n\n00:01.000 --> 00:02.000\tline:90%\nLow\n`;
		expect(parseSrt(vtt)).toEqual([{ start: 1, end: 2, text: "Low" }]);
	});

	it("reads a WebVTT timing line with text before its arrow, as FFmpeg does", () => {
		const vtt =
			`WEBVTT\n\n00:01.000x --> 00:02.000\nA\n01:00.000 and counting\n\n` +
			`00:03.000 garbage --> 00:04.000\nB\n\n00:05.000\u00a0--> 00:06.000\nC\n\n` +
			`00:07.000 <--> 00:08.000\nD\n\n00:09.000 ---> 00:10.000\nE\n`;
		expect(parseSrt(vtt)).toEqual([
			{ start: 1, end: 2, text: "A\n01:00.000 and counting" },
			{ start: 3, end: 4, text: "B" },
			{ start: 5, end: 6, text: "C" },
			{ start: 7, end: 8, text: "D" },
			{ start: 9, end: 10, text: "E" },
		]);
	});

	it("reads a WebVTT timing line with text before its arrow after the cue's name", () => {
		const vtt =
			`WEBVTT\n\nfirst\n00:01.000 x --> 00:02.000\nA\n\n` +
			`2\n00:03.000 garbage --> 00:04.000\nB\n`;
		expect(parseSrt(vtt)).toEqual([
			{ start: 1, end: 2, text: "A" },
			{ start: 3, end: 4, text: "B" },
		]);
	});

	it("keeps a WebVTT text line with text before its arrow as text, as FFmpeg does", () => {
		const vtt =
			`WEBVTT\n\n00:01.000 --> 00:02.000\n00:30.000 go --> 00:40.000\nA\n` +
			`1:30.5 in --> 2:00.0 out\n00:05.000 go --> 00:05.000\nmore\n`;
		expect(parseSrt(vtt)).toEqual([
			{
				start: 1,
				end: 2,
				text: "00:30.000 go --> 00:40.000\nA\n1:30.5 in --> 2:00.0 out\n00:05.000 go --> 00:05.000\nmore",
			},
		]);
	});

	it("keeps a WebVTT text line that's only a time as text", () => {
		const vtt = `WEBVTT\n\n00:01.000 --> 00:02.000\nLap\n100:00.000\nTotal\n  1:00.000\nEnd\n`;
		expect(parseSrt(vtt)).toEqual([
			{ start: 1, end: 2, text: "Lap\n100:00.000\nTotal\n1:00.000\nEnd" },
		]);
	});

	it("reads the end time of a WebVTT timing line after its first arrow", () => {
		const vtt =
			`WEBVTT\n\n00:01.000 --> 00:02.000 --> 00:09.000\nA\n\n` +
			`00:03.000 --> x --> 00:04.000\nB\n\n00:05.000 --> 00:06.000\nC\n`;
		expect(parseSrt(vtt)).toEqual([
			{ start: 1, end: 2, text: "A" },
			{ start: 5, end: 6, text: "C" },
		]);
	});

	it("skips a WebVTT cue whose timing line can't be read and shows the cues after it", () => {
		const vtt =
			`WEBVTT\n\n00:01.000 --> 00:02.000\nA\n\nx00:03.000 --> 00:04.000\nB\n\n` +
			`00:05.000 -->\u00a000:06.000\nC\n\n00:07.000 -- > 00:08.000\nD\n\n` +
			`00:09.000 --> 00:10.000\nE\n`;
		expect(parseSrt(vtt)).toEqual([
			{ start: 1, end: 2, text: "A" },
			{ start: 9, end: 10, text: "E" },
		]);
	});

	it("reads a file as WebVTT only when it starts with WEBVTT", () => {
		const vtt = ` WEBVTT\n\n00:01.000 --> 00:02.000\nA\n`;
		expect(parseSrt(vtt)).toEqual([]);
	});

	it("ends a WebVTT cue at its first empty line", () => {
		const vtt =
			`WEBVTT - Episode 1\n\n00:01.000 --> 00:04.000\nHello\n\n` +
			`NOTE The next cue is said off screen\n\n` +
			`outro\n00:05.000 --> 00:06.000\nThere\n \nStill there`;
		expect(parseSrt(vtt)).toEqual([
			{ start: 1, end: 4, text: "Hello" },
			{ start: 5, end: 6, text: "There\nStill there" },
		]);
	});

	it("keeps a WebVTT cue whose text is only a number", () => {
		const vtt =
			`WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n3\n\n` +
			`00:00:03.000 --> 00:00:04.000\n1984\n\n2\n` +
			`00:00:05.000 --> 00:00:06.000\n1\n`;
		expect(parseSrt(vtt).map((c) => c.text)).toEqual(["3", "1984", "1"]);
	});

	it("keeps a WebVTT cue that's only a number with a line of spaces after it", () => {
		const vtt =
			`WEBVTT\n\n00:01.000 --> 00:02.000\n3\n  \n` +
			`00:03.000 --> 00:04.000\n2\n\t\n00:05.000 --> 00:06.000\n1\n`;
		expect(parseSrt(vtt).map((c) => c.text)).toEqual(["3", "2", "1"]);
	});

	it.each([
		{ name: "a line of spaces", gap: "  \n" },
		{ name: "no line", gap: "" },
	])("drops the next WebVTT cue's name after $name in place of an empty one", ({ gap }) => {
		const vtt =
			`WEBVTT\n\n1\n00:01.000 --> 00:02.000\nHello\n${gap}` +
			`2\n00:03.000 --> 00:04.000\nWorld\n`;
		expect(parseSrt(vtt)).toEqual([
			{ start: 1, end: 2, text: "Hello" },
			{ start: 3, end: 4, text: "World" },
		]);
	});

	it("ends a WebVTT cue at an empty line in a file with only carriage returns", () => {
		const vtt =
			"WEBVTT\r\r00:01.000 --> 00:04.000\rHello\r\rNOTE Not shown\r\r" +
			"outro\r00:05.000 --> 00:06.000\rThere\r";
		expect(parseSrt(vtt)).toEqual([
			{ start: 1, end: 4, text: "Hello" },
			{ start: 5, end: 6, text: "There" },
		]);
	});

	it.each([
		{ name: "an SRT file", content: "\uFEFF00:00:01,000 --> 00:00:02,000\nHello\n" },
		{
			name: "an SRT file with blank lines first",
			content: "\uFEFF\n\n1\n00:00:01,000 --> 00:00:02,000\nHello\n",
		},
		{
			name: "a WebVTT file",
			content: "\uFEFFWEBVTT\n\n00:01.000 --> 00:02.000\nHello\n\nNOTE Not shown\n",
		},
	])("reads $name that starts with a byte order mark", ({ content }) => {
		expect(parseSrt(content)).toEqual([{ start: 1, end: 2, text: "Hello" }]);
	});

	it("reads a cue with position values after its end time", () => {
		const srt = `1\n00:00:01,000 --> 00:00:02,000  X1:100 X2:600 Y1:50 Y2:80\nPlaced\n\n`;
		expect(parseSrt(srt)).toEqual([{ start: 1, end: 2, text: "Placed" }]);
	});

	it("reads the first two times of a timing line with more than one arrow", () => {
		const srt = `1\n00:00:01,000 --> 00:00:02,000 --> 00:00:03,000\nConfused\n\n`;
		expect(parseSrt(srt)).toEqual([{ start: 1, end: 2, text: "Confused" }]);
	});

	it("parses a block that has no cue number", () => {
		const srt = `00:00:01,000 --> 00:00:02,000\nNo number\n\n`;
		expect(parseSrt(srt)).toEqual([{ start: 1, end: 2, text: "No number" }]);
	});

	it("trims the spaces around each line of text", () => {
		const srt = `1\n00:00:01,000 --> 00:00:02,000\n  Line one  \n <i>Line two</i> \n\n`;
		expect(parseSrt(srt)[0].text).toBe("Line one\nLine two");
	});

	it("drops lines that are empty once the tags and spaces are gone", () => {
		const srt = `1\n00:00:01,000 --> 00:00:02,000\n<i></i>\n<b> </b>\nSpoken line\n\n`;
		expect(parseSrt(srt)[0].text).toBe("Spoken line");
	});

	it("skips a cue with no text left once the tags are gone", () => {
		const srt = `1\n00:00:01,000 --> 00:00:02,000\n<font color="#ffffff"></font>\n\n`;
		expect(parseSrt(srt)).toHaveLength(0);
	});

	const lineEndings = [
		{ name: "Windows", eol: "\r\n" },
		{ name: "classic Mac", eol: "\r" },
		{ name: "twice converted", eol: "\r\r\n" },
		{ name: "three times converted", eol: "\r\r\r\n" },
	];
	const twoCues = [
		"1",
		"00:00:01,000 --> 00:00:02,000",
		"First line",
		"Second line",
		"",
		"2",
		"00:00:03,000 --> 00:00:04,000",
		"Next cue",
		"",
	];
	const twoCuesRead = [
		{ start: 1, end: 2, text: "First line\nSecond line" },
		{ start: 3, end: 4, text: "Next cue" },
	];

	it.each(lineEndings)("reads SRT files with $name line endings", ({ eol }) => {
		expect(parseSrt(twoCues.join(eol))).toEqual(twoCuesRead);
	});

	it.each(lineEndings)("reads WebVTT files with $name line endings", ({ eol }) => {
		const vtt = ["WEBVTT", "", ...twoCues.map((line) => line.replaceAll(",", "."))].join(eol);
		expect(parseSrt(vtt)).toEqual(twoCuesRead);
	});

	it("reads a file that mixes its line endings", () => {
		const srt =
			"1\n00:00:01,000 --> 00:00:02,000\r\r\nFirst\r\r\n2\r" +
			"00:00:03,000 --> 00:00:04,000\nSecond\r\n";
		expect(parseSrt(srt)).toEqual([
			{ start: 1, end: 2, text: "First" },
			{ start: 3, end: 4, text: "Second" },
		]);
	});

	it.each([
		{ name: "a file with line feeds", end: "\n" },
		{ name: "a file without line feeds", end: "" },
	])("reads a long run of carriage returns in $name quickly", ({ end }) => {
		// A pattern that backtracks over the run would take seconds here.
		const srt = "00:00:01,000 --> 00:00:02,000" + "\r".repeat(200_000) + "Hi" + end;
		const started = performance.now();
		expect(parseSrt(srt)).toEqual([{ start: 1, end: 2, text: "Hi" }]);
		expect(performance.now() - started).toBeLessThan(1000);
	});
});
