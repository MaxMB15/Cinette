// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { platform as osPlatform } from "@tauri-apps/plugin-os";
import {
	getPlatform,
	isMobilePlatform,
	layoutModeFor,
	platformName,
	type Viewport,
} from "./platform";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: vi.fn() }));

const view = (width: number, height: number, screenShortSide: number): Viewport => ({
	width,
	height,
	screenShortSide,
});

describe("layoutModeFor", () => {
	it("gives an iPhone the phone layout in both orientations", () => {
		expect(layoutModeFor("ios", view(402, 874, 402))).toBe("mobile");
		expect(layoutModeFor("ios", view(874, 402, 402))).toBe("mobile");
	});

	it("gives an iPad mini in portrait the tablet layout", () => {
		expect(layoutModeFor("ios", view(744, 1133, 744))).toBe("tablet");
	});

	it("gives a large iPad in landscape the desktop layout", () => {
		expect(layoutModeFor("ios", view(1376, 1032, 1032))).toBe("desktop");
	});

	it("gives a narrow iPad Split View pane the phone layout", () => {
		expect(layoutModeFor("ios", view(375, 1032, 1032))).toBe("mobile");
	});

	it("uses the tv layout for large Android screens", () => {
		expect(layoutModeFor("android", view(1920, 1080, 1080))).toBe("tv");
		expect(layoutModeFor("android", view(412, 915, 412))).toBe("mobile");
	});

	it("always uses the desktop layout on desktop platforms", () => {
		expect(layoutModeFor("macos", view(400, 600, 900))).toBe("desktop");
		expect(layoutModeFor("linux", view(1280, 800, 800))).toBe("desktop");
	});
});

describe("getPlatform", () => {
	afterEach(() => {
		vi.mocked(osPlatform).mockReset();
	});

	it("returns the os plugin's platform", () => {
		vi.mocked(osPlatform).mockReturnValue("ios");
		expect(getPlatform()).toBe("ios");
	});

	it("falls back to macos outside Tauri", () => {
		vi.mocked(osPlatform).mockImplementation(() => {
			throw new Error("not in Tauri");
		});
		expect(getPlatform()).toBe("macos");
	});

	it("falls back to macos for a platform the app doesn't support", () => {
		vi.mocked(osPlatform).mockReturnValue("freebsd");
		expect(getPlatform()).toBe("macos");
	});
});

describe("isMobilePlatform", () => {
	it("is true for iOS and Android only", () => {
		expect(isMobilePlatform("ios")).toBe(true);
		expect(isMobilePlatform("android")).toBe(true);
		expect(isMobilePlatform("macos")).toBe(false);
		expect(isMobilePlatform("linux")).toBe(false);
	});
});

describe("platformName", () => {
	it("spells platform names the usual way", () => {
		expect(platformName("ios")).toBe("iOS");
		expect(platformName("macos")).toBe("macOS");
		expect(platformName("linux")).toBe("Linux");
	});
});
