// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { UpdateBanner } from "./UpdateBanner";
import type { UpdateState } from "@/hooks/useUpdateChecker";

const fakeUpdate = (overrides: Record<string, unknown> = {}) => ({
	version: "2.0.0",
	body: "Release notes here",
	date: "2026-01-01",
	downloadAndInstall: vi.fn(),
	...overrides,
});

const makeState = (overrides: Partial<UpdateState> = {}): UpdateState => ({
	update: null,
	checking: false,
	installing: false,
	progress: null,
	error: null,
	packageInstall: false,
	supported: true,
	dismiss: vi.fn(),
	install: vi.fn().mockResolvedValue(undefined),
	checkForUpdates: vi.fn().mockResolvedValue(null),
	...overrides,
});

describe("UpdateBanner", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	// ── Visibility ────────────────────────────────────────────────────

	it("renders nothing when there is no update", () => {
		const { container } = render(<UpdateBanner state={makeState()} />);
		expect(container.firstChild).toBeNull();
	});

	it("renders nothing when hidden prop is true even with an update", () => {
		const state = makeState({ update: fakeUpdate() as never });
		const { container } = render(<UpdateBanner state={state} hidden />);
		expect(container.firstChild).toBeNull();
	});

	it("renders the banner when an update is available", () => {
		const state = makeState({ update: fakeUpdate() as never });
		render(<UpdateBanner state={state} />);
		expect(screen.getByText(/Update available — v2\.0\.0/)).toBeTruthy();
	});

	// ── Content ───────────────────────────────────────────────────────

	it("shows the update body as description", () => {
		const state = makeState({ update: fakeUpdate() as never });
		render(<UpdateBanner state={state} />);
		expect(screen.getByText("Release notes here")).toBeTruthy();
	});

	it("shows fallback text when update body is null", () => {
		const state = makeState({
			update: fakeUpdate({ body: null }) as never,
		});
		render(<UpdateBanner state={state} />);
		expect(screen.getByText("A new version is ready to install.")).toBeTruthy();
	});

	// ── Install button ────────────────────────────────────────────────

	it("shows Install button when not installing", () => {
		const state = makeState({ update: fakeUpdate() as never });
		render(<UpdateBanner state={state} />);
		expect(screen.getByText("Install")).toBeTruthy();
	});

	it("calls install when Install button is clicked", () => {
		const install = vi.fn();
		const state = makeState({ update: fakeUpdate() as never, install });
		render(<UpdateBanner state={state} />);

		fireEvent.click(screen.getByText("Install"));
		expect(install).toHaveBeenCalledTimes(1);
	});

	// ── Dismiss button ────────────────────────────────────────────────

	it("shows dismiss button when not installing", () => {
		const state = makeState({ update: fakeUpdate() as never });
		render(<UpdateBanner state={state} />);
		expect(screen.getByLabelText("Dismiss update")).toBeTruthy();
	});

	it("calls dismiss when dismiss button is clicked", () => {
		const dismiss = vi.fn();
		const state = makeState({ update: fakeUpdate() as never, dismiss });
		render(<UpdateBanner state={state} />);

		fireEvent.click(screen.getByLabelText("Dismiss update"));
		expect(dismiss).toHaveBeenCalledTimes(1);
	});

	// ── Installing state ──────────────────────────────────────────────

	it("hides Install and dismiss buttons while installing", () => {
		const state = makeState({
			update: fakeUpdate() as never,
			installing: true,
			progress: 50,
		});
		render(<UpdateBanner state={state} />);

		expect(screen.queryByText("Install")).toBeNull();
		expect(screen.queryByLabelText("Dismiss update")).toBeNull();
	});

	it("shows download progress during install", () => {
		const state = makeState({
			update: fakeUpdate() as never,
			installing: true,
			progress: 42,
		});
		render(<UpdateBanner state={state} />);
		expect(screen.getByText("Downloading… 42%")).toBeTruthy();
	});

	it("shows Installing… when progress is null during install", () => {
		const state = makeState({
			update: fakeUpdate() as never,
			installing: true,
			progress: null,
		});
		render(<UpdateBanner state={state} />);
		expect(screen.getByText("Installing…")).toBeTruthy();
	});

	it("renders progress bar during install with progress", () => {
		const state = makeState({
			update: fakeUpdate() as never,
			installing: true,
			progress: 75,
		});
		const { container } = render(<UpdateBanner state={state} />);

		const progressBar = container.querySelector('[style*="width: 75%"]');
		expect(progressBar).toBeTruthy();
	});

	// ── Package install (deb/rpm) ─────────────────────────────────────

	it("shows password required hint when package download completes", () => {
		const state = makeState({
			update: fakeUpdate() as never,
			installing: true,
			progress: 100,
			packageInstall: true,
		});
		render(<UpdateBanner state={state} />);
		expect(screen.getByText(/password required/)).toBeTruthy();
	});

	it("shows Install button for package installs (same as native)", () => {
		const state = makeState({
			update: fakeUpdate() as never,
			packageInstall: true,
		});
		render(<UpdateBanner state={state} />);
		expect(screen.getByText("Install")).toBeTruthy();
	});

	// ── Error state ───────────────────────────────────────────────────

	it("displays error message when error is set", () => {
		const state = makeState({
			update: fakeUpdate() as never,
			error: "Update failed: Download request failed with status: 404 Not Found",
		});
		render(<UpdateBanner state={state} />);
		expect(
			screen.getByText("Update failed: Download request failed with status: 404 Not Found")
		).toBeTruthy();
	});

	it("shows Install button alongside error so user can retry", () => {
		const state = makeState({
			update: fakeUpdate() as never,
			error: "Update failed: network error",
			installing: false,
		});
		render(<UpdateBanner state={state} />);

		expect(screen.getByText(/Update failed/)).toBeTruthy();
		expect(screen.getByText("Install")).toBeTruthy();
	});

	it("does not show error when error is null", () => {
		const state = makeState({ update: fakeUpdate() as never, error: null });
		render(<UpdateBanner state={state} />);
		expect(screen.queryByText(/Update failed/)).toBeNull();
	});
});
