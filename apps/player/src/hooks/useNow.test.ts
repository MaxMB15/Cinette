// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { useNow, NOW_TICK_MS } from "./useNow";

const START = Date.UTC(2026, 9, 11, 12, 0, 0);

describe("useNow", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(START);
	});
	afterEach(() => vi.useRealTimers());

	it("starts at the current time and moves on every tick", () => {
		const { result, unmount } = renderHook(() => useNow());
		expect(result.current).toBe(START / 1000);
		act(() => vi.advanceTimersByTime(NOW_TICK_MS));
		expect(result.current).toBe(START / 1000 + NOW_TICK_MS / 1000);
		unmount();
	});

	it("shares one timer and stops it when nothing uses it", () => {
		const a = renderHook(() => useNow());
		const b = renderHook(() => useNow());
		expect(vi.getTimerCount()).toBe(1);
		a.unmount();
		expect(vi.getTimerCount()).toBe(1);
		b.unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reads the time again when it starts after a pause", () => {
		const first = renderHook(() => useNow());
		first.unmount();
		vi.setSystemTime(START + 3_600_000);
		const { result, unmount } = renderHook(() => useNow());
		expect(result.current).toBe(START / 1000 + 3600);
		unmount();
	});
});
