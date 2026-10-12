// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, afterEach } from "vitest";
import { createRef } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { Slider } from "./slider";

afterEach(cleanup);

describe("Slider", () => {
	it("gives its ref the root that holds the thumb", () => {
		const ref = createRef<HTMLSpanElement>();
		render(<Slider ref={ref} value={30} aria-label="Volume" />);

		const thumb = screen.getByRole("slider", { name: "Volume" });
		expect(thumb).toHaveAttribute("aria-valuenow", "30");
		expect(ref.current).not.toBe(thumb);
		expect(ref.current?.contains(thumb)).toBe(true);
		expect(ref.current).toHaveClass("touch-none");
	});
});
