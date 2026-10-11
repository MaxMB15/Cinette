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

/** Where the schedule reads each provider's settings and last EPG refresh.
 *  The caller passes them in, since they live in hooks/useChannels, which
 *  imports this module. */
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
