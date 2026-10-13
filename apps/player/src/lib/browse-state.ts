// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/**
 * Channel-list state that survives the list unmounting while the player is
 * open: the selected tab, the search text, and how much has been watched
 * since the list was last shown (used to decide whether to keep the search
 * when coming back).
 */

const KEY = "mvp_browseState";

/** Watching for at least this long clears the search when returning to the list. */
export const SEARCH_RESET_AFTER_MS = 60_000;

interface StoredBrowseState {
	tab?: string;
	search?: string;
	/** Playback time since the list was last shown; paused and buffering time not included. */
	watchedMs?: number;
}

const read = (): StoredBrowseState => {
	try {
		return JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as StoredBrowseState;
	} catch {
		return {};
	}
};

const write = (patch: Partial<StoredBrowseState>): void => {
	try {
		sessionStorage.setItem(KEY, JSON.stringify({ ...read(), ...patch }));
	} catch {}
};

export const saveBrowseTab = (tab: string): void => write({ tab });

export const saveBrowseSearch = (search: string): void => write({ search });

/** Called by the player as playback advances. */
export const addWatchedTime = (ms: number): void => {
	if (ms > 0) write({ watchedMs: (read().watchedMs ?? 0) + ms });
};

/**
 * Read the state to restore when the channel list opens, and reset the watch
 * time. If at least SEARCH_RESET_AFTER_MS was watched the search is cleared,
 * otherwise it's kept so the user can pick another result.
 */
export const consumeBrowseState = (): { tab?: string; search: string } => {
	const s = read();
	let search = s.search ?? "";
	if (s.watchedMs !== undefined) {
		if (s.watchedMs >= SEARCH_RESET_AFTER_MS) search = "";
		write({ search, watchedMs: undefined });
	}
	return { tab: s.tab, search };
};
