// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

/** After this long, add a line saying a slow server is normal. */
const SLOW_OPEN_MS = 15_000;

/**
 * Centered spinner shown while a stream opens, so a slow server isn't just a
 * black screen. It ignores the pointer so taps and double-clicks still reach
 * the player underneath.
 */
export const OpeningIndicator = () => {
	const [slow, setSlow] = useState(false);

	useEffect(() => {
		const timer = setTimeout(() => setSlow(true), SLOW_OPEN_MS);
		return () => clearTimeout(timer);
	}, []);

	return (
		<div
			role="status"
			aria-live="polite"
			className="pointer-events-none flex flex-col items-center gap-3 p-6 text-center"
		>
			<Loader2 className="h-10 w-10 animate-spin text-white/80" aria-hidden />
			<p className="text-sm font-medium text-white/90">Opening stream</p>
			{slow && (
				<p className="max-w-xs text-xs text-white/60">
					Some servers take a while to respond.
				</p>
			)}
		</div>
	);
};
