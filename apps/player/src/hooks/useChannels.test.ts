// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { createTestQueryClient, wrapperFor } from "@/test/query";
import {
	loadProviderSettings,
	saveProviderSettings,
	getEpgLastRefresh,
	setEpgLastRefresh,
	subscribeToGuide,
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
		// The module keeps refresh times in memory too, and clearing storage
		// doesn't clear them, so use an id no other test refreshes.
		expect(getEpgLastRefresh("never-refreshed")).toBe(0);
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

// Mock all Tauri API calls. Defaults are the mocks' own implementations, so
// `vi.resetAllMocks()` before each test puts them back after a test overrides one.
vi.mock("@/lib/tauri", () => ({
	loadM3uPlaylist: vi.fn(async () => {}),
	loadM3uFile: vi.fn(async () => {}),
	loadXtreamProvider: vi.fn(async () => {}),
	getProviders: vi.fn(async () => []),
	removeProvider: vi.fn(async () => {}),
	getAllChannels: vi.fn(async () => []),
	refreshProvider: vi.fn(async () => {}),
	refreshEpg: vi.fn(async () => 120),
	updateProvider: vi.fn(async () => {}),
	toggleFavorite: vi.fn(async () => true),
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
		vi.resetAllMocks();
		localStorage.clear();
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

		const { result } = renderHook(() => useChannelsProvider(), { wrapper: wrapperFor() });
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

		const { result } = renderHook(() => useChannelsProvider(), { wrapper: wrapperFor() });
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

		const { result } = renderHook(() => useChannelsProvider(), { wrapper: wrapperFor() });
		await waitFor(() => expect(result.current.channels.length).toBe(2));

		await act(async () => {
			await result.current.toggleFavorite("c1");
		});

		expect(result.current.channels[0].isFavorite).toBe(true);
		expect(result.current.channels[1].isFavorite).toBe(false);
	});

	it("sets error when getProviders fails", async () => {
		mockGetProviders.mockRejectedValue(new Error("network"));

		const { result } = renderHook(() => useChannelsProvider(), { wrapper: wrapperFor() });
		await waitFor(() => expect(result.current.initialized).toBe(true));

		expect(result.current.error).toContain("network");
	});

	it("loadM3u sets loading state and refreshes after", async () => {
		const { result } = renderHook(() => useChannelsProvider(), { wrapper: wrapperFor() });
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

		const { result } = renderHook(() => useChannelsProvider(), { wrapper: wrapperFor() });
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

	it("clears the last add's error when the next add starts", async () => {
		mockLoadM3u.mockRejectedValueOnce(new Error("bad playlist"));
		const { result } = renderHook(() => useChannelsProvider(), { wrapper: wrapperFor() });
		await waitFor(() => expect(result.current.initialized).toBe(true));
		await act(() => result.current.loadM3u("test", "http://bad.url").catch(() => {}));
		expect(result.current.error).toContain("bad playlist");

		const next = deferred<void>();
		mockLoadM3u.mockReturnValueOnce(next.promise as never);
		act(() => {
			void result.current.loadM3u("test", "http://good.url");
		});
		expect(result.current.error).toBeNull();
		await act(async () => next.resolve());
	});

	it("refreshProvider calls API then refreshes providers and channels", async () => {
		const { result } = renderHook(() => useChannelsProvider(), { wrapper: wrapperFor() });
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
			renderHook(() => useChannelsProvider(), { wrapper: wrapperFor() });
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

import { createElement, type ReactNode } from "react";
import {
	loadM3uFile as loadM3uFileApi,
	loadXtreamProvider,
	removeProvider as removeProviderApi,
	updateProvider as updateProviderApi,
} from "@/lib/tauri";
import { ChannelsContext, useChannels } from "./useChannels";
import { makeProvider } from "@/test/app-fixtures";
import type { Provider } from "@/lib/types";
import { deferred } from "@/test/deferred";
import { makeHistoryEntry } from "@/test/channel-fixtures";
import { watchHistoryQuery } from "@/lib/queries";
import type { QueryClient } from "@tanstack/react-query";

type Hook = ReturnType<typeof useChannelsProvider>;

const channel = (id: string, isFavorite = false) =>
	({ id, name: id.toUpperCase(), groupTitle: "News", isFavorite }) as never;

/** Mounts the provider and waits for its first load. */
const mountProvider = async (client?: QueryClient) => {
	const hook = renderHook(() => useChannelsProvider(), { wrapper: wrapperFor(client) });
	await waitFor(() => expect(hook.result.current.initialized).toBe(true));
	return hook;
};

/** Runs an action that should fail and returns what it threw. */
const failureOf = async (action: () => Promise<void>) => {
	let caught: unknown = null;
	await act(async () => {
		try {
			await action();
		} catch (e) {
			caught = e;
		}
	});
	return caught;
};

describe("useChannelsProvider provider changes", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		localStorage.clear();
	});

	it("waits for both lists before it counts as loaded, and starts with none", async () => {
		const channels = deferred<never[]>();
		mockGetProviders.mockResolvedValue([makeProvider()]);
		mockGetAllChannels.mockReturnValue(channels.promise);
		const { result } = renderHook(() => useChannelsProvider(), { wrapper: wrapperFor() });
		expect(result.current.providers).toEqual([]);
		await waitFor(() => expect(result.current.providers).toHaveLength(1));

		expect(result.current.initialized).toBe(false);
		expect(result.current.channels).toEqual([]);
		expect(result.current.categories).toEqual([]);
		await act(async () => channels.resolve([channel("c1")]));
		expect(result.current.initialized).toBe(true);
	});

	it("stays loaded while channels that failed their first load load again", async () => {
		mockGetAllChannels.mockRejectedValueOnce(new Error("database locked"));
		const seen: boolean[] = [];
		const { result } = renderHook(
			() => {
				const value = useChannelsProvider();
				seen.push(value.initialized);
				return value;
			},
			{ wrapper: wrapperFor() }
		);
		await waitFor(() => expect(result.current.initialized).toBe(true));
		expect(result.current.error).toBe("Error: database locked");

		const again = deferred<never[]>();
		mockGetAllChannels.mockReturnValueOnce(again.promise);
		let reload!: Promise<void>;
		act(() => {
			reload = result.current.refreshChannels();
		});
		await waitFor(() => expect(mockGetAllChannels).toHaveBeenCalledTimes(2));
		expect(result.current.initialized).toBe(true);
		await act(async () => {
			again.resolve([channel("c1")]);
			await reload;
		});

		expect(result.current.channels).toHaveLength(1);
		expect(seen.slice(seen.indexOf(true))).not.toContain(false);
	});

	it("gives null for a reload when the list has left the cache", async () => {
		const client = createTestQueryClient();
		const { result } = renderHook(() => useChannelsProvider(), { wrapper: wrapperFor(client) });
		await waitFor(() => expect(result.current.initialized).toBe(true));
		client.clear();

		let list: Provider[] | null = [];
		await act(async () => {
			list = await result.current.refreshProviders();
		});
		expect(list).toBeNull();
	});

	it("keeps a favorite picked while the channels still load from failing", async () => {
		mockGetAllChannels.mockReturnValue(new Promise(() => {}));
		mockToggleFavorite.mockResolvedValue(true as never);
		const { result } = renderHook(() => useChannelsProvider(), { wrapper: wrapperFor() });

		await act(() => result.current.toggleFavorite("c1"));

		expect(mockToggleFavorite).toHaveBeenCalledWith("c1");
		expect(result.current.error).toBeNull();
		expect(result.current.channels).toEqual([]);
	});

	it("makes a new call when it reloads during a load, and keeps the newer list", async () => {
		mockGetProviders.mockResolvedValueOnce([makeProvider({ name: "First" })]);
		const { result } = await mountProvider();
		const older = deferred<Provider[]>();
		const newer = makeProvider({ name: "Newer" });
		mockGetProviders.mockReturnValueOnce(older.promise).mockResolvedValueOnce([newer]);

		let first!: Promise<Provider[] | null>;
		let second!: Promise<Provider[] | null>;
		await act(async () => {
			first = result.current.refreshProviders();
			second = result.current.refreshProviders();
			await second;
		});
		await act(async () => {
			older.resolve([makeProvider({ name: "Older" })]);
			await first;
		});

		expect(mockGetProviders).toHaveBeenCalledTimes(3);
		await expect(second).resolves.toEqual([newer]);
		expect(result.current.providers).toEqual([newer]);
	});

	it("reloads the providers and returns them, or null when the call fails", async () => {
		const { result } = await mountProvider();
		const p = makeProvider();
		mockGetProviders.mockResolvedValueOnce([p]);
		let list: Provider[] | null = null;
		await act(async () => {
			list = await result.current.refreshProviders();
		});
		expect(list).toEqual([p]);

		mockGetProviders.mockRejectedValueOnce("store locked");
		await act(async () => {
			list = await result.current.refreshProviders();
		});
		expect(list).toBeNull();
		expect(result.current.providers).toEqual([p]);
		expect(result.current.error).toBe("store locked");
	});

	it("saves an edited provider and reloads the provider list", async () => {
		const { result } = await mountProvider();
		const renamed = makeProvider({ name: "Renamed" });
		mockGetProviders.mockResolvedValueOnce([renamed]);

		await act(() =>
			result.current.updateProvider("p1", "Renamed", "http://new.example", "user", "secret")
		);

		expect(updateProviderApi).toHaveBeenCalledWith(
			"p1",
			"Renamed",
			"http://new.example",
			"user",
			"secret"
		);
		expect(result.current.providers).toEqual([renamed]);
		expect(result.current.error).toBeNull();
	});

	it("reports an edit the backend turns down and passes the error on", async () => {
		const { result } = await mountProvider();
		vi.mocked(updateProviderApi).mockRejectedValueOnce(new Error("bad url"));

		const caught = await failureOf(() => result.current.updateProvider("p1", "Name", "nope"));

		expect((caught as Error).message).toBe("bad url");
		expect(result.current.error).toBe("Error: bad url");
	});

	it("adds a playlist from a file and loads its channels", async () => {
		const { result } = await mountProvider();
		mockGetProviders.mockResolvedValueOnce([makeProvider()]);
		mockGetAllChannels.mockResolvedValueOnce([channel("c1")]);

		await act(() => result.current.loadM3uFile("Local", "/music/list.m3u"));

		expect(loadM3uFileApi).toHaveBeenCalledWith("Local", "/music/list.m3u");
		expect(result.current.providers).toHaveLength(1);
		expect(result.current.channels).toHaveLength(1);
		expect(result.current.loading).toBe(false);
	});

	it("adds an Xtream account with its login", async () => {
		const { result } = await mountProvider();

		await act(() => result.current.loadXtream("Xt", "http://xt.example", "user", "secret"));

		expect(loadXtreamProvider).toHaveBeenCalledWith(
			"Xt",
			"http://xt.example",
			"user",
			"secret"
		);
		expect(result.current.loading).toBe(false);
	});

	it("removes a provider and drops its channels", async () => {
		mockGetProviders.mockResolvedValueOnce([makeProvider()]);
		mockGetAllChannels.mockResolvedValueOnce([channel("c1")]);
		const { result } = await mountProvider();
		expect(result.current.channels).toHaveLength(1);

		await act(() => result.current.removeProvider("p1"));

		expect(removeProviderApi).toHaveBeenCalledWith("p1");
		expect(result.current.providers).toEqual([]);
		expect(result.current.channels).toEqual([]);
	});

	it("reloads the lists after a removal while the computer is offline", async () => {
		mockGetProviders.mockResolvedValueOnce([makeProvider()]);
		mockGetAllChannels.mockResolvedValueOnce([channel("c1")]);
		const { result } = await mountProvider();
		act(() => {
			window.dispatchEvent(new Event("offline"));
		});
		try {
			await act(() => result.current.removeProvider("p1"));

			expect(mockGetProviders).toHaveBeenCalledTimes(2);
			expect(mockGetAllChannels).toHaveBeenCalledTimes(2);
			expect(result.current.providers).toEqual([]);
			expect(result.current.channels).toEqual([]);
		} finally {
			act(() => {
				window.dispatchEvent(new Event("online"));
			});
		}
	});

	it("shows a failed removal without throwing", async () => {
		mockGetProviders.mockResolvedValueOnce([makeProvider()]);
		const { result } = await mountProvider();
		vi.mocked(removeProviderApi).mockRejectedValueOnce(new Error("locked"));

		await act(() => result.current.removeProvider("p1"));

		expect(result.current.error).toBe("Error: locked");
		expect(result.current.providers).toHaveLength(1);
	});

	it.each([
		{ action: "reloading the channels", run: (r: Hook) => r.refreshChannels() },
		{ action: "a playlist refresh", run: (r: Hook) => r.refreshProvider("p1") },
	])(
		"loads the watch history again after $action, which moves it to new ids",
		async ({ run }) => {
			const client = createTestQueryClient();
			const history = watchHistoryQuery(200).queryKey;
			client.setQueryData(history, [makeHistoryEntry()]);
			const { result } = await mountProvider(client);
			expect(client.getQueryState(history)?.isInvalidated).toBe(false);

			await act(() => run(result.current));

			expect(client.getQueryState(history)?.isInvalidated).toBe(true);
		}
	);

	it("keeps the channels it has when reloading them fails", async () => {
		mockGetAllChannels.mockResolvedValueOnce([channel("c1")]);
		const { result } = await mountProvider();
		mockGetAllChannels.mockRejectedValueOnce(new Error("database locked"));

		await act(() => result.current.refreshChannels());

		expect(result.current.channels).toHaveLength(1);
		expect(result.current.error).toBe("Error: database locked");
	});

	it("reports a failed provider refresh and passes the error on", async () => {
		const { result } = await mountProvider();
		mockGetProviders.mockClear();
		mockRefreshProvider.mockRejectedValueOnce(new Error("offline"));

		const caught = await failureOf(() => result.current.refreshProvider("p1"));

		expect((caught as Error).message).toBe("offline");
		expect(result.current.error).toBe("Error: offline");
		expect(mockGetProviders).not.toHaveBeenCalled();
	});

	it("leaves the channel list alone when the favorite isn't in it", async () => {
		mockGetAllChannels.mockResolvedValueOnce([channel("c1")]);
		const { result } = await mountProvider();
		const before = result.current.channels;

		await act(() => result.current.toggleFavorite("gone"));

		expect(mockToggleFavorite).toHaveBeenCalledWith("gone");
		expect(result.current.channels).toBe(before);
	});

	it("shows a failed favorite change and keeps the star as it was", async () => {
		mockGetAllChannels.mockResolvedValueOnce([channel("c1")]);
		const { result } = await mountProvider();
		mockToggleFavorite.mockRejectedValueOnce(new Error("locked"));

		await act(() => result.current.toggleFavorite("c1"));

		expect(result.current.error).toBe("Error: locked");
		expect(result.current.channels[0]).toMatchObject({ id: "c1", isFavorite: false });
	});

	it("refreshes a playlist that comes due on the minute poll", async () => {
		vi.useFakeTimers();
		try {
			localStorage.setItem(
				"provider-settings-p1",
				JSON.stringify({
					autoRefresh: true,
					refreshIntervalHours: 24,
					epgAutoRefresh: false,
					epgRefreshIntervalHours: 24,
				})
			);
			mockGetProviders.mockResolvedValue([
				makeProvider({ lastUpdated: new Date(0).toISOString() }),
			]);
			renderHook(() => useChannelsProvider(), { wrapper: wrapperFor() });

			// The poll on mount runs before the providers load.
			await act(() => vi.advanceTimersByTimeAsync(0));
			expect(mockRefreshProvider).not.toHaveBeenCalled();
			expect(mockGetProviders).toHaveBeenCalledTimes(1);

			await act(() => vi.advanceTimersByTimeAsync(60_000));
			expect(mockRefreshProvider).toHaveBeenCalledExactlyOnceWith("p1");
			// The refreshed playlist is read back so the next poll sees its new time.
			expect(mockGetProviders).toHaveBeenCalledTimes(2);
			expect(mockGetAllChannels).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("useChannelsProvider guide refreshes", () => {
	// The module keeps refresh times in memory, which clearing storage doesn't
	// clear, so each test uses ids no other test refreshes.
	const withGuide = (id: string) => makeProvider({ id, epgUrl: `http://example.test/${id}.xml` });

	/** Mounts the provider with fake timers and lets its first load finish. */
	const mountWithFakeTimers = async () => {
		vi.useFakeTimers();
		const hook = renderHook(() => useChannelsProvider(), { wrapper: wrapperFor() });
		await act(() => vi.advanceTimersByTimeAsync(0));
		return hook;
	};

	beforeEach(() => {
		vi.resetAllMocks();
		localStorage.clear();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("fetches a new playlist's guide as soon as it's added, and only once", async () => {
		const guide = deferred<number>();
		mockRefreshEpg.mockReturnValue(guide.promise);
		const { result } = await mountWithFakeTimers();
		mockGetProviders.mockResolvedValue([withGuide("added-guide")]);

		await act(() => result.current.loadM3u("Home", "http://example.test/list.m3u"));
		expect(mockRefreshEpg).toHaveBeenCalledExactlyOnceWith("added-guide");

		// The poll finds the guide due, but the fetch is still running.
		await act(() => vi.advanceTimersByTimeAsync(60_000));
		expect(mockRefreshEpg).toHaveBeenCalledOnce();

		const version = result.current.guideVersion;
		await act(() => {
			guide.resolve(120);
			return vi.advanceTimersByTimeAsync(0);
		});
		expect(result.current.guideVersion).toBe(version + 1);

		// Once it's in, the guide isn't due again for a day.
		await act(() => vi.advanceTimersByTimeAsync(60_000));
		expect(mockRefreshEpg).toHaveBeenCalledOnce();
	});

	it("leaves the guides of the providers it already had to the poll", async () => {
		mockRefreshEpg.mockResolvedValue(120);
		mockGetProviders.mockResolvedValue([withGuide("had-guide")]);
		const { result } = await mountWithFakeTimers();
		mockGetProviders.mockResolvedValue([withGuide("had-guide"), withGuide("xtream-guide")]);

		await act(() => result.current.loadXtream("Xt", "http://xt.example", "user", "secret"));
		expect(mockRefreshEpg).toHaveBeenCalledExactlyOnceWith("xtream-guide");

		await act(() => vi.advanceTimersByTimeAsync(60_000));
		expect(mockRefreshEpg).toHaveBeenCalledTimes(2);
		expect(mockRefreshEpg).toHaveBeenLastCalledWith("had-guide");
	});

	it("doesn't fetch a guide for a new playlist that has none", async () => {
		const { result } = await mountWithFakeTimers();
		mockGetProviders.mockResolvedValue([makeProvider({ id: "no-guide" })]);

		await act(() => result.current.loadM3u("Home", "http://example.test/list.m3u"));
		await act(() => vi.advanceTimersByTimeAsync(60_000));

		expect(mockRefreshEpg).not.toHaveBeenCalled();
	});

	it("adds the playlist when its guide fails, and waits before trying the guide again", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		mockRefreshEpg.mockRejectedValue(new Error("offline"));
		const { result } = await mountWithFakeTimers();
		mockGetProviders.mockResolvedValue([withGuide("failing-guide")]);
		const version = result.current.guideVersion;

		await act(() => result.current.loadM3u("Home", "http://example.test/list.m3u"));
		expect(result.current.providers).toHaveLength(1);
		expect(result.current.error).toBeNull();

		await act(() => vi.advanceTimersByTimeAsync(4 * 60_000));
		expect(mockRefreshEpg).toHaveBeenCalledOnce();
		expect(result.current.guideVersion).toBe(version);
	});

	it("adds the playlist when the provider list then fails to load, and fetches no guide", async () => {
		const { result } = await mountWithFakeTimers();
		mockGetProviders.mockRejectedValue(new Error("providers unavailable"));

		await act(() => result.current.loadM3u("Home", "http://example.test/list.m3u"));

		expect(result.current.error).toBe("Error: providers unavailable");
		expect(mockRefreshEpg).not.toHaveBeenCalled();
	});

	it("stops telling a listener about guide refreshes once it unsubscribes", () => {
		const listener = vi.fn();
		const unsubscribe = subscribeToGuide(listener);

		setEpgLastRefresh("listened-guide");
		unsubscribe();
		setEpgLastRefresh("listened-guide");

		expect(listener).toHaveBeenCalledOnce();
	});

	it("goes up a version for a guide refresh that finished anywhere", async () => {
		const { result } = await mountProvider();
		const version = result.current.guideVersion;

		// The splash screen and the settings dialog record their refreshes this way.
		act(() => setEpgLastRefresh("splash-guide"));

		expect(result.current.guideVersion).toBe(version + 1);
	});
});

describe("useChannels", () => {
	it("refuses to run outside the channels provider", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(() => renderHook(() => useChannels())).toThrow(
				"useChannels must be used within a ChannelsProvider"
			);
		} finally {
			consoleError.mockRestore();
		}
	});

	it("reads the value the provider shares", () => {
		const value = { providers: [makeProvider()] } as never;
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(ChannelsContext.Provider, { value }, children);

		const { result } = renderHook(() => useChannels(), { wrapper });

		expect(result.current).toBe(value);
	});
});
