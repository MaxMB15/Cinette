// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { platform as osPlatform } from "@tauri-apps/plugin-os";
import type { LayoutMode, Platform } from "@/lib/types";

const PLATFORMS: readonly string[] = ["macos", "ios", "android", "windows", "linux"];

declare global {
	interface Window {
		/** Set by the app's init script on Android TV, Google TV and Fire TV. See android_device.rs. */
		__CINETTE_TV__?: boolean;
	}
}

/**
 * The OS the app runs on, with "tv" for an Android TV. The os plugin and the
 * app's init script set what this reads before any page script runs, so
 * it's known on the first render. Outside Tauri, in tests or a plain
 * browser, it's "macos".
 */
export const getPlatform = (): Platform => {
	try {
		const p = osPlatform();
		if (p === "android" && window.__CINETTE_TV__ === true) return "tv";
		return PLATFORMS.includes(p) ? (p as Platform) : "macos";
	} catch {
		return "macos";
	}
};

/** Phones, tablets and TVs: no downloads, no updater, no donation prompts. */
export const isMobilePlatform = (p: Platform = getPlatform()): boolean =>
	p === "ios" || p === "android" || p === "tv";

/**
 * Whether this device can control other Cinette devices. Every device can
 * be controlled, but a TV doesn't control others.
 */
export const controlsOthers = (p: Platform = getPlatform()): boolean => p !== "tv";

/** Whether it can play on a TV over Google Cast, on macOS and Linux. */
export const castsFrom = (p: Platform): boolean => p === "macos" || p === "linux";

/** Whether it can play video on a TV over AirPlay, on iOS and macOS. */
export const airplaysFrom = (p: Platform): boolean => p === "ios" || p === "macos";

/** Whether it can play on a TV over AirPlay or Google Cast. */
export const playsOnTvs = (p: Platform): boolean => castsFrom(p) || airplaysFrom(p);

/** The narrowest iPad, an iPad mini in portrait. Below this a tablet gets the phone layout. */
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
 * A TV always gets the TV layout. A phone always gets the phone layout. A
 * tablet picks by window width, so Split View and Stage Manager get the
 * layout that fits.
 */
export const layoutModeFor = (platform: Platform, viewport: Viewport): LayoutMode => {
	if (platform === "tv") return "tv";
	if (platform === "ios" || platform === "android") {
		if (viewport.screenShortSide < TABLET_MIN_WIDTH) return "mobile";
		if (viewport.width >= DESKTOP_MIN_WIDTH) return "desktop";
		if (viewport.width >= TABLET_MIN_WIDTH) return "tablet";
		return "mobile";
	}
	return "desktop";
};
