// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSplashScreen } from "./useSplashScreen";
import { createRefreshTracker, type RefreshTracker } from "@/lib/refresh-schedule";
import { makeUpdateState } from "@/test/app-fixtures";

// Mock Tauri API calls
vi.mock("@/lib/tauri", () => ({
	refreshProvider: vi.fn(),
	refreshEpg: vi.fn(),
}));

vi.mock("./useChannels", () => ({
	useChannels: vi.fn(),
	loadProviderSettings: vi.fn(),
	getEpgLastRefresh: vi.fn(),
	setEpgLastRefresh: vi.fn(),
}));

import * as tauri from "@/lib/tauri";
import * as channelsHook from "./useChannels";

const mockUseChannels = vi.mocked(channelsHook.useChannels);
const mockRefreshProvider = vi.mocked(tauri.refreshProvider);
const mockRefreshEpg = vi.mocked(tauri.refreshEpg);
const mockLoadProviderSettings = vi.mocked(channelsHook.loadProviderSettings);
const mockGetEpgLastRefresh = vi.mocked(channelsHook.getEpgLastRefresh);
const mockSetEpgLastRefresh = vi.mocked(channelsHook.setEpgLastRefresh);

describe("useSplashScreen", () => {
	let tracker: RefreshTracker;

	beforeEach(() => {
		sessionStorage.clear();
		tracker = createRefreshTracker();
		// Default: no providers, already initialized
		mockUseChannels.mockReturnValue({
			providers: [],
			initialized: true,
			autoRefresh: tracker,
		} as never);
		mockLoadProviderSettings.mockReturnValue({
			autoRefresh: false,
			refreshIntervalHours: 24,
			epgAutoRefresh: false,
			epgRefreshIntervalHours: 24,
		});
		mockGetEpgLastRefresh.mockReturnValue(0);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("starts with dismissed=false and 4 steps when session is fresh", async () => {
		const updateState = makeUpdateState();
		const { result } = renderHook(() => useSplashScreen({ updateState }));
		expect(result.current.steps).toHaveLength(4);
		expect(result.current.dismissed).toBe(false);
		await waitFor(() => expect(result.current.allDone).toBe(true));
		expect(result.current.steps.every((s) => s.status === "done")).toBe(true);
	});

	it("marks dismissed immediately if session key is already set", () => {
		sessionStorage.setItem("splash-shown", "true");
		const updateState = makeUpdateState();
		const { result } = renderHook(() => useSplashScreen({ updateState }));
		expect(result.current.dismissed).toBe(true);
		expect(result.current.allDone).toBe(true);
	});

	it("completes all steps and sets allDone when there are no providers", async () => {
		const updateState = makeUpdateState();
		const { result } = renderHook(() => useSplashScreen({ updateState }));

		await waitFor(() => expect(result.current.allDone).toBe(true));

		expect(result.current.steps.every((s) => s.status === "done")).toBe(true);
		expect(result.current.progress).toBe(1);
	});

	it("does not call refreshProvider when autoRefresh is false", async () => {
		mockUseChannels.mockReturnValue({
			providers: [{ id: "p1", lastUpdated: new Date(0).toISOString(), epgUrl: null }],
			initialized: true,
			autoRefresh: tracker,
		} as never);
		mockLoadProviderSettings.mockReturnValue({
			autoRefresh: false,
			refreshIntervalHours: 24,
			epgAutoRefresh: false,
			epgRefreshIntervalHours: 24,
		});

		const updateState = makeUpdateState();
		const { result } = renderHook(() => useSplashScreen({ updateState }));
		await waitFor(() => expect(result.current.allDone).toBe(true));

		expect(mockRefreshProvider).not.toHaveBeenCalled();
	});

	it("calls refreshProvider when autoRefresh=true and interval elapsed", async () => {
		mockUseChannels.mockReturnValue({
			providers: [{ id: "p1", lastUpdated: new Date(0).toISOString(), epgUrl: null }],
			initialized: true,
			autoRefresh: tracker,
		} as never);
		mockLoadProviderSettings.mockReturnValue({
			autoRefresh: true,
			refreshIntervalHours: 24,
			epgAutoRefresh: false,
			epgRefreshIntervalHours: 24,
		});
		mockRefreshProvider.mockResolvedValue(undefined);

		const updateState = makeUpdateState();
		const { result } = renderHook(() => useSplashScreen({ updateState }));
		await waitFor(() => expect(result.current.allDone).toBe(true));

		expect(mockRefreshProvider).toHaveBeenCalledWith("p1");
	});

	it.each([
		["a guide", 120],
		["a guide that came back empty", 0],
	])(
		"refreshes %s when the interval has passed, and counts it as refreshed",
		async (_, saved) => {
			mockUseChannels.mockReturnValue({
				providers: [
					{
						id: "p1",
						lastUpdated: new Date().toISOString(),
						epgUrl: "http://epg.example.com/guide.xml",
					},
				],
				initialized: true,
				autoRefresh: tracker,
			} as never);
			mockLoadProviderSettings.mockReturnValue({
				autoRefresh: false,
				refreshIntervalHours: 24,
				epgAutoRefresh: true,
				epgRefreshIntervalHours: 24,
			});
			mockGetEpgLastRefresh.mockReturnValue(0); // never refreshed
			mockRefreshEpg.mockResolvedValue(saved);

			const updateState = makeUpdateState();
			const { result } = renderHook(() => useSplashScreen({ updateState }));
			await waitFor(() => expect(result.current.allDone).toBe(true));

			expect(mockRefreshEpg).toHaveBeenCalledWith("p1");
			expect(mockSetEpgLastRefresh).toHaveBeenCalledWith("p1");
			expect(result.current.steps.find((s) => s.id === "epg")?.status).toBe("done");
		}
	);

	it("finishes with the remaining steps failed when a step throws", async () => {
		mockUseChannels.mockReturnValue({
			providers: [
				{
					id: "p1",
					lastUpdated: new Date().toISOString(),
					epgUrl: "http://epg.example.com/guide.xml",
				},
			],
			initialized: true,
			autoRefresh: tracker,
		} as never);
		mockLoadProviderSettings.mockReturnValue({
			autoRefresh: false,
			refreshIntervalHours: 24,
			epgAutoRefresh: true,
			epgRefreshIntervalHours: 24,
		});
		mockGetEpgLastRefresh.mockImplementation(() => {
			throw new Error("storage blocked");
		});
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const onComplete = vi.fn();

		const { result } = renderHook(() =>
			useSplashScreen({ updateState: makeUpdateState(), onComplete })
		);
		await waitFor(() => expect(result.current.allDone).toBe(true));

		expect(result.current.steps.map((s) => s.status)).toEqual([
			"done",
			"error",
			"error",
			"error",
		]);
		expect(onComplete).toHaveBeenCalledWith(true);
		consoleError.mockRestore();
	});

	it("does not call refreshEpg when epgAutoRefresh=true but interval not elapsed", async () => {
		mockUseChannels.mockReturnValue({
			providers: [
				{
					id: "p1",
					lastUpdated: new Date().toISOString(),
					epgUrl: "http://epg.example.com/guide.xml",
				},
			],
			initialized: true,
			autoRefresh: tracker,
		} as never);
		mockLoadProviderSettings.mockReturnValue({
			autoRefresh: false,
			refreshIntervalHours: 24,
			epgAutoRefresh: true,
			epgRefreshIntervalHours: 24,
		});
		mockGetEpgLastRefresh.mockReturnValue(Date.now() - 1000); // refreshed 1 second ago

		const updateState = makeUpdateState();
		const { result } = renderHook(() => useSplashScreen({ updateState }));
		await waitFor(() => expect(result.current.allDone).toBe(true));

		expect(mockRefreshEpg).not.toHaveBeenCalled();
	});

	it("shows update step as 'Update available' when update is found", async () => {
		const fakeUpdate = { version: "1.2.3" } as never;
		const updateState = makeUpdateState({
			update: fakeUpdate,
			checkForUpdates: vi.fn().mockResolvedValue(fakeUpdate),
		});

		const { result } = renderHook(() => useSplashScreen({ updateState }));
		await waitFor(() => expect(result.current.allDone).toBe(true));

		expect(result.current.update).toEqual({ version: "1.2.3" });
		const updateStep = result.current.steps.find((s) => s.id === "updates");
		expect(updateStep?.label).toContain("1.2.3");
	});

	it("marks the playlists step as error when a refresh fails but still allows continuing", async () => {
		// The tracker logs each failed refresh.
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		mockUseChannels.mockReturnValue({
			providers: [{ id: "p1", lastUpdated: new Date(0).toISOString(), epgUrl: null }],
			initialized: true,
			autoRefresh: tracker,
		} as never);
		mockLoadProviderSettings.mockReturnValue({
			autoRefresh: true,
			refreshIntervalHours: 24,
			epgAutoRefresh: false,
			epgRefreshIntervalHours: 24,
		});
		mockRefreshProvider.mockRejectedValue(new Error("offline"));

		const updateState = makeUpdateState();
		const { result } = renderHook(() => useSplashScreen({ updateState }));
		await waitFor(() => expect(result.current.allDone).toBe(true));

		const playlists = result.current.steps.find((s) => s.id === "playlists");
		expect(playlists?.status).toBe("error");
		expect(playlists?.label).toMatch(/failed/i);
		// The user must still be able to proceed past the splash.
		expect(result.current.allDone).toBe(true);
		consoleError.mockRestore();
	});

	it("marks the EPG step as error when a refresh fails but still allows continuing", async () => {
		// The tracker logs each failed refresh.
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		mockUseChannels.mockReturnValue({
			providers: [
				{
					id: "p1",
					lastUpdated: new Date().toISOString(),
					epgUrl: "http://epg.example.com/guide.xml",
				},
			],
			initialized: true,
			autoRefresh: tracker,
		} as never);
		mockLoadProviderSettings.mockReturnValue({
			autoRefresh: false,
			refreshIntervalHours: 24,
			epgAutoRefresh: true,
			epgRefreshIntervalHours: 24,
		});
		mockGetEpgLastRefresh.mockReturnValue(0);
		mockRefreshEpg.mockRejectedValue(new Error("offline"));

		const updateState = makeUpdateState();
		const { result } = renderHook(() => useSplashScreen({ updateState }));
		await waitFor(() => expect(result.current.allDone).toBe(true));

		const epg = result.current.steps.find((s) => s.id === "epg");
		expect(epg?.status).toBe("error");
		expect(epg?.label).toMatch(/failed/i);
		expect(result.current.allDone).toBe(true);
		consoleError.mockRestore();
	});

	it("counts the EPG sources that failed when only some do", async () => {
		// The tracker logs each failed refresh.
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const epgUrl = "http://epg.example.com/guide.xml";
		mockUseChannels.mockReturnValue({
			providers: [
				{ id: "p1", lastUpdated: new Date().toISOString(), epgUrl },
				{ id: "p2", lastUpdated: new Date().toISOString(), epgUrl },
			],
			initialized: true,
			autoRefresh: tracker,
		} as never);
		mockLoadProviderSettings.mockReturnValue({
			autoRefresh: false,
			refreshIntervalHours: 24,
			epgAutoRefresh: true,
			epgRefreshIntervalHours: 24,
		});
		mockRefreshEpg.mockImplementation((id: string) =>
			id === "p2" ? Promise.reject(new Error("offline")) : Promise.resolve(120)
		);

		const updateState = makeUpdateState();
		const { result } = renderHook(() => useSplashScreen({ updateState }));
		await waitFor(() => expect(result.current.allDone).toBe(true));

		const epg = result.current.steps.find((s) => s.id === "epg");
		expect(epg?.status).toBe("error");
		expect(epg?.label).toBe("Failed to refresh 1 of 2 EPG sources");
		const playlists = result.current.steps.find((s) => s.id === "playlists");
		expect(playlists?.label).toBe("Playlists up to date");
		consoleError.mockRestore();
	});

	it("leaves its refresh with the poll's tracker so the poll doesn't start it again", async () => {
		mockUseChannels.mockReturnValue({
			providers: [{ id: "p1", lastUpdated: new Date(0).toISOString(), epgUrl: null }],
			initialized: true,
			autoRefresh: tracker,
		} as never);
		mockLoadProviderSettings.mockReturnValue({
			autoRefresh: true,
			refreshIntervalHours: 24,
			epgAutoRefresh: false,
			epgRefreshIntervalHours: 24,
		});
		let finish = () => {};
		mockRefreshProvider.mockImplementation(
			() => new Promise<void>((resolve) => (finish = resolve))
		);

		const { result } = renderHook(() => useSplashScreen({ updateState: makeUpdateState() }));
		await waitFor(() => expect(mockRefreshProvider).toHaveBeenCalledTimes(1));

		// The poll comes round while the slow refresh is still running.
		const pollRefresh = vi.fn(() => Promise.resolve());
		void tracker.run("playlist:p1", pollRefresh);
		expect(pollRefresh).not.toHaveBeenCalled();

		finish();
		await waitFor(() => expect(result.current.allDone).toBe(true));
		const playlists = result.current.steps.find((s) => s.id === "playlists");
		expect(playlists?.label).toBe("Playlists refreshed");
	});

	it("waits for a guide refresh the poll already started", async () => {
		const epgUrl = "http://epg.example.com/guide.xml";
		mockUseChannels.mockReturnValue({
			providers: [{ id: "p1", lastUpdated: new Date().toISOString(), epgUrl }],
			initialized: true,
			autoRefresh: tracker,
		} as never);
		mockLoadProviderSettings.mockReturnValue({
			autoRefresh: false,
			refreshIntervalHours: 24,
			epgAutoRefresh: true,
			epgRefreshIntervalHours: 24,
		});
		let finish = () => {};
		void tracker.run("epg:p1", () => new Promise<void>((resolve) => (finish = resolve)));

		const { result } = renderHook(() => useSplashScreen({ updateState: makeUpdateState() }));
		await waitFor(() =>
			expect(result.current.steps.find((s) => s.id === "epg")?.status).toBe("active")
		);
		expect(result.current.allDone).toBe(false);

		finish();
		await waitFor(() => expect(result.current.allDone).toBe(true));
		expect(mockRefreshEpg).not.toHaveBeenCalled();
		expect(result.current.steps.find((s) => s.id === "epg")?.label).toBe("EPG refreshed");
	});

	it("dismiss() sets dismissed=true and stores session key", async () => {
		const updateState = makeUpdateState();
		const { result } = renderHook(() => useSplashScreen({ updateState }));
		await waitFor(() => expect(result.current.allDone).toBe(true));

		act(() => result.current.dismiss());

		expect(result.current.dismissed).toBe(true);
		expect(sessionStorage.getItem("splash-shown")).toBe("true");
	});

	it("still dismisses when the session flag can't be saved", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new DOMException("full", "QuotaExceededError");
		});
		try {
			const updateState = makeUpdateState();
			const { result } = renderHook(() => useSplashScreen({ updateState }));
			await waitFor(() => expect(result.current.allDone).toBe(true));

			act(() => result.current.dismiss());

			expect(result.current.dismissed).toBe(true);
		} finally {
			setItem.mockRestore();
			warn.mockRestore();
		}
	});

	it("shows the splash when the session flag can't be read", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new DOMException("blocked", "SecurityError");
		});
		try {
			const updateState = makeUpdateState();
			const { result } = renderHook(() => useSplashScreen({ updateState }));
			expect(result.current.dismissed).toBe(false);
		} finally {
			getItem.mockRestore();
			warn.mockRestore();
		}
	});

	it("calls onComplete callback when loading finishes", async () => {
		const onComplete = vi.fn();
		const updateState = makeUpdateState();
		const { result } = renderHook(() => useSplashScreen({ updateState, onComplete }));
		await waitFor(() => expect(result.current.allDone).toBe(true));

		expect(onComplete).toHaveBeenCalledOnce();
	});

	it("leaves out the update step where the app store handles updates", async () => {
		const onComplete = vi.fn();
		const updateState = makeUpdateState({ supported: false });
		const { result } = renderHook(() => useSplashScreen({ updateState, onComplete }));

		expect(result.current.steps.map((s) => s.id)).toEqual(["providers", "playlists", "epg"]);
		await waitFor(() => expect(result.current.allDone).toBe(true));

		expect(result.current.progress).toBe(1);
		expect(updateState.checkForUpdates).not.toHaveBeenCalled();
		expect(onComplete).toHaveBeenCalledExactlyOnceWith(false);
	});

	it("gives up on the update check after seven seconds", async () => {
		vi.useFakeTimers();
		try {
			const onComplete = vi.fn();
			const updateState = makeUpdateState({
				checkForUpdates: vi.fn(() => new Promise<null>(() => {})),
			});
			const { result } = renderHook(() => useSplashScreen({ updateState, onComplete }));
			const updates = () => result.current.steps.find((s) => s.id === "updates");

			await act(() => vi.advanceTimersByTimeAsync(0));
			expect(updates()?.status).toBe("active");

			await act(() => vi.advanceTimersByTimeAsync(6_999));
			expect(result.current.allDone).toBe(false);
			expect(onComplete).not.toHaveBeenCalled();

			await act(() => vi.advanceTimersByTimeAsync(1));
			expect(updates()).toMatchObject({
				status: "error",
				label: "Unable to check for updates",
			});
			expect(result.current.allDone).toBe(true);
			expect(onComplete).toHaveBeenCalledExactlyOnceWith(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("lets the user continue when the update check fails", async () => {
		const updateState = makeUpdateState({
			checkForUpdates: vi.fn().mockRejectedValue(new Error("offline")),
		});
		const { result } = renderHook(() => useSplashScreen({ updateState }));
		await waitFor(() => expect(result.current.allDone).toBe(true));

		expect(result.current.steps.find((s) => s.id === "updates")).toMatchObject({
			status: "error",
			label: "Unable to check for updates",
		});
	});

	it("counts a playlist still waiting to retry as failed without refreshing it again", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await tracker
				.run("playlist:p1", () => Promise.reject(new Error("offline")))
				?.catch(() => {});
			mockUseChannels.mockReturnValue({
				providers: [{ id: "p1", lastUpdated: new Date(0).toISOString(), epgUrl: null }],
				initialized: true,
				autoRefresh: tracker,
			} as never);
			mockLoadProviderSettings.mockReturnValue({
				autoRefresh: true,
				refreshIntervalHours: 24,
				epgAutoRefresh: false,
				epgRefreshIntervalHours: 24,
			});

			const { result } = renderHook(() =>
				useSplashScreen({ updateState: makeUpdateState() })
			);
			await waitFor(() => expect(result.current.allDone).toBe(true));

			expect(mockRefreshProvider).not.toHaveBeenCalled();
			expect(result.current.steps.find((s) => s.id === "playlists")).toMatchObject({
				status: "error",
				label: "Failed to refresh playlists",
			});
		} finally {
			consoleError.mockRestore();
		}
	});

	it("stops without finishing when it closes during a playlist refresh", async () => {
		mockUseChannels.mockReturnValue({
			providers: [{ id: "p1", lastUpdated: new Date(0).toISOString(), epgUrl: null }],
			initialized: true,
			autoRefresh: tracker,
		} as never);
		mockLoadProviderSettings.mockReturnValue({
			autoRefresh: true,
			refreshIntervalHours: 24,
			epgAutoRefresh: false,
			epgRefreshIntervalHours: 24,
		});
		let finish = () => {};
		mockRefreshProvider.mockImplementationOnce(
			() => new Promise<void>((resolve) => (finish = resolve))
		);
		const onComplete = vi.fn();
		const updateState = makeUpdateState();

		const { unmount } = renderHook(() => useSplashScreen({ updateState, onComplete }));
		await waitFor(() => expect(mockRefreshProvider).toHaveBeenCalledTimes(1));
		unmount();
		await act(async () => finish());

		expect(updateState.checkForUpdates).not.toHaveBeenCalled();
		expect(onComplete).not.toHaveBeenCalled();
	});

	type SettleCheck = (finish: (update: null) => void, fail: (e: Error) => void) => void;
	const checkEndings: [string, SettleCheck][] = [
		["finds nothing", (finish) => finish(null)],
		["fails", (_finish, fail) => fail(new Error("offline"))],
	];

	it.each(checkEndings)(
		"stops without finishing when it closes while the update check %s",
		async (_ending, settle) => {
			let finish: (update: null) => void = () => {};
			let fail: (e: Error) => void = () => {};
			const updateState = makeUpdateState({
				checkForUpdates: vi.fn(
					() =>
						new Promise<null>((resolve, reject) => {
							finish = resolve;
							fail = reject;
						})
				),
			});
			const onComplete = vi.fn();

			const { result, unmount } = renderHook(() =>
				useSplashScreen({ updateState, onComplete })
			);
			await waitFor(() =>
				expect(result.current.steps.find((s) => s.id === "updates")?.status).toBe("active")
			);
			unmount();
			await act(async () => settle(finish, fail));

			expect(onComplete).not.toHaveBeenCalled();
		}
	);
});
