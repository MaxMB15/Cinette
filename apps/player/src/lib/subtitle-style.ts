// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/** The fonts the subtitles can use. */
export const FONT_FAMILIES: { label: string; value: string }[] = [
	{ label: "Default", value: "system-ui, sans-serif" },
	{ label: "Sans-serif", value: "Arial, Helvetica, sans-serif" },
	{ label: "Serif", value: "Georgia, 'Times New Roman', serif" },
	{ label: "Monospace", value: "'Courier New', Courier, monospace" },
];

/** The next subtitle size up or down, which stays between 12 and 40. */
export const stepSubtitleSize = (size: number, direction: 1 | -1): number =>
	Math.min(40, Math.max(12, size + direction * 2));

/** `delay` moved by `seconds`, rounded so repeated steps don't drift. */
export const addSubtitleDelay = (delay: number, seconds: number): number =>
	Math.round((delay + seconds) * 10) / 10;

/** A subtitle delay with its sign, like +0.5s. */
export const formatSubtitleDelay = (delay: number): string =>
	`${delay > 0 ? "+" : ""}${delay.toFixed(1)}s`;

/** The language's name in the viewer's language, or its code when it has none. */
export const languageName = (code: string): string => {
	try {
		return new Intl.DisplayNames(undefined, { type: "language" }).of(code) ?? code;
	} catch {
		return code;
	}
};
