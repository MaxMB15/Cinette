// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SegmentedControl } from "./segmented-control";

const OPTIONS = [
	{ value: false, label: "Off" },
	{ value: true, label: "On" },
];

describe("SegmentedControl", () => {
	afterEach(() => {
		cleanup();
	});

	it("is a named group that marks only the chosen option as pressed", () => {
		render(
			<SegmentedControl
				aria-label="Auto-refresh"
				value
				onChange={vi.fn()}
				options={OPTIONS}
			/>
		);
		expect(screen.getByRole("group", { name: "Auto-refresh" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "On" }).getAttribute("aria-pressed")).toBe(
			"true"
		);
		expect(screen.getByRole("button", { name: "Off" }).getAttribute("aria-pressed")).toBe(
			"false"
		);
	});

	it("reports the option that was clicked", () => {
		const onChange = vi.fn();
		render(<SegmentedControl value onChange={onChange} options={OPTIONS} />);
		fireEvent.click(screen.getByRole("button", { name: "Off" }));
		expect(onChange).toHaveBeenCalledWith(false);
	});

	it("does not submit the form it sits in", () => {
		const onSubmit = vi.fn((e: React.SubmitEvent) => e.preventDefault());
		render(
			<form onSubmit={onSubmit}>
				<SegmentedControl value={false} onChange={vi.fn()} options={OPTIONS} />
			</form>
		);
		fireEvent.click(screen.getByRole("button", { name: "On" }));
		expect(onSubmit).not.toHaveBeenCalled();
	});
});
