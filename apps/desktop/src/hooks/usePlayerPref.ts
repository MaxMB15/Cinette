// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useState } from "react";

/**
 * A player preference from `player-prefs`, read again each time Settings
 * fires `event` for it. `read` should be a module-level function, so the
 * listener isn't added again on every render.
 */
export const usePlayerPref = <T>(read: () => T, event: string): T => {
	const [value, setValue] = useState(read);
	useEffect(() => {
		const update = () => setValue(read());
		window.addEventListener(event, update);
		return () => window.removeEventListener(event, update);
	}, [read, event]);
	return value;
};
