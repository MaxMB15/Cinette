// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ConnectionStatusOverlay } from "./ConnectionStatusOverlay";

const idle = {
	reconnecting: false,
	reconnectAttempt: 0,
	buffering: false,
	loadFailed: false,
	recentlyRecovered: false,
};

describe("ConnectionStatusOverlay", () => {
	afterEach(cleanup);

	it("shows nothing while the connection is fine", () => {
		const { container } = render(<ConnectionStatusOverlay {...idle} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("offers Retry for a stream that didn't open", () => {
		const onRetry = vi.fn();
		render(<ConnectionStatusOverlay {...idle} openFailed onRetry={onRetry} />);
		expect(screen.getByText(/didn't open/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("moves below the top bar when asked, clear of the Back button", () => {
		const { rerender } = render(<ConnectionStatusOverlay {...idle} loadFailed />);
		expect(screen.getByRole("status").className).toContain("top-[calc(1.5rem");
		rerender(<ConnectionStatusOverlay {...idle} loadFailed belowTopBar />);
		expect(screen.getByRole("status").className).toContain("top-[calc(4.5rem");
	});
});
