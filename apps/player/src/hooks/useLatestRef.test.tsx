// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { render, renderHook } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { describe, it, expect } from "vitest";
import { useLatestRef } from "./useLatestRef";

describe("useLatestRef", () => {
	it("keeps one ref and gives it each new value", () => {
		const { result, rerender } = renderHook(({ v }) => useLatestRef(v), {
			initialProps: { v: 1 },
		});
		const first = result.current;
		expect(first.current).toBe(1);
		rerender({ v: 2 });
		expect(result.current).toBe(first);
		expect(first.current).toBe(2);
	});

	it("has the new value by the time a child's layout effect runs", () => {
		const seen: number[] = [];
		const Child = ({ report }: { report: () => void }) => {
			useLayoutEffect(report);
			return null;
		};
		const Parent = ({ v }: { v: number }) => {
			const latest = useLatestRef(v);
			return (
				<Child
					report={() => {
						seen.push(latest.current);
					}}
				/>
			);
		};
		const { rerender } = render(<Parent v={1} />);
		rerender(<Parent v={2} />);
		expect(seen).toEqual([1, 2]);
	});
});
