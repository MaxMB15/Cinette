// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// The subtitles the player showed when its page last closed, kept in
// sessionStorage. Playback goes on while another page is open, and mpv
// doesn't draw the subtitles the app draws itself. So when the player page
// opens again on the same item, it shows these again.

import { readStorage, removeStorage, writeStorage } from "./storage";
import type { SubtitlePosition } from "./subtitle-position";
import type { SubtitleCue, SubtitleEntry } from "./types";

const KEY = "mvp_lastSubtitles";

/** The language, and the place in it, to pick subtitles from for the next episode. */
export interface SubtitlePreference {
	languageCode: string;
	rankInLanguage: number;
}

export interface SubtitleSession {
	/** The item the subtitles were shown over. */
	channelId: string;
	/** The URL the player last loaded for it, or null while it hadn't started. */
	url: string | null;
	/** The subtitle file picked, or null for none. */
	fileId: number | null;
	entry: SubtitleEntry | null;
	cues: SubtitleCue[];
	/** The delay picked for the subtitles, in seconds. */
	delay: number;
	position: SubtitlePosition;
	fontSize: number;
	fontFamily: string;
	preference: SubtitlePreference | null;
	/** Whether the next episode's subtitles were still loading. */
	autoLoad: boolean;
}

/** The subtitles saved when the player page last closed, or null. */
export const readSubtitleSession = (): SubtitleSession | null => {
	try {
		return JSON.parse(readStorage(KEY, "session") ?? "null") as SubtitleSession | null;
	} catch {
		return null;
	}
};

/**
 * Saves the subtitles for when the player page opens again, or forgets them
 * for null. The old ones go first, so a save that fails leaves none.
 */
export const saveSubtitleSession = (session: SubtitleSession | null): void => {
	removeStorage(KEY, "session");
	if (session) writeStorage(KEY, JSON.stringify(session), "session");
};
