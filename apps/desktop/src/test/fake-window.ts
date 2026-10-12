// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { vi } from "vitest";

let fullscreen = false;
const resizeHandlers = new Set<() => void>();

/**
 * The app's window in tests. Use it with
 * `vi.mock("@tauri-apps/api/window", () => import("@/test/fake-window"))`,
 * and call `resetFakeWindow` after each test.
 *
 * Like tao, it takes a full screen change as soon as the app asks for it.
 * `changeFullscreen` makes a change the app didn't ask for, the way the green
 * button on macOS would.
 */
export const fakeWindow = {
	setFullscreen: vi.fn(async (on: boolean) => {
		fullscreen = on;
	}),
	isFullscreen: vi.fn(async () => fullscreen),
	onResized: vi.fn(async (handler: () => void) => {
		resizeHandlers.add(handler);
		return () => {
			resizeHandlers.delete(handler);
		};
	}),
	changeFullscreen: (on: boolean) => {
		fullscreen = on;
		resizeHandlers.forEach((handler) => handler());
	},
	resizeListeners: () => resizeHandlers.size,
};

export const getCurrentWindow = vi.fn(() => fakeWindow);

export const resetFakeWindow = () => {
	fullscreen = false;
	resizeHandlers.clear();
	fakeWindow.setFullscreen.mockClear();
	fakeWindow.isFullscreen.mockClear();
	fakeWindow.onResized.mockClear();
	getCurrentWindow.mockClear();
};

/** Waits until the window's pending answers have reached the app. */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
