// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import {
	createContext,
	useContext,
	useState,
	useCallback,
	useEffect,
	useMemo,
	useRef,
} from "react";
import type { Channel, Category, Provider } from "@/lib/types";
import {
	createRefreshTracker,
	findDueRefreshes,
	refreshKeys,
	type RefreshTracker,
} from "@/lib/refresh-schedule";
import { deriveCategories } from "@/lib/channels";
import { readStorage, writeStorage } from "@/lib/storage";
import {
	loadM3uPlaylist,
	loadM3uFile as loadM3uFileApi,
	loadXtreamProvider,
	getProviders,
	removeProvider as removeProviderApi,
	getAllChannels,
	refreshProvider as refreshProviderApi,
	refreshEpg as refreshEpgApi,
	updateProvider as updateProviderApi,
	toggleFavorite as toggleFavoriteApi,
} from "@/lib/tauri";

// --- Provider settings (stored in localStorage) ---

export interface ProviderSettings {
	autoRefresh: boolean;
	refreshIntervalHours: number;
	epgAutoRefresh: boolean;
	epgRefreshIntervalHours: number;
}

export const loadProviderSettings = (id: string): ProviderSettings => {
	try {
		const raw = localStorage.getItem(`provider-settings-${id}`);
		if (raw) {
			const parsed = JSON.parse(raw);
			// Migrate from old 3-way string format ("disabled"|"startup"|"interval")
			if (typeof parsed.autoRefresh === "string") {
				return {
					autoRefresh: parsed.autoRefresh !== "disabled",
					refreshIntervalHours: parsed.refreshIntervalHours ?? 24,
					epgAutoRefresh: parsed.epgAutoRefresh ?? true,
					epgRefreshIntervalHours: parsed.epgRefreshIntervalHours ?? 24,
				};
			}
			return {
				epgAutoRefresh: true,
				epgRefreshIntervalHours: 24,
				...parsed,
			} as ProviderSettings;
		}
	} catch {}
	return {
		autoRefresh: false,
		refreshIntervalHours: 24,
		epgAutoRefresh: true,
		epgRefreshIntervalHours: 24,
	};
};

export const saveProviderSettings = (id: string, settings: ProviderSettings) => {
	localStorage.setItem(`provider-settings-${id}`, JSON.stringify(settings));
};

// EPG last-refresh timestamp stored separately (providers have no epg_last_updated field)
const epgLastRefreshKey = (id: string) => `epg-last-refresh-${id}`;
// A copy in memory keeps blocked storage from making every poll refresh the guide again.
const epgLastRefreshThisSession = new Map<string, number>();
export const getEpgLastRefresh = (id: string): number => {
	const stored = parseInt(readStorage(epgLastRefreshKey(id)) ?? "0", 10) || 0;
	return Math.max(stored, epgLastRefreshThisSession.get(id) ?? 0);
};
export const setEpgLastRefresh = (id: string) => {
	const now = Date.now();
	epgLastRefreshThisSession.set(id, now);
	writeStorage(epgLastRefreshKey(id), String(now));
};

// --- Context ---

interface ChannelsContextValue {
	channels: Channel[];
	categories: Category[];
	providers: Provider[];
	initialized: boolean;
	loading: boolean;
	error: string | null;
	loadM3u: (name: string, url: string) => Promise<void>;
	loadM3uFile: (name: string, path: string) => Promise<void>;
	loadXtream: (name: string, url: string, username: string, password: string) => Promise<void>;
	refreshProviders: () => Promise<void>;
	refreshChannels: () => Promise<void>;
	refreshProvider: (id: string) => Promise<void>;
	updateProvider: (
		id: string,
		name: string,
		url: string,
		username?: string,
		password?: string
	) => Promise<void>;
	removeProvider: (id: string) => Promise<void>;
	toggleFavorite: (channelId: string) => Promise<void>;
	/** Runs the automatic refreshes, shared by the splash screen and the poll. */
	autoRefresh: RefreshTracker;
}

export const ChannelsContext = createContext<ChannelsContextValue | null>(null);

export const useChannelsProvider = (): ChannelsContextValue => {
	const [channels, setChannels] = useState<Channel[]>([]);
	const [categories, setCategories] = useState<Category[]>([]);
	const [providers, setProviders] = useState<Provider[]>([]);
	const [initialized, setInitialized] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const channelIndex = useMemo(() => {
		const m = new Map<string, number>();
		channels.forEach((ch, i) => m.set(ch.id, i));
		return m;
	}, [channels]);

	const refreshChannels = useCallback(async () => {
		try {
			const chs = await getAllChannels();
			setChannels(chs);
			setCategories(deriveCategories(chs));
		} catch (e) {
			setError(String(e));
		}
	}, []);

	const refreshProviders = useCallback(async () => {
		try {
			setProviders(await getProviders());
		} catch (e) {
			setError(String(e));
		}
	}, []);

	const refreshProvider = useCallback(
		async (id: string) => {
			try {
				await refreshProviderApi(id);
				await refreshProviders();
				await refreshChannels();
			} catch (e) {
				setError(String(e));
				throw e;
			}
		},
		[refreshProviders, refreshChannels]
	);

	const updateProvider = useCallback(
		async (id: string, name: string, url: string, username?: string, password?: string) => {
			try {
				await updateProviderApi(id, name, url, username, password);
				await refreshProviders();
			} catch (e) {
				setError(String(e));
				throw e;
			}
		},
		[refreshProviders]
	);

	// Adding a provider of any kind runs the same steps around a different backend call.
	const addProvider = useCallback(
		async (add: () => Promise<unknown>) => {
			setLoading(true);
			setError(null);
			try {
				await add();
				await refreshProviders();
				await refreshChannels();
			} catch (e) {
				setError(String(e));
				throw e;
			} finally {
				setLoading(false);
			}
		},
		[refreshProviders, refreshChannels]
	);

	const loadM3u = useCallback(
		(name: string, url: string) => addProvider(() => loadM3uPlaylist(name, url)),
		[addProvider]
	);

	const loadM3uFile = useCallback(
		(name: string, path: string) => addProvider(() => loadM3uFileApi(name, path)),
		[addProvider]
	);

	const loadXtream = useCallback(
		(name: string, url: string, username: string, password: string) =>
			addProvider(() => loadXtreamProvider(name, url, username, password)),
		[addProvider]
	);

	const removeProvider = useCallback(
		async (id: string) => {
			try {
				await removeProviderApi(id);
				await refreshProviders();
				await refreshChannels();
			} catch (e) {
				setError(String(e));
			}
		},
		[refreshProviders, refreshChannels]
	);

	const toggleFavorite = useCallback(
		async (channelId: string) => {
			try {
				const newFavorite = await toggleFavoriteApi(channelId);
				setChannels((prev) => {
					const idx = channelIndex.get(channelId);
					if (idx === undefined) return prev;
					const next = [...prev];
					next[idx] = { ...next[idx], isFavorite: newFavorite };
					return next;
				});
			} catch (e) {
				setError(String(e));
			}
		},
		[channelIndex]
	);

	// Initial load — ref guard prevents StrictMode double-mount from firing twice.
	// Both providers and channels must load before `initialized` is set so the
	// splash screen does not dismiss before the UI has data to display.
	const didInit = useRef(false);
	useEffect(() => {
		if (didInit.current) return;
		didInit.current = true;
		Promise.all([refreshProviders(), refreshChannels()]).finally(() => {
			setInitialized(true);
		});
	}, [refreshProviders, refreshChannels]);

	// Keep providers ref current so interval can read it without re-registering
	const providersRef = useRef<Provider[]>([]);
	useEffect(() => {
		providersRef.current = providers;
	}, [providers]);

	const refreshProviderRef = useRef(refreshProvider);
	useEffect(() => {
		refreshProviderRef.current = refreshProvider;
	}, [refreshProvider]);

	// The splash screen runs its startup refreshes through this tracker too, so
	// the poll skips one the splash started that is still running.
	const [autoRefresh] = useState(() => createRefreshTracker());

	// Poll every 60s to check if any provider/EPG is due for refresh.
	// Using a ref-based approach avoids resetting timers on every providers update.
	// The tracker skips refreshes still running and backs off after failures.
	useEffect(() => {
		const tick = () => {
			const { playlistIds, epgIds } = findDueRefreshes(providersRef.current, {
				settingsFor: loadProviderSettings,
				epgLastRefreshFor: getEpgLastRefresh,
			});
			for (const id of playlistIds) {
				autoRefresh.run(refreshKeys.playlist(id), () => refreshProviderRef.current(id));
			}
			for (const id of epgIds) {
				autoRefresh.run(refreshKeys.epg(id), () =>
					refreshEpgApi(id).then(() => setEpgLastRefresh(id))
				);
			}
		};

		tick(); // fire immediately on mount
		const id = setInterval(tick, 60_000);
		return () => clearInterval(id);
	}, [autoRefresh]);

	return {
		channels,
		categories,
		providers,
		initialized,
		loading,
		error,
		loadM3u,
		loadM3uFile,
		loadXtream,
		refreshProviders,
		refreshChannels,
		refreshProvider,
		updateProvider,
		removeProvider,
		toggleFavorite,
		autoRefresh,
	};
};

export const useChannels = (): ChannelsContextValue => {
	const ctx = useContext(ChannelsContext);
	if (!ctx) throw new Error("useChannels must be used within a ChannelsProvider");
	return ctx;
};
