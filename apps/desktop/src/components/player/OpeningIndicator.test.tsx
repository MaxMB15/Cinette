// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";
import { OpeningIndicator } from "./OpeningIndicator";

describe("OpeningIndicator", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("adds the slow server line after 15 seconds", () => {
		render(<OpeningIndicator onRetry={() => {}} />);
		expect(screen.getByText("Opening stream")).toBeInTheDocument();
		expect(screen.queryByText(/take a while/)).not.toBeInTheDocument();

		act(() => {
			vi.advanceTimersByTime(15_000);
		});
		expect(screen.getByText(/take a while/)).toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("offers Try again after 45 seconds", () => {
		const onRetry = vi.fn();
		render(<OpeningIndicator onRetry={onRetry} />);

		act(() => {
			vi.advanceTimersByTime(44_999);
		});
		expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();

		act(() => {
			vi.advanceTimersByTime(1);
		});
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("keeps the button's click away from the player underneath", () => {
		const onPlayerClick = vi.fn();
		render(
			<div onClick={onPlayerClick}>
				<OpeningIndicator onRetry={() => {}} />
			</div>
		);
		act(() => {
			vi.advanceTimersByTime(45_000);
		});
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(onPlayerClick).not.toHaveBeenCalled();
	});

	it("has no button without a retry handler", () => {
		render(<OpeningIndicator />);
		act(() => {
			vi.advanceTimersByTime(60_000);
		});
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});
});
