// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { platform as osPlatform } from "@tauri-apps/plugin-os";
import { hasFullscreenButton, setWindowFullscreen } from "./fullscreen";

const setFullscreen = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@tauri-apps/plugin-os", () => ({ platform: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({ setFullscreen }),
}));

describe("hasFullscreenButton", () => {
	it("leaves the button out of the phone layout", () => {
		expect(hasFullscreenButton(true, "mobile")).toBe(false);
	});

	it("shows the button on an iPad, which has the sidebar", () => {
		expect(hasFullscreenButton(true, "tablet")).toBe(true);
		expect(hasFullscreenButton(true, "desktop")).toBe(true);
	});

	it("shows the button without a touch screen", () => {
		expect(hasFullscreenButton(false, "desktop")).toBe(true);
		expect(hasFullscreenButton(false, "tv")).toBe(true);
		expect(hasFullscreenButton(false, "mobile")).toBe(true);
	});
});

describe("setWindowFullscreen", () => {
	afterEach(() => {
		setFullscreen.mockClear();
	});

	it("sets the window to full screen on desktop", async () => {
		vi.mocked(osPlatform).mockReturnValue("macos");
		await setWindowFullscreen(true);
		await setWindowFullscreen(false);
		expect(setFullscreen.mock.calls).toEqual([[true], [false]]);
	});

	it("leaves the window alone on iOS and Android", async () => {
		vi.mocked(osPlatform).mockReturnValue("ios");
		await setWindowFullscreen(true);
		vi.mocked(osPlatform).mockReturnValue("android");
		await setWindowFullscreen(true);
		expect(setFullscreen).not.toHaveBeenCalled();
	});
});
