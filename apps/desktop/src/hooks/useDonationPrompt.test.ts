// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDonationPrompt } from "./useDonationPrompt";

const STORAGE_KEY = "donation-last-shown";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

describe("useDonationPrompt", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not show when enabled=false", () => {
		const { result } = renderHook(() => useDonationPrompt({ enabled: false }));
		expect(result.current.shouldShow).toBe(false);
	});

	it("waits for enabled before showing", () => {
		const { result, rerender } = renderHook(({ enabled }) => useDonationPrompt({ enabled }), {
			initialProps: { enabled: false },
		});
		expect(result.current.shouldShow).toBe(false);
		rerender({ enabled: true });
		expect(result.current.shouldShow).toBe(true);
	});

	it("shows on first launch (no stored key)", () => {
		const { result } = renderHook(() => useDonationPrompt({ enabled: true }));
		expect(result.current.shouldShow).toBe(true);
	});

	it("does not show if dismissed less than 30 days ago", () => {
		const recent = Date.now() - (THIRTY_DAYS_MS - 1000);
		localStorage.setItem(STORAGE_KEY, String(recent));
		const { result } = renderHook(() => useDonationPrompt({ enabled: true }));
		expect(result.current.shouldShow).toBe(false);
	});

	it("shows if dismissed exactly 30 days ago", () => {
		const old = Date.now() - THIRTY_DAYS_MS;
		localStorage.setItem(STORAGE_KEY, String(old));
		const { result } = renderHook(() => useDonationPrompt({ enabled: true }));
		expect(result.current.shouldShow).toBe(true);
	});

	it("dismiss() sets shouldShow=false and writes timestamp", () => {
		const before = Date.now();
		const { result } = renderHook(() => useDonationPrompt({ enabled: true }));
		expect(result.current.shouldShow).toBe(true);

		act(() => result.current.dismiss());

		expect(result.current.shouldShow).toBe(false);
		const stored = parseInt(localStorage.getItem(STORAGE_KEY) ?? "0", 10);
		expect(stored).toBeGreaterThanOrEqual(before);
	});

	describe("when storage fails", () => {
		beforeEach(() => {
			vi.spyOn(console, "warn").mockImplementation(() => {});
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("still shows the prompt when the timestamp can't be read", () => {
			vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
				throw new DOMException("blocked", "SecurityError");
			});
			const { result } = renderHook(() => useDonationPrompt({ enabled: true }));
			expect(result.current.shouldShow).toBe(true);
		});

		it("still closes the prompt when the timestamp can't be saved", () => {
			vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
				throw new DOMException("full", "QuotaExceededError");
			});
			const { result } = renderHook(() => useDonationPrompt({ enabled: true }));

			act(() => result.current.dismiss());

			expect(result.current.shouldShow).toBe(false);
		});
	});
});
