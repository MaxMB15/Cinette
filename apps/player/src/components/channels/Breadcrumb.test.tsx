// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { render, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Breadcrumb } from "./Breadcrumb";

describe("Breadcrumb", () => {
	it("renders all path segments", () => {
		const { container } = render(
			<Breadcrumb
				path={[{ label: "All Categories", onClick: vi.fn() }, { label: "United States" }]}
			/>
		);
		expect(container.textContent).toContain("All Categories");
		expect(container.textContent).toContain("United States");
	});

	it("calls onClick for non-last segments", () => {
		const onClick = vi.fn();
		const { container } = render(
			<Breadcrumb path={[{ label: "All Categories", onClick }, { label: "US: Sports" }]} />
		);
		const btn = container.querySelector("button")!;
		fireEvent.click(btn);
		expect(onClick).toHaveBeenCalledOnce();
	});
});
