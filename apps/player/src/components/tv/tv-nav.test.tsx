// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TvNavContext, useRemembered, useTvNav, type TvNav } from "./tv-nav";

const navWith = (memory: Map<string, unknown> = new Map()): TvNav => ({
	section: "movie",
	openSection: vi.fn(),
	memory,
});

const wrapperFor = (nav: TvNav) => {
	const Provider = ({ children }: { children: ReactNode }) => (
		<TvNavContext.Provider value={nav}>{children}</TvNavContext.Provider>
	);
	return Provider;
};

describe("useTvNav", () => {
	it("starts on live TV with nothing remembered, outside the TV layout", () => {
		const { result } = renderHook(() => useTvNav());
		expect(result.current.section).toBe("live");
		expect(result.current.memory.size).toBe(0);
		expect(() => result.current.openSection("settings")).not.toThrow();
	});

	it("gives what the TV layout provides", () => {
		const nav = navWith();
		const { result } = renderHook(() => useTvNav(), { wrapper: wrapperFor(nav) });
		expect(result.current).toBe(nav);
	});
});

describe("useRemembered", () => {
	it("starts from the initial value when nothing is stored", () => {
		const memory = new Map<string, unknown>([["other", 5]]);
		const { result } = renderHook(() => useRemembered("cursor", 2), {
			wrapper: wrapperFor(navWith(memory)),
		});
		expect(result.current[0]).toBe(2);
	});

	it("gives back what's stored when the screen opens again", () => {
		const memory = new Map<string, unknown>([["cursor", 7]]);
		const { result } = renderHook(() => useRemembered("cursor", 2), {
			wrapper: wrapperFor(navWith(memory)),
		});
		expect(result.current[0]).toBe(7);
	});

	it("gives back a stored empty value rather than the initial one", () => {
		const memory = new Map<string, unknown>([["open", null]]);
		const { result } = renderHook(() => useRemembered<string | null>("open", "first"), {
			wrapper: wrapperFor(navWith(memory)),
		});
		expect(result.current[0]).toBeNull();
	});

	it("shows a new value and keeps it for the next time the screen opens", () => {
		const nav = navWith();
		const first = renderHook(() => useRemembered("cursor", 2), { wrapper: wrapperFor(nav) });

		act(() => first.result.current[1](9));
		expect(first.result.current[0]).toBe(9);
		first.unmount();

		const again = renderHook(() => useRemembered("cursor", 2), { wrapper: wrapperFor(nav) });
		expect(again.result.current[0]).toBe(9);
	});

	it("stores under the key the screen has now", () => {
		const memory = new Map<string, unknown>();
		const { result, rerender } = renderHook(({ key }) => useRemembered(key, 0), {
			initialProps: { key: "first" },
			wrapper: wrapperFor(navWith(memory)),
		});

		rerender({ key: "second" });
		act(() => result.current[1](3));

		expect(memory.get("second")).toBe(3);
		expect(memory.has("first")).toBe(false);
	});
});
