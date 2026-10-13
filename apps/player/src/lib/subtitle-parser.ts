// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { SubtitleCue } from "./types";

/** Parse "HH:MM:SS,mmm" or "HH:MM:SS.mmm" into seconds. */
const parseTimestamp = (ts: string): number => {
	const clean = ts.trim().replace(",", ".");
	const parts = clean.split(":");
	if (parts.length !== 3) return 0;
	const [h, m, s] = parts.map(Number);
	return h * 3600 + m * 60 + s;
};

/** Strip SRT/HTML tags (<i>, <b>, <font ...>, etc.) from subtitle text. */
const stripTags = (text: string): string => {
	return text.replace(/<[^>]+>/g, "").trim();
};

/** Parse SRT file content into an array of SubtitleCue objects. */
export const parseSrt = (content: string): SubtitleCue[] => {
	const cues: SubtitleCue[] = [];
	// Normalise line endings and split into blocks
	const blocks = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split(/\n\n+/);

	for (const block of blocks) {
		const lines = block.trim().split("\n");
		if (lines.length < 2) continue;

		// Find the timestamp line (contains "-->")
		const tsIdx = lines.findIndex((l) => l.includes("-->"));
		if (tsIdx === -1) continue;

		const tsParts = lines[tsIdx].split("-->");
		if (tsParts.length !== 2) continue;

		const start = parseTimestamp(tsParts[0]);
		const end = parseTimestamp(tsParts[1]);
		if (isNaN(start) || isNaN(end) || end <= start) continue;

		// Everything after the timestamp line is the subtitle text
		const text = lines
			.slice(tsIdx + 1)
			.map(stripTags)
			.filter(Boolean)
			.join("\n");

		if (!text) continue;
		cues.push({ start, end, text });
	}

	return cues;
};
