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
	useSyncExternalStore,
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
import { useLatestRef } from "@/hooks/useLatestRef";
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

// Counts the guide refreshes that have finished, so the channel list knows to
// load the guide again. Every refresh, from the splash screen, the poll, an add
// or the settings dialog, records itself through setEpgLastRefresh.
let guideVersion = 0;
const guideListeners = new Set<() => void>();
/** Calls the listener after each guide refresh finishes, and returns a function that stops it. */
export const subscribeToGuide = (listener: () => void) => {
	guideListeners.add(listener);
	return () => {
		guideListeners.delete(listener);
	};
};
const getGuideVersion = () => guideVersion;

/** Records that this provider's guide just refreshed, and tells the channel list it changed. */
export const setEpgLastRefresh = (id: string) => {
	const now = Date.now();
	epgLastRefreshThisSession.set(id, now);
	writeStorage(epgLastRefreshKey(id), String(now));
	guideVersion += 1;
	for (const listener of guideListeners) listener();
};

// Where the poll reads each provider's settings and last guide refresh.
const refreshLookups = {
	settingsFor: loadProviderSettings,
	epgLastRefreshFor: getEpgLastRefresh,
};

// Refreshes a provider's guide through the tracker, so the poll and an add
// never fetch the same guide at once.
const refreshGuide = (tracker: RefreshTracker, id: string) =>
	tracker.run(refreshKeys.epg(id), () => refreshEpgApi(id).then(() => setEpgLastRefresh(id)));

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
	/** Loads the provider list again, and returns it, or null when it fails. */
	refreshProviders: () => Promise<Provider[] | null>;
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
	/**
	 * Goes up each time a provider's guide finishes refreshing, so the guide on
	 * screen can load again.
	 */
	guideVersion: number;
}

export const ChannelsContext = createContext<ChannelsContextValue | null>(null);

export const useChannelsProvider = (): ChannelsContextValue => {
	const [channels, setChannels] = useState<Channel[]>([]);
	const [categories, setCategories] = useState<Category[]>([]);
	const [providers, setProviders] = useState<Provider[]>([]);
	const [initialized, setInitialized] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const guideVersion = useSyncExternalStore(subscribeToGuide, getGuideVersion);
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
			const list = await getProviders();
			setProviders(list);
			return list;
		} catch (e) {
			setError(String(e));
			return null;
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

	// Keep providers ref current so the poll and an add can read it without re-registering
	const providersRef = useLatestRef(providers);
	const refreshProviderRef = useLatestRef(refreshProvider);

	// The splash screen runs its startup refreshes through this tracker too, so
	// the poll skips one the splash started that is still running.
	const [autoRefresh] = useState(() => createRefreshTracker());

	// Adding a provider of any kind runs the same steps around a different backend call.
	const addProvider = useCallback(
		(add: () => Promise<unknown>): Promise<void> => {
			setLoading(true);
			setError(null);
			const known = new Set(providersRef.current.map((p) => p.id));
			const steps = async () => {
				await add();
				const list = await refreshProviders();
				await refreshChannels();
				// Fetch the new provider's guide now rather than at the next poll.
				// Adding doesn't wait for it, since a guide can take a while.
				if (list) {
					const added = list.filter((p) => !known.has(p.id));
					for (const id of findDueRefreshes(added, refreshLookups).epgIds) {
						refreshGuide(autoRefresh, id);
					}
				}
			};
			// Promise callbacks in place of try and finally, which the React
			// Compiler can't compile yet.
			return steps()
				.catch((e) => {
					setError(String(e));
					throw e;
				})
				.finally(() => setLoading(false));
		},
		// Stryker disable next-line ArrayDeclaration: every one of these stays the same object while the context provider is mounted, so an empty list gives the same callback.
		[providersRef, refreshProviders, refreshChannels, autoRefresh]
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

	// Poll every 60s to check if any provider/EPG is due for refresh.
	// Using a ref-based approach avoids resetting timers on every providers update.
	// The tracker skips refreshes still running and backs off after failures.
	useEffect(() => {
		const tick = () => {
			const { playlistIds, epgIds } = findDueRefreshes(providersRef.current, refreshLookups);
			for (const id of playlistIds) {
				autoRefresh.run(refreshKeys.playlist(id), () => refreshProviderRef.current(id));
			}
			for (const id of epgIds) refreshGuide(autoRefresh, id);
		};

		tick(); // fire immediately on mount
		const id = setInterval(tick, 60_000);
		return () => clearInterval(id);
	}, [autoRefresh, providersRef, refreshProviderRef]);

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
		guideVersion,
	};
};

export const useChannels = (): ChannelsContextValue => {
	const ctx = useContext(ChannelsContext);
	if (!ctx) throw new Error("useChannels must be used within a ChannelsProvider");
	return ctx;
};

/** The ids of the user's providers, which tell which provider a channel is from. */
export const useProviderIds = (): string[] => {
	const { providers } = useChannels();
	return useMemo(() => providers.map((p) => p.id), [providers]);
};
