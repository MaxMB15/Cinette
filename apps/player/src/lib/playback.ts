// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { seriesTitleOf } from "./channels";
import { deletePlaybackPosition, markPositionFinished, savePlaybackPosition } from "./tauri";
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

/** How often (ms) watch progress is persisted while playing. */
export const PROGRESS_SAVE_INTERVAL = 5000;

/** Where a movie or episode got to, as a player keeps it until it's saved. */
export interface PlaybackProgress {
	/** Resume key (see playbackKey); null for live or nothing playing. */
	key: string | null;
	/** URL the progress belongs to — mpv state for any other URL is ignored. */
	url: string | null;
	position: number;
	duration: number;
	/** Position changed since the last save. */
	dirty: boolean;
	lastSaved: number;
	/**
	 * Resume point the load was started at. Until playback reaches it, earlier
	 * positions (mpv reporting the start of the file before the seek lands) are
	 * ignored so they can't overwrite or delete the saved resume point.
	 */
	pendingStart: number | null;
}

// Stryker disable next-line ObjectLiteral: With no key, saveProgress saves nothing and a player compares nothing, whatever the rest holds.
export const EMPTY_PROGRESS: PlaybackProgress = {
	key: null,
	url: null,
	position: 0,
	duration: 0,
	// Stryker disable next-line BooleanLiteral: With no key, saveProgress saves nothing, changed or not.
	dirty: false,
	lastSaved: 0,
	pendingStart: null,
};

export const progressFor = (ch: Channel, startPos?: number, url = ch.url): PlaybackProgress => ({
	key: playbackKey(ch),
	url,
	position: startPos ?? 0,
	duration: 0,
	dirty: false,
	lastSaved: Date.now(),
	pendingStart: startPos ?? null,
});

/**
 * Persists `p`'s position, if it moved since the last save. A finished item is
 * kept as finished, so it counts as watched and isn't offered to resume. One
 * rewound to the very start (e.g. "Start over") is forgotten, so it doesn't
 * keep offering a stale resume point.
 */
export const saveProgress = (p: PlaybackProgress): Promise<void> | undefined => {
	if (!p.key || !p.dirty || p.duration <= 0) return;
	p.dirty = false;
	p.lastSaved = Date.now();
	if (isFinished(p.position, p.duration)) {
		return markPositionFinished(p.key, p.duration).catch(() => {});
	}
	if (p.position < MIN_RESUME_SECONDS) {
		return deletePlaybackPosition(p.key).catch(() => {});
	}
	return savePlaybackPosition(p.key, p.position, p.duration).catch(() => {});
};
