// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, useMemo, useCallback, useEffect } from "react";
import { useNavigate } from "react-router";
import {
	LoaderCircle,
	TvMinimal,
	MonitorPlay,
	Heart,
	Clapperboard,
	RotateCcwClock,
	Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SearchBar } from "./SearchBar";
import { CategoryFilter } from "./CategoryFilter";
import { ChannelCard, COMPACT_ROW_HEIGHT, ROW_CARD_LEFT_WIDTH } from "./ChannelCard";
import { ChannelLogo } from "./ChannelLogo";
import { useGroupHierarchy } from "@/hooks/useGroupHierarchy";
import { RecentlyPlayedRow } from "./RecentlyPlayedRow";
import { PinnedGroupsRow } from "./PinnedGroupsRow";
import { CategoryBrowser } from "./CategoryBrowser";
import { GroupList } from "./GroupList";
import { Breadcrumb } from "./Breadcrumb";
import { CategoryManager } from "./CategoryManager";
import { VirtualList } from "./VirtualList";
import { SeriesDetailModal } from "./SeriesDetailModal";
import { MovieInfoDrawer } from "./MovieInfoDrawer";
import { HistoryTab } from "./HistoryTab";
import { NoSearchResults } from "./NoSearchResults";
import { DownloadsTab } from "./DownloadsTab";
import { isMobilePlatform } from "@/lib/platform";
import { usePlatform } from "@/hooks/usePlatform";
import {
	coversWindow,
	formatHHMM,
	getGridMarks,
	guideRangeFor,
	toPct,
	type TimeRange,
} from "@/lib/epg-window";
import { useChannels } from "@/hooks/useChannels";
import { useDownloads } from "@/hooks/useDownloads";
import { useDelayedFlag } from "@/hooks/useDelayedFlag";
import { useNow } from "@/hooks/useNow";
import { useGuidePrograms, type GuideChannels } from "@/hooks/useGuidePrograms";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getXtreamSeriesEpisodes, getCachedSeriesEpisodes } from "@/lib/tauri";
import { guideSearchQuery } from "@/lib/queries";
import { consumeBrowseState, saveBrowseSearch, saveBrowseTab } from "@/lib/browse-state";
import { findEpisode, sortEpisodes } from "@/lib/episodes";
import { categoriesByCount, channelCountFor, dedupeByTitle, seriesTitleOf } from "@/lib/channels";
import { recordingChannel } from "@/lib/recordings";
import { formatCount } from "@/lib/format";
import type {
	Channel,
	Category,
	EpgProgram,
	EpgSearchResult,
	WatchHistoryEntry,
} from "@/lib/types";

type Tab = "live" | "movie" | "series" | "favorites" | "downloads" | "history";

/** Grouping key for series titles — tolerant of case and spacing differences. */
const seriesKey = (title: string): string => title.trim().toLowerCase().replace(/\s+/g, " ");

const ALL_TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
	{ id: "live", label: "Live", icon: TvMinimal },
	{ id: "movie", label: "Movies", icon: Clapperboard },
	{ id: "series", label: "Series", icon: MonitorPlay },
	{ id: "favorites", label: "Favorites", icon: Heart },
	{ id: "downloads", label: "Downloads", icon: Download },
	{ id: "history", label: "History", icon: RotateCcwClock },
];

// The mobile apps have no downloads.
const TABS = ALL_TABS.filter((t) => t.id !== "downloads" || !isMobilePlatform());

/** Whether `v` names a tab this platform shows, such as one saved before playback. */
const isTab = (v: unknown): v is Tab => TABS.some((t) => t.id === v);

/** Pixels per hour for the dynamic window (higher = wider spacing between gridlines). */
const PX_PER_HOUR = 150;
/**
 * Width (px) of the right-side buttons in a RowCard (LIVE badge + ♡ + px-2 padding).
 * Must match the right spacer added to the sticky header so gridlines align with labels.
 */
const RIGHT_BUTTONS_PX = 80;

/**
 * The guide data of a channel that has none. One shared list keeps the prop
 * the same between renders, so the memoized rows don't re-render for it.
 */
const NO_PROGRAMS: EpgProgram[] = [];
const NO_RESULTS: EpgSearchResult[] = [];

const formatEpgTime = (startTime: number, now: number): string => {
	const diff = startTime - now;
	if (diff <= 0) return "now";
	if (diff < 3600) return `in ${Math.ceil(diff / 60)}m`;
	if (diff < 7200) return `in ${Math.floor(diff / 3600)}h`;
	const d = new Date(startTime * 1000);
	const today = new Date(now * 1000);
	const tomorrow = new Date(today);
	tomorrow.setDate(today.getDate() + 1);
	const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	if (d.toDateString() === today.toDateString()) return `today ${timeStr}`;
	if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${timeStr}`;
	return (
		d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) +
		` ${timeStr}`
	);
};

export const ChannelList = () => {
	const { channels, loading, toggleFavorite, providers, guideVersion } = useChannels();
	// A phone is too narrow for the EPG timeline, so live rows show what's on now.
	const { layoutMode } = usePlatform();
	const compactRows = layoutMode === "mobile";
	const rowVariant = compactRows ? "compact" : "row";
	const { byChannel, bySeries } = useDownloads();
	const navigate = useNavigate();

	// Tab and search are restored when coming back from the player (see lib/browse-state).
	const [initialBrowse] = useState(consumeBrowseState);
	const [activeTab, setActiveTab] = useState<Tab>(
		isTab(initialBrowse.tab) ? initialBrowse.tab : "live"
	);
	const [search, setSearch] = useState(initialBrowse.search);
	// Debounced search — updated 250ms after user stops typing to avoid per-keystroke re-renders
	const [debouncedSearch, setDebouncedSearch] = useState(initialBrowse.search);

	useEffect(() => {
		saveBrowseTab(activeTab);
	}, [activeTab]);
	useEffect(() => {
		saveBrowseSearch(search);
	}, [search]);
	const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

	// Hierarchy navigation state
	const [navState, setNavState] = useState<
		| { level: "home" }
		| { level: "category"; name: string }
		| { level: "group"; name: string; parentCategory?: string }
	>({ level: "home" });
	const [showCategoryManager, setShowCategoryManager] = useState(false);

	const activeProviderId = providers.length > 0 ? providers[0].id : null;
	const contentType =
		activeTab === "movie" ? "movie" : activeTab === "series" ? "series" : "live";
	const hierarchy = useGroupHierarchy(activeProviderId, contentType);
	const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
	const [showDownloadsOnly, setShowDownloadsOnly] = useState(false);
	const [seriesModalData, setSeriesModalData] = useState<{
		showTitle: string;
		episodes: Channel[];
		seriesChannelId: string;
	} | null>(null);
	const [seriesLoading, setSeriesLoading] = useState(false);
	// Episode lists usually load in a moment; only show the overlay when they don't.
	const showSeriesLoading = useDelayedFlag(seriesLoading, 300);
	const [selectedMovie, setSelectedMovie] = useState<Channel | null>(null);

	// EPG search: one result per channel (earliest matching program)
	// The guide search, 300ms after the last key, since it's a backend round trip.
	const [epgTerm, setEpgTerm] = useState("");

	// The root div's width, which sets the guide's window and the grid
	// columns. It's null until the div has been measured.
	const [containerWidth, setContainerWidth] = useState<number | null>(null);
	// The guide's window and its red line for now follow this clock.
	const now = useNow();

	/**
	 * Ref callback for the root div. While the channels load, or before any
	 * arrive, the list shows a spinner or a message in its place and the div
	 * loses this ref. This measures the div each time it gets the ref back,
	 * then follows its size.
	 */
	const measureRoot = useCallback((el: HTMLDivElement | null) => {
		if (!el) return;
		setContainerWidth(el.clientWidth);
		const observer = new ResizeObserver(([entry]) =>
			setContainerWidth(entry.contentRect.width)
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	// The guide's window, PX_PER_HOUR pixels for each hour and never under 3
	// hours, with a third of it before now. It moves along with the clock.
	const { windowStart, windowEnd } = useMemo(() => {
		// containerWidth is the whole component's width. The scroll container
		// inside has px-3, 12px on each side, and each row has two fixed
		// columns, so the timeline gets what's left.
		const effectiveWidth = containerWidth || 400;
		const timelinePx = Math.max(
			200,
			effectiveWidth - 24 - ROW_CARD_LEFT_WIDTH - RIGHT_BUTTONS_PX
		);
		const totalHours = Math.max(3, timelinePx / PX_PER_HOUR);
		const pastSec = Math.round((totalHours / 3) * 3600);
		const futureSec = Math.round(((totalHours * 2) / 3) * 3600);
		return { windowStart: now - pastSec, windowEnd: now + futureSec };
	}, [containerWidth, now]);

	const windowTotal = windowEnd - windowStart;

	// Debounce: update debouncedSearch 250ms after search changes
	useEffect(() => {
		const t = setTimeout(() => setDebouncedSearch(search), 250);
		return () => clearTimeout(t);
	}, [search]);

	const byType = useMemo(() => {
		const map: Record<"live" | "movie" | "series", Channel[]> = {
			live: [],
			movie: [],
			series: [],
		};
		for (const ch of channels) {
			const t = ch.contentType as "live" | "movie" | "series";
			if (t in map) map[t].push(ch);
			else map.live.push(ch);
		}
		return map;
	}, [channels]);

	const seriesShows = useMemo(() => {
		const seen = new Map<string, Channel>();
		for (const ch of byType.series) {
			const title = seriesTitleOf(ch);
			const key = seriesKey(title);
			if (!seen.has(key)) seen.set(key, { ...ch, name: title, sources: [] });
		}
		return Array.from(seen.values());
	}, [byType.series]);

	// Xtream lists the same show as separate series entries (other categories,
	// languages, servers). They're shown as one card, so keep every entry per
	// title to load all their episodes — the duplicates become extra sources.
	const xtreamSeriesByTitle = useMemo(() => {
		const map = new Map<string, Channel[]>();
		for (const ch of byType.series) {
			if (!ch.url.startsWith("xtream://series/")) continue;
			const key = seriesKey(seriesTitleOf(ch));
			const list = map.get(key);
			if (list) list.push(ch);
			else map.set(key, [ch]);
		}
		return map;
	}, [byType.series]);

	/** Episodes of every Xtream series entry sharing this show's title. */
	const fetchXtreamShowEpisodes = useCallback(
		async (showName: string, container: Channel): Promise<Channel[]> => {
			const containers = xtreamSeriesByTitle.get(seriesKey(showName)) ?? [container];
			// The clicked entry first so its episodes stay the default source.
			const ordered = [container, ...containers.filter((c) => c.id !== container.id)];
			const results = await Promise.allSettled(
				ordered.map((c) => getXtreamSeriesEpisodes(c.id))
			);
			const first = results[0];
			if (first.status === "rejected") throw first.reason;
			return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
		},
		[xtreamSeriesByTitle]
	);

	const movieTitles = useMemo(() => dedupeByTitle(byType.movie), [byType.movie]);

	const activeChannels = useMemo(() => {
		if (activeTab === "favorites") return channels.filter((ch) => ch.isFavorite);
		if (activeTab === "series") return seriesShows;
		if (activeTab === "movie") return movieTitles;
		if (activeTab === "history" || activeTab === "downloads") return [];
		return byType[activeTab];
	}, [activeTab, seriesShows, movieTitles, byType, channels]);

	const categories = useMemo<Category[]>(() => {
		if (
			activeTab === "series" ||
			activeTab === "favorites" ||
			activeTab === "history" ||
			activeTab === "downloads"
		)
			return [];
		return categoriesByCount(byType[activeTab as "live" | "movie"]);
	}, [byType, activeTab]);

	const handleTabChange = (tab: Tab) => {
		setActiveTab(tab);
		setSelectedCategory(null);
		setShowFavoritesOnly(false);
		setShowDownloadsOnly(false);
		setNavState({ level: "home" });
	};

	const effectiveCategory = navState.level === "group" ? navState.name : selectedCategory;

	// Filtering uses the debounced search, so typing doesn't re-render the
	// list on every key. Spaces around the search don't count.
	const searchQuery = debouncedSearch.trim().toLowerCase();
	const filtered = useMemo(() => {
		let result = activeChannels;
		if (effectiveCategory && activeTab !== "series" && activeTab !== "favorites") {
			result = result.filter((ch) => ch.groupTitle === effectiveCategory);
		}
		if (searchQuery) {
			result = result.filter((ch) => ch.name.toLowerCase().includes(searchQuery));
		}
		if (showFavoritesOnly && activeTab !== "favorites") {
			result = result.filter((ch) => ch.isFavorite === true);
		}
		if (showDownloadsOnly && activeTab !== "downloads") {
			result = result.filter((ch) => byChannel.has(ch.id) || bySeries.has(ch.id));
		}
		return result;
	}, [
		activeChannels,
		effectiveCategory,
		searchQuery,
		activeTab,
		showFavoritesOnly,
		showDownloadsOnly,
		byChannel,
		bySeries,
	]);

	// The part of the guide to load, which covers the window. It waits for the
	// first measurement so a wide list doesn't load twice. After that it only
	// moves when the window leaves it, as the list gets wider or the clock
	// carries the window past its end. A narrower list or a clock tick doesn't
	// load the guide again.
	const [guideRange, setGuideRange] = useState<TimeRange | null>(null);
	if (
		containerWidth !== null &&
		!(guideRange && coversWindow(guideRange, windowStart, windowEnd))
	) {
		setGuideRange(guideRangeFor(now, windowStart, windowEnd));
	}

	// The guide ids of the live favorites, for the Favorites tab.
	const favoriteGuideIds = useMemo(
		() => byType.live.flatMap((ch) => (ch.isFavorite && ch.tvgId ? [ch.tvgId] : [])),
		[byType.live]
	);

	// The Live tab shows every channel's guide, and the Favorites tab only that
	// of its live favorites with a guide id. It loads when its range moves,
	// when the tab starts showing it, when the number of channels changes and
	// when a provider's guide finishes refreshing. Going from Live to Favorites
	// keeps what's loaded, and a new favorite loads only its own programs.
	const guideChannels: GuideChannels | null =
		channels.length === 0
			? null
			: activeTab === "live"
				? "all"
				: activeTab === "favorites" && favoriteGuideIds.length > 0
					? favoriteGuideIds
					: null;
	const { programs: epgMap, isPending: guidePending } = useGuidePrograms(
		guideRange,
		guideChannels,
		`${channels.length}:${guideVersion}`
	);

	// Only the live tab searches the guide.
	const epgQuery = activeTab === "live" ? search.trim() : "";
	// An empty box forgets the last term, so typing it again is a new search
	// that asks the guide again once the cached answer is a minute old.
	if (!epgQuery && epgTerm !== "") setEpgTerm("");
	useEffect(() => {
		if (!epgQuery) return;
		const timer = setTimeout(() => setEpgTerm(epgQuery), 300);
		return () => clearTimeout(timer);
	}, [epgQuery]);
	const epgSearch = useQuery({
		...guideSearchQuery(epgTerm),
		enabled: epgTerm !== "",
		// The last search's results stay while the next one's load.
		placeholderData: keepPreviousData,
	});
	// An empty search box shows no results, even before the search catches up.
	const epgSearchResults = (epgQuery && epgSearch.data) || NO_RESULTS;

	const getChannelPrograms = (ch: Channel): EpgProgram[] =>
		(ch.tvgId && epgMap.get(ch.tvgId)) || NO_PROGRAMS;
	// A row whose programs are on their way may only be waiting for them.
	const isGuidePending = (ch: Channel): boolean => Boolean(ch.tvgId && guidePending(ch.tvgId));

	/**
	 * Opens the episode list for a show. From Downloads, which has to work
	 * offline, the cached list stands in when the live one can't be had.
	 */
	const openSeries = useCallback(
		(channel: Channel, cacheFallback: boolean): Promise<void> => {
			const showName = seriesTitleOf(channel);
			setSeriesLoading(true);
			const open = async () => {
				let eps: Channel[];
				if (channel.url.startsWith("xtream://series/")) {
					eps = await fetchXtreamShowEpisodes(showName, channel).catch((e) => {
						if (!cacheFallback) throw e;
						console.warn("[ChannelList] live episode fetch failed, using cache:", e);
						return [];
					});
				} else {
					eps = byType.series.filter((ep) => seriesTitleOf(ep) === showName);
				}
				if (cacheFallback && eps.length === 0) {
					eps = await getCachedSeriesEpisodes(channel.id);
				}
				setSeriesModalData({
					showTitle: showName,
					episodes: eps,
					seriesChannelId: channel.id,
				});
			};
			// Promise callbacks in place of try and finally, which the React
			// Compiler can't compile yet.
			return open()
				.catch((e) => console.error("[ChannelList] failed to load series episodes:", e))
				.finally(() => setSeriesLoading(false));
		},
		[byType.series, fetchXtreamShowEpisodes]
	);

	// Shows open their episode list and movies with sources open their drawer.
	// Favorites and Downloads mix types, so there the channel's own type decides.
	const handlePlay = useCallback(
		(channel: Channel) => {
			const mixed = activeTab === "favorites" || activeTab === "downloads";
			if (activeTab === "series" || (mixed && channel.contentType === "series")) {
				void openSeries(channel, activeTab === "downloads");
			} else if (
				(activeTab === "movie" || (mixed && channel.contentType === "movie")) &&
				channel.sources.length > 0
			) {
				setSelectedMovie(channel);
			} else {
				navigate("/player", {
					state: { url: channel.url, channelName: channel.name, channel },
				});
			}
		},
		[activeTab, navigate, openSeries]
	);

	const handleEpgResultPlay = useCallback(
		(epgChannelId: string) => {
			const ch = byType.live.find((c) => c.tvgId === epgChannelId);
			if (ch) handlePlay(ch);
		},
		[byType.live, handlePlay]
	);

	const handleToggleFavorite = useCallback(
		(channel: Channel) => {
			toggleFavorite(channel.id);
		},
		[toggleFavorite]
	);

	const handleHistoryPlay = useCallback(
		(entry: WatchHistoryEntry) => {
			if (entry.contentType === "series") {
				// The history names the show the same way the Recently Played row does.
				const seriesName = entry.seriesTitle ?? seriesTitleOf({ name: entry.channelName });
				// Find the series container to handle Xtream lazy-load
				const seriesContainer = byType.series.find((s) => seriesTitleOf(s) === seriesName);
				const seriesChannelId = seriesContainer?.id ?? entry.channelId;
				// Play the watched episode directly; if it's no longer listed, fall
				// back to the series picker.
				const playOrPick = (eps: Channel[]) => {
					const ep = findEpisode(eps, entry.channelId, entry.channelName);
					if (ep) {
						navigate("/player", {
							state: {
								url: ep.url,
								channelName: ep.name,
								channel: ep,
								seriesEpisodes: sortEpisodes(eps),
							},
						});
					} else if (eps.length > 0) {
						setSeriesModalData({
							showTitle: seriesName,
							episodes: eps,
							seriesChannelId,
						});
					}
				};
				if (seriesContainer && seriesContainer.url.startsWith("xtream://series/")) {
					setSeriesLoading(true);
					fetchXtreamShowEpisodes(seriesName, seriesContainer)
						.then(playOrPick)
						.catch((e) => console.error("[Xtream] failed to fetch series episodes:", e))
						.finally(() => setSeriesLoading(false));
				} else {
					playOrPick(byType.series.filter((ep) => seriesTitleOf(ep) === seriesName));
				}
			} else if (entry.contentType === "movie") {
				const movie = byType.movie.find((ch) => ch.name === entry.channelName);
				if (movie) setSelectedMovie(movie);
			} else if (entry.contentType === "recording") {
				// A recording plays from its file for as long as the app keeps it.
				const rec = byChannel.get(entry.channelId);
				if (rec?.kind !== "recording" || rec.status !== "completed") return;
				const ch = recordingChannel(rec);
				navigate("/player", { state: { url: ch.url, channelName: ch.name, channel: ch } });
			} else {
				const ch = byType.live.find((c) => c.id === entry.channelId);
				if (!ch) return;
				navigate("/player", {
					state: { url: ch.url, channelName: entry.channelName, channel: ch },
				});
			}
		},
		[byType, byChannel, navigate, fetchXtreamShowEpisodes]
	);

	const favoritesByType = useMemo(() => {
		const favs = filtered;
		return {
			live: favs.filter((ch) => ch.contentType === "live"),
			movie: favs.filter((ch) => ch.contentType === "movie"),
			series: favs.filter((ch) => ch.contentType === "series"),
		};
	}, [filtered]);

	// Number of downloaded items (movies + episodes + finished recordings).
	// `byChannel` is keyed per download channel, so a series' episodes count
	// individually; the series container itself has no download record and
	// must not be added. A recording counts once it has a file.
	const downloadCount = useMemo(
		() =>
			[...byChannel.values()].filter(
				(d) => d.kind !== "recording" || d.status === "completed"
			).length,
		[byChannel]
	);

	const isGrid = activeTab !== "live";
	// Dynamic grid columns: fit as many ~180 px-wide cards as possible, stretch via 1fr.
	const gridWidth = (containerWidth || 800) - 24; // minus px-3 padding
	const GAP_PX = 12;
	const MIN_CARD_W = 180;
	const columnsPerRow = isGrid
		? Math.max(2, Math.floor((gridWidth + GAP_PX) / (MIN_CARD_W + GAP_PX)))
		: 1;
	// Card height: image (aspect 2:1 = width/2) + title (~28px) + margin (~10px)
	const cardWidth = isGrid ? (gridWidth - GAP_PX * (columnsPerRow - 1)) / columnsPerRow : 0;
	const gridRowHeight = isGrid
		? Math.round(cardWidth / 2 + 38)
		: compactRows
			? COMPACT_ROW_HEIGHT
			: 48;
	const rowCount =
		activeTab === "favorites" || activeTab === "history"
			? 0
			: Math.ceil(filtered.length / columnsPerRow);

	// Use debouncedSearch for isLiveSearch to avoid expensive view-switch on every keystroke
	const hasSearch = searchQuery.length > 0;
	const isLiveSearch = activeTab === "live" && hasSearch;
	// Show channel list only when: no hierarchy (flat mode), or drilled into a group, or on favorites/history
	const showChannelList =
		!hierarchy.hasHierarchy ||
		navState.level === "group" ||
		activeTab === "favorites" ||
		activeTab === "history";

	// Grid marks for sticky header and background gridlines (uses same window as ChannelCard)
	const headerGridMarks = useMemo(
		() => getGridMarks(windowStart, windowEnd),
		[windowStart, windowEnd]
	);

	if (loading) {
		return (
			<div className="flex items-center justify-center h-full">
				<LoaderCircle className="h-5 w-5 animate-spin text-primary" />
			</div>
		);
	}

	if (channels.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
				<p className="text-base font-semibold">No channels yet</p>
				<p className="text-sm text-muted-foreground">Add a playlist to start watching.</p>
				<Button onClick={() => navigate("/playlists")} size="sm" className="mt-1">
					Add Playlist
				</Button>
			</div>
		);
	}

	const totalFavorites = channels.filter((ch) => ch.isFavorite).length;

	// What the list counts, such as "channel" in "3 channels".
	const countNoun =
		activeTab === "live"
			? "channel"
			: activeTab === "movie"
				? "movie"
				: activeTab === "series"
					? "show"
					: activeTab === "downloads"
						? "download"
						: "favorite";
	const countLabel = `${countNoun}s`;

	// Pixel offset of the timeline column left edge within the virtualizer div.
	// The rows already sit inside the px-3 padding that ChannelList gives
	// VirtualList's scroll element, so no extra 12px.
	const timelineLeft = ROW_CARD_LEFT_WIDTH;

	return (
		<div ref={measureRoot} className="flex flex-col h-full">
			{/* Tab bar. The tabs scroll sideways when they don't fit; on phones the
			    search and filters move to a row of their own below them. */}
			<div
				className={cn(
					"border-b border-border shrink-0",
					!compactRows && "flex items-center px-3"
				)}
			>
				<div
					className={cn(
						"flex items-center min-w-0 overflow-x-auto scrollbar-hide",
						compactRows ? "px-1" : "flex-1"
					)}
				>
					{TABS.map(({ id, label, icon: Icon }) => {
						const count =
							id === "history"
								? null
								: id === "favorites"
									? totalFavorites
									: id === "downloads"
										? downloadCount
										: id === "series"
											? seriesShows.length
											: id === "movie"
												? movieTitles.length
												: byType[id as "live"].length;
						return (
							<button
								key={id}
								onClick={() => handleTabChange(id)}
								className={`flex items-center gap-1.5 ${compactRows ? "px-3" : "px-4"} py-3 text-sm font-medium whitespace-nowrap shrink-0 border-b-2 transition-colors ${
									activeTab === id
										? "border-primary text-primary"
										: "border-transparent text-muted-foreground hover:text-foreground"
								}`}
							>
								<Icon className="h-3.5 w-3.5" />
								{label}
								{count !== null && (
									<span
										className={`text-[11px] px-1.5 py-0.5 rounded-full tabular-nums ${
											activeTab === id
												? "bg-primary/15 text-primary"
												: "bg-muted text-muted-foreground"
										}`}
									>
										{count.toLocaleString()}
									</span>
								)}
							</button>
						);
					})}
				</div>
				<div
					className={cn(
						"flex items-center shrink-0",
						compactRows && "px-3 pt-2.5 pb-2 empty:hidden"
					)}
				>
					{activeTab !== "history" && activeTab !== "downloads" && (
						<SearchBar
							value={search}
							onChange={setSearch}
							className={compactRows ? "flex-1 w-auto" : undefined}
						/>
					)}
					{activeTab !== "favorites" &&
						activeTab !== "history" &&
						activeTab !== "downloads" && (
							<button
								onClick={() => setShowFavoritesOnly((v) => !v)}
								className={`h-8 w-8 flex items-center justify-center rounded-md ml-1 transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring ${
									showFavoritesOnly
										? "text-red-500 bg-red-500/10"
										: "text-muted-foreground hover:text-foreground hover:bg-accent"
								}`}
								aria-label={showFavoritesOnly ? "Show all" : "Show favorites only"}
								aria-pressed={showFavoritesOnly}
							>
								<Heart
									className={`h-4 w-4 ${showFavoritesOnly ? "fill-current" : ""}`}
								/>
							</button>
						)}
					{activeTab !== "favorites" &&
						activeTab !== "history" &&
						activeTab !== "downloads" &&
						!isMobilePlatform() && (
							<button
								onClick={() => setShowDownloadsOnly((v) => !v)}
								className={`h-8 w-8 flex items-center justify-center rounded-md ml-1 transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring ${
									showDownloadsOnly
										? "text-blue-400 bg-blue-400/10"
										: "text-muted-foreground hover:text-foreground hover:bg-accent"
								}`}
								aria-label={showDownloadsOnly ? "Show all" : "Show downloaded only"}
								aria-pressed={showDownloadsOnly}
							>
								<Download className="h-4 w-4" />
							</button>
						)}
				</div>
			</div>

			{/* Hierarchy navigation — replaces flat CategoryFilter */}
			{activeTab !== "favorites" &&
				activeTab !== "history" &&
				activeTab !== "downloads" &&
				hierarchy.loaded && (
					<div className={showChannelList ? "shrink-0" : "flex-1 overflow-y-auto"}>
						{navState.level === "home" && (
							<>
								<RecentlyPlayedRow
									contentType={contentType as "live" | "movie" | "series"}
									onPlay={handleHistoryPlay}
								/>
								<PinnedGroupsRow
									pinnedGroups={hierarchy.pinnedGroups}
									categories={categories}
									selectedGroup={null}
									onSelectGroup={(name) => setNavState({ level: "group", name })}
									onUnpin={hierarchy.unpinGroup}
								/>
								{hierarchy.hasHierarchy ? (
									<CategoryBrowser
										superCategories={hierarchy.superCategories.map((name) => {
											const groups = hierarchy.getGroupsForCategory(name);
											return {
												name,
												groupCount: groups.length,
												channelCount: groups.reduce(
													(sum, g) =>
														sum + channelCountFor(categories, g),
													0
												),
											};
										})}
										topLevelGroups={hierarchy.topLevelGroups.map((name) => ({
											name,
											channelCount: channelCountFor(categories, name),
										}))}
										onSelectCategory={(name) =>
											setNavState({ level: "category", name })
										}
										onSelectGroup={(name) =>
											setNavState({ level: "group", name })
										}
										onManage={() => setShowCategoryManager(true)}
									/>
								) : categories.length > 1 ? (
									<div className="px-3 pt-2.5">
										<CategoryFilter
											categories={categories}
											selected={selectedCategory}
											onSelect={setSelectedCategory}
										/>
									</div>
								) : null}
								{!hierarchy.hasHierarchy &&
									hierarchy.entries.length === 0 &&
									categories.length > 1 && (
										<div className="mx-4 mt-2 p-3 rounded-lg bg-primary/5 border border-primary/20 text-sm">
											<p className="text-muted-foreground">
												Channels not categorized yet.
											</p>
											<button
												onClick={() => setShowCategoryManager(true)}
												className="text-primary hover:underline text-xs mt-1"
											>
												Use AI to organize channels?
											</button>
										</div>
									)}
							</>
						)}
						{navState.level === "category" && (
							<>
								<Breadcrumb
									path={[
										{
											label: "All Categories",
											onClick: () => setNavState({ level: "home" }),
										},
										{ label: navState.name },
									]}
								/>
								<GroupList
									groups={hierarchy
										.getGroupsForCategory(navState.name)
										.filter(
											(g) =>
												!searchQuery ||
												g.toLowerCase().includes(searchQuery)
										)}
									categories={categories}
									onSelectGroup={(name) =>
										setNavState({
											level: "group",
											name,
											parentCategory: navState.name,
										})
									}
									isPinned={hierarchy.isPinned}
									onTogglePin={(name) =>
										hierarchy.isPinned(name)
											? hierarchy.unpinGroup(name)
											: hierarchy.pinGroup(name)
									}
								/>
							</>
						)}
						{navState.level === "group" && (
							<Breadcrumb
								path={[
									...(navState.parentCategory
										? [
												{
													label: "All Categories",
													onClick: () => setNavState({ level: "home" }),
												},
												{
													label: navState.parentCategory,
													onClick: () =>
														setNavState({
															level: "category",
															name: navState.parentCategory!,
														}),
												},
											]
										: [
												{
													label: "All Categories",
													onClick: () => setNavState({ level: "home" }),
												},
											]),
									{ label: navState.name },
								]}
							/>
						)}
					</div>
				)}

			{/* Result count */}
			{activeTab !== "history" &&
				activeTab !== "downloads" &&
				!isLiveSearch &&
				showChannelList && (
					<div className="shrink-0 px-3 pt-2 pb-1">
						<span className="text-xs text-muted-foreground">
							{formatCount(filtered.length, countNoun)}
						</span>
					</div>
				)}

			{/* Sticky time-axis header — only when channel list is visible */}
			{activeTab === "live" && showChannelList && !compactRows && (
				<div className="shrink-0 flex items-center px-3 pb-1 border-b border-border/15">
					{/* Left spacer: matches ROW_CARD_LEFT_WIDTH in RowCard */}
					<div style={{ width: `${ROW_CARD_LEFT_WIDTH}px` }} className="shrink-0" />
					{/* Time label area: flex-1 matches the timeline flex-1 */}
					<div className="flex-1 relative h-5">
						{headerGridMarks.map((t) => {
							const p = toPct(t, windowStart, windowTotal);
							if (p < 2 || p > 98) return null;
							const isHour = t % 3600 === 0;
							return (
								<span
									key={t}
									className={`absolute -translate-x-1/2 whitespace-nowrap tabular-nums select-none ${
										isHour
											? "text-[9px] text-muted-foreground/75 font-medium"
											: "text-[8px] text-muted-foreground/40"
									}`}
									style={{ left: `${p.toFixed(3)}%`, top: "4px" }}
								>
									{formatHHMM(t)}
								</span>
							);
						})}
						{/* "Now" arrow aligned with the red marker line */}
						<span
							className="absolute -translate-x-1/2 text-[9px] text-red-400/80 select-none"
							style={{
								left: `${toPct(now, windowStart, windowTotal).toFixed(3)}%`,
								top: "2px",
							}}
						>
							▾
						</span>
					</div>
					{/* Right spacer: matches RIGHT_BUTTONS_PX so percentages align with gridlines */}
					<div style={{ width: `${RIGHT_BUTTONS_PX}px` }} className="shrink-0" />
				</div>
			)}

			{/* Series loading overlay */}
			{showSeriesLoading && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs">
					<div className="flex items-center gap-3 bg-card rounded-2xl px-6 py-4 shadow-2xl">
						<LoaderCircle className="h-5 w-5 animate-spin text-primary" />
						<span className="text-sm font-medium">Loading episodes…</span>
					</div>
				</div>
			)}

			{seriesModalData && (
				<SeriesDetailModal
					showTitle={seriesModalData.showTitle}
					episodes={seriesModalData.episodes}
					seriesChannelId={seriesModalData.seriesChannelId}
					onClose={() => setSeriesModalData(null)}
					onPlay={(ch) => {
						navigate("/player", {
							state: {
								url: ch.url,
								channelName: ch.name,
								channel: ch,
								seriesEpisodes: sortEpisodes(seriesModalData.episodes),
							},
						});
					}}
				/>
			)}

			{selectedMovie && (
				<MovieInfoDrawer
					movie={selectedMovie}
					onClose={() => setSelectedMovie(null)}
					onPlay={(ch) =>
						navigate("/player", {
							state: { url: ch.url, channelName: ch.name, channel: ch },
						})
					}
				/>
			)}

			{/* History tab */}
			{activeTab === "history" ? (
				<HistoryTab onPlay={handleHistoryPlay} />
			) : activeTab === "downloads" ? (
				<div className="flex-1 overflow-auto scrollbar-hide">
					<DownloadsTab onPlay={handlePlay} onToggleFavorite={handleToggleFavorite} />
				</div>
			) : activeTab === "favorites" ? (
				<div className="flex-1 overflow-auto scrollbar-hide px-3 pb-3">
					{filtered.length === 0 && hasSearch ? (
						<NoSearchResults
							query={debouncedSearch}
							scope="favorites"
							onClear={() => setSearch("")}
						/>
					) : filtered.length === 0 ? (
						<div className="flex flex-col items-center justify-center h-full gap-2 text-center py-12">
							<Heart className="h-10 w-10 text-muted-foreground/30" />
							<p className="text-sm text-muted-foreground">
								No favorites yet — tap ♡ on any channel
							</p>
						</div>
					) : (
						<div className="space-y-4 pt-2">
							{favoritesByType.live.length > 0 && (
								<section>
									<h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-0.5">
										Live
									</h3>
									<div className="flex flex-col">
										{favoritesByType.live.map((ch) => (
											<ChannelCard
												key={ch.id}
												channel={ch}
												onPlay={handlePlay}
												variant={rowVariant}
												onToggleFavorite={handleToggleFavorite}
												epgPrograms={getChannelPrograms(ch)}
												guidePending={isGuidePending(ch)}
												windowStart={windowStart}
												windowEnd={windowEnd}
											/>
										))}
									</div>
								</section>
							)}
							{favoritesByType.movie.length > 0 && (
								<section>
									<h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-0.5">
										Movies
									</h3>
									<div
										className="grid gap-3"
										style={{
											gridTemplateColumns: `repeat(${columnsPerRow}, minmax(0, 1fr))`,
										}}
									>
										{favoritesByType.movie.map((ch) => (
											<ChannelCard
												key={ch.id}
												channel={ch}
												onPlay={handlePlay}
												variant="poster"
												onToggleFavorite={handleToggleFavorite}
											/>
										))}
									</div>
								</section>
							)}
							{favoritesByType.series.length > 0 && (
								<section>
									<h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-0.5">
										Series
									</h3>
									<div
										className="grid gap-3"
										style={{
											gridTemplateColumns: `repeat(${columnsPerRow}, minmax(0, 1fr))`,
										}}
									>
										{favoritesByType.series.map((ch) => (
											<ChannelCard
												key={ch.id}
												channel={ch}
												onPlay={handlePlay}
												variant="poster"
												onToggleFavorite={handleToggleFavorite}
											/>
										))}
									</div>
								</section>
							)}
						</div>
					)}
				</div>
			) : isLiveSearch ? (
				/* Search results: channel name matches + EPG programme matches */
				<div className="flex-1 overflow-auto scrollbar-hide px-3 pb-3 pt-2">
					{filtered.length > 0 && (
						<>
							<p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-1 mb-1">
								Channels
							</p>
							<div className="flex flex-col mb-3 relative">
								{/* Background gridlines — mirrors the virtualizer path */}
								{!compactRows && (
									<div
										className="absolute inset-0 pointer-events-none z-0"
										style={{
											left: `${ROW_CARD_LEFT_WIDTH}px`,
											right: `${RIGHT_BUTTONS_PX}px`,
										}}
									>
										{headerGridMarks.map((t) => (
											<div
												key={t}
												className={`absolute top-0 bottom-0 w-px ${
													t % 3600 === 0 ? "bg-border/30" : "bg-border/12"
												}`}
												style={{
													left: `${toPct(t, windowStart, windowTotal).toFixed(3)}%`,
												}}
											/>
										))}
										<div
											className="absolute top-0 bottom-0 w-px bg-red-400/20"
											style={{
												left: `${toPct(now, windowStart, windowTotal).toFixed(3)}%`,
											}}
										/>
									</div>
								)}
								{filtered.slice(0, 80).map((ch) => (
									<ChannelCard
										key={ch.id}
										channel={ch}
										onPlay={handlePlay}
										variant={rowVariant}
										onToggleFavorite={handleToggleFavorite}
										epgPrograms={getChannelPrograms(ch)}
										guidePending={isGuidePending(ch)}
										windowStart={windowStart}
										windowEnd={windowEnd}
									/>
								))}
								{filtered.length > 80 && (
									<p className="text-[10px] text-muted-foreground/50 px-2 py-1">
										+{filtered.length - 80} more — narrow your search
									</p>
								)}
							</div>
						</>
					)}

					{epgSearchResults.length > 0 && (
						<>
							<p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-1 mb-1">
								On Now / Upcoming
							</p>
							<div className="flex flex-col">
								{epgSearchResults.map((result, i) => (
									<button
										key={`${result.channelId}-${i}`}
										onClick={() => handleEpgResultPlay(result.channelId)}
										className="group flex items-center gap-3 w-full px-2 py-2 rounded-lg hover:bg-accent transition-colors text-left focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
									>
										<ChannelLogo
											url={result.channelLogoUrl}
											className="h-8 w-8 rounded"
											fallback={
												<TvMinimal className="h-3.5 w-3.5 text-muted-foreground" />
											}
										/>

										<div className="flex-1 min-w-0">
											<p className="text-sm leading-tight truncate">
												{result.title}
											</p>
											<p className="text-[11px] text-muted-foreground truncate mt-0.5">
												{result.channelName}
											</p>
										</div>
										<span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
											{formatEpgTime(result.startTime, now)}
										</span>
									</button>
								))}
							</div>
						</>
					)}

					{filtered.length === 0 && epgSearchResults.length === 0 && (
						<NoSearchResults
							query={debouncedSearch}
							scope="channels or programmes"
							filtered={showFavoritesOnly}
							onClear={() => setSearch("")}
						/>
					)}
				</div>
			) : !showChannelList ? null : (
				/* Virtualised list — live/movie/series tabs */
				<VirtualList
					key={columnsPerRow}
					className="flex-1 scrollbar-hide px-3 pb-3"
					count={rowCount}
					rowHeight={gridRowHeight}
					placeholder={
						filtered.length === 0 && hasSearch ? (
							<NoSearchResults
								query={debouncedSearch}
								scope={countLabel}
								filtered={showFavoritesOnly || effectiveCategory != null}
								onClear={() => setSearch("")}
							/>
						) : filtered.length === 0 && showFavoritesOnly ? (
							<div className="flex flex-col items-center justify-center h-full gap-2 text-center py-12">
								<Heart className="h-10 w-10 text-muted-foreground/30" />
								<p className="text-sm text-muted-foreground">
									No favorites yet — tap ♡ on any channel
								</p>
							</div>
						) : undefined
					}
					background={
						/* Background gridlines spanning full virtual height — only on Live tab */
						activeTab === "live" &&
						!compactRows && (
							<div
								className="absolute top-0 bottom-0 pointer-events-none z-0"
								style={{
									left: `${timelineLeft}px`,
									right: `${RIGHT_BUTTONS_PX}px`,
								}}
							>
								{headerGridMarks.map((t) => (
									<div
										key={t}
										className={`absolute top-0 bottom-0 w-px ${
											t % 3600 === 0 ? "bg-border/30" : "bg-border/12"
										}`}
										style={{
											left: `${toPct(t, windowStart, windowTotal).toFixed(3)}%`,
										}}
									/>
								))}
								{/* Full-height "now" line */}
								<div
									className="absolute top-0 bottom-0 w-px bg-red-400/20"
									style={{
										left: `${toPct(now, windowStart, windowTotal).toFixed(3)}%`,
									}}
								/>
							</div>
						)
					}
					renderRow={(index) => {
						const startIdx = index * columnsPerRow;
						const rowChannels = filtered.slice(startIdx, startIdx + columnsPerRow);
						return isGrid ? (
							<div
								className="grid gap-3 pt-1"
								style={{
									gridTemplateColumns: `repeat(${columnsPerRow}, minmax(0, 1fr))`,
								}}
							>
								{rowChannels.map((ch) => (
									<ChannelCard
										key={ch.id}
										channel={ch}
										onPlay={handlePlay}
										variant="poster"
										onToggleFavorite={handleToggleFavorite}
									/>
								))}
							</div>
						) : (
							<div className="flex flex-col">
								{rowChannels.map((ch) => (
									<ChannelCard
										key={ch.id}
										channel={ch}
										onPlay={handlePlay}
										variant={rowVariant}
										onToggleFavorite={handleToggleFavorite}
										epgPrograms={getChannelPrograms(ch)}
										guidePending={isGuidePending(ch)}
										windowStart={windowStart}
										windowEnd={windowEnd}
									/>
								))}
							</div>
						);
					}}
				/>
			)}

			{showCategoryManager && activeProviderId && (
				<div className="absolute inset-0 z-50 bg-background">
					<CategoryManager
						providerId={activeProviderId}
						contentType={contentType}
						channels={channels}
						onClose={() => setShowCategoryManager(false)}
					/>
				</div>
			)}
		</div>
	);
};
