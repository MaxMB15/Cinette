// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { UpdateBanner } from "./UpdateBanner";
import { fakeUpdate, makeUpdateState } from "@/test/app-fixtures";

describe("UpdateBanner", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	// ── Visibility ────────────────────────────────────────────────────

	it("renders nothing when there is no update", () => {
		const { container } = render(<UpdateBanner state={makeUpdateState()} />);
		expect(container.firstChild).toBeNull();
	});

	it("renders nothing when hidden prop is true even with an update", () => {
		const state = makeUpdateState({ update: fakeUpdate() });
		const { container } = render(<UpdateBanner state={state} hidden />);
		expect(container.firstChild).toBeNull();
	});

	it("renders the banner when an update is available", () => {
		const state = makeUpdateState({ update: fakeUpdate() });
		render(<UpdateBanner state={state} />);
		expect(screen.getByText(/Update available — v2\.0\.0/)).toBeTruthy();
	});

	// ── Content ───────────────────────────────────────────────────────

	it("shows the update body as description", () => {
		const state = makeUpdateState({ update: fakeUpdate() });
		render(<UpdateBanner state={state} />);
		expect(screen.getByText("Release notes")).toBeTruthy();
	});

	it("shows fallback text when the update has no notes", () => {
		const state = makeUpdateState({ update: fakeUpdate({ body: undefined }) });
		render(<UpdateBanner state={state} />);
		expect(screen.getByText("A new version is ready to install.")).toBeTruthy();
	});

	// ── Install button ────────────────────────────────────────────────

	it("shows Install button when not installing", () => {
		const state = makeUpdateState({ update: fakeUpdate() });
		render(<UpdateBanner state={state} />);
		expect(screen.getByText("Install")).toBeTruthy();
	});

	it("calls install when Install button is clicked", () => {
		const install = vi.fn();
		const state = makeUpdateState({ update: fakeUpdate(), install });
		render(<UpdateBanner state={state} />);

		fireEvent.click(screen.getByText("Install"));
		expect(install).toHaveBeenCalledTimes(1);
	});

	// ── Dismiss button ────────────────────────────────────────────────

	it("shows dismiss button when not installing", () => {
		const state = makeUpdateState({ update: fakeUpdate() });
		render(<UpdateBanner state={state} />);
		expect(screen.getByLabelText("Dismiss update")).toBeTruthy();
	});

	it("calls dismiss when dismiss button is clicked", () => {
		const dismiss = vi.fn();
		const state = makeUpdateState({ update: fakeUpdate(), dismiss });
		render(<UpdateBanner state={state} />);

		fireEvent.click(screen.getByLabelText("Dismiss update"));
		expect(dismiss).toHaveBeenCalledTimes(1);
	});

	// ── Installing state ──────────────────────────────────────────────

	it("hides Install and dismiss buttons while installing", () => {
		const state = makeUpdateState({
			update: fakeUpdate(),
			installing: true,
			progress: 50,
		});
		render(<UpdateBanner state={state} />);

		expect(screen.queryByText("Install")).toBeNull();
		expect(screen.queryByLabelText("Dismiss update")).toBeNull();
	});

	it("shows download progress during install", () => {
		const state = makeUpdateState({
			update: fakeUpdate(),
			installing: true,
			progress: 42,
		});
		render(<UpdateBanner state={state} />);
		expect(screen.getByText("Downloading… 42%")).toBeTruthy();
	});

	it("shows Installing… when progress is null during install", () => {
		const state = makeUpdateState({
			update: fakeUpdate(),
			installing: true,
			progress: null,
		});
		render(<UpdateBanner state={state} />);
		expect(screen.getByText("Installing…")).toBeTruthy();
	});

	it("renders progress bar during install with progress", () => {
		const state = makeUpdateState({
			update: fakeUpdate(),
			installing: true,
			progress: 75,
		});
		const { container } = render(<UpdateBanner state={state} />);

		const progressBar = container.querySelector('[style*="width: 75%"]');
		expect(progressBar).toBeTruthy();
	});

	// ── Package install (deb/rpm) ─────────────────────────────────────

	it("shows password required hint when package download completes", () => {
		const state = makeUpdateState({
			update: fakeUpdate(),
			installing: true,
			progress: 100,
			packageInstall: true,
		});
		render(<UpdateBanner state={state} />);
		expect(screen.getByText(/password required/)).toBeTruthy();
	});

	it("shows Install button for package installs (same as native)", () => {
		const state = makeUpdateState({
			update: fakeUpdate(),
			packageInstall: true,
		});
		render(<UpdateBanner state={state} />);
		expect(screen.getByText("Install")).toBeTruthy();
	});

	// ── Error state ───────────────────────────────────────────────────

	it("displays error message when error is set", () => {
		const state = makeUpdateState({
			update: fakeUpdate(),
			error: "Update failed: Download request failed with status: 404 Not Found",
		});
		render(<UpdateBanner state={state} />);
		expect(
			screen.getByText("Update failed: Download request failed with status: 404 Not Found")
		).toBeTruthy();
	});

	it("shows Install button alongside error so user can retry", () => {
		const state = makeUpdateState({
			update: fakeUpdate(),
			error: "Update failed: network error",
			installing: false,
		});
		render(<UpdateBanner state={state} />);

		expect(screen.getByText(/Update failed/)).toBeTruthy();
		expect(screen.getByText("Install")).toBeTruthy();
	});

	it("does not show error when error is null", () => {
		const state = makeUpdateState({ update: fakeUpdate(), error: null });
		render(<UpdateBanner state={state} />);
		expect(screen.queryByText(/Update failed/)).toBeNull();
	});
});
