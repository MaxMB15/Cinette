// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, useEffect } from "react";
import { getPlatform, layoutModeFor, readViewport } from "@/lib/platform";

export const usePlatform = () => {
	const [platform] = useState(getPlatform);
	const [layoutMode, setLayoutMode] = useState(() => layoutModeFor(platform, readViewport()));

	// An iPad changes layout when it rotates or enters Split View. React skips
	// the render when the mode stays the same.
	useEffect(() => {
		const onResize = () => setLayoutMode(layoutModeFor(platform, readViewport()));
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [platform]);

	return { platform, layoutMode };
};
