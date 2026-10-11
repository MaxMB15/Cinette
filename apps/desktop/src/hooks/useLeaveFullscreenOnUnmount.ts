// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useFullscreen } from "@/lib/fullscreen-context";

/**
 * Leaves fullscreen when the player closes, whether by Stop or by a link to
 * another page such as the OMDb hint in an info sheet. Fullscreen hides the
 * sidebar app-wide, and only the player page can leave it, so without this
 * the next page would have no way out.
 */
export const useLeaveFullscreenOnUnmount = () => {
	const { isFullscreen, setFullscreen } = useFullscreen();
	const isFullscreenRef = useRef(isFullscreen);
	isFullscreenRef.current = isFullscreen;

	useEffect(
		() => () => {
			if (!isFullscreenRef.current) return;
			setFullscreen(false);
			getCurrentWindow()
				.setFullscreen(false)
				.catch((e) => {
					console.error("[PlayerView] setFullscreen(false) failed:", e);
				});
		},
		[setFullscreen]
	);
};
