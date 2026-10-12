// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach, onTestFinished } from "vitest";
import { platform as osPlatform } from "@tauri-apps/plugin-os";
import { createChangeTracker } from "./change-tracker";
import { followWindowFullscreen, hasFullscreenButton, setWindowFullscreen } from "./fullscreen";
import { fakeWindow, getCurrentWindow, resetFakeWindow, settle } from "@/test/fake-window";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => import("@/test/fake-window"));

afterEach(() => {
	resetFakeWindow();
});

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
	it("sets the window to full screen on desktop", async () => {
		vi.mocked(osPlatform).mockReturnValue("macos");
		await setWindowFullscreen(true);
		await setWindowFullscreen(false);
		expect(fakeWindow.setFullscreen.mock.calls).toEqual([[true], [false]]);
	});

	it("leaves the window alone on iOS and Android", async () => {
		vi.mocked(osPlatform).mockReturnValue("ios");
		await setWindowFullscreen(true);
		vi.mocked(osPlatform).mockReturnValue("android");
		await setWindowFullscreen(true);
		expect(fakeWindow.setFullscreen).not.toHaveBeenCalled();
	});
});

describe("followWindowFullscreen", () => {
	it("reads the window at the start and after each resize", async () => {
		vi.mocked(osPlatform).mockReturnValue("macos");
		const onChange = vi.fn();
		const stop = followWindowFullscreen(onChange, createChangeTracker());
		await settle();
		fakeWindow.changeFullscreen(true);
		await settle();
		fakeWindow.changeFullscreen(false);
		await settle();
		expect(onChange.mock.calls).toEqual([[false], [true], [false]]);

		stop();
		await settle();
		expect(fakeWindow.resizeListeners()).toBe(0);
	});

	it("drops a read sent before one of the app's own changes", async () => {
		vi.mocked(osPlatform).mockReturnValue("macos");
		let answer: (on: boolean) => void = () => {};
		fakeWindow.isFullscreen.mockImplementationOnce(
			() => new Promise<boolean>((resolve) => (answer = resolve))
		);
		const changes = createChangeTracker();
		const onChange = vi.fn();
		followWindowFullscreen(onChange, changes);
		changes.begin()();
		answer(false);
		await settle();
		expect(onChange).not.toHaveBeenCalled();

		fakeWindow.changeFullscreen(true);
		await settle();
		expect(onChange).toHaveBeenCalledWith(true);
	});

	it("drops a read that comes back while one of the app's changes runs", async () => {
		vi.mocked(osPlatform).mockReturnValue("macos");
		const changes = createChangeTracker();
		const onChange = vi.fn();
		const done = changes.begin();
		followWindowFullscreen(onChange, changes);
		await settle();
		expect(onChange).not.toHaveBeenCalled();
		done();
	});

	it("leaves the window alone on iOS and Android", async () => {
		for (const os of ["ios", "android"] as const) {
			vi.mocked(osPlatform).mockReturnValue(os);
			const stop = followWindowFullscreen(vi.fn(), createChangeTracker());
			stop();
		}
		await settle();
		expect(fakeWindow.isFullscreen).not.toHaveBeenCalled();
		expect(fakeWindow.onResized).not.toHaveBeenCalled();
	});

	it("does nothing outside Tauri, where there's no window", async () => {
		vi.mocked(osPlatform).mockReturnValue("macos");
		getCurrentWindow.mockImplementationOnce(() => {
			throw new TypeError("no Tauri internals");
		});
		const onChange = vi.fn();
		const stop = followWindowFullscreen(onChange, createChangeTracker());
		stop();
		await settle();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("logs a read that fails", async () => {
		vi.mocked(osPlatform).mockReturnValue("macos");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		onTestFinished(() => error.mockRestore());
		fakeWindow.isFullscreen.mockRejectedValueOnce(new Error("window closed"));
		const onChange = vi.fn();
		followWindowFullscreen(onChange, createChangeTracker());
		await settle();
		expect(onChange).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith("[fullscreen] isFullscreen failed:", expect.any(Error));
	});

	it("reads once at a time while the window is being resized", async () => {
		vi.mocked(osPlatform).mockReturnValue("macos");
		const onChange = vi.fn();
		followWindowFullscreen(onChange, createChangeTracker());
		await settle();
		let answer: (on: boolean) => void = () => {};
		fakeWindow.isFullscreen.mockImplementationOnce(
			() => new Promise<boolean>((resolve) => (answer = resolve))
		);
		for (let i = 0; i < 5; i++) fakeWindow.changeFullscreen(true);
		expect(fakeWindow.isFullscreen).toHaveBeenCalledTimes(2);

		answer(true);
		await settle();
		// One more read for the resizes that came while the last one ran.
		expect(fakeWindow.isFullscreen).toHaveBeenCalledTimes(3);
		expect(onChange).toHaveBeenLastCalledWith(true);
	});

	it("passes nothing on after it stops", async () => {
		vi.mocked(osPlatform).mockReturnValue("macos");
		let answer: (on: boolean) => void = () => {};
		fakeWindow.isFullscreen.mockImplementationOnce(
			() => new Promise<boolean>((resolve) => (answer = resolve))
		);
		const onChange = vi.fn();
		const stop = followWindowFullscreen(onChange, createChangeTracker());
		stop();
		answer(true);
		await settle();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("logs a resize listener that fails", async () => {
		vi.mocked(osPlatform).mockReturnValue("macos");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		onTestFinished(() => error.mockRestore());
		fakeWindow.onResized.mockRejectedValueOnce(new Error("no permission"));
		const stop = followWindowFullscreen(vi.fn(), createChangeTracker());
		await settle();
		stop();
		await settle();
		expect(error).toHaveBeenCalledWith("[fullscreen] onResized failed:", expect.any(Error));
	});
});
