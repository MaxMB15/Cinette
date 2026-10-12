// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { AggregateDownloadState, DownloadIconState, DownloadRecord } from "./types";

/**
 * Whether a movie or episode download is waiting its turn or running, so it
 * can still be stopped. A recording waits and runs under its own statuses,
 * which `isActiveRecording` checks.
 */
export const isActiveDownload = ({ status }: Pick<DownloadRecord, "status">): boolean =>
	status === "downloading" || status === "queued";

/**
 * The download button's state for a movie or episode, from the download
 * `groupDownloads` keeps for it, if it has one. A finished download wins over
 * a newer try. A cancelled download shows as idle, so the button starts it
 * again.
 */
export const downloadIconState = (
	download: Pick<DownloadRecord, "status"> | undefined
): DownloadIconState => {
	if (!download) return "idle";
	if (download.status === "completed") return "complete";
	if (isActiveDownload(download)) return "downloading";
	if (download.status === "failed") return "failed";
	return "idle";
};

/** The download button's state for a series or one of its seasons. */
export const aggregateIconState = (state: AggregateDownloadState): DownloadIconState =>
	state === "none" ? "idle" : state;
