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

	it.each([
		{ name: "Windows", eol: "\r\n" },
		{ name: "classic Mac", eol: "\r" },
	])("reads files with $name line endings", ({ eol }) => {
		const srt = [
			"1",
			"00:00:01,000 --> 00:00:02,000",
			"First line",
			"Second line",
			"",
			"2",
			"00:00:03,000 --> 00:00:04,000",
			"Next cue",
			"",
		].join(eol);
		expect(parseSrt(srt)).toEqual([
			{ start: 1, end: 2, text: "First line\nSecond line" },
			{ start: 3, end: 4, text: "Next cue" },
		]);
	});
});
