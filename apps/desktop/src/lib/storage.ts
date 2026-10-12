// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/** When the donation prompt was last dismissed, in epoch milliseconds. */
export const DONATION_LAST_SHOWN_KEY = "donation-last-shown";
/** Set for the rest of the session once the splash screen is dismissed. */
export const SPLASH_SHOWN_KEY = "splash-shown";

export type StorageArea = "local" | "session";

// Touching the storage objects can throw too, when the webview blocks storage,
// so the lookup happens inside each try.
const storageFor = (area: StorageArea): Storage =>
	area === "session" ? window.sessionStorage : window.localStorage;

/** The stored value, or null when it is missing or storage can't be read. */
export const readStorage = (key: string, area: StorageArea = "local"): string | null => {
	try {
		return storageFor(area).getItem(key);
	} catch (err) {
		console.warn(`[storage] could not read ${key}:`, err);
		return null;
	}
};

/**
 * Stores a value and reports whether it was saved. A full quota or blocked
 * storage returns false instead of throwing.
 */
export const writeStorage = (key: string, value: string, area: StorageArea = "local"): boolean => {
	try {
		storageFor(area).setItem(key, value);
		return true;
	} catch (err) {
		console.warn(`[storage] could not write ${key}:`, err);
		return false;
	}
};
