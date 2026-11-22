// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/** The current Unix time in whole seconds, the unit EPG times use. */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const parseDateMs = (value: string | null | undefined): number => {
	// Stryker disable next-line StringLiteral: Date.parse gives NaN for both "" and the text Stryker puts in, so this returns 0 either way.
	const ms = Date.parse(value ?? "");
	return isNaN(ms) ? 0 : ms;
};

/** How long ago `ms` was, in its largest whole unit, like "40 min ago" or "2 h ago". */
export const timeAgo = (ms: number, now: number): string => {
	const minutes = Math.floor((now - ms) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.floor(hours / 24);
	return days === 1 ? "yesterday" : `${days} days ago`;
};
