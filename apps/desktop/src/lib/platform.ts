// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { platform as osPlatform } from "@tauri-apps/plugin-os";
import type { LayoutMode, Platform } from "@/lib/types";

const PLATFORMS: readonly string[] = ["macos", "ios", "android", "windows", "linux"];

/**
 * The OS the app runs on. The os plugin sets it before any page script runs,
 * so it's known on the first render. Outside Tauri, in tests or a plain
 * browser, it's "macos".
 */
export const getPlatform = (): Platform => {
	try {
		const p = osPlatform();
		return PLATFORMS.includes(p) ? (p as Platform) : "macos";
	} catch {
		return "macos";
	}
};

const PLATFORM_NAMES: Record<Platform, string> = {
	macos: "macOS",
	ios: "iOS",
	android: "Android",
	windows: "Windows",
	linux: "Linux",
};

/** The platform as people write it, like "iOS" or "macOS". */
export const platformName = (p: Platform): string => PLATFORM_NAMES[p];

/** Phones and tablets: no downloads, no updater, no donation prompts. */
export const isMobilePlatform = (p: Platform = getPlatform()): boolean =>
	p === "ios" || p === "android";

/** The narrowest iPad, an iPad mini in portrait. Below this an iPad gets the phone layout. */
export const TABLET_MIN_WIDTH = 744;
/** An 11-inch iPad in landscape and up get the desktop layout. */
export const DESKTOP_MIN_WIDTH = 1024;

export interface Viewport {
	width: number;
	height: number;
	/** The shorter side of the whole screen, which doesn't change with Split View or rotation. */
	screenShortSide: number;
}

export const readViewport = (): Viewport => ({
	width: window.innerWidth,
	height: window.innerHeight,
	screenShortSide: Math.min(window.screen.width, window.screen.height),
});

/**
 * An iPhone always gets the phone layout. An iPad picks by window width, so
 * Split View and Stage Manager get the layout that fits.
 */
export const layoutModeFor = (platform: Platform, viewport: Viewport): LayoutMode => {
	if (platform === "ios") {
		if (viewport.screenShortSide < TABLET_MIN_WIDTH) return "mobile";
		if (viewport.width >= DESKTOP_MIN_WIDTH) return "desktop";
		if (viewport.width >= TABLET_MIN_WIDTH) return "tablet";
		return "mobile";
	}
	if (platform === "android") {
		// Fire Stick and Android TV get "tv". Large Android viewports count as TV.
		return viewport.width >= 960 && viewport.height >= 540 ? "tv" : "mobile";
	}
	return "desktop";
};
