// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { BusyButton } from "./busy-button";

describe("BusyButton", () => {
	afterEach(() => {
		cleanup();
	});

	it("shows its label while idle", () => {
		render(
			<BusyButton busy={false} busyLabel="Refreshing…">
				Refresh now
			</BusyButton>
		);
		const button = screen.getByRole("button", { name: "Refresh now" }) as HTMLButtonElement;
		expect(button.disabled).toBe(false);
	});

	it("says what it is doing and is disabled while busy", () => {
		render(
			<BusyButton busy busyLabel="Refreshing…">
				Refresh now
			</BusyButton>
		);
		const button = screen.getByRole("button", { name: "Refreshing…" }) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		expect(button.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
	});

	it("stays disabled when the caller disables it", () => {
		render(
			<BusyButton busy={false} busyLabel="Refreshing…" disabled>
				Refresh now
			</BusyButton>
		);
		expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
	});
});
