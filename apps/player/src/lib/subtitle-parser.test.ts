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
});
