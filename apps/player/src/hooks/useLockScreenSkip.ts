// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect } from "react";
import { mpvSetSkipIntervals } from "@/lib/tauri";
import { isMobilePlatform } from "@/lib/platform";
import { readSkipIntervals, SKIP_INTERVALS_EVENT } from "@/lib/player-prefs";

/**
 * Keeps the lock screen's skip buttons jumping the lengths set in Settings.
 * Lives at the top of the app, since audio keeps playing with the player
 * closed and the lengths can change in Settings meanwhile.
 */
export const useLockScreenSkip = () => {
	useEffect(() => {
		if (!isMobilePlatform()) return;
		const send = () => {
			const { back, forward } = readSkipIntervals();
			mpvSetSkipIntervals(back, forward).catch(() => {});
		};
		send();
		window.addEventListener(SKIP_INTERVALS_EVENT, send);
		return () => window.removeEventListener(SKIP_INTERVALS_EVENT, send);
	}, []);
};
