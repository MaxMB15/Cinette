// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
	loadProviderSettings,
	saveProviderSettings,
	getEpgLastRefresh,
	setEpgLastRefresh,
} from "./useChannels";

// ── Pure helper tests (no mocks needed) ──────────────────────────────

describe("loadProviderSettings", () => {
	beforeEach(() => localStorage.clear());

	it("returns defaults when nothing is stored", () => {
		const s = loadProviderSettings("p1");
		expect(s).toEqual({
			autoRefresh: false,
			refreshIntervalHours: 24,
			epgAutoRefresh: true,
			epgRefreshIntervalHours: 24,
		});
	});

	it("returns stored boolean-format settings", () => {
		localStorage.setItem(
			"provider-settings-p1",
			JSON.stringify({
				autoRefresh: true,
				refreshIntervalHours: 12,
				epgAutoRefresh: false,
				epgRefreshIntervalHours: 6,
			})
		);
		const s = loadProviderSettings("p1");
		expect(s).toEqual({
			autoRefresh: true,
			refreshIntervalHours: 12,
			epgAutoRefresh: false,
			epgRefreshIntervalHours: 6,
		});
	});

	it("migrates old string 'disabled' autoRefresh to boolean false", () => {
		localStorage.setItem(
			"provider-settings-p1",
			JSON.stringify({ autoRefresh: "disabled", refreshIntervalHours: 48 })
		);
		const s = loadProviderSettings("p1");
		expect(s.autoRefresh).toBe(false);
		expect(s.refreshIntervalHours).toBe(48);
	});

	it("migrates old string 'startup' autoRefresh to boolean true", () => {
		localStorage.setItem("provider-settings-p1", JSON.stringify({ autoRefresh: "startup" }));
		const s = loadProviderSettings("p1");
		expect(s.autoRefresh).toBe(true);
	});

	it("migrates old string 'interval' autoRefresh to boolean true", () => {
		localStorage.setItem(
			"provider-settings-p1",
			JSON.stringify({ autoRefresh: "interval", refreshIntervalHours: 6 })
		);
		const s = loadProviderSettings("p1");
		expect(s.autoRefresh).toBe(true);
		expect(s.refreshIntervalHours).toBe(6);
	});

	it("fills in missing epg fields with defaults during migration", () => {
		localStorage.setItem("provider-settings-p1", JSON.stringify({ autoRefresh: "startup" }));
		const s = loadProviderSettings("p1");
		expect(s.epgAutoRefresh).toBe(true);
		expect(s.epgRefreshIntervalHours).toBe(24);
	});

	it("fills in missing epg fields for boolean-format settings", () => {
		localStorage.setItem(
			"provider-settings-p1",
			JSON.stringify({ autoRefresh: true, refreshIntervalHours: 12 })
		);
		const s = loadProviderSettings("p1");
		expect(s.epgAutoRefresh).toBe(true);
		expect(s.epgRefreshIntervalHours).toBe(24);
	});

	it("returns defaults on malformed JSON", () => {
		localStorage.setItem("provider-settings-p1", "not-json{{{");
		const s = loadProviderSettings("p1");
		expect(s).toEqual({
			autoRefresh: false,
			refreshIntervalHours: 24,
			epgAutoRefresh: true,
			epgRefreshIntervalHours: 24,
		});
	});

	it("uses different keys for different provider IDs", () => {
		saveProviderSettings("a", {
			autoRefresh: true,
			refreshIntervalHours: 1,
			epgAutoRefresh: false,
			epgRefreshIntervalHours: 2,
		});
		const a = loadProviderSettings("a");
		const b = loadProviderSettings("b");
		expect(a.autoRefresh).toBe(true);
		expect(b.autoRefresh).toBe(false); // defaults
	});
});

describe("saveProviderSettings", () => {
	beforeEach(() => localStorage.clear());

	it("persists and round-trips settings", () => {
		const settings = {
			autoRefresh: true,
			refreshIntervalHours: 8,
			epgAutoRefresh: false,
			epgRefreshIntervalHours: 48,
		};
		saveProviderSettings("p1", settings);
		expect(loadProviderSettings("p1")).toEqual(settings);
	});
});

describe("getEpgLastRefresh / setEpgLastRefresh", () => {
	beforeEach(() => localStorage.clear());

	it("returns 0 when no timestamp is stored", () => {
		expect(getEpgLastRefresh("p1")).toBe(0);
	});

	it("stores and retrieves a timestamp", () => {
		const before = Date.now();
		setEpgLastRefresh("p1");
		const after = Date.now();
		const stored = getEpgLastRefresh("p1");
		expect(stored).toBeGreaterThanOrEqual(before);
		expect(stored).toBeLessThanOrEqual(after);
	});

	it("uses separate keys per provider", () => {
		setEpgLastRefresh("a");
		expect(getEpgLastRefresh("a")).toBeGreaterThan(0);
		expect(getEpgLastRefresh("b")).toBe(0);
	});

	it("keeps the time for the session when storage is blocked", () => {
		const blocked = () => {
			throw new DOMException("blocked", "SecurityError");
		};
		const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
		const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(getEpgLastRefresh("blocked")).toBe(0);
			const before = Date.now();
			setEpgLastRefresh("blocked");
			expect(getEpgLastRefresh("blocked")).toBeGreaterThanOrEqual(before);
		} finally {
			getItem.mockRestore();
			setItem.mockRestore();
			vi.mocked(console.warn).mockRestore();
		}
	});
});

// ── useChannelsProvider hook tests ────────────────────────────────────

// Mock all Tauri API calls
vi.mock("@/lib/tauri", () => ({
	loadM3uPlaylist: vi.fn().mockResolvedValue(undefined),
	loadM3uFile: vi.fn().mockResolvedValue(undefined),
	loadXtreamProvider: vi.fn().mockResolvedValue(undefined),
	getProviders: vi.fn().mockResolvedValue([]),
	removeProvider: vi.fn().mockResolvedValue(undefined),
	getAllChannels: vi.fn().mockResolvedValue([]),
	refreshProvider: vi.fn().mockResolvedValue(undefined),
	refreshEpg: vi.fn().mockResolvedValue(120),
	updateProvider: vi.fn().mockResolvedValue(undefined),
	toggleFavorite: vi.fn().mockResolvedValue(true),
}));

import {
	getProviders,
	getAllChannels,
	toggleFavorite as toggleFavoriteApi,
	loadM3uPlaylist,
	refreshProvider as refreshProviderApi,
	refreshEpg as refreshEpgApi,
} from "@/lib/tauri";
import { useChannelsProvider } from "./useChannels";

const mockGetProviders = vi.mocked(getProviders);
const mockGetAllChannels = vi.mocked(getAllChannels);
const mockToggleFavorite = vi.mocked(toggleFavoriteApi);
const mockLoadM3u = vi.mocked(loadM3uPlaylist);
const mockRefreshProvider = vi.mocked(refreshProviderApi);
const mockRefreshEpg = vi.mocked(refreshEpgApi);

describe("useChannelsProvider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		mockGetProviders.mockResolvedValue([]);
		mockGetAllChannels.mockResolvedValue([]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("loads providers and channels on mount", async () => {
		const providers = [{ id: "p1", name: "Test", type: "m3u" }] as never[];
		const channels = [
			{ id: "c1", name: "Ch1", groupTitle: "News", isFavorite: false },
		] as never[];
		mockGetProviders.mockResolvedValue(providers);
		mockGetAllChannels.mockResolvedValue(channels);

		const { result } = renderHook(() => useChannelsProvider());
		await waitFor(() => expect(result.current.initialized).toBe(true));

		expect(result.current.providers).toEqual(providers);
		expect(result.current.channels).toEqual(channels);
	});

	it("derives categories from channels", async () => {
		mockGetAllChannels.mockResolvedValue([
			{ id: "c1", name: "CNN", groupTitle: "News", isFavorite: false },
			{ id: "c2", name: "BBC", groupTitle: "News", isFavorite: false },
			{ id: "c3", name: "ESPN", groupTitle: "Sports", isFavorite: false },
		] as never[]);

		const { result } = renderHook(() => useChannelsProvider());
		await waitFor(() => expect(result.current.initialized).toBe(true));

		expect(result.current.categories).toHaveLength(2);
		const news = result.current.categories.find((c) => c.name === "News");
		const sports = result.current.categories.find((c) => c.name === "Sports");
		expect(news?.channelCount).toBe(2);
		expect(sports?.channelCount).toBe(1);
	});

	it("toggleFavorite updates the channel in place", async () => {
		mockGetAllChannels.mockResolvedValue([
			{ id: "c1", name: "CNN", groupTitle: "News", isFavorite: false },
			{ id: "c2", name: "BBC", groupTitle: "News", isFavorite: false },
		] as never[]);
		mockToggleFavorite.mockResolvedValue(true as never);

		const { result } = renderHook(() => useChannelsProvider());
		await waitFor(() => expect(result.current.channels.length).toBe(2));

		await act(async () => {
			await result.current.toggleFavorite("c1");
		});

		expect(result.current.channels[0].isFavorite).toBe(true);
		expect(result.current.channels[1].isFavorite).toBe(false);
	});

	it("sets error when getProviders fails", async () => {
		mockGetProviders.mockRejectedValue(new Error("network"));

		const { result } = renderHook(() => useChannelsProvider());
		await waitFor(() => expect(result.current.initialized).toBe(true));

		expect(result.current.error).toContain("network");
	});

	it("loadM3u sets loading state and refreshes after", async () => {
		const { result } = renderHook(() => useChannelsProvider());
		await waitFor(() => expect(result.current.initialized).toBe(true));

		mockGetProviders.mockClear();
		mockGetAllChannels.mockClear();

		await act(async () => {
			await result.current.loadM3u("test", "http://example.com/playlist.m3u");
		});

		expect(mockLoadM3u).toHaveBeenCalledWith("test", "http://example.com/playlist.m3u");
		expect(mockGetProviders).toHaveBeenCalled();
		expect(mockGetAllChannels).toHaveBeenCalled();
		expect(result.current.loading).toBe(false);
	});

	it("loadM3u sets error and rethrows on failure", async () => {
		mockLoadM3u.mockRejectedValue(new Error("bad playlist"));

		const { result } = renderHook(() => useChannelsProvider());
		await waitFor(() => expect(result.current.initialized).toBe(true));

		let caught: Error | null = null;
		await act(async () => {
			try {
				await result.current.loadM3u("test", "http://bad.url");
			} catch (e) {
				caught = e as Error;
			}
		});

		expect((caught as Error | null)?.message).toBe("bad playlist");
		expect(result.current.error).toContain("bad playlist");
		expect(result.current.loading).toBe(false);
	});

	it("refreshProvider calls API then refreshes providers and channels", async () => {
		const { result } = renderHook(() => useChannelsProvider());
		await waitFor(() => expect(result.current.initialized).toBe(true));

		mockRefreshProvider.mockClear();
		mockGetProviders.mockClear();
		mockGetAllChannels.mockClear();

		await act(async () => {
			await result.current.refreshProvider("p1");
		});

		expect(mockRefreshProvider).toHaveBeenCalledWith("p1");
		expect(mockGetProviders).toHaveBeenCalled();
		expect(mockGetAllChannels).toHaveBeenCalled();
	});

	it("waits before retrying a guide refresh that failed instead of trying every poll", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
		mockGetProviders.mockResolvedValue([
			{
				id: "guide-down",
				name: "Down",
				type: "xtream",
				url: "http://example.test",
				channelCount: 0,
				epgUrl: "http://example.test/xmltv.php",
			},
		]);
		mockRefreshEpg.mockRejectedValue(new Error("login failed"));
		try {
			renderHook(() => useChannelsProvider());
			// The poll on mount runs before the providers load, so the first try is a minute in.
			await act(() => vi.advanceTimersByTimeAsync(0));
			expect(mockRefreshEpg).not.toHaveBeenCalled();
			await act(() => vi.advanceTimersByTimeAsync(60_000));
			expect(mockRefreshEpg).toHaveBeenCalledTimes(1);

			await act(() => vi.advanceTimersByTimeAsync(4 * 60_000));
			expect(mockRefreshEpg).toHaveBeenCalledTimes(1);

			await act(() => vi.advanceTimersByTimeAsync(60_000));
			expect(mockRefreshEpg).toHaveBeenCalledTimes(2);
		} finally {
			mockRefreshEpg.mockResolvedValue(120);
			vi.useRealTimers();
		}
	});
});
