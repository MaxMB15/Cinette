// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { seriesTitleOf } from "./channels";
import type { Channel } from "./types";

/** Positions earlier than this aren't worth offering a resume for. */
export const MIN_RESUME_SECONDS = 30;

const normalize = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Stable key identifying a movie or episode for resume tracking.
 *
 * Channel IDs are index-based (`{provider}-ch-{n}`) and shift when a playlist
 * is refreshed, and the URL changes when the user picks a different source, so
 * neither is a reliable key. The title (plus season/episode for series) is.
 * Returns null for live channels, which have no resumable position.
 */
export const playbackKey = (ch: Channel): string | null => {
	if (ch.contentType === "live") return null;
	if (ch.contentType === "series" && ch.season != null && ch.episode != null) {
		const title = normalize(seriesTitleOf(ch));
		return `series:${title}:s${ch.season}e${ch.episode}`;
	}
	return `${ch.contentType}:${normalize(ch.name)}`;
};

/**
 * True when the position is close enough to the end that the item counts as
 * watched: within the last 5% (end credits) or the last 30 seconds.
 */
export const isFinished = (position: number, duration: number): boolean =>
	duration > 0 && (position >= duration * 0.95 || duration - position < 30);

/** Whether a saved position should trigger the "resume or start over" prompt. */
export const shouldOfferResume = (position: number, duration: number): boolean =>
	position >= MIN_RESUME_SECONDS && !isFinished(position, duration);
