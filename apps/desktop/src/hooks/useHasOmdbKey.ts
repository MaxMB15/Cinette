// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useState } from "react";
import { getOmdbApiKey } from "@/lib/tauri";

// The last answer, so a sheet that opens again shows it at once while it checks.
let lastKnown: boolean | null = null;

/** Records whether a key is saved. Settings calls this when it saves one. */
export const rememberHasOmdbKey = (hasKey: boolean | null) => {
	lastKnown = hasKey;
};

/**
 * Whether an OMDb API key is saved, or null until the first check answers.
 * Only the yes or no leaves this hook, never the key. It starts from the last
 * answer and checks again once `needed` is true, so a sheet that mounts when
 * it opens sees a key added since it last opened. A sheet that already has
 * OMDb details passes false and skips the check.
 */
export const useHasOmdbKey = (needed: boolean): boolean | null => {
	const [hasKey, setHasKey] = useState<boolean | null>(lastKnown);
	useEffect(() => {
		if (!needed) return;
		let cancelled = false;
		getOmdbApiKey()
			.then((key) => {
				lastKnown = Boolean(key);
				if (!cancelled) setHasKey(lastKnown);
			})
			// If the store can't be read, act as if a key is set so nothing changes.
			.catch(() => {
				if (!cancelled) setHasKey(true);
			});
		return () => {
			cancelled = true;
		};
	}, [needed]);
	return hasKey;
};
