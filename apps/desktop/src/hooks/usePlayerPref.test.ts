// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePlayerPref } from "./usePlayerPref";
import { readSkipIntervals, SKIP_INTERVALS_EVENT, writeSkipInterval } from "@/lib/player-prefs";

describe("usePlayerPref", () => {
	beforeEach(() => localStorage.clear());

	it("starts from the saved value", () => {
		writeSkipInterval("back", 30);
		const { result } = renderHook(() => usePlayerPref(readSkipIntervals, SKIP_INTERVALS_EVENT));
		expect(result.current.back).toBe(30);
	});

	it("follows changes made while it's mounted", () => {
		const { result } = renderHook(() => usePlayerPref(readSkipIntervals, SKIP_INTERVALS_EVENT));
		act(() => writeSkipInterval("forward", 60));
		expect(result.current.forward).toBe(60);
	});

	it("stops listening once unmounted", () => {
		const { result, unmount } = renderHook(() =>
			usePlayerPref(readSkipIntervals, SKIP_INTERVALS_EVENT)
		);
		unmount();
		writeSkipInterval("forward", 60);
		expect(result.current.forward).toBe(10);
	});
});
