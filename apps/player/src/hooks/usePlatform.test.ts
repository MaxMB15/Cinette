// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { platform as osPlatform } from "@tauri-apps/plugin-os";
import { usePlatform } from "./usePlatform";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: vi.fn() }));

const original = {
	innerWidth: window.innerWidth,
	innerHeight: window.innerHeight,
	screenWidth: window.screen.width,
	screenHeight: window.screen.height,
};

const setProp = (target: object, key: string, value: number) =>
	Object.defineProperty(target, key, { configurable: true, value });

/** Sets the screen and the window inside it, in CSS pixels. */
const setDisplay = (screenWidth: number, screenHeight: number, width: number, height: number) => {
	setProp(window.screen, "width", screenWidth);
	setProp(window.screen, "height", screenHeight);
	setProp(window, "innerWidth", width);
	setProp(window, "innerHeight", height);
};

/** Resizes the window and tells the app, the way rotating an iPad would. */
const resizeTo = (width: number, height: number) =>
	act(() => {
		setProp(window, "innerWidth", width);
		setProp(window, "innerHeight", height);
		window.dispatchEvent(new Event("resize"));
	});

afterEach(() => {
	cleanup();
	setDisplay(
		original.screenWidth,
		original.screenHeight,
		original.innerWidth,
		original.innerHeight
	);
	vi.restoreAllMocks();
});

describe("usePlatform", () => {
	it("keeps a Mac on the desktop layout whatever the window size", () => {
		vi.mocked(osPlatform).mockReturnValue("macos");
		setDisplay(1512, 982, 500, 700);

		const { result } = renderHook(() => usePlatform());
		expect(result.current).toEqual({ platform: "macos", layoutMode: "desktop" });

		resizeTo(320, 480);
		expect(result.current.layoutMode).toBe("desktop");
	});

	it("moves an iPad between layouts as its window changes size", () => {
		vi.mocked(osPlatform).mockReturnValue("ios");
		setDisplay(1032, 1376, 1032, 1376);

		const { result } = renderHook(() => usePlatform());
		expect(result.current).toEqual({ platform: "ios", layoutMode: "desktop" });

		resizeTo(834, 1376);
		expect(result.current.layoutMode).toBe("tablet");

		resizeTo(375, 1376);
		expect(result.current.layoutMode).toBe("mobile");

		resizeTo(1376, 1032);
		expect(result.current.layoutMode).toBe("desktop");
	});

	it("keeps an iPhone on the phone layout when it turns sideways", () => {
		vi.mocked(osPlatform).mockReturnValue("ios");
		setDisplay(402, 874, 402, 874);

		const { result } = renderHook(() => usePlatform());
		expect(result.current.layoutMode).toBe("mobile");

		resizeTo(874, 402);
		expect(result.current.layoutMode).toBe("mobile");
	});

	it("gives an Android TV the tv platform and layout", () => {
		vi.mocked(osPlatform).mockReturnValue("android");
		window.__CINETTE_TV__ = true;
		setDisplay(960, 540, 960, 540);

		const { result } = renderHook(() => usePlatform());
		expect(result.current).toEqual({ platform: "tv", layoutMode: "tv" });
		delete window.__CINETTE_TV__;
	});

	it("gives a large Android tablet the desktop layout, not the tv one", () => {
		vi.mocked(osPlatform).mockReturnValue("android");
		setDisplay(1280, 800, 1280, 800);

		const { result } = renderHook(() => usePlatform());
		expect(result.current).toEqual({ platform: "android", layoutMode: "desktop" });
	});

	it("stops following resizes once unmounted", () => {
		vi.mocked(osPlatform).mockReturnValue("ios");
		setDisplay(1032, 1376, 1032, 1376);
		const add = vi.spyOn(window, "addEventListener");
		const remove = vi.spyOn(window, "removeEventListener");

		const { unmount } = renderHook(() => usePlatform());
		const handler = add.mock.calls.find(([type]) => type === "resize")?.[1];
		expect(handler).toBeTypeOf("function");

		unmount();
		expect(remove).toHaveBeenCalledWith("resize", handler);
	});
});
