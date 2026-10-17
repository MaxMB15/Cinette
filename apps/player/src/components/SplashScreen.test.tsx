// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { platform as osPlatform } from "@tauri-apps/plugin-os";
import { SplashScreen } from "./SplashScreen";
import type { SplashScreenState, SplashStep } from "@/hooks/useSplashScreen";
import type { UpdateState } from "@/hooks/useUpdateChecker";
import { openUrl } from "@/lib/openUrl";
import { fakeUpdate, makeUpdateState } from "@/test/app-fixtures";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: vi.fn() }));
vi.mock("@/lib/openUrl", () => ({ openUrl: vi.fn() }));

const BMC_URL = "https://buymeacoffee.com/MaxMB15";

const doneSteps: SplashStep[] = [
	{ id: "providers", label: "Providers & channels loaded", status: "done" },
	{ id: "playlists", label: "No playlists configured", status: "done" },
	{ id: "epg", label: "No EPG configured", status: "done" },
	{ id: "updates", label: "Up to date", status: "done" },
];

const makeSplash = (overrides: Partial<SplashScreenState> = {}): SplashScreenState => ({
	steps: doneSteps,
	allDone: true,
	progress: 1,
	update: null,
	dismissed: false,
	hasProviders: false,
	dismiss: vi.fn(),
	...overrides,
});

const show = (splash: SplashScreenState, updateState: UpdateState = makeUpdateState()) =>
	render(<SplashScreen splash={splash} updateState={updateState} />);

/** The filled part of a progress bar, found by its width. */
const barWithWidth = (container: HTMLElement, width: string) =>
	Array.from(container.querySelectorAll<HTMLElement>("div[style]")).find(
		(el) => el.style.width === width
	);

beforeEach(() => {
	vi.mocked(osPlatform).mockReturnValue("macos");
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("SplashScreen", () => {
	it("welcomes a new user and lets them in once the checks finish", () => {
		const splash = makeSplash();
		show(splash);

		expect(screen.getByRole("heading", { name: "Cinette" })).toBeInTheDocument();
		expect(screen.getByText("Welcome to Cinette")).toBeInTheDocument();
		expect(
			screen.getByText("Add a playlist in the Playlists tab to get started.")
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Get Started →" }));
		expect(splash.dismiss).toHaveBeenCalledOnce();
	});

	it("keeps Get Started disabled while the checks are still running", () => {
		const splash = makeSplash({ allDone: false, progress: 0.25 });
		show(splash);

		const start = screen.getByRole("button", { name: "Get Started →" });
		expect(start).toBeDisabled();
		fireEvent.click(start);
		expect(splash.dismiss).not.toHaveBeenCalled();
	});

	it("lists the startup steps under the welcome message when there are no playlists", () => {
		show(makeSplash());

		for (const step of doneSteps) {
			expect(screen.getByText(step.label)).toBeInTheDocument();
		}
	});

	it("shows loading progress and how far each step has got", () => {
		const { container } = show(
			makeSplash({
				hasProviders: true,
				allDone: false,
				progress: 0.5,
				steps: [
					{ id: "providers", label: "Providers & channels loaded", status: "done" },
					{ id: "playlists", label: "Failed to refresh playlists", status: "error" },
					{ id: "epg", label: "Checking EPG…", status: "active" },
					{ id: "updates", label: "Checking for updates", status: "pending" },
				],
			})
		);

		expect(screen.queryByText("Welcome to Cinette")).not.toBeInTheDocument();
		expect(barWithWidth(container, "50%")).toBeDefined();
		expect(screen.getByText("Providers & channels loaded")).toHaveClass("text-foreground");
		expect(screen.getByText("Failed to refresh playlists")).toHaveClass("text-amber-500");
		expect(screen.getByText("Checking EPG…")).toHaveClass("text-primary", "font-medium");
		expect(screen.getByText("Checking for updates")).toHaveClass("text-muted-foreground");
		// Each row has an icon: a tick, a warning, a spinner, or an empty ring.
		expect(container.querySelector('path[d="M2 6l3 3 5-5"]')).not.toBeNull();
		expect(container.querySelector('path[d="M6 3v4M6 8.5v.5"]')).not.toBeNull();
		expect(container.querySelectorAll(".animate-spin")).toHaveLength(1);
		expect(container.querySelector(".border-2.border-border")).not.toBeNull();
	});

	it("rounds the loading progress to a whole percent", () => {
		const { container } = show(makeSplash({ hasProviders: true, progress: 2 / 3 }));
		expect(barWithWidth(container, "67%")).toBeDefined();
	});

	it("offers a found update once loading finishes", () => {
		const splash = makeSplash({
			update: fakeUpdate({ version: "2.1.0", body: "Faster startup" }),
		});
		const updateState = makeUpdateState({ update: splash.update });
		show(splash, updateState);

		expect(screen.getByText("Update available — v2.1.0")).toBeInTheDocument();
		expect(screen.getByText("Faster startup")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Get Started →" })).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Install Update" }));
		expect(updateState.install).toHaveBeenCalledOnce();

		fireEvent.click(screen.getByRole("button", { name: "Skip for now →" }));
		expect(splash.dismiss).toHaveBeenCalledOnce();
	});

	it("describes the update in general terms when it has no release notes", () => {
		show(makeSplash({ update: fakeUpdate({ body: null }) }));
		expect(screen.getByText("A new version is ready to install.")).toBeInTheDocument();
	});

	it("waits for loading to finish before offering an update", () => {
		show(makeSplash({ allDone: false, update: fakeUpdate() }));

		expect(screen.queryByText(/Update available/)).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Install Update" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Get Started →" })).toBeDisabled();
	});

	it("shows how much of the update has downloaded", () => {
		const updateState = makeUpdateState({ installing: true, progress: 40 });
		const { container } = show(makeSplash({ update: fakeUpdate() }), updateState);

		const install = screen.getByRole("button", { name: "Downloading… 40%" });
		expect(install).toBeDisabled();
		expect(barWithWidth(container, "40%")).toBeDefined();
	});

	it("says it is installing when the download size is unknown", () => {
		const updateState = makeUpdateState({ installing: true, progress: null });
		const { container } = show(makeSplash({ update: fakeUpdate() }), updateState);

		expect(screen.getByRole("button", { name: "Installing…" })).toBeDisabled();
		// With no playlists there is no loading bar either, so no bar is drawn at all.
		expect(container.querySelectorAll("div[style]")).toHaveLength(0);
	});

	it("shows why an install failed", () => {
		const updateState = makeUpdateState({ error: "Update failed: offline" });
		show(makeSplash({ update: fakeUpdate() }), updateState);

		expect(screen.getByText("Update failed: offline")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Install Update" })).toBeEnabled();
	});

	it("opens the donation page from the QR code and from the coffee button", () => {
		show(makeSplash());

		expect(screen.getByRole("heading", { name: "Support Cinette" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Scan to donate via Buy Me a Coffee" }));
		fireEvent.click(screen.getByRole("button", { name: "Buy me a coffee" }));

		expect(openUrl).toHaveBeenCalledTimes(2);
		expect(openUrl).toHaveBeenNthCalledWith(1, BMC_URL);
		expect(openUrl).toHaveBeenNthCalledWith(2, BMC_URL);
	});

	it("leaves out the support panel on iOS", () => {
		vi.mocked(osPlatform).mockReturnValue("ios");
		show(makeSplash());

		expect(screen.queryByText("Support Cinette")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Buy me a coffee" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Get Started →" })).toBeEnabled();
	});
});
