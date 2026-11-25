// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describeSource } from "./sources";
import { languageName } from "./subtitle-style";
import type { MpvTrack } from "./types";

/** One choice in a list the viewer picks from, with a line under its name if it has one. */
export interface PlaybackPick {
	key: string;
	label: string;
	detail?: string;
}

const LAYOUTS: Readonly<Record<number, string>> = { 1: "Mono", 2: "Stereo", 6: "5.1", 8: "7.1" };

/**
 * What an audio track is called: its language, or else its title or number,
 * with its channels, as "English 5.1".
 */
export const audioTrackName = (track: MpvTrack): string => {
	const name = track.language ? languageName(track.language) : track.title || `Track ${track.id}`;
	const layout = LAYOUTS[track.channels ?? 0];
	return layout ? `${name} ${layout}` : name;
};

/** The audio tracks, each with its title or codec under its name. */
export const audioPicks = (tracks: readonly MpvTrack[]): PlaybackPick[] =>
	tracks.map((t) => ({
		key: String(t.id),
		label: audioTrackName(t),
		detail: (t.language ? t.title : null) || t.codec?.toUpperCase() || undefined,
	}));

/** The sources, numbered from one, each with its host and file type but never its login. */
export const sourcePicks = (urls: readonly string[]): PlaybackPick[] =>
	urls.map((url, i) => ({
		key: url,
		label: `Source ${i + 1}`,
		detail: describeSource(url) ?? undefined,
	}));

/** The speeds a movie or episode can play at. */
export const PLAYBACK_SPEEDS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** A speed as the viewer reads it: "Normal", or "1.5×". */
export const speedLabel = (speed: number): string => (speed === 1 ? "Normal" : `${speed}×`);

/** The speeds, by name. */
export const speedPicks = (): PlaybackPick[] =>
	PLAYBACK_SPEEDS.map((s) => ({ key: String(s), label: speedLabel(s) }));
