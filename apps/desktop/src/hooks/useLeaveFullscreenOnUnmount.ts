// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useRef } from "react";
import { useFullscreen } from "@/lib/fullscreen-context";

/**
 * Leaves fullscreen when the player closes, whether by Stop or by a link to
 * another page such as the OMDb hint in an info sheet. The player's own
 * fullscreen controls go with it, so the next page would otherwise be left
 * in a fullscreen window. A window that was already fullscreen when the
 * player opened, such as from the green button on macOS, stays that way.
 */
export const useLeaveFullscreenOnUnmount = () => {
	const { isFullscreen, setFullscreen } = useFullscreen();
	const isFullscreenRef = useRef(isFullscreen);
	// Only the first render's value is kept.
	const wasFullscreenRef = useRef(isFullscreen);
	useEffect(() => {
		isFullscreenRef.current = isFullscreen;
	}, [isFullscreen]);

	useEffect(
		() => () => {
			if (isFullscreenRef.current && !wasFullscreenRef.current) setFullscreen(false);
		},
		[setFullscreen]
	);
};
