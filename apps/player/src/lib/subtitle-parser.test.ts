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

	it("skips a block whose start or end can't be read", () => {
		const srt =
			`1\n00:00:xx,000 --> 00:00:02,000\nBad start\n\n` +
			`2\n00:00:03,000 --> 00:00:yy,000\nBad end\n\n` +
			`3\n00:00:05,000 --> 00:00:06,000\nGood\n\n`;
		expect(parseSrt(srt).map((c) => c.text)).toEqual(["Good"]);
	});

	it("reads a time without hours as minutes and seconds", () => {
		const srt = `1\n00:01,000 --> 01:02,500\nNo hours\n\n`;
		expect(parseSrt(srt)).toEqual([{ start: 1, end: 62.5, text: "No hours" }]);
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

	it("skips a block whose timestamp has one part or four", () => {
		const srt =
			`1\n01,000 --> 00:00:02,000\nOne part\n\n` +
			`1\n00:00:00:03,000 --> 00:00:04,000\nExtra start\n\n` +
			`2\n00:00:05,000 --> 00:00:00:06,000\nExtra end\n\n` +
			`3\n00:00:07,000 --> 00:00:08,000\nGood\n\n`;
		expect(parseSrt(srt).map((c) => c.text)).toEqual(["Good"]);
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

	it("keeps a line of text with an arrow in it", () => {
		const srt =
			`1\n00:00:01,000 --> 00:00:02,000\nGo --> there\n3 cats --> home\n` +
			`Meet at 10:30 --> the station\n10:30 is too late\n\n` +
			`2\n  00:00:03,000 --> 00:00:04,000\n<!-- note -->Hi\n`;
		expect(parseSrt(srt)).toEqual([
			{
				start: 1,
				end: 2,
				text: "Go --> there\n3 cats --> home\nMeet at 10:30 --> the station\n10:30 is too late",
			},
			{ start: 3, end: 4, text: "Hi" },
		]);
	});

	it("skips a cue with no text after its timing line", () => {
		expect(parseSrt(`1\n00:00:01,000 --> 00:00:02,000\n`)).toEqual([]);
	});

	it("keeps a line with a number and words before the next timing line", () => {
		const srt =
			`00:00:01,000 --> 00:00:02,000\nCount to 3\n` +
			`00:00:03,000 --> 00:00:04,000\n3 cats\n` +
			`00:00:05,000 --> 00:00:06,000\nLast\n`;
		expect(parseSrt(srt).map((c) => c.text)).toEqual(["Count to 3", "3 cats", "Last"]);
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

	it("ends a cue at a timing line that can't be read", () => {
		const srt =
			`1\n00:00:01,000 --> 00:00:02,000\nFirst\n\n` +
			`2\n00:00:xx,000 --> 00:00:04,000\nBad\n\n` +
			`3\n00:00:05,000 --> 00:00:06,000\nGood\n`;
		expect(parseSrt(srt).map((c) => c.text)).toEqual(["First", "Good"]);
	});

	it("skips a timing line with a blank part in a time", () => {
		const srt =
			`1\n00:00:01,000 --> 00:01: 05,000\nGap in the end\n\n` +
			`2\n00: :03,000 --> 00:00:04,000\nSpace for minutes\n\n` +
			`3\n00:00:05,000 --> 00:00:06,000\nGood\n`;
		expect(parseSrt(srt).map((c) => c.text)).toEqual(["Good"]);
	});

	it("reads a WebVTT setting after a tab", () => {
		const vtt = `WEBVTT\n\n00:01.000 --> 00:02.000\tline:90%\nLow\n`;
		expect(parseSrt(vtt)).toEqual([{ start: 1, end: 2, text: "Low" }]);
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
		{ name: "an SRT", content: "\uFEFF00:00:01,000 --> 00:00:02,000\nHello\n" },
		{
			name: "an SRT with blank lines first",
			content: "\uFEFF\n\n1\n00:00:01,000 --> 00:00:02,000\nHello\n",
		},
		{
			name: "a WebVTT",
			content: "\uFEFFWEBVTT\n\n00:01.000 --> 00:02.000\nHello\n\nNOTE Not shown\n",
		},
	])("reads $name file that starts with a byte order mark", ({ content }) => {
		expect(parseSrt(content)).toEqual([{ start: 1, end: 2, text: "Hello" }]);
	});

	it("reads a cue with position values after its end time", () => {
		const srt = `1\n00:00:01,000 --> 00:00:02,000  X1:100 X2:600 Y1:50 Y2:80\nPlaced\n\n`;
		expect(parseSrt(srt)).toEqual([{ start: 1, end: 2, text: "Placed" }]);
	});

	it("skips a timing line with more than one arrow", () => {
		const srt = `1\n00:00:01,000 --> 00:00:02,000 --> 00:00:03,000\nConfused\n\n`;
		expect(parseSrt(srt)).toHaveLength(0);
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
		const vtt = ["WEBVTT", "", ...twoCues.map((line) => line.replace(",", "."))].join(eol);
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

	it("reads a long run of carriage returns quickly", () => {
		// A pattern that backtracks over the run would take seconds here.
		const started = performance.now();
		expect(parseSrt("A" + "\r".repeat(200_000) + "x")).toEqual([]);
		expect(performance.now() - started).toBeLessThan(1000);
	});
});
