// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Button } from "./button";

afterEach(cleanup);

describe("Button", () => {
	it("draws its variant and size and reports clicks", () => {
		const onClick = vi.fn();
		render(
			<Button variant="outline" size="sm" onClick={onClick}>
				Retry
			</Button>
		);

		const button = screen.getByRole("button", { name: "Retry" });
		expect(button).toHaveClass("border", "border-input", "h-9", "px-3");
		fireEvent.click(button);
		expect(onClick).toHaveBeenCalledOnce();
	});

	it("gives its ref the button so a dialog can focus it", () => {
		const ref = createRef<HTMLButtonElement>();
		render(<Button ref={ref}>Close</Button>);

		expect(ref.current).toBe(screen.getByRole("button", { name: "Close" }));
	});
});
