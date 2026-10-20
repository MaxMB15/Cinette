// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { check } from "@tauri-apps/plugin-updater";
import { listen } from "@tauri-apps/api/event";
import { platform as osPlatform } from "@tauri-apps/plugin-os";
import type { UpdateState } from "@/hooks/useUpdateChecker";
import type { Provider } from "@/lib/types";
import { resetFakeWindow } from "@/test/fake-window";
import { fakeUpdate, makeProvider } from "@/test/app-fixtures";
import App from "./App";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => import("@/test/fake-window"));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

// The pages have their own tests. Here they only show which route is open.
vi.mock("./components/channels/ChannelList", () => ({
	ChannelList: () => <p>Channel list page</p>,
}));
vi.mock("./components/player/VideoPlayer", () => ({ PlayerView: () => <p>Player page</p> }));
vi.mock("./components/playlist/PlaylistManager", () => ({
	PlaylistManager: () => <p>Playlists page</p>,
}));
vi.mock("./components/settings/Settings", () => ({
	Settings: ({ updateState }: { updateState: UpdateState }) => (
		<p>Settings page, update {updateState.update?.version ?? "none"}</p>
	),
}));

let providers: Provider[] = [];

/** What the Rust side answers, by command. */
const backend = (command: string): unknown => {
	switch (command) {
		case "get_providers":
			return providers;
		case "get_all_channels":
		case "list_downloads":
			return [];
		case "get_download_retention":
			return null;
		case "get_install_info":
			return {
				installType: "native",
				releaseUrl: "https://github.com/MaxMB15/Cinette/releases/latest",
			};
		default:
			return undefined;
	}
};

const callsTo = (command: string) => invoke.mock.calls.filter(([c]) => c === command);

const renderApp = (path = "/") =>
	render(
		<MemoryRouter initialEntries={[path]}>
			<App />
		</MemoryRouter>
	);

const getStarted = () => screen.getByRole("button", { name: "Get Started →" });
const waitForStartupChecks = () => waitFor(() => expect(getStarted()).toBeEnabled());

const autoRefreshPlaylist = (id: string) =>
	localStorage.setItem(
		`provider-settings-${id}`,
		JSON.stringify({
			autoRefresh: true,
			refreshIntervalHours: 24,
			epgAutoRefresh: false,
			epgRefreshIntervalHours: 24,
		})
	);

beforeEach(() => {
	providers = [];
	sessionStorage.clear();
	localStorage.clear();
	invoke.mockImplementation(async (command: string) => backend(command));
	vi.mocked(osPlatform).mockReturnValue("macos");
	vi.mocked(check).mockResolvedValue(null);
});

afterEach(() => {
	cleanup();
	resetFakeWindow();
	vi.clearAllMocks();
});

describe("App", () => {
	it("shows the start screen until the startup checks finish, then opens the app", async () => {
		renderApp();

		expect(screen.getByText("Welcome to Cinette")).toBeInTheDocument();
		expect(getStarted()).toBeDisabled();

		await waitForStartupChecks();
		expect(screen.getByText("Up to date")).toBeInTheDocument();
		expect(check).toHaveBeenCalled();

		fireEvent.click(getStarted());
		expect(screen.queryByText("Welcome to Cinette")).not.toBeInTheDocument();
		expect(screen.getByText("Channel list page")).toBeInTheDocument();
		expect(sessionStorage.getItem("splash-shown")).toBe("true");
	});

	it("asks desktop users for a donation once they leave the start screen", async () => {
		renderApp();
		await waitForStartupChecks();
		expect(screen.queryByText("Enjoying Cinette?")).not.toBeInTheDocument();

		fireEvent.click(getStarted());
		expect(screen.getByText("Enjoying Cinette?")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Dismiss donation prompt" }));
		expect(screen.queryByText("Enjoying Cinette?")).not.toBeInTheDocument();
		expect(localStorage.getItem("donation-last-shown")).toMatch(/^\d+$/);
	});

	it("listens for consent requests and its own links on the desktop", async () => {
		renderApp();
		await waitFor(() =>
			expect(listen).toHaveBeenCalledWith("remote://consent", expect.any(Function))
		);
		await waitFor(() =>
			expect(listen).toHaveBeenCalledWith("remote://controller", expect.any(Function))
		);
	});

	it("shows the consent and connect dialogs only on the desktop", async () => {
		vi.mocked(osPlatform).mockReturnValue("ios");
		renderApp();
		await waitFor(() =>
			expect(listen).toHaveBeenCalledWith("remote://command", expect.any(Function))
		);
		expect(listen).not.toHaveBeenCalledWith("remote://consent", expect.any(Function));
		expect(listen).not.toHaveBeenCalledWith("remote://controller", expect.any(Function));
	});

	it("takes commands from other Cinette devices", async () => {
		renderApp();
		await waitFor(() =>
			expect(listen).toHaveBeenCalledWith("remote://command", expect.any(Function))
		);
	});

	it("skips the start screen for the rest of the session", async () => {
		sessionStorage.setItem("splash-shown", "true");
		localStorage.setItem("donation-last-shown", String(Date.now()));
		renderApp();

		expect(screen.queryByRole("button", { name: "Get Started →" })).not.toBeInTheDocument();
		expect(screen.getByText("Channel list page")).toBeInTheDocument();
		await waitFor(() => expect(check).toHaveBeenCalledOnce());
		expect(screen.queryByText("Enjoying Cinette?")).not.toBeInTheDocument();
	});

	it.each([
		["/", "Channel list page"],
		["/player", "Player page"],
		["/playlists", "Playlists page"],
		["/settings", "Settings page, update none"],
	])("opens %s on its page inside the app layout", (path, page) => {
		sessionStorage.setItem("splash-shown", "true");
		localStorage.setItem("donation-last-shown", String(Date.now()));
		renderApp(path);

		expect(screen.getByText(page)).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
		expect(invoke).toHaveBeenCalledWith("plugin:mpv|mpv_set_visible", {
			visible: path === "/player",
		});
	});

	it("reloads playlists and channels after the start screen refreshed a playlist", async () => {
		providers = [makeProvider({ lastUpdated: new Date(0).toISOString() })];
		autoRefreshPlaylist("p1");
		renderApp();

		await waitForStartupChecks();
		expect(screen.getByText("Playlists refreshed")).toBeInTheDocument();
		expect(callsTo("refresh_provider")).toEqual([["refresh_provider", { id: "p1" }]]);
		await waitFor(() => expect(callsTo("get_providers")).toHaveLength(2));
		expect(callsTo("get_all_channels")).toHaveLength(2);
	});

	it("loads playlists only once when none was due for a refresh", async () => {
		providers = [makeProvider({ lastUpdated: new Date().toISOString() })];
		autoRefreshPlaylist("p1");
		renderApp();

		await waitForStartupChecks();
		expect(screen.getByText("Playlists up to date")).toBeInTheDocument();
		expect(callsTo("refresh_provider")).toEqual([]);
		expect(callsTo("get_providers")).toHaveLength(1);
		expect(callsTo("get_all_channels")).toHaveLength(1);
	});

	it("offers an update on the start screen, then in a banner that holds back the donation prompt", async () => {
		vi.mocked(check).mockResolvedValue(
			fakeUpdate({ version: "2.1.0", body: "Faster startup" })
		);
		renderApp("/settings");

		await screen.findByRole("button", { name: "Install Update" });
		// The banner waits for the start screen to close.
		expect(screen.queryByRole("button", { name: "Dismiss update" })).not.toBeInTheDocument();
		expect(screen.getByText("Settings page, update 2.1.0")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Skip for now →" }));
		expect(screen.queryByRole("button", { name: "Install Update" })).not.toBeInTheDocument();
		expect(screen.getByText("Update available — v2.1.0")).toBeInTheDocument();
		expect(screen.queryByText("Enjoying Cinette?")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Dismiss update" }));
		expect(screen.queryByText("Update available — v2.1.0")).not.toBeInTheDocument();
		expect(screen.getByText("Enjoying Cinette?")).toBeInTheDocument();
	});

	it("leaves out the update check, the support panel and the donation prompt on iOS", async () => {
		vi.mocked(osPlatform).mockReturnValue("ios");
		renderApp();

		await waitForStartupChecks();
		expect(screen.getByText("No EPG configured")).toBeInTheDocument();
		expect(screen.queryByText("Checking for updates")).not.toBeInTheDocument();
		expect(screen.queryByText("Up to date")).not.toBeInTheDocument();
		expect(screen.queryByText("Support Cinette")).not.toBeInTheDocument();
		expect(check).not.toHaveBeenCalled();
		// The lock screen's skip buttons get the default lengths.
		expect(invoke).toHaveBeenCalledWith("plugin:mpv|mpv_set_skip_intervals", {
			back: 10,
			forward: 10,
		});

		fireEvent.click(getStarted());
		expect(screen.getByText("Channel list page")).toBeInTheDocument();
		expect(screen.queryByText("Enjoying Cinette?")).not.toBeInTheDocument();
	});
});
