// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, afterEach } from "vitest";
import { createRef } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { ScrollArea } from "./scroll-area";

afterEach(cleanup);

describe("ScrollArea", () => {
	it("scrolls its children and gives its ref the scrolling element", () => {
		const ref = createRef<HTMLDivElement>();
		render(
			<ScrollArea ref={ref} className="h-40" data-testid="area">
				<p>Row</p>
			</ScrollArea>
		);

		const area = screen.getByTestId("area");
		expect(ref.current).toBe(area);
		expect(area).toHaveClass("overflow-auto", "h-40");
		expect(area).toContainElement(screen.getByText("Row"));
	});
});
