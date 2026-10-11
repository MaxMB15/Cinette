// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useState } from "react";
import { getOmdbApiKey } from "@/lib/tauri";

/**
 * Whether an OMDb API key is saved, or null while the check runs. Only the
 * yes or no leaves this hook, never the key. It checks on mount, so a sheet
 * that mounts when it opens sees a key added since it last opened.
 */
export const useHasOmdbKey = (): boolean | null => {
	const [hasKey, setHasKey] = useState<boolean | null>(null);
	useEffect(() => {
		let cancelled = false;
		getOmdbApiKey()
			.then((key) => {
				if (!cancelled) setHasKey(Boolean(key));
			})
			// If the store can't be read, act as if a key is set so nothing changes.
			.catch(() => {
				if (!cancelled) setHasKey(true);
			});
		return () => {
			cancelled = true;
		};
	}, []);
	return hasKey;
};
