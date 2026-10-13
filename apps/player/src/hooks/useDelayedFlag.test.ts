// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { useDelayedFlag } from "./useDelayedFlag";

describe("useDelayedFlag", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("stays false when the value turns off before the delay", () => {
		const { result, rerender } = renderHook(({ v }) => useDelayedFlag(v, 300), {
			initialProps: { v: true },
		});
		act(() => vi.advanceTimersByTime(200));
		expect(result.current).toBe(false);
		rerender({ v: false });
		act(() => vi.advanceTimersByTime(500));
		expect(result.current).toBe(false);
	});

	it("turns true after the delay and off immediately", () => {
		const { result, rerender } = renderHook(({ v }) => useDelayedFlag(v, 300), {
			initialProps: { v: true },
		});
		act(() => vi.advanceTimersByTime(300));
		expect(result.current).toBe(true);
		rerender({ v: false });
		expect(result.current).toBe(false);
	});
});
