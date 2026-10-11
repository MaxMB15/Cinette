// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useSyncExternalStore } from "react";

export const NOW_TICK_MS = 30_000;

const nowSeconds = () => Math.floor(Date.now() / 1000);

let now = nowSeconds();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

// One timer serves every component on screen, and it only runs while one of
// them is mounted.
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	if (timer === null) {
		now = nowSeconds();
		timer = setInterval(() => {
			now = nowSeconds();
			listeners.forEach((l) => l());
		}, NOW_TICK_MS);
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0 && timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	};
};

const getSnapshot = () => now;

/** The current Unix time in seconds, updated every 30 seconds. */
export const useNow = (): number => useSyncExternalStore(subscribe, getSnapshot);
