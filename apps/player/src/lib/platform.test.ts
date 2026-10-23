// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { platform as osPlatform } from "@tauri-apps/plugin-os";
import {
	getPlatform,
	isMobilePlatform,
	layoutModeFor,
	controlsOthers,
	type Viewport,
	playsOnTvs,
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

	it("switches an iPad to the desktop layout at exactly 1024 wide", () => {
		expect(layoutModeFor("ios", view(1024, 768, 768))).toBe("desktop");
		expect(layoutModeFor("ios", view(1023, 768, 768))).toBe("tablet");
	});

	it("gives a narrow iPad Split View pane the phone layout", () => {
		expect(layoutModeFor("ios", view(375, 1032, 1032))).toBe("mobile");
	});

	it("always gives a TV the tv layout", () => {
		expect(layoutModeFor("tv", view(960, 540, 540))).toBe("tv");
		expect(layoutModeFor("tv", view(1920, 1080, 1080))).toBe("tv");
	});

	it("gives Android phones and tablets the same layouts as iOS ones", () => {
		expect(layoutModeFor("android", view(412, 915, 412))).toBe("mobile");
		expect(layoutModeFor("android", view(915, 412, 412))).toBe("mobile");
		expect(layoutModeFor("android", view(800, 1280, 800))).toBe("tablet");
		expect(layoutModeFor("android", view(1280, 800, 800))).toBe("desktop");
	});

	it("always uses the desktop layout on desktop platforms", () => {
		expect(layoutModeFor("macos", view(400, 600, 900))).toBe("desktop");
		expect(layoutModeFor("linux", view(1280, 800, 800))).toBe("desktop");
	});
});

describe("getPlatform", () => {
	afterEach(() => {
		vi.mocked(osPlatform).mockReset();
		delete window.__CINETTE_TV__;
	});

	it("returns the os plugin's platform", () => {
		vi.mocked(osPlatform).mockReturnValue("ios");
		expect(getPlatform()).toBe("ios");
	});

	it("is tv on an Android device the app's init script marked as a TV", () => {
		vi.mocked(osPlatform).mockReturnValue("android");
		expect(getPlatform()).toBe("android");
		window.__CINETTE_TV__ = true;
		expect(getPlatform()).toBe("tv");
	});

	it("only takes the TV mark on Android", () => {
		vi.mocked(osPlatform).mockReturnValue("ios");
		window.__CINETTE_TV__ = true;
		expect(getPlatform()).toBe("ios");
	});

	it("falls back to macos outside Tauri", () => {
		vi.mocked(osPlatform).mockImplementation(() => {
			throw new Error("not in Tauri");
		});
		expect(getPlatform()).toBe("macos");
	});

	it.each([
		{ what: "a platform the app doesn't support", name: "freebsd" },
		{ what: "an empty platform name", name: "" },
	])("falls back to macos for $what", ({ name }) => {
		vi.mocked(osPlatform).mockReturnValue(name as ReturnType<typeof osPlatform>);
		expect(getPlatform()).toBe("macos");
	});
});

describe("isMobilePlatform", () => {
	it("is true for iOS, Android and TVs only", () => {
		expect(isMobilePlatform("ios")).toBe(true);
		expect(isMobilePlatform("android")).toBe(true);
		expect(isMobilePlatform("tv")).toBe(true);
		expect(isMobilePlatform("macos")).toBe(false);
		expect(isMobilePlatform("linux")).toBe(false);
	});
});

describe("playsOnTvs", () => {
	it("is AirPlay's iOS and macOS, and Cast's macOS and Linux", () => {
		for (const p of ["macos", "linux", "ios"] as const) expect(playsOnTvs(p)).toBe(true);
		for (const p of ["windows", "android", "tv"] as const) expect(playsOnTvs(p)).toBe(false);
	});
});

describe("controlsOthers", () => {
	it("lets computers, phones and tablets control other devices", () => {
		for (const p of ["macos", "linux", "windows", "android", "ios"] as const) {
			expect(controlsOthers(p)).toBe(true);
		}
	});

	it("doesn't let a TV", () => {
		expect(controlsOthers("tv")).toBe(false);
	});

	it("asks the platform when given none", () => {
		vi.mocked(osPlatform).mockReturnValue("android");
		window.__CINETTE_TV__ = true;
		expect(controlsOthers()).toBe(false);
		delete window.__CINETTE_TV__;
	});
});
