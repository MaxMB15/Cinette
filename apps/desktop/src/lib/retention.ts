// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { DownloadRecord } from "./types";

const DAY_SECS = 24 * 60 * 60;

/** Choices for "Delete downloads after", in days. 0 keeps downloads until removed. */
export const RETENTION_OPTIONS = [
	{ value: 0, label: "Never" },
	{ value: 7, label: "7 days" },
	{ value: 14, label: "14 days" },
	{ value: 30, label: "30 days" },
	{ value: 90, label: "90 days" },
];

/**
 * When the retention setting deletes `rec`, in Unix seconds, or null if it
 * never will. Matches `delete_at` in `crates/core/src/downloads/retention.rs`,
 * which does the deleting: the count starts when the download finished and
 * starts over each time it's played.
 */
export const deleteAt = (rec: DownloadRecord, days: number | null): number | null => {
	if (!days || rec.keep || rec.status !== "completed") return null;
	const since = Math.max(rec.finishedAt ?? rec.createdAt, rec.lastPlayedAt ?? 0);
	return since + days * DAY_SECS;
};

/** "Deletes in 3 days" for a deletion time `at`, both in Unix seconds. */
export const deleteLabel = (at: number, now: number): string => {
	const days = Math.ceil((at - now) / DAY_SECS);
	if (days <= 0) return "Deletes soon";
	return days === 1 ? "Deletes in 1 day" : `Deletes in ${days} days`;
};

export type RetentionSummary = { state: "none" } | { state: "kept" } | { state: "due"; at: number };

/**
 * What the retention setting will do to a set of downloads: a movie, an
 * episode, or every episode of a series. Downloads the user kept are left out,
 * so `due` gives the soonest deletion among the rest. `kept` means every
 * finished download in the set is kept.
 */
export const summarize = (records: DownloadRecord[], days: number | null): RetentionSummary => {
	const finished = records.filter((r) => r.status === "completed");
	if (!days || finished.length === 0) return { state: "none" };
	const dates = finished.map((r) => deleteAt(r, days)).filter((at): at is number => at !== null);
	if (dates.length === 0) return { state: "kept" };
	return { state: "due", at: Math.min(...dates) };
};
