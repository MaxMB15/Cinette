// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { CategoryBrowser } from "./CategoryBrowser";

describe("CategoryBrowser", () => {
	afterEach(cleanup);

	const defaultProps = {
		superCategories: [{ name: "United States", groupCount: 3, channelCount: 150 }],
		topLevelGroups: [{ name: "Misc", channelCount: 10 }],
		onSelectCategory: vi.fn(),
		onSelectGroup: vi.fn(),
		onManage: vi.fn(),
	};

	it("renders super-categories and top-level groups", () => {
		render(<CategoryBrowser {...defaultProps} />);
		expect(screen.getByText("United States")).toBeDefined();
		expect(screen.getByText("Misc")).toBeDefined();
		expect(screen.getByText("Manage")).toBeDefined();
	});

	it("calls onSelectCategory when clicking a super-category", () => {
		render(<CategoryBrowser {...defaultProps} />);
		fireEvent.click(screen.getAllByText("United States")[0]);
		expect(defaultProps.onSelectCategory).toHaveBeenCalledWith("United States");
	});

	it("shows the counts under each tile", () => {
		render(<CategoryBrowser {...defaultProps} />);
		expect(screen.getByText("3 groups \u00b7 150 ch")).toBeDefined();
		expect(screen.getByText("10 channels")).toBeDefined();
	});

	it("calls onSelectGroup when clicking a top-level group", () => {
		render(<CategoryBrowser {...defaultProps} />);
		fireEvent.click(screen.getByRole("button", { name: /Misc/ }));
		expect(defaultProps.onSelectGroup).toHaveBeenCalledWith("Misc");
	});
});
