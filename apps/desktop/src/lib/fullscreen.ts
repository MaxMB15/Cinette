// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ChangeTracker } from "@/lib/change-tracker";
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

/**
 * Reads whether the window is full screen now and after each resize, and
 * passes it to `onChange` until the returned function is called. Going in or
 * out of full screen resizes the window, so this also catches the ways the
 * app doesn't start itself, such as the green button on macOS.
 *
 * A read sent before one of the app's own changes in `changes` is dropped,
 * since it may come back with the state from before the change. Dragging the
 * window's edge resizes it many times a second, so only one read runs at a
 * time, with one more after it if the window resized meanwhile. Does nothing
 * on iOS and Android, where the window never goes full screen, or outside
 * Tauri, where there's no window to follow.
 */
export const followWindowFullscreen = (
	onChange: (on: boolean) => void,
	changes: ChangeTracker
): (() => void) => {
	if (isMobilePlatform()) return () => {};
	let win: ReturnType<typeof getCurrentWindow>;
	try {
		win = getCurrentWindow();
	} catch {
		return () => {};
	}
	let stopped = false;
	let reading = false;
	let resizedMeanwhile = false;
	const read = () => {
		if (reading) {
			resizedMeanwhile = true;
			return;
		}
		reading = true;
		const mark = changes.mark();
		win.isFullscreen()
			.then(
				(on) => {
					if (!stopped && !changes.isStale(mark)) onChange(on);
				},
				(e) => console.error("[fullscreen] isFullscreen failed:", e)
			)
			.finally(() => {
				reading = false;
				if (resizedMeanwhile && !stopped) {
					resizedMeanwhile = false;
					read();
				}
			});
	};
	read();
	const unlisten = win.onResized(read).catch((e) => {
		console.error("[fullscreen] onResized failed:", e);
		return () => {};
	});
	return () => {
		stopped = true;
		unlisten.then((fn) => fn());
	};
};
