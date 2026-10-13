// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ContentDisclaimer, DISCLAIMER_URL } from "./ContentDisclaimer";
import { openUrl } from "@/lib/openUrl";

vi.mock("@/lib/openUrl", () => ({ openUrl: vi.fn() }));

describe("ContentDisclaimer", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("says the app has no content and the user is responsible", () => {
		render(<ContentDisclaimer />);
		expect(screen.getByText(/doesn't include any channels or content/)).toBeTruthy();
		expect(screen.getByText(/You're responsible for what you watch/)).toBeTruthy();
	});

	it("opens the full disclaimer in the browser", () => {
		render(<ContentDisclaimer />);
		fireEvent.click(screen.getByRole("button", { name: "Read the full disclaimer" }));
		expect(openUrl).toHaveBeenCalledWith(DISCLAIMER_URL);
	});

	it("doesn't submit a surrounding form", () => {
		const onSubmit = vi.fn((e: Event) => e.preventDefault());
		render(
			<form onSubmit={onSubmit as never}>
				<ContentDisclaimer />
			</form>
		);
		fireEvent.click(screen.getByRole("button", { name: "Read the full disclaimer" }));
		expect(onSubmit).not.toHaveBeenCalled();
	});
});
