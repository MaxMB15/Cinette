// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@/lib/tauri", () => ({
	mpvSetSkipIntervals: vi.fn().mockResolvedValue(undefined),
}));

const platform = vi.hoisted(() => ({ mobile: true }));
vi.mock("@/lib/platform", () => ({
	isMobilePlatform: () => platform.mobile,
}));

import { mpvSetSkipIntervals } from "@/lib/tauri";
import { writeSkipInterval } from "@/lib/player-prefs";
import { useLockScreenSkip } from "./useLockScreenSkip";

describe("useLockScreenSkip", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.mocked(mpvSetSkipIntervals).mockClear();
		platform.mobile = true;
	});
	afterEach(() => localStorage.clear());

	it("sends the lengths at start and after each change", () => {
		const { unmount } = renderHook(() => useLockScreenSkip());
		expect(mpvSetSkipIntervals).toHaveBeenLastCalledWith(10, 10);
		writeSkipInterval("forward", 30);
		expect(mpvSetSkipIntervals).toHaveBeenLastCalledWith(10, 30);
		unmount();
		writeSkipInterval("back", 5);
		expect(mpvSetSkipIntervals).toHaveBeenCalledTimes(2);
	});

	it("does nothing on desktop", () => {
		platform.mobile = false;
		renderHook(() => useLockScreenSkip());
		writeSkipInterval("forward", 30);
		expect(mpvSetSkipIntervals).not.toHaveBeenCalled();
	});
});
