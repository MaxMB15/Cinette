// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { Provider } from "@/lib/types";
import { parseDateMs } from "@/lib/date";

const HOUR_MS = 60 * 60 * 1000;

/** The auto refresh part of a provider's settings. */
export interface RefreshSettings {
	autoRefresh: boolean;
	refreshIntervalHours: number;
	epgAutoRefresh: boolean;
	epgRefreshIntervalHours: number;
}

/**
 * Where the schedule reads each provider's settings and last EPG refresh.
 * The caller passes them in, since they live in hooks/useChannels, which
 * imports this module.
 */
export interface RefreshLookups {
	settingsFor: (providerId: string) => RefreshSettings;
	epgLastRefreshFor: (providerId: string) => number;
}

export interface DueRefreshes {
	playlistIds: string[];
	epgIds: string[];
}

/** A refresh is due once a full interval has passed since the last one. */
export const isRefreshDue = (lastMs: number, intervalHours: number, now: number): boolean =>
	now - lastMs >= intervalHours * HOUR_MS;

/** Which providers have auto refresh on and are due a playlist or EPG refresh. */
export const findDueRefreshes = (
	providers: Provider[],
	lookups: RefreshLookups,
	now: number = Date.now()
): DueRefreshes => {
	const playlistIds: string[] = [];
	const epgIds: string[] = [];
	for (const p of providers) {
		const settings = lookups.settingsFor(p.id);
		if (
			settings.autoRefresh &&
			isRefreshDue(parseDateMs(p.lastUpdated), settings.refreshIntervalHours, now)
		) {
			playlistIds.push(p.id);
		}
		if (
			settings.epgAutoRefresh &&
			p.epgUrl &&
			isRefreshDue(lookups.epgLastRefreshFor(p.id), settings.epgRefreshIntervalHours, now)
		) {
			epgIds.push(p.id);
		}
	}
	return { playlistIds, epgIds };
};

/** The first wait before trying a failed refresh again. */
export const RETRY_FIRST_DELAY_MS = 5 * 60 * 1000;
/** The longest wait between tries, so a source that comes back is picked up the same day. */
export const RETRY_MAX_DELAY_MS = 6 * HOUR_MS;

/** How long to wait after the given number of failures in a row, doubling each time. */
export const retryDelayMs = (failures: number): number =>
	Math.min(RETRY_FIRST_DELAY_MS * 2 ** Math.max(failures - 1, 0), RETRY_MAX_DELAY_MS);

/** Tracker keys for a provider's automatic playlist and guide refreshes. */
export const refreshKeys = {
	playlist: (providerId: string): string => `playlist:${providerId}`,
	epg: (providerId: string): string => `epg:${providerId}`,
};

export interface RefreshTracker {
	/**
	 * Starts the refresh for this key and returns its promise, which rejects if
	 * the refresh fails. If one is already running for the key, returns that
	 * one's promise instead of starting another. Returns null when the last try
	 * failed too recently to try again.
	 */
	run: (key: string, refresh: () => Promise<unknown>) => Promise<void> | null;
}

/**
 * Keeps automatic refreshes from piling up work. The splash screen and the
 * poll share one tracker, so a refresh that is still running when the poll
 * comes round isn't started a second time. A refresh that fails waits longer
 * before each new try instead of running every poll. For Xtream every try
 * sends the login, so a provider that's down would otherwise get one a minute.
 */
export const createRefreshTracker = (clock: () => number = Date.now): RefreshTracker => {
	const running = new Map<string, Promise<void>>();
	const failures = new Map<string, { count: number; retryAt: number }>();

	const run = (key: string, refresh: () => Promise<unknown>): Promise<void> | null => {
		const inFlight = running.get(key);
		if (inFlight) return inFlight;
		const failure = failures.get(key);
		if (failure && clock() < failure.retryAt) return null;
		const done = refresh()
			.then(
				() => {
					failures.delete(key);
				},
				(e: unknown) => {
					const count = (failure?.count ?? 0) + 1;
					const delay = retryDelayMs(count);
					failures.set(key, { count, retryAt: clock() + delay });
					console.error(
						`[refresh] ${key} failed, trying again in ${Math.round(delay / 60_000)} min:`,
						e
					);
					throw e;
				}
			)
			.finally(() => {
				running.delete(key);
			});
		// The poll doesn't wait for the result, so a failure it ignores must not
		// show up as an unhandled rejection. Callers that wait still see it.
		done.catch(() => {});
		running.set(key, done);
		return done;
	};

	return { run };
};
