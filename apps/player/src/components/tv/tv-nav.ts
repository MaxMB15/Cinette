// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { createContext, useCallback, useContext, useState } from "react";

/** The sections of the channels page. */
export type TvSection = "search" | "live" | "movie" | "series" | "favorites" | "history";

export interface TvNav {
	section: TvSection;
	/** Opens a page by its place in the rail and moves the focus into it. */
	openSection: (section: TvSection | "settings") => void;
	/** Where each screen was, kept while the player has the screen. */
	memory: Map<string, unknown>;
}

const NO_NAV: TvNav = {
	section: "live",
	openSection: () => {},
	memory: new Map(),
};

export const TvNavContext = createContext<TvNav>(NO_NAV);

export const useTvNav = (): TvNav => useContext(TvNavContext);

/**
 * Like useState, for a TV screen's place: what's stored comes back when the
 * screen opens again after the player or another section.
 */
export const useRemembered = <T>(key: string, initial: T): readonly [T, (value: T) => void] => {
	const { memory } = useTvNav();
	const [value, setValue] = useState<T>(() =>
		memory.has(key) ? (memory.get(key) as T) : initial
	);
	const set = useCallback(
		(next: T) => {
			memory.set(key, next);
			setValue(next);
		},
		[memory, key]
	);
	return [value, set] as const;
};
