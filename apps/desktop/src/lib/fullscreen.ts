// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMobilePlatform } from "@/lib/platform";
import type { LayoutMode } from "@/lib/types";

/**
 * Whether the player shows a full screen button. The phone layout already
 * plays full screen. Every other layout has the sidebar next to the video,
 * including an iPad's, so it needs the button. A device without a touch
 * screen, like an Android TV box, keeps it for its remote in any layout.
 */
export const hasFullscreenButton = (touch: boolean, layoutMode: LayoutMode): boolean =>
	!touch || layoutMode !== "mobile";

/**
 * Puts the window in or out of full screen. On iOS and Android the window
 * already fills its screen or its Split View pane, and tao's iOS version
 * would resize it to the whole screen, so there full screen only hides the
 * sidebar.
 */
export const setWindowFullscreen = async (on: boolean): Promise<void> => {
	if (isMobilePlatform()) return;
	await getCurrentWindow().setFullscreen(on);
};
