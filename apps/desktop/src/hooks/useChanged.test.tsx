// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { render, renderHook, screen } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { describe, it, expect } from "vitest";
import { useChanged } from "./useChanged";

describe("useChanged", () => {
	it("is true once for each new value and not on the first render", () => {
		const seen: boolean[] = [];
		const { rerender } = renderHook(({ v }) => seen.push(useChanged(v)), {
			initialProps: { v: "a" },
		});
		rerender({ v: "a" });
		rerender({ v: "b" });
		// The hook's own update renders again at once, and that render sees no change.
		expect(seen).toEqual([false, false, true, false]);
	});

	it("lets a component reset its state before the new value shows", () => {
		const committed: string[] = [];
		const Item = ({ id }: { id: string }) => {
			const [draft, setDraft] = useState("typed");
			if (useChanged(id)) setDraft("");
			useLayoutEffect(() => {
				committed.push(draft);
			});
			return <input aria-label={id} value={draft} readOnly />;
		};
		const { rerender } = render(<Item id="a" />);
		rerender(<Item id="b" />);
		expect(screen.getByRole("textbox", { name: "b" })).toHaveValue("");
		// The render that paired "b" with the old text never reached the page.
		expect(committed).toEqual(["typed", ""]);
	});
});
