// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { DownloadRecord } from "./types";

/**
 * How far along a download is, from 0 to 100, or null when the server didn't
 * give the video's size, as for an HLS stream. ffmpeg writes the file again as
 * it saves it, so it can end up a little larger than that size, and this stops
 * at 100.
 */
export const downloadPercent = ({
	downloadedBytes,
	totalBytes,
}: Pick<DownloadRecord, "downloadedBytes" | "totalBytes">): number | null =>
	totalBytes ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : null;
