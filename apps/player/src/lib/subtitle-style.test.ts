// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it } from "vitest";
import {
	addSubtitleDelay,
	FONT_FAMILIES,
	formatSubtitleDelay,
	languageName,
	stepSubtitleSize,
} from "./subtitle-style";

describe("FONT_FAMILIES", () => {
	it("offers four fonts, each with a fallback", () => {
		expect(FONT_FAMILIES).toEqual([
			{ label: "Default", value: "system-ui, sans-serif" },
			{ label: "Sans-serif", value: "Arial, Helvetica, sans-serif" },
			{ label: "Serif", value: "Georgia, 'Times New Roman', serif" },
			{ label: "Monospace", value: "'Courier New', Courier, monospace" },
		]);
	});
});

describe("stepSubtitleSize", () => {
	it("moves two pixels at a time", () => {
		expect(stepSubtitleSize(20, 1)).toBe(22);
		expect(stepSubtitleSize(20, -1)).toBe(18);
	});

	it("stays between 12 and 40", () => {
		expect(stepSubtitleSize(40, 1)).toBe(40);
		expect(stepSubtitleSize(39, 1)).toBe(40);
		expect(stepSubtitleSize(12, -1)).toBe(12);
		expect(stepSubtitleSize(13, -1)).toBe(12);
	});
});

describe("addSubtitleDelay", () => {
	it("adds the seconds and takes them away", () => {
		expect(addSubtitleDelay(1, 0.5)).toBe(1.5);
		expect(addSubtitleDelay(1, -0.5)).toBe(0.5);
	});

	it("doesn't drift over repeated steps", () => {
		expect(addSubtitleDelay(0.1, 0.2)).toBe(0.3);
		expect(addSubtitleDelay(0.7, 0.1)).toBe(0.8);
	});
});

describe("formatSubtitleDelay", () => {
	it("gives a delay its sign", () => {
		expect(formatSubtitleDelay(0.5)).toBe("+0.5s");
		expect(formatSubtitleDelay(-0.5)).toBe("-0.5s");
	});

	it("gives no delay no sign", () => {
		expect(formatSubtitleDelay(0)).toBe("0.0s");
	});
});

describe("languageName", () => {
	it("names a language in the viewer's language", () => {
		const name = new Intl.DisplayNames(undefined, { type: "language" }).of("fr");
		expect(languageName("fr")).toBe(name);
		expect(languageName("fr")).not.toBe("fr");
	});

	it("gives back a code that isn't a language", () => {
		expect(languageName("not a language")).toBe("not a language");
	});
});
